import { useEffect, useRef, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, useConfirmDialog } from '@/components/ui/confirm-dialog'
import { useDesktop } from '@/features/desktop/provider'
import { api } from '@/features/desktop/api'
import { RefreshCw, Search, CheckCircle, Copy, Check, Clock, FolderOpen, User, Bot, MessageSquareText, Star, Archive, ArchiveRestore, ChevronDown, ChevronUp } from 'lucide-react'
import type { Session } from '@/features/desktop/types'

function formatTime(timestamp: string, justNowLabel: string): string {
  try {
    const num = parseInt(timestamp)
    let date: Date
    if (num > 10 ** 17) date = new Date(num / 1_000_000)
    else if (num > 10 ** 15) date = new Date(num / 1_000)
    else if (num > 10 ** 12) date = new Date(num)
    else date = new Date(num * 1000)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const hours = diff / (1000 * 60 * 60)
    if (hours < 1) return justNowLabel
    if (hours < 24) return `${Math.floor(hours)}h`
    if (hours < 48) return '1d'
    return `${Math.floor(hours / 24)}d`
  } catch {
    return ''
  }
}

function formatDateTime(timestamp: string): string {
  try {
    const num = parseInt(timestamp)
    let date: Date
    if (num > 10 ** 17) date = new Date(num / 1_000_000)
    else if (num > 10 ** 15) date = new Date(num / 1_000)
    else if (num > 10 ** 12) date = new Date(num)
    else date = new Date(num * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  } catch {
    return ''
  }
}

const platformColors = {
  claude: 'bg-gradient-to-br from-blue-500 to-indigo-600',
  codex: 'bg-gradient-to-br from-orange-500 to-red-500',
  opencode: 'bg-gradient-to-br from-green-500 to-emerald-600',
  kiro: 'bg-gradient-to-br from-purple-500 to-violet-600',
}

const platformBorderColors = {
  claude: 'border-l-blue-500',
  codex: 'border-l-orange-500',
  opencode: 'border-l-green-500',
  kiro: 'border-l-purple-500',
}

const PAGE_SIZE = 50

export function SessionList() {
  const { t, state, dispatch } = useDesktop()
  const currentPlatform = state.currentPlatform
  const sessions = state.sessions
  const selectedSessionKey = state.selectedSessionKey
  const searchQuery = state.searchQuery
  const [refreshing, setRefreshing] = useState(false)
  const [refreshDone, setRefreshDone] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const showArchived = state.showArchived
  const { confirm, dialogProps } = useConfirmDialog()

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const debouncedSetSearch = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      dispatch({ type: 'setSearchQuery', payload: value })
    }, 300)
  }, [dispatch])

  useEffect(() => {
    if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings') return
    const loadSessions = async () => {
      setLoading(true)
      try {
        const isSearch = searchQuery.trim().length > 0
        console.time(`[perf] getSessions(${currentPlatform}, search=${isSearch})`)
        const result = await api.getSessions(currentPlatform, searchQuery, isSearch ? undefined : PAGE_SIZE, 0, showArchived)
        console.timeEnd(`[perf] getSessions(${currentPlatform}, search=${isSearch})`)
        dispatch({ type: 'setSessions', payload: result.items })
        setTotalCount(result.total)
        if (result.items.length > 0 && !selectedSessionKey) {
          dispatch({ type: 'setSelectedSessionKey', payload: result.items[0].sessionKey })
        }
        dispatch({ type: 'setEditingBlock', payload: null })
        dispatch({ type: 'setSessionStatus', payload: null })
      } catch (err) {
        console.error('Failed to load sessions:', err)
        dispatch({ type: 'setSessions', payload: [] })
        setTotalCount(0)
        dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
      } finally {
        setLoading(false)
      }
    }
    loadSessions()
  }, [currentPlatform, searchQuery, showArchived])

  useEffect(() => {
    if (!selectedSessionKey || currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings') return
    const loadDetail = async () => {
      try {
        console.time(`[perf] getSessionDetail(${currentPlatform})`)
        const detail = await api.getSessionDetail(currentPlatform, selectedSessionKey)
        console.timeEnd(`[perf] getSessionDetail(${currentPlatform})`)
        dispatch({ type: 'setSessionDetail', payload: detail })
        if (state.showEditLog) {
          api.getEditLog(currentPlatform, selectedSessionKey).then(logs => dispatch({ type: 'setEditLog', payload: logs })).catch(console.error)
        }
        dispatch({
          type: 'updateSession',
          payload: { sessionKey: selectedSessionKey, updates: { displayTitle: detail.aliasTitle || detail.title, aliasTitle: detail.aliasTitle } }
        })
      } catch (err) {
        console.error('Failed to load session detail:', err)
      }
    }
    loadDetail()
  }, [selectedSessionKey, currentPlatform])

  const handleRefresh = async () => {
    setRefreshing(true)
    setRefreshDone(false)
    try {
      const isSearch = searchQuery.trim().length > 0
      const result = await api.getSessions(currentPlatform, searchQuery, isSearch ? undefined : PAGE_SIZE, 0, showArchived)
      dispatch({ type: 'setSessions', payload: result.items })
      setTotalCount(result.total)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.refreshed') } })
      setRefreshDone(true)
      setTimeout(() => setRefreshDone(false), 1500)
    } catch (err) {
      console.error('Failed to refresh:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
    }
    setRefreshing(false)
  }

  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      const result = await api.getSessions(currentPlatform, searchQuery, PAGE_SIZE, sessions.length, showArchived)
      dispatch({ type: 'setSessions', payload: [...sessions, ...result.items] })
      setTotalCount(result.total)
    } catch (err) {
      console.error('Failed to load more:', err)
    }
    setLoadingMore(false)
  }

  const remaining = totalCount - sessions.length
  const displaySessions = favoritesOnly ? sessions.filter(s => s.favorite) : sessions

  if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings') {
    return null
  }

  return (
    <aside className="flex h-full w-[280px] flex-shrink-0 flex-col border-r border-border/50 bg-gradient-to-b from-card to-card/55 backdrop-blur-xl xl:w-[320px]">
      <div className="border-b border-border/50 p-4 md:p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-foreground text-lg truncate">
            {currentPlatform.charAt(0).toUpperCase() + currentPlatform.slice(1)} {showArchived ? t('session.archiveView') : t('session.sessions')}
          </h2>
          <div className="flex items-center gap-1.5">
            <Button
              variant={favoritesOnly ? "secondary" : "ghost"}
              size="icon"
              onClick={() => { setFavoritesOnly(!favoritesOnly) }}
              className={cn(
                "h-8 w-8 transition-all",
                favoritesOnly
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : "text-muted-foreground hover:text-foreground"
              )}
              title={t('session.favorite')}
            >
              <Star className={cn("w-3.5 h-3.5", favoritesOnly && "fill-current")} />
            </Button>
            <Button
              variant={showArchived ? "secondary" : "ghost"}
              size="sm"
              onClick={() => { setFavoritesOnly(false); dispatch({ type: 'setShowArchived', payload: !showArchived }) }}
              className={cn(
                "h-8 gap-1.5 text-xs transition-all",
                showArchived
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Archive className="w-3.5 h-3.5" />
              {showArchived ? t('session.sessionsView') : t('session.archiveView')}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing} className={cn("h-8 w-8 transition-all duration-300", refreshDone && "text-green-400")}>
              {refreshDone ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />}
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={t('session.search')}
            defaultValue={searchQuery}
            onChange={(e) => debouncedSetSearch(e.target.value)}
            className="pl-10 bg-muted/30 border-border/50"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3 md:p-4">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="animate-pulse rounded-2xl border-l-4 border-border/30 p-4 bg-gradient-to-r from-muted/30 to-transparent">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-lg bg-muted/50" />
                  <div className="h-4 bg-muted/50 rounded flex-1 max-w-[60%]" />
                  <div className="h-4 w-8 bg-muted/30 rounded" />
                </div>
                <div className="h-3 bg-muted/30 rounded w-full mt-2" />
                <div className="h-3 bg-muted/20 rounded w-2/3 mt-1.5" />
              </div>
            ))
          ) : displaySessions.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-muted/50 flex items-center justify-center">
                {showArchived ? <Archive className="w-6 h-6 text-muted-foreground/50" /> : <Search className="w-6 h-6 text-muted-foreground/50" />}
              </div>
              <p className="text-sm text-muted-foreground">{showArchived ? t('session.noArchivedSessions') : t('session.noSessions')}</p>
            </div>
          ) : (
            <>
              {displaySessions.map((session) => (
                <SessionCard
                  key={session.sessionKey}
                  session={session}
                  isSelected={selectedSessionKey === session.sessionKey}
                  showArchived={showArchived}
                  onClick={() => {
                    dispatch({ type: 'setSelectedSessionKey', payload: session.sessionKey })
                    dispatch({ type: 'setEditingBlock', payload: null })
                  }}
                  onToggleFavorite={async (e) => {
                    e.stopPropagation()
                    const isNow = await api.toggleFlag(currentPlatform, session.sessionKey, 'favorite')
                    dispatch({ type: 'updateSession', payload: { sessionKey: session.sessionKey, updates: { favorite: isNow } } })
                  }}
                  onToggleArchive={async (e) => {
                    e.stopPropagation()
                    if (!showArchived && !await confirm({ title: t('session.archive'), description: t('session.archiveConfirm') })) return
                    await api.toggleFlag(currentPlatform, session.sessionKey, 'archived')
                    dispatch({ type: 'setSessions', payload: sessions.filter(s => s.sessionKey !== session.sessionKey) })
                    if (selectedSessionKey === session.sessionKey) {
                      dispatch({ type: 'setSelectedSessionKey', payload: null })
                      dispatch({ type: 'setSessionDetail', payload: null })
                    }
                    dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: showArchived ? t('session.unarchive') : t('session.archived') } })
                  }}
                  justNowLabel={t('session.justNow')}
                  untitledLabel={t('session.untitled')}
                  noPreviewLabel={t('session.noPreview')}
                  archiveLabel={showArchived ? t('session.unarchive') : t('session.archive')}
                />
              ))}
              {remaining > 0 && !favoritesOnly && (
                <button
                  type="button"
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                  className="w-full rounded-2xl border border-dashed border-border/60 py-3 text-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {loadingMore ? t('loading') : t('session.loadMore', { count: remaining })}
                </button>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      <ConfirmDialog {...dialogProps} />
    </aside>
  )
}

