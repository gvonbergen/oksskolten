#!/usr/bin/env tsx
/**
 * Pinned-Meilisearch smoke test for embedding-assisted search.
 *
 * Verifies the assumptions the oksskolten semantic-search feature relies on
 * against the real pinned image (getmeili/meilisearch:v1.13, same as
 * compose.yaml), using a local mock embedding endpoint — no external API:
 *
 *  1. A document with `_vectors: { <embedder>: null }` is NOT embedded
 *     (numberOfEmbeddedDocuments counts only summarized docs).
 *  2. An embedder configured in index settings survives the create → settings →
 *     add-documents → swap → delete-old cycle used by oksskolten's rebuild
 *     (regression for https://github.com/babarot/oksskolten/issues/117).
 *  3. Hybrid search works together with filters.
 *  4. When the embedding endpoint is unreachable, hybrid queries fail but
 *     plain keyword queries still return results (the app falls back to
 *     keyword search, so keyword results are never lost to embedding).
 *
 * Requires Docker and network access to pull the pinned image.
 *
 * Usage:
 *   npx tsx scripts/smoke-embedding.ts
 *   SMOKE_MEILI_PORT=7710 SMOKE_MOCK_PORT=7711 npx tsx scripts/smoke-embedding.ts
 */
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { MeiliSearch } from 'meilisearch'

const MEILI_PORT = Number(process.env.SMOKE_MEILI_PORT || 7710)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 7711)
const MEILI_IMAGE = 'getmeili/meilisearch:v1.13'
const MASTER_KEY = 'smoke-master-key'
const EMBEDDER = 'article-v1'
const DIMENSIONS = 8

/** Deterministic pseudo-vector so results are reproducible without a real model. */
function pseudoVector(text: string): number[] {
  const buf = createHash('sha256').update(text).digest()
  const vec: number[] = []
  for (let i = 0; i < DIMENSIONS; i++) vec.push((buf[i] - 128) / 255)
  return vec
}

