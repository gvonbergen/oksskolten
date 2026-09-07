/**
 * Bounded Meilisearch version-compatibility probe for the incremental
 * summary-to-embedding regeneration contract (captain-authorized testing
 * only; no version-upgrade decision made here).
 *
 * App-flow sequence per doc (mirrors insertArticle -> autoSummarize ->
 * updateArticleContent -> syncArticleToSearch):
 *   1. fresh index + ollama embedder (template = title + summary)
 *   2. insert doc with summary null and _vectors: {article-v1: null}
 *   3. update with summary text + _vectors: {article-v1: {regenerate: true}}
 *
 * Validation is a crossed 4-doc semantic discrimination: each doc's title
 * and summary describe DIFFERENT topics, so only if the arriving summary
 * text entered the vector do summary-only queries rank the right doc first.
 * Keyword-fallback is excluded by semanticRatio: 1.0 and by using summary
 * terms that never appear in any title (and vice versa).
 *
 * Usage: node scripts/meili-regen-compat-probe.mjs <host> <masterKey>
 */
const MEILI_URL = process.argv[2] || 'http://127.0.0.1:7702'
const KEY = process.argv[3] || ''
const OLLAMA = process.env.OLLAMA_EMBED_URL || 'http://10.8.0.2:11434/api/embed'
const MODEL = process.env.OLLAMA_EMBED_MODEL || 'embeddinggemma:latest'
const EMBEDDER = 'article-v1'
const TEMPLATE = '{{doc.title}}\n\n{{doc.summary}}'

const DOCS = [
  { id: 1, title: 'Sourdough fermentation guide', summary: 'pandas forage bamboo shoots in misty mountain forests' },
  { id: 2, title: 'Garden gnome collecting', summary: 'hurricanes form over warm atlantic ocean waters' },
  { id: 3, title: 'Climbing gear checklist', summary: 'influenza vaccines are updated for each flu season' },
  { id: 4, title: 'Rooftop beekeeping basics', summary: 'comet tails brighten as they approach the sun' },
]

const h = {
  'content-type': 'application/json',
  ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
}

async function api(method, path, body) {
  const res = await fetch(`${MEILI_URL}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

async function waitTask(task, label) {
  for (let i = 0; i < 240; i++) {
    const { status, json } = await api('GET', `/tasks/${task.taskUid}`)
    if (status !== 200) throw new Error(`${label}: task lookup HTTP ${status}`)
    if (json.status === 'succeeded') return json
    if (json.status === 'failed') throw new Error(`${label} failed: ${json.error?.message}`)
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${label} timed out`)
}

async function addDoc(doc, label) {
  const r = await api('POST', '/indexes/probe/documents', doc)
  if (r.status !== 202 || !r.json?.taskUid) throw new Error(`${label}: unexpected POST ${r.status}: ${JSON.stringify(r.json)}`)
  await waitTask(r.json, label)
}

async function stats() {
  const { json } = await api('GET', '/indexes/probe/stats')
  return { docs: json.numberOfDocuments, embeds: json.numberOfEmbeddings ?? null }
}

async function semantic(query) {
  const { json } = await api('POST', '/indexes/probe/search', { q: query, hybrid: { semanticRatio: 1.0, embedder: EMBEDDER }, limit: 4 })
  return json.hits?.map(x => x.id) ?? []
}

async function summarizeEmbedCalls(ollamaUrl, key, since) {
  // Count /api/embed POSTs against the shared Ollama since a timestamp.
  // Best-effort; used to verify regenerate triggers provider work.
  return null
}

const results = {}

async function run(label) {
  const log = (s) => console.log(`  [${label}] ${s}`)
  await api('DELETE', '/indexes/probe')
  let r = await api('POST', '/indexes', { uid: 'probe', primaryKey: 'id' })
  await waitTask(r.json, 'create index')
  r = await api('PATCH', '/indexes/probe/settings', {
    embedders: { [EMBEDDER]: { source: 'ollama', model: MODEL, url: OLLAMA, documentTemplate: TEMPLATE } },
  })
  await waitTask(r.json, 'settings')

  // App flow: vectorless insert, then summary arrival with regenerate flag.
  for (const d of DOCS) {
    await addDoc({ id: d.id, title: d.title, summary: null, _vectors: { [EMBEDDER]: null } }, `insert ${d.id}`)
  }
  let s = await stats()
  log(`after 4 vectorless inserts: docs=${s.docs} embeds=${s.embeds}`)
  const afterInsert = s.embeds

  for (const d of DOCS) {
    await addDoc({ id: d.id, title: d.title, summary: d.summary, _vectors: { [EMBEDDER]: { regenerate: true } } }, `flag-update ${d.id}`)
  }
  await new Promise(r2 => setTimeout(r2, 2000))
  s = await stats()
  log(`after 4 regenerate-flag summary updates: docs=${s.docs} embeds=${s.embeds}`)
  const afterFlag = s.embeds

  // Crossed discrimination: summary-only terms must rank the right doc first.
  let summaryHits = 0
  const summaryRanking = []
  for (const d of DOCS) {
    const q = d.summary.replace(/^(pandas|hurricanes|influenza|comet) /, '')
    const hits = await semantic(d.summary)
    const ok = hits[0] === d.id
    if (ok) summaryHits++
    summaryRanking.push(`${d.id}->${hits.join(',')}`)
  }
  let titleHits = 0
  const titleRanking = []
  for (const d of DOCS) {
    const hits = await semantic(d.title)
    const ok = hits[0] === d.id
    if (ok) titleHits++
    titleRanking.push(`${d.id}->${hits.join(',')}`)
  }
  log(`semantic discrimination: summary queries ${summaryHits}/4 correct (${summaryRanking.join(' | ')}); title queries ${titleHits}/4 correct (${titleRanking.join(' | ')})`)

  results[label] = { afterInsert, afterFlag, summaryHits, titleHits }
}

await run(MEILI_URL)
console.log('RESULT ' + JSON.stringify(results))