function SessionCard({ session, isSelected, showArchived, onClick, onToggleFavorite, onToggleArchive, justNowLabel, untitledLabel, noPreviewLabel, archiveLabel }: {
  session: Session
  isSelected: boolean
  showArchived: boolean
  onClick: () => void
  onToggleFavorite: (e: React.MouseEvent) => void
  onToggleArchive: (e: React.MouseEvent) => void
  justNowLabel: string
  untitledLabel: string
  noPreviewLabel: string
  archiveLabel: string
}) {
  const platform = session.platform || 'claude'
  const borderColor = platformBorderColors[platform as keyof typeof platformBorderColors] || platformBorderColors.claude
  const [copied, setCopied] = useState(false)
  const [matchesExpanded, setMatchesExpanded] = useState(false)

  const handleCopyCwd = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!session.cwd) return
    try {
      await navigator.clipboard.writeText(session.cwd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative cursor-pointer rounded-2xl border-l-4 p-4 transition-all duration-200",
        "bg-gradient-to-r from-muted/30 to-transparent",
        isSelected
          ? cn("bg-gradient-to-r from-blue-500/10 to-transparent border-blue-500/50 shadow-lg shadow-blue-500/10", "border-l-blue-500")
          : cn("border-border/50 hover:border-border hover:from-muted/50", borderColor)
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={cn(
            "w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-xs flex-shrink-0 shadow-lg",
            platformColors[platform as keyof typeof platformColors] || platformColors.claude
          )}>
            {platform[0].toUpperCase()}
          </span>
          <h3 className={cn("font-semibold text-sm truncate min-w-0", isSelected ? "text-blue-400" : "text-foreground")}>
            {session.displayTitle || session.sessionId || untitledLabel}
          </h3>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={onToggleFavorite}
            className={cn(
              "p-1 rounded-md transition-colors",
              session.favorite
                ? "text-amber-400 hover:text-amber-300"
                : "text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-amber-400"
            )}
          >
            <Star className={cn("w-3.5 h-3.5", session.favorite && "fill-current")} />
          </button>
          <button
            type="button"
            onClick={onToggleArchive}
            className="p-1 rounded-md text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-foreground transition-colors"
            title={archiveLabel}
          >
            {showArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
          </button>
          <span className="text-[10px] text-muted-foreground/60 bg-muted/30 px-2 py-1 rounded-md ml-1">
            {formatTime(session.updatedAt, justNowLabel)}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed break-all">
        {session.preview || noPreviewLabel}
      </p>
      {session.contentMatches && session.contentMatches.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {(matchesExpanded ? session.contentMatches : session.contentMatches.slice(0, 2)).map((match, i) => (
            <div key={i} className="flex items-start gap-1.5 rounded-lg bg-amber-500/8 border border-amber-500/15 px-2.5 py-1.5">
              {match.role === 'user' ? (
                <User className="size-3 shrink-0 mt-0.5 text-amber-400/70" />
              ) : (
                <Bot className="size-3 shrink-0 mt-0.5 text-amber-400/70" />
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground/80 line-clamp-2 break-all">
                {match.snippet}
              </p>
            </div>
          ))}
          {session.contentMatches.length > 2 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setMatchesExpanded(!matchesExpanded) }}
              className="flex items-center gap-1 pl-1 text-[10px] text-amber-400/60 hover:text-amber-400 transition-colors"
            >
              {matchesExpanded ? (
                <>
                  <ChevronUp className="size-3" />
                </>
              ) : (
                <>
                  <ChevronDown className="size-3" />
                  <MessageSquareText className="size-3" />
                  +{(session.totalContentMatches || session.contentMatches.length) - 2}
                </>
              )}
            </button>
          )}
        </div>
      )}
      {session.updatedAt && (
        <div className="flex items-center gap-1.5 mt-2 text-[10px] text-muted-foreground/50">
          <Clock className="w-3 h-3 flex-shrink-0" />
          <span>{formatDateTime(session.updatedAt)}</span>
        </div>
      )}
      {session.cwd && (
        <button
          type="button"
          onClick={handleCopyCwd}
          className={cn(
            "flex items-center gap-1.5 mt-1.5 max-w-full text-[10px] font-mono rounded-md px-2 py-1 transition-colors",
            copied
              ? "bg-green-500/15 text-green-400"
              : "bg-muted/30 text-muted-foreground/50 hover:bg-muted/50 hover:text-muted-foreground/80"
          )}
        >
          {copied ? <Check className="w-3 h-3 flex-shrink-0" /> : <FolderOpen className="w-3 h-3 flex-shrink-0" />}
          <span className="truncate">{session.cwd}</span>
          {!copied && <Copy className="w-3 h-3 flex-shrink-0 ml-auto opacity-0 group-hover:opacity-60 transition-opacity" />}
        </button>
      )}
    </div>
  )
}
