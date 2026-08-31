import { authHeaders } from './api-base'

interface SearchResult {
  id: number
  title: string
  url: string
  feed_name: string
  published_at: string | null
}

export async function searchArticles(
  q: string,
  filters: { bookmarked: boolean; liked: boolean; unread: boolean; since?: string },
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<{ articles: SearchResult[]; has_more: boolean; indexBuilding?: boolean; searchMode?: 'keyword' | 'hybrid' | 'keyword-fallback' }> {
  const params = new URLSearchParams({ q, limit: String(limit) })
  if (offset > 0) params.set('offset', String(offset))
  if (filters.bookmarked) params.set('bookmarked', '1')
  if (filters.liked) params.set('liked', '1')
  if (filters.unread) params.set('unread', '1')
  if (filters.since) params.set('since', filters.since)
  const res = await fetch(`/api/articles/search?${params.toString()}`, {
    headers: authHeaders(),
    signal,
  })
  if (res.status === 503) {
    return { articles: [], has_more: false, indexBuilding: true }
  }
  if (!res.ok) return { articles: [], has_more: false }
  const data = await res.json()
  return { articles: data.articles, has_more: data.has_more ?? false, searchMode: data.search_mode }
}
