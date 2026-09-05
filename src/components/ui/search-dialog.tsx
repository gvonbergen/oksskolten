import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import { X, Bookmark, ThumbsUp, Circle, CalendarDays, CalendarRange, CalendarFold } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Dialog, DialogPortal, DialogOverlay, DialogTitle } from './dialog'
import { fetcher } from '../../lib/fetcher'
import { searchArticles } from '../../lib/search'

/** Maximum number of search results returned per page */
const SEARCH_RESULTS_LIMIT = 20
import { articleUrlToPath } from '../../lib/url'
import { formatRelativeDate } from '../../lib/dateFormat'
import { useI18n } from '../../lib/i18n'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from './command'

interface SearchResult {
  id: number
  title: string
  url: string
  feed_name: string
  published_at: string | null
}

interface SearchDialogProps {
  onClose: () => void
}

export function SearchDialog({ onClose }: SearchDialogProps) {
  const navigate = useNavigate()
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [indexBuilding, setIndexBuilding] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [filterBookmarked, setFilterBookmarked] = useState(false)
  const [filterLiked, setFilterLiked] = useState(false)
  const [filterUnread, setFilterUnread] = useState(false)
  const [datePeriod, setDatePeriod] = useState<'today' | 'week' | 'month' | null>(null)
  const [keywordFallback, setKeywordFallback] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const abortRef = useRef<AbortController>(undefined)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loadMoreRef = useRef<() => void>(() => {})

  const { data: recentData } = useSWR<{ articles: SearchResult[] }>(
    '/api/articles?read=1&limit=10',
    fetcher,
  )
  const recentArticles = recentData?.articles ?? []

  const buildFilters = useCallback(() => {
    let since: string | undefined
    if (datePeriod) {
      const now = new Date()
      if (datePeriod === 'today') {
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
      } else if (datePeriod === 'week') {
        const d = new Date(now)
        d.setDate(d.getDate() - 7)
        since = d.toISOString()
      } else if (datePeriod === 'month') {
        const d = new Date(now)
        d.setMonth(d.getMonth() - 1)
        since = d.toISOString()
      }
    }
    return { bookmarked: filterBookmarked, liked: filterLiked, unread: filterUnread, since }
  }, [filterBookmarked, filterLiked, filterUnread, datePeriod])

  const doSearch = useCallback(async (q: string, filters: { bookmarked: boolean; liked: boolean; unread: boolean; since?: string }, offset = 0) => {
    if (offset === 0) {
      abortRef.current?.abort()
    }
    if (!q.trim()) {
      setResults([])
      setHasSearched(false)
      setHasMore(false)
      return
    }
    const controller = new AbortController()
    if (offset === 0) {
      abortRef.current = controller
    }
    try {
      const data = await searchArticles(q, filters, SEARCH_RESULTS_LIMIT, offset, controller.signal)
      if (data.indexBuilding) {
        setIndexBuilding(true)
        setTimeout(() => doSearch(q, filters, 0), 3000)
        return
      }
      setIndexBuilding(false)
      // Show a discreet notice only after an actual embedding-failure
      // fallback, never when semantic search is intentionally disabled
      // (the server then returns search_mode 'keyword', not 'keyword-fallback').
      setKeywordFallback(data.searchMode === 'keyword-fallback')
      if (offset === 0) {
        setResults(data.articles)
      } else {
        setResults(prev => [...prev, ...data.articles])
      }
      setHasMore(data.has_more)
      setHasSearched(true)
      setIsLoadingMore(false)
    } catch {
      // aborted or network error
      setIsLoadingMore(false)
    }
  }, [])

  // Debounced search on query/filter change (always offset=0)
  useEffect(() => {
    clearTimeout(debounceRef.current)
    const filters = buildFilters()
    debounceRef.current = setTimeout(() => doSearch(query, filters, 0), 300)
    return () => clearTimeout(debounceRef.current)
  }, [query, filterBookmarked, filterLiked, filterUnread, datePeriod, doSearch, buildFilters])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // Load more callback
  loadMoreRef.current = () => {
    if (!hasMore || isLoadingMore || !query.trim()) return
    setIsLoadingMore(true)
    const filters = buildFilters()
    void doSearch(query, filters, results.length)
  }

  // IntersectionObserver for sentinel
  const sentinelCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    sentinelRef.current = node
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMoreRef.current()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    observerRef.current = observer
  }, [])

  // Re-trigger load if sentinel is visible after fetch completes
  useEffect(() => {
    if (!hasMore || isLoadingMore) return
    const node = sentinelRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    if (rect.top < window.innerHeight + 200) {
      loadMoreRef.current()
    }
  }, [results.length, hasMore, isLoadingMore])

  function handleSelect(article: SearchResult) {
    onClose()
    void navigate(articleUrlToPath(article.url))
  }

  const displayItems = query.trim() ? results : recentArticles

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="bg-bg-card md:bg-overlay" />
        <DialogPrimitive.Content
          className="fixed inset-0 md:inset-auto md:top-[15vh] md:left-1/2 md:-translate-x-1/2 z-[70] w-full md:max-w-lg md:rounded-xl md:border border-border md:shadow-xl overflow-hidden select-none bg-bg-card flex flex-col"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
        <Command
          shouldFilter={false}
          className={[
            'flex flex-col h-full md:h-auto',
            '[&_[cmdk-input-wrapper]]:border-0 [&_[cmdk-input-wrapper]]:bg-bg-subtle [&_[cmdk-input-wrapper]]:rounded-lg [&_[cmdk-input-wrapper]]:px-3',
            'md:[&_[cmdk-input-wrapper]]:border-b md:[&_[cmdk-input-wrapper]]:border-border md:[&_[cmdk-input-wrapper]]:bg-transparent md:[&_[cmdk-input-wrapper]]:rounded-none md:[&_[cmdk-input-wrapper]]:px-4',
          ].join(' ')}
        >
          {/* Search header */}
          <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5 md:p-0">
            <div className="relative flex-1 min-w-0">
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={t('search.placeholder')}
                autoFocus
              />
              {query && (
                <button
                  onClick={() => { setQuery(''); setResults([]); setHasSearched(false); setHasMore(false) }}
                  className="absolute right-3 md:right-4 top-1/2 -translate-y-1/2 text-muted hover:text-text transition-colors"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              )}
            </div>
            <button
              onClick={onClose}
              className="md:hidden flex items-center justify-center w-8 h-8 rounded-full bg-bg-subtle text-muted hover:text-text active:bg-border transition-colors shrink-0"
              aria-label="Close"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          {/* Filter toggles */}
          <div className="flex flex-nowrap gap-1.5 px-3 py-2 border-b border-border select-none overflow-x-auto scrollbar-none">
            <button
              onClick={() => setFilterBookmarked(v => !v)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all border whitespace-nowrap shrink-0 ${
                filterBookmarked
                  ? 'border-border bg-bg-subtle text-text'
                  : 'border-border bg-text/15 text-muted hover:text-text'
              }`}
            >
              <Bookmark size={12} strokeWidth={1.5} fill={filterBookmarked ? 'currentColor' : 'none'} />
              {t('search.filterBookmarked')}
            </button>
            <button
              onClick={() => setFilterLiked(v => !v)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all border whitespace-nowrap shrink-0 ${
                filterLiked
                  ? 'border-border bg-bg-subtle text-text'
                  : 'border-border bg-text/15 text-muted hover:text-text'
              }`}
            >
              <ThumbsUp size={12} strokeWidth={1.5} fill={filterLiked ? 'currentColor' : 'none'} />
              {t('search.filterLiked')}
            </button>
            <button
              onClick={() => setFilterUnread(v => !v)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all border whitespace-nowrap shrink-0 ${
                filterUnread
                  ? 'border-border bg-bg-subtle text-text'
                  : 'border-border bg-text/15 text-muted hover:text-text'
              }`}
            >
              <Circle size={12} strokeWidth={1.5} fill={filterUnread ? 'currentColor' : 'none'} />
              {t('search.filterUnread')}
            </button>
            <span className="w-px h-4 bg-border/50 self-center mx-0.5 shrink-0" />
            {([
              { key: 'today', Icon: CalendarDays },
              { key: 'week', Icon: CalendarRange },
              { key: 'month', Icon: CalendarFold },
            ] as const).map(({ key, Icon }) => {
              const active = datePeriod === key
              return (
                <button
                  key={key}
                  onClick={() => setDatePeriod(v => v === key ? null : key)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all border whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-border bg-bg-subtle text-text'
                      : 'border-border bg-text/15 text-muted hover:text-text'
                  }`}
                >
                  <Icon size={12} strokeWidth={1.5} />
                  {t(`search.period.${key}`)}
                </button>
              )
            })}
          </div>

          <CommandList className="flex-1 md:flex-none max-h-none md:max-h-[60vh]">
            {indexBuilding && (
              <CommandEmpty>{t('search.indexBuilding')}</CommandEmpty>
            )}
            {!indexBuilding && hasSearched && results.length === 0 && (
              <CommandEmpty>{t('search.noResults')}</CommandEmpty>
            )}
            {keywordFallback && hasSearched && (
              <p className="px-4 py-1.5 text-[11px] text-muted/80 text-center select-none">
                {t('search.semanticFallback')}
              </p>
            )}
            {displayItems.length > 0 && (
              <CommandGroup>
                {displayItems.map(article => (
                  <CommandItem
                    key={article.id}
                    value={String(article.id)}
                    onSelect={() => handleSelect(article)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="text-sm text-text truncate w-full">{article.title}</span>
                    <span className="text-xs text-muted truncate w-full">
                      {article.feed_name}
                      {article.published_at && ` · ${formatRelativeDate(article.published_at, locale, { justNow: t('date.justNow') })}`}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {hasMore && (
              <div ref={sentinelCallbackRef} className="py-3 text-center">
                {isLoadingMore && <span className="text-xs text-muted">...</span>}
              </div>
            )}
          </CommandList>

          {/* Footer hint (desktop only) */}
          <div className="hidden md:block px-4 py-2 border-t border-border text-[11px] text-muted text-center">
            {t('search.hint')}
          </div>
        </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
