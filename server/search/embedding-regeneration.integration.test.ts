import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MeiliSearch } from 'meilisearch'

/**
 * Live-Meilisearch regression test for the incremental summary → embedding
 * synchronization gap (303 summarized / 283 embedded demo drift).
 *
 * Meilisearch renders the embedder's documentTemplate only when a document
 * is FIRST ADDED. An `addDocuments` update of an existing document preserves
 * its existing vector state — including an explicit vectorless marker — so a
 * summary arriving after ingestion never gets embedded unless the update
 * carries `_vectors: { embedder: { regenerate: true } }`. This test proves
 * the exact demo sequence: insert without summary (vectorless) → update with
 * summary + regenerate → embedding count increases.
 *
 * Skipped unless a real Meilisearch is reachable:
 *   MEILI_INTEGRATION_URL=http://localhost:7700 \
 *   MEILI_INTEGRATION_MASTER_KEY=...        (optional)
 *   OLLAMA_INTEGRATION_URL=http://localhost:11434   (optional, default)
 *
 * The embedder test also self-skips when the configured Ollama endpoint is
 * not actually serving, so the suite stays green without live infrastructure.
 */

const MEILI_URL = process.env.MEILI_INTEGRATION_URL
const MEILI_KEY = process.env.MEILI_INTEGRATION_MASTER_KEY
const OLLAMA_URL = process.env.OLLAMA_INTEGRATION_URL || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_INTEGRATION_MODEL || 'embeddinggemma:latest'

const EMBEDDER = 'article-v1'
const TEMPLATE = '{{doc.title}}\n\n{{doc.summary}}'

const runSuite = !!MEILI_URL

describe.skipIf(!runSuite)('live Meilisearch: incremental summary-to-embedding regeneration', () => {
  // Constructed lazily: instantiating MeiliSearch with an undefined host
  // throws even inside a describe.skipIf block (the body still evaluates).
  let client: MeiliSearch
  const indexUid = `articles_regen_it_${Date.now()}`
  let ollamaAvailable = false

  async function waitForTask(task: { taskUid: number }): Promise<void> {
    const res = await client.tasks.waitForTask(task.taskUid, { timeout: 60_000 })
    if (res.status !== 'succeeded') {
      throw new Error(`Task ${res.uid} ${res.status}: ${res.error?.message}`)
    }
  }

  async function stats(): Promise<{ numberOfDocuments: number; numberOfEmbeddings: number | null }> {
    const s = await client.index(indexUid).getStats()
    return { numberOfDocuments: s.numberOfDocuments, numberOfEmbeddings: s.numberOfEmbeddings ?? null }
  }

  beforeAll(async () => {
    client = new MeiliSearch({ host: MEILI_URL!, apiKey: MEILI_KEY })
    // Probe Ollama so the embedding assertions self-skip when no live
    // embedding provider exists (vector generation is Meilisearch-driven).
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
      ollamaAvailable = res.ok
    } catch {
      ollamaAvailable = false
    }
  })

  afterAll(async () => {
    try {
      await client.deleteIndex(indexUid)
    } catch {
      // best-effort cleanup
    }
  })

  it('inserts summary-less (vectorless), then regenerates when the summary arrives', { timeout: 180_000 }, async () => {
    // 180s: real Ollama embedding of 3 sequential updates takes well over
    // vitest's default 5s per-test timeout even on healthy infrastructure.
    await waitForTask(await client.createIndex(indexUid, { primaryKey: 'id' }))
    await waitForTask(await client.index(indexUid).updateSettings({
      embedders: ollamaAvailable
        ? { [EMBEDDER]: { source: 'ollama', model: OLLAMA_MODEL, url: `${OLLAMA_URL}/api/embed`, documentTemplate: TEMPLATE } }
        : {},
    }))

    // 1. Ingestion upsert: summary-less, explicitly vectorless.
    const base = { id: 1, title: 'Integration Test Article', summary: null as string | null }
    await waitForTask(await client.index(indexUid).addDocuments([{ ...base, _vectors: { [EMBEDDER]: null } }]))
    let s = await stats()
    expect(s.numberOfDocuments).toBe(1)
    if (ollamaAvailable) expect(s.numberOfEmbeddings).toBe(0)

    // 2. The buggy behavior: a summary update WITHOUT the regenerate flag
    //    preserves the existing vectorless state (the demo drift).
    await waitForTask(await client.index(indexUid).addDocuments([{ ...base, summary: 'A brand new summary.' }]))
    s = await stats()
    if (ollamaAvailable) expect(s.numberOfEmbeddings).toBe(0)

    // 3. The fix: the same upsert WITH the regenerate flag embeds the doc.
    //    Meilisearch-generated vectors live in its internal vector store and
    //    do NOT appear in the stored document's `_vectors` field, so the
    //    observable contract is semantic search: a summary-term query must
    //    rank the doc first even though the summary text never appears in
    //    any title (a second distractor doc prevents keyword fallback from
    //    trivially matching a single-document index).
    await waitForTask(await client.index(indexUid).addDocuments([
      { ...base, summary: 'A brand new summary.', _vectors: { [EMBEDDER]: { regenerate: true } } },
    ]))
    s = await stats()
    expect(s.numberOfDocuments).toBe(1)
    if (ollamaAvailable) {
      expect(s.numberOfEmbeddings).toBe(1)

      // Distractor: disjoint title/summary topics, same app-flow sequence.
      const other = { id: 2, title: 'Harbor logistics bulletin', summary: null as string | null }
      await waitForTask(await client.index(indexUid).addDocuments([
        { ...other, _vectors: { [EMBEDDER]: null } },
      ]))
      await waitForTask(await client.index(indexUid).addDocuments([
        { ...other, summary: 'glaciers retreat as polar temperatures rise', _vectors: { [EMBEDDER]: { regenerate: true } } },
      ]))
      const hybrid = (q: string) => client.index(indexUid).search(q, { hybrid: { semanticRatio: 1.0, embedder: EMBEDDER }, limit: 2 })
      const summaryHit = (await hybrid('brand new summary wording'))?.hits[0]?.id
      expect(summaryHit).toBe(1)
      const otherSummaryHit = (await hybrid('glaciers retreat polar temperatures'))?.hits[0]?.id
      expect(otherSummaryHit).toBe(2)
      // Control: title terms still resolve to their own docs.
      const titleHit = (await hybrid('Integration Test Article'))?.hits[0]?.id
      expect(titleHit).toBe(1)
    }
  })
})