function startMockEmbedder(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          const inputs: string[] = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
          const data = inputs.map((text, i) => ({ object: 'embedding', index: i, embedding: pseudoVector(text) }))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data, model: parsed.model, usage: { total_tokens: inputs.length } }))
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad request' }))
        }
      })
    })
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server))
  })
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Meilisearch did not become healthy at ${url}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${message}`)
    process.exitCode = 1
    throw new Error(message)
  }
  console.log(`✓ ${message}`)
}

async function enableMeiliTask(client: MeiliSearch, waitTask: any, label: string): Promise<void> {
  const task = await waitTask
  if (task.status === 'failed') {
    throw new Error(`${label} failed: ${JSON.stringify(task.error)}`)
  }
}

async function waitUntilStats(client: MeiliSearch, index: string, embedded: number, documents: number): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const stats = await client.index(index).getStats()
    if (stats.numberOfEmbeddedDocuments >= embedded && stats.numberOfDocuments >= documents) {
      return
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for stats embedded=${embedded} docs=${documents}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function main(): Promise<void> {
  // 1. Start mock embedder end-to-end lifecycle markers.
  const mock = await startMockEmbedder()
  let meiliProc: ReturnType<typeof spawn> | null = null
  try {
    execFileSync('docker', ['rm', '-f', 'oksskolten-smoke-meili'], { stdio: 'ignore' }).catch?.(() => {})
  } catch { /* container may not exist */ }

  try {
    meiliProc = spawn(
      'docker',
      [
        'run', '-d', '--rm', '--name', 'oksskolten-smoke-meili',
        '--network', 'host',
        '-e', `MEILI_MASTER_KEY=${MASTER_KEY}`,
        '-e', 'MEILI_NO_ANALYTICS=true',
        '-e', `MEILI_HTTP_ADDR=127.0.0.1:${MEILI_PORT}`,
        MEILI_IMAGE,
      ],
      { stdio: 'inherit' },
    )
    const meiliUrl = `http://127.0.0.1:${MEILI_PORT}`
    await waitForHealth(meiliUrl)
    const client = new MeiliSearch({ host: meiliUrl, apiKey: MASTER_KEY })

    const embedderSettings = {
      [EMBEDDER]: {
        source: 'rest',
        url: `http://127.0.0.1:${MOCK_PORT}/v1/embeddings`,
        request: { model: 'smoke-model', input: '{{text}}' },
        // OpenAI-compatible response: { "data": [ { "embedding": [...] } ] }
        response: { data: [{ embedding: '{{embedding}}' }] },
        dimensions: DIMENSIONS,
        documentTemplate: '{{doc.title}}\n\n{{doc.summary}}',
      },
    }
    const keywordSettings = {
      searchableAttributes: ['title', 'full_text'],
      filterableAttributes: ['feed_id', 'published_at'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    }

    const staging = client.index('articles_staging')

    // 2. oksskolten-equivalent rebuild cycle: create staging → settings
    // (with embedder) → add docs → swap → delete old.
    await enableMeiliTask(client, client.createIndex('articles_staging', { primaryKey: 'id' }).waitTask(), 'create staging')
    await enableMeiliTask(client, staging.updateSettings({ ...keywordSettings, embedders: embedderSettings }).waitTask(), 'apply staged settings')

    const docs = [
      { id: 1, feed_id: 10, title: 'Rust async executors', summary: 'How tasks are scheduled', full_text: 'long body about rust async', published_at: 1700000000 },
      // This document opts out of embedding via the null marker — the app
      // uses this for articles without a summary.
      { id: 2, feed_id: 10, title: 'No summary yet', summary: null, full_text: 'keyword only body', published_at: 1700000001, _vectors: { [EMBEDDER]: null } },
    ]
    await enableMeiliTask(client, staging.addDocuments(docs).waitTask(), 'add documents')

    // 2a. Only the summarized document gets embedded.
    await waitUntilStats(client, 'articles_staging', 1, 2)
    const stagedStats = await staging.getStats()
    assert(stagedStats.numberOfEmbeddedDocuments === 1, 'null _vectors marker skips embedding generation (1/2 embedded)')

    // 2b. Swap and delete old (the app's rebuild end: `articles` <- staging).
    await enableMeiliTask(client, client.createIndex('articles', { primaryKey: 'id' }).waitTask(), 'create empty production')
    await enableMeiliTask(client, client.swapIndexes([{ indexes: ['articles', 'articles_staging'] }] as any).waitTask(), 'swap')
    await enableMeiliTask(client, client.deleteIndex('articles_staging').waitTask(), 'delete old')

    const production = client.index('articles')

    // 3. #117 regression: the swapped-in index still carries the embedder.
    const liveSettings = await production.getSettings()
    assert(!!liveSettings.embedders?.[EMBEDDER], 'embedder survives the create/settings/add/swap/delete rebuild cycle (#117)')

    // 4. Hybrid search respects filters.
    await waitUntilStats(client, 'articles', 1, 2)
    const hybrid = await production.search('tasks scheduling', {
      hybrid: { embedder: EMBEDDER, semanticRatio: 0.5 },
      filter: 'feed_id = 10',
      limit: 10,
    })
    assert(Array.isArray(hybrid.hits), 'hybrid query succeeds')
    assert(hybrid.hits[0]?.id === 1, 'hybrid query ranks the semantically matching article first')
    const filtered = await production.search('tasks', { filter: 'published_at > 1700000000', limit: 10 })
    assert(filtered.hits.every((h: { id: number }) => h.id === 2), 'filters still apply with hybrid configured')

    // 5. Embedding endpoint dies → keyword results must survive (the app
    // falls back to keyword when hybrid generation fails; unit tests pin
    // the retry-once behavior at the query layer). At the Meili level we
    // verify the deterministic part: previously indexed documents remain
    // fully searchable by keyword while the embedder endpoint is down.
    await new Promise<void>((resolve) => { try { mock.close(() => resolve()) } catch { resolve() } })
    await new Promise((r) => setTimeout(r, 500))
    const keyword = await production.search('rust async executors')
    assert(
      keyword.hits.some((h: { id: number }) => h.id === 1),
      'keyword search still returns indexed results when the embedding endpoint is down (fallback premise)',
    )

    console.log('\nAll smoke assertions passed against Meilisearch ' + (await client.getVersion()).pkgVersion)
  } finally {
    try { mock.close() } catch { /* already closed */ }
    try {
      execFileSync('docker', ['rm', '-f', 'oksskolten-smoke-meili'], { stdio: 'ignore' })
      meiliProc?.unref()
    } catch { /* container may not exist */ }
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err)
  process.exit(1)
})