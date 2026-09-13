import { describe, it, expect } from 'vitest'
import { demoStore } from './demo-store'
import { demoApiPost, demoApiDelete, demoFetcher } from './mock-api'

function allArticles() {
  return demoStore.getArticles({ limit: 10_000 }).articles
}

describe('demo redownload action', () => {
  it('bumps fetched_at so the client completion poll ends', async () => {
    const target = allArticles()[0]
    const before = await demoFetcher(`/api/articles/by-url?url=${encodeURIComponent(target.url)}`) as { id: number; fetched_at: string }

    const res = await demoApiPost(`/api/articles/${before.id}/redownload`)
    expect(res).toEqual({ status: 'accepted' })

    const after = await demoFetcher(`/api/articles/by-url?url=${encodeURIComponent(target.url)}`) as { id: number; fetched_at: string }
    expect(after.fetched_at).not.toBe(before.fetched_at)
  })
})

describe('demo delete action', () => {
  it('removes the article from the store so it stays gone after list reload', async () => {
    const target = allArticles()[0]
    expect(target).toBeDefined()

    const res = await demoApiDelete(`/api/articles/${target.id}`)
    expect(res).toEqual({ success: true })

    // A fresh list read (what a list reload after navigation does) no
    // longer contains the article.
    expect(allArticles().some(a => a.id === target.id)).toBe(false)
    // The detail endpoint rejects the gone article like the server's 404.
    await expect(demoFetcher(`/api/articles/by-url?url=${encodeURIComponent(target.url)}`)).rejects.toThrow('Article not found')
  })
})