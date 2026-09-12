import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSWRConfig } from 'swr'
import { apiPatch, apiPost, apiDelete } from '../lib/fetcher'
import type { ArticleDetail } from '../../shared/types'

export function useArticleActions(article: ArticleDetail | undefined, articleKey: string) {
  const navigate = useNavigate()
  const { mutate: globalMutate, cache } = useSWRConfig()

  const [optimisticBookmark, setOptimisticBookmark] = useState<boolean | undefined>(undefined)
  const [optimisticLiked, setOptimisticLiked] = useState<string | null | undefined>(undefined)
  const [archivingImages, setArchivingImages] = useState(false)
  const [redownloading, setRedownloading] = useState(false)
  const [redownloadError, setRedownloadError] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const isBookmarked = optimisticBookmark !== undefined ? optimisticBookmark : !!article?.bookmarked_at
  const isLiked = optimisticLiked !== undefined ? !!optimisticLiked : !!article?.liked_at

  // Reset optimistic state when article changes
  useEffect(() => {
    setOptimisticBookmark(undefined)
    setOptimisticLiked(undefined)
  }, [article?.id])

  const revalidateLists = useCallback(() => {
    // globalMutate(filterFn) silently skips $inf$ keys produced by
    // useSWRInfinite, so walk the cache directly to cover both
    // /api/feeds (regular) and /api/articles (infinite) entries.
    for (const key of cache.keys()) {
      if (typeof key !== 'string') continue
      if (key.includes('/api/feeds') || key.includes('/api/articles')) {
        void globalMutate(key)
      }
    }
  }, [globalMutate, cache])

  const toggleBookmark = useCallback(async () => {
    if (!article) return
    const next = !isBookmarked
    setOptimisticBookmark(next)
    void globalMutate(articleKey, (current: ArticleDetail | undefined) => (
      current ? { ...current, bookmarked_at: next ? new Date().toISOString() : null } : current
    ), false)
    try {
      await apiPatch(`/api/articles/${article.id}/bookmark`, { bookmarked: next })
      void globalMutate(articleKey)
      revalidateLists()
    } catch {
      setOptimisticBookmark(undefined)
      void globalMutate(articleKey)
    }
  }, [article, articleKey, isBookmarked, globalMutate, revalidateLists])

  const toggleLike = useCallback(async () => {
    if (!article) return
    const next = !isLiked
    const nextLikedAt = next ? new Date().toISOString() : null
    setOptimisticLiked(nextLikedAt)
    void globalMutate(articleKey, (current: ArticleDetail | undefined) => (
      current ? { ...current, liked_at: nextLikedAt } : current
    ), false)
    try {
      await apiPatch(`/api/articles/${article.id}/like`, { liked: next })
      void globalMutate(articleKey)
      revalidateLists()
    } catch {
      setOptimisticLiked(undefined)
      void globalMutate(articleKey)
    }
  }, [article, articleKey, isLiked, globalMutate, revalidateLists])

  const handleArchiveImages = useCallback(async () => {
    if (!article || archivingImages) return
    setArchivingImages(true)
    try {
      await apiPost(`/api/articles/${article.id}/archive-images`)
      setTimeout(() => {
        void globalMutate(articleKey)
        setArchivingImages(false)
      }, 3000)
    } catch {
      setArchivingImages(false)
    }
  }, [article, articleKey, archivingImages, globalMutate])

  const handleDelete = useCallback(() => {
    if (!article) return
    const feedId = article.feed_id
    const articleId = article.id
    void navigate(`/feeds/${feedId}`, { replace: true })
    apiDelete(`/api/articles/${articleId}`)
      .then(() => {
        void globalMutate((key: unknown) =>
          typeof key === 'string' && key.startsWith('/api/feeds'),
        )
        // RSS deletes are soft-hides; article lists must drop them too.
        revalidateLists()
      })
      .catch((err) => console.warn('Failed to delete article:', err))
  }, [article, globalMutate, navigate, revalidateLists])

  // Redownload runs as a 202 background job server-side (a page fetch can
  // take ~15s plus a FlareSolverr fallback round), so poll the article SWR
  // key until the server-side fetched_at changes (success marker, refreshed
  // by the redownload job) or the timeout elapses (failure).
  const REDOWNLOAD_POLL_INTERVAL_MS = 2000
  const REDOWNLOAD_TIMEOUT_MS = 90_000

  // Stop polling when the article changes or the component unmounts.
  const redownloadArticleIdRef = useRef<number | null>(null)
  useEffect(() => {
    setRedownloading(false)
    setRedownloadError(false)
    redownloadArticleIdRef.current = article?.id ?? null
    return () => { redownloadArticleIdRef.current = null }
  }, [article?.id])

  const handleRedownload = useCallback(async () => {
    if (!article || redownloading) return
    setRedownloading(true)
    setRedownloadError(false)
    const targetArticleId = article.id
    const initialFetchedAt = article.fetched_at
    try {
      await apiPost(`/api/articles/${article.id}/redownload`)
    } catch {
      // 409 (already in progress) or transient failure: keep polling — the
      // running job may still complete.
    }
    const deadline = Date.now() + REDOWNLOAD_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REDOWNLOAD_POLL_INTERVAL_MS))
      if (redownloadArticleIdRef.current !== targetArticleId) return
      try {
        const fresh = await globalMutate(articleKey) as ArticleDetail | undefined
        if (fresh?.fetched_at && fresh.fetched_at !== initialFetchedAt) {
          revalidateLists()
          setRedownloading(false)
          return
        }
      } catch {
        // Transient network error — keep polling until the deadline.
      }
    }
    setRedownloadError(true)
    setRedownloading(false)
  }, [article, articleKey, redownloading, globalMutate, revalidateLists])

  return {
    isBookmarked,
    isLiked,
    archivingImages,
    redownloading,
    redownloadError,
    setRedownloadError,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    toggleBookmark,
    toggleLike,
    handleArchiveImages,
    handleRedownload,
    handleDelete,
  }
}
