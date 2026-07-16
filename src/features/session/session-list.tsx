import { useEffect, useRef, useCallback, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, useConfirmDialog } from '@/components/ui/confirm-dialog'
import { useDesktop } from '@/features/desktop/provider'
import { api } from '@/features/desktop/api'
import { RefreshCw, Search, CheckCircle, Copy, Check, Clock, FolderOpen, User, Bot, MessageSquareText, Star, Archive, ArchiveRestore, ChevronDown, ChevronUp, CheckSquare, X } from 'lucide-react'
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
  'kiro-ide': 'bg-gradient-to-br from-fuchsia-500 to-purple-600',
  cursor: 'bg-gradient-to-br from-sky-400 to-blue-600',
  gemini: 'bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600',
  grok: 'bg-gradient-to-br from-zinc-700 via-zinc-500 to-orange-500',
  pi: 'bg-gradient-to-br from-rose-500 via-pink-500 to-cyan-500',
}



const PAGE_SIZE = 50
const SESSION_CARD_RENDER_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '160px',
}

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
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null)
  const [batchOperating, setBatchOperating] = useState(false)

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

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedKeys(new Set())
    setLastClickedIndex(null)
  }, [])

  useEffect(() => {
    exitSelectionMode()
  }, [currentPlatform, showArchived, exitSelectionMode])

  useEffect(() => {
    if (!selectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitSelectionMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectionMode, exitSelectionMode])

  const remaining = totalCount - sessions.length
  const displaySessions = favoritesOnly ? sessions.filter(s => s.favorite) : sessions

  const handleSelectAll = () => {
    setSelectedKeys(new Set(displaySessions.map(s => s.sessionKey)))
    setLastClickedIndex(null)
  }

  const handleInvertSelection = () => {
    const next = new Set<string>()
    for (const s of displaySessions) {
      if (!selectedKeys.has(s.sessionKey)) next.add(s.sessionKey)
    }
    setSelectedKeys(next)
    setLastClickedIndex(null)
  }

  const handleCardClick = (session: Session, index: number, e: React.MouseEvent) => {
    if (!selectionMode) {
      dispatch({ type: 'setSelectedSessionKey', payload: session.sessionKey })
      dispatch({ type: 'setEditingBlock', payload: null })
      return
    }
    const next = new Set(selectedKeys)
    if (e.shiftKey && lastClickedIndex !== null) {
      const start = Math.min(lastClickedIndex, index)
      const end = Math.max(lastClickedIndex, index)
      const targetState = !next.has(session.sessionKey)
      for (let i = start; i <= end; i++) {
        const sk = displaySessions[i]?.sessionKey
        if (!sk) continue
        if (targetState) next.add(sk)
        else next.delete(sk)
      }
    } else if (next.has(session.sessionKey)) {
      next.delete(session.sessionKey)
    } else {
      next.add(session.sessionKey)
    }
    setSelectedKeys(next)
    setLastClickedIndex(index)
  }

  const handleBatchAction = async (flag: 'archived' | 'favorite', set: boolean) => {
    if (selectedKeys.size === 0) {
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.noSelection') } })
      return
    }
    setBatchOperating(true)
    const keys = Array.from(selectedKeys)
    try {
      const affected = await api.batchSetFlag(currentPlatform, keys, flag, set)
      if (flag === 'archived') {
        dispatch({ type: 'setSessions', payload: sessions.filter(s => !selectedKeys.has(s.sessionKey)) })
        setTotalCount(c => Math.max(0, c - keys.length))
        if (selectedSessionKey && selectedKeys.has(selectedSessionKey)) {
          dispatch({ type: 'setSelectedSessionKey', payload: null })
          dispatch({ type: 'setSessionDetail', payload: null })
        }
      } else {
        for (const key of keys) {
          dispatch({ type: 'updateSession', payload: { sessionKey: key, updates: { favorite: set } } })
        }
      }
      const messageKey = flag === 'archived'
        ? (set ? 'session.batchArchived' : 'session.batchUnarchived')
        : (set ? 'session.batchFavorited' : 'session.batchUnfavorited')
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t(messageKey, { count: affected }) } })
      exitSelectionMode()
    } catch (err) {
      console.error('Batch operation failed:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.batchFailed') } })
    } finally {
      setBatchOperating(false)
    }
  }

  if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings') {
    return null
  }

  return (
    <aside className="flex h-full w-[250px] flex-shrink-0 flex-col border-r border-border/50 bg-gradient-to-b from-card to-card/55 backdrop-blur-xl xl:w-[280px]">
      <div className="border-b border-border/50 p-4 md:p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-foreground text-lg truncate flex-1 min-w-0 pr-1">
            {(() => {
              if (currentPlatform === 'kiro-ide') return 'Kiro IDE'
              if (currentPlatform === 'opencode') return 'OpenCode'
              if (currentPlatform === 'pi') return 'Pi'
              if (currentPlatform === 'grok') return 'Grok Build'
              return currentPlatform.charAt(0).toUpperCase() + currentPlatform.slice(1)
            })()} {showArchived ? t('session.archiveView') : t('session.sessions')}
          </h2>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button
              variant={selectionMode ? "secondary" : "ghost"}
              size="icon"
              onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
              className={cn(
                "h-8 w-8 transition-all",
                selectionMode
                  ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                  : "text-muted-foreground hover:text-foreground"
              )}
              title={selectionMode ? t('session.exitSelect') : t('session.selectMode')}
            >
              <CheckSquare className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing} className={cn("h-8 w-8 transition-all duration-300", refreshDone && "text-green-400")}>
              {refreshDone ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />}
            </Button>
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
              size="icon"
              onClick={() => { setFavoritesOnly(false); dispatch({ type: 'setShowArchived', payload: !showArchived }) }}
              className={cn(
                "h-8 w-8 transition-all",
                showArchived
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : "text-muted-foreground hover:text-foreground"
              )}
              title={showArchived ? t('session.sessionsView') : t('session.archiveView')}
            >
              <Archive className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
          <Input
            placeholder={t('session.search')}
            defaultValue={searchQuery}
            onChange={(e) => debouncedSetSearch(e.target.value)}
            className="pl-10 bg-muted/20 border-border/40 hover:border-border/80 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:border-primary/40 rounded-xl transition-all"
          />
        </div>
      </div>
      {selectionMode && (
        <div className="border-b border-primary/20 bg-gradient-to-r from-primary/10 to-primary/3 px-4 py-2.5 animate-in slide-in-from-top duration-300 backdrop-blur-md">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-bold text-primary mr-1">
              {t('session.selectedCount', { count: selectedKeys.size })}
            </span>
            <Button size="sm" variant="ghost" onClick={handleSelectAll} className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground rounded-lg">
              {t('session.selectAll')}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleInvertSelection} className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground rounded-lg">
              {t('session.invertSelection')}
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={exitSelectionMode}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground rounded-lg"
              title={t('session.exitSelect')}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={batchOperating || selectedKeys.size === 0}
              onClick={() => handleBatchAction('archived', !showArchived)}
              className="h-8 gap-1.5 px-3 text-xs flex-1 rounded-xl shadow-sm hover:shadow"
            >
              {showArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              {showArchived ? t('session.batchUnarchive') : t('session.batchArchive')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={batchOperating || selectedKeys.size === 0}
              onClick={() => handleBatchAction('favorite', true)}
              className="h-8 gap-1.5 px-3 text-xs flex-1 rounded-xl shadow-sm hover:shadow"
            >
              <Star className="w-3.5 h-3.5" />
              {t('session.batchFavorite')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={batchOperating || selectedKeys.size === 0}
              onClick={() => handleBatchAction('favorite', false)}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-amber-400 hover:bg-amber-400/10 rounded-xl transition-all"
              title={t('session.batchUnfavorite')}
            >
              <Star className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
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
              {displaySessions.map((session, index) => (
                <SessionCard
                  key={session.sessionKey}
                  session={session}
                  isSelected={selectedSessionKey === session.sessionKey}
                  showArchived={showArchived}
                  selectionMode={selectionMode}
                  isMultiSelected={selectedKeys.has(session.sessionKey)}
                  onClick={(e) => handleCardClick(session, index, e)}
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
              {remaining > 0 && !favoritesOnly && !selectionMode && (
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

function SessionCard({ session, isSelected, showArchived, selectionMode, isMultiSelected, onClick, onToggleFavorite, onToggleArchive, justNowLabel, untitledLabel, noPreviewLabel, archiveLabel }: {
  session: Session
  isSelected: boolean
  showArchived: boolean
  selectionMode: boolean
  isMultiSelected: boolean
  onClick: (e: React.MouseEvent) => void
  onToggleFavorite: (e: React.MouseEvent) => void
  onToggleArchive: (e: React.MouseEvent) => void
  justNowLabel: string
  untitledLabel: string
  noPreviewLabel: string
  archiveLabel: string
}) {
  const platform = session.platform || 'claude'
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

  const highlightAsSelection = selectionMode ? isMultiSelected : isSelected

  return (
    <div
      onClick={onClick}
      style={SESSION_CARD_RENDER_STYLE}
      className={cn(
        "group relative cursor-pointer rounded-2xl border transition-all duration-300 select-none overflow-hidden p-4",
        highlightAsSelection
          ? "bg-gradient-to-br from-primary/8 via-primary/2 to-card border-primary/30 shadow-md shadow-primary/5 pl-[18px] backdrop-blur-md"
          : "border-border/30 bg-card/45 hover:border-border/60 hover:bg-card/85 pl-[18px]"
      )}
    >
      {/* Accent Gradient Capsule Bar */}
      <div
        className={cn(
          "absolute left-0 top-3 bottom-3 w-[4.5px] rounded-r-full transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
          highlightAsSelection
            ? "bg-gradient-to-b from-primary to-indigo-500 shadow-[0_0_10px_color-mix(in srgb,var(--primary)_70%,transparent)] h-[calc(100%-24px)] scale-y-110"
            : cn(
                "h-5 opacity-40 group-hover:opacity-100 group-hover:h-[calc(100%-24px)]",
                platform === 'claude' && "bg-gradient-to-b from-violet-400 to-indigo-500",
                platform === 'codex' && "bg-gradient-to-b from-orange-400 to-red-500",
                platform === 'opencode' && "bg-gradient-to-b from-green-400 to-emerald-500",
                platform === 'kiro' && "bg-gradient-to-b from-purple-400 to-violet-500",
                platform === 'kiro-ide' && "bg-gradient-to-b from-fuchsia-400 to-purple-500",
                platform === 'gemini' && "bg-gradient-to-b from-blue-400 to-indigo-500",
                platform === 'grok' && "bg-gradient-to-b from-zinc-300 to-orange-500",
                platform === 'cursor' && "bg-gradient-to-b from-sky-400 to-blue-500",
                platform === 'pi' && "bg-gradient-to-b from-rose-400 to-cyan-500"
              )
        )}
      />

      {selectionMode && (
        <div className="absolute top-3 right-3 z-10">
          <div className={cn(
            "w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all duration-200",
            isMultiSelected
              ? "bg-blue-500 border-blue-500 shadow-sm shadow-blue-500/50"
              : "bg-background/60 border-muted-foreground/40 group-hover:border-blue-400"
          )}>
            {isMultiSelected && <Check className="w-3 h-3 text-white stroke-[3]" />}
          </div>
        </div>
      )}
      <div className={cn("flex items-center justify-between gap-2 mb-2 min-w-0", selectionMode && "pr-8")}>
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className={cn(
            "w-7 h-7 rounded-xl flex items-center justify-center text-white font-black text-xs flex-shrink-0 shadow-lg shadow-black/10 border border-white/10 select-none",
            platformColors[platform as keyof typeof platformColors] || platformColors.claude
          )}>
            {platform === 'kiro-ide' ? 'K' : platform === 'opencode' ? 'O' : platform === 'pi' ? 'P' : platform === 'grok' ? 'G' : platform[0].toUpperCase()}
          </span>
          <h3 className={cn("font-bold text-sm truncate min-w-0 transition-colors duration-200 flex-1", highlightAsSelection ? "text-primary" : "text-foreground group-hover:text-foreground")}>
            {session.displayTitle || session.sessionId || untitledLabel}
          </h3>
        </div>
        {!selectionMode && (
          <div className="flex items-center gap-1.5 flex-shrink-0 h-6">
            {session.favorite && (
              <Star className="w-3.5 h-3.5 text-amber-400 fill-current flex-shrink-0 animate-in zoom-in-50 duration-200" />
            )}
            <span className="text-[10px] text-muted-foreground/60 bg-muted/40 border border-border/30 px-2 py-0.5 rounded-lg select-none flex-shrink-0">
              {formatTime(session.updatedAt, justNowLabel)}
            </span>
          </div>
        )}
        {selectionMode && session.favorite && (
          <Star className="w-3.5 h-3.5 text-amber-400 fill-current flex-shrink-0 mr-7" />
        )}
      </div>
      <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed break-all">
        {session.preview || noPreviewLabel}
      </p>
      {session.contentMatches && session.contentMatches.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {(matchesExpanded ? session.contentMatches : session.contentMatches.slice(0, 2)).map((match, i) => (
            <div key={i} className="flex items-start gap-1.5 rounded-lg bg-amber-500/5 border border-amber-500/12 px-2.5 py-1.5">
              {match.role === 'user' ? (
                <User className="size-3 shrink-0 mt-0.5 text-amber-400/60" />
              ) : (
                <Bot className="size-3 shrink-0 mt-0.5 text-amber-400/60" />
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground/80 line-clamp-2 break-all font-mono">
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
        <div className="flex items-center justify-between gap-1.5 mt-2.5 text-[10px] text-muted-foreground/55">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/40" />
            <span>{formatDateTime(session.updatedAt)}</span>
          </div>
          {!session.cwd && !selectionMode && (
            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <button
                type="button"
                onClick={onToggleFavorite}
                className={cn(
                  "p-1 rounded-md transition-colors",
                  session.favorite
                    ? "text-amber-400 hover:text-amber-300"
                    : "text-muted-foreground/40 hover:text-amber-400"
                )}
              >
                <Star className={cn("w-3.5 h-3.5", session.favorite && "fill-current")} />
              </button>
              <button
                type="button"
                onClick={onToggleArchive}
                className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground transition-colors"
                title={archiveLabel}
              >
                {showArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
        </div>
      )}
      {session.cwd && (
        <div className="flex items-center gap-2 mt-2 max-w-full">
          <button
            type="button"
            onClick={handleCopyCwd}
            className={cn(
              "flex items-center gap-1.5 text-[10px] font-mono rounded-lg px-2.5 py-1 border transition-all duration-200 min-w-0 flex-1",
              copied
                ? "bg-green-500/10 text-green-400 border-green-500/20"
                : "bg-muted/30 text-muted-foreground/50 border-border/30 hover:bg-primary/10 hover:text-primary hover:border-primary/20"
            )}
          >
            {copied ? <Check className="w-3 h-3 flex-shrink-0" /> : <FolderOpen className="w-3 h-3 flex-shrink-0" />}
            <span className="truncate">{session.cwd}</span>
            {!copied && <Copy className="w-3 h-3 flex-shrink-0 ml-auto opacity-0 group-hover:opacity-80 transition-opacity" />}
          </button>
          
          {!selectionMode && (
            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <button
                type="button"
                onClick={onToggleFavorite}
                className={cn(
                  "p-1 rounded-md transition-colors",
                  session.favorite
                    ? "text-amber-400 hover:text-amber-300"
                    : "text-muted-foreground/45 hover:text-amber-400"
                )}
              >
                <Star className={cn("w-3.5 h-3.5", session.favorite && "fill-current")} />
              </button>
              <button
                type="button"
                onClick={onToggleArchive}
                className="p-1 rounded-md text-muted-foreground/45 hover:text-foreground transition-colors"
                title={archiveLabel}
              >
                {showArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
