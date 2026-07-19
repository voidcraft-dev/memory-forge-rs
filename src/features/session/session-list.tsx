import { useEffect, useRef, useCallback, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog, useConfirmDialog } from '@/components/ui/confirm-dialog'
import { useDesktop } from '@/features/desktop/provider'
import { api, isTauriRuntime } from '@/features/desktop/api'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { RefreshCw, Search, CheckCircle, Copy, Check, Clock, FolderOpen, User, Bot, MessageSquareText, Star, Archive, ArchiveRestore, ChevronDown, ChevronUp, ChevronRight, CheckSquare, X, Upload, FileJson, AlertTriangle, Eye } from 'lucide-react'
import type { RawJsonlImportPreview, Session } from '@/features/desktop/types'
import { useSearchParams } from 'react-router'

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
const JSONL_TRANSFER_PLATFORMS = new Set(['claude', 'codex', 'pi'])
const SESSION_CARD_RENDER_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '160px',
}

export function SessionList() {
  const { t, state, dispatch, isRemote, isReadOnlyRemote } = useDesktop()
  const [remoteSearchParams, setRemoteSearchParams] = useSearchParams()
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
  const [importPreview, setImportPreview] = useState<RawJsonlImportPreview | null>(null)
  const [probingImport, setProbingImport] = useState(false)
  const [committingImport, setCommittingImport] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

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
        if (isRemote || state.showEditLog) {
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

  const handleChooseImport = async () => {
    setImportError(null)
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Session JSONL', extensions: ['jsonl'] }],
      })
      if (!selected || Array.isArray(selected)) return
      setProbingImport(true)
      const preview = await api.probeJsonlImport(currentPlatform, selected)
      setImportPreview(preview)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setImportError(message)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message } })
    } finally {
      setProbingImport(false)
    }
  }

  const handleCommitImport = async () => {
    if (!importPreview) return
    setCommittingImport(true)
    setImportError(null)
    try {
      const result = await api.importRawJsonl(currentPlatform, importPreview.sourcePath)
      const refreshed = await api.getSessions(currentPlatform, '', PAGE_SIZE, 0, showArchived)
      dispatch({ type: 'setSessions', payload: refreshed.items })
      setTotalCount(refreshed.total)
      dispatch({ type: 'setSelectedSessionKey', payload: result.sessionKey })
      dispatch({
        type: 'setSessionStatus',
        payload: {
          tone: 'success',
          message: result.alreadyExists ? t('session.importExists') : result.renamed ? t('session.importedRenamed') : t('session.imported'),
        },
      })
      setImportPreview(null)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommittingImport(false)
    }
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
      if (isRemote) {
        const nextSearchParams = new URLSearchParams(remoteSearchParams)
        nextSearchParams.set('session', session.sessionKey)
        setRemoteSearchParams(nextSearchParams)
      }
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

  if (isRemote) {
    const platformName = currentPlatform === 'kiro-ide'
      ? 'Kiro IDE'
      : currentPlatform === 'opencode'
        ? 'OpenCode'
        : currentPlatform.charAt(0).toUpperCase() + currentPlatform.slice(1)

    return (
      <aside className={cn('remote-session-list', selectedSessionKey && 'max-md:hidden')}>
        <div className="remote-session-list-header">
          <div className="remote-session-heading-row">
            <div className="min-w-0">
              <p className="remote-kicker">{showArchived ? t('session.archiveView') : t('remoteRecentSessions')}</p>
              <h1>{platformName}</h1>
              <span>{t('remoteSessionCount', { count: totalCount })}</span>
            </div>
            <div className="remote-list-actions">
              {isReadOnlyRemote && (
                <span className="remote-readonly-mark" title={t('remoteReadOnlyHint')}>
                  <Eye className="size-3.5" />
                </span>
              )}
              <button
                type="button"
                className={cn('remote-icon-button', favoritesOnly && 'remote-icon-button-active')}
                onClick={() => setFavoritesOnly((value) => !value)}
                title={t('session.favorite')}
                aria-label={t('session.favorite')}
                aria-pressed={favoritesOnly}
              >
                <Star className={cn('size-4', favoritesOnly && 'fill-current')} />
              </button>
              <button
                type="button"
                className={cn('remote-icon-button', showArchived && 'remote-icon-button-active')}
                onClick={() => {
                  setFavoritesOnly(false)
                  dispatch({ type: 'setShowArchived', payload: !showArchived })
                }}
                title={showArchived ? t('session.sessionsView') : t('session.archiveView')}
                aria-label={showArchived ? t('session.sessionsView') : t('session.archiveView')}
                aria-pressed={showArchived}
              >
                <Archive className="size-4" />
              </button>
              <button
                type="button"
                className={cn('remote-icon-button', refreshDone && 'remote-icon-button-success')}
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                title={t('session.refresh')}
                aria-label={t('session.refresh')}
              >
                {refreshDone
                  ? <CheckCircle className="size-4" />
                  : <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />}
              </button>
            </div>
          </div>

          <label className="remote-search-field">
            <Search className="size-4" />
            <span className="sr-only">{t('session.search')}</span>
            <input
              type="search"
              placeholder={t('session.search')}
              defaultValue={searchQuery}
              onChange={(event) => debouncedSetSearch(event.target.value)}
            />
          </label>
        </div>

        <div className="remote-session-scroll">
          {loading ? (
            <div className="remote-session-loading" aria-label={t('loading')}>
              {Array.from({ length: 7 }).map((_, index) => (
                <div key={index} className="remote-session-skeleton">
                  <span />
                  <div><i /><i /></div>
                </div>
              ))}
            </div>
          ) : displaySessions.length === 0 ? (
            <div className="remote-empty-state">
              {showArchived ? <Archive className="size-6" /> : <Search className="size-6" />}
              <strong>{showArchived ? t('session.noArchivedSessions') : t('session.noSessions')}</strong>
            </div>
          ) : (
            <div className="remote-session-rows">
              {displaySessions.map((session, index) => (
                <RemoteSessionRow
                  key={session.sessionKey}
                  session={session}
                  selected={selectedSessionKey === session.sessionKey}
                  onClick={(event) => handleCardClick(session, index, event)}
                  justNowLabel={t('session.justNow')}
                  untitledLabel={t('session.untitled')}
                  noPreviewLabel={t('session.noPreview')}
                />
              ))}
              {remaining > 0 && !favoritesOnly && (
                <button
                  type="button"
                  className="remote-load-more"
                  onClick={() => void handleLoadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? <RefreshCw className="size-4 animate-spin" /> : null}
                  {loadingMore ? t('loading') : t('session.loadMore', { count: remaining })}
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    )
  }

  return (
    <aside className={cn(
      "flex h-full w-full min-w-0 flex-shrink-0 flex-col border-border/50 bg-gradient-to-b from-card to-card/55 backdrop-blur-xl md:w-[250px] md:border-r xl:w-[280px]",
      selectedSessionKey && "max-md:hidden",
    )}>
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
            {isTauriRuntime() && JSONL_TRANSFER_PLATFORMS.has(currentPlatform) && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleChooseImport}
                disabled={probingImport}
                className="h-8 w-8 text-muted-foreground transition-all hover:bg-cyan-500/10 hover:text-cyan-400"
                title={t('session.importJsonl')}
              >
                <Upload className={cn('w-3.5 h-3.5', probingImport && 'animate-pulse')} />
              </Button>
            )}
            {!isRemote && <Button
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
            </Button>}
            <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing} className={cn("h-8 w-8 transition-all duration-300", refreshDone && "text-green-400")} title={t('session.refresh')} aria-label={t('session.refresh')}>
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
          {isReadOnlyRemote && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-primary/15 bg-primary/6 px-3 py-2 text-[11px] leading-relaxed text-primary/80">
              <Eye className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('remoteReadOnlyHint')}</span>
            </div>
          )}
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
                  readOnly={isRemote}
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
      <Dialog open={importPreview !== null} onOpenChange={(open) => { if (!open && !committingImport) setImportPreview(null) }}>
        <DialogContent className="max-w-[620px] border-cyan-500/20 bg-card/98">
          <DialogHeader className="border-cyan-500/15 bg-gradient-to-r from-cyan-500/10 via-blue-500/5 to-transparent">
            <DialogTitle className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10 text-cyan-400">
                <FileJson className="size-5" />
              </span>
              <span>
                <span className="block text-base">{t('session.importTitle')}</span>
                <span className="mt-1 block font-mono text-[10px] font-normal uppercase tracking-[0.18em] text-cyan-400/70">{t('session.importSubtitle')}</span>
              </span>
            </DialogTitle>
          </DialogHeader>
          {importPreview && (
            <DialogBody className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-quiet">Platform</p>
                  <p className="mt-1 text-sm font-semibold capitalize text-foreground">{importPreview.platform}</p>
                </div>
                <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-quiet">Session ID</p>
                  <p className="mt-1 truncate font-mono text-xs text-foreground" title={importPreview.sessionId}>{importPreview.sessionId}</p>
                </div>
              </div>
              {(importPreview.title || importPreview.preview) && (
                <div className="rounded-xl border border-border/40 bg-background/40 p-3.5">
                  <p className="text-sm font-semibold text-foreground">{importPreview.title || 'Untitled Session'}</p>
                  {importPreview.preview && <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">{importPreview.preview}</p>}
                </div>
              )}
              <div className="space-y-2 rounded-xl border border-border/40 bg-muted/15 p-3.5 font-mono text-[11px]">
                <div><span className="text-quiet">cwd</span><p className="mt-0.5 break-all text-foreground/80">{importPreview.cwd || '—'}</p></div>
                <div><span className="text-quiet">target</span><p className="mt-0.5 break-all text-cyan-300/80">{importPreview.targetPath}</p></div>
              </div>
              {importPreview.conflict && (
                <div className={cn('flex gap-2.5 rounded-xl border px-3.5 py-3 text-xs', importPreview.conflict === 'same' ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-300' : 'border-amber-500/20 bg-amber-500/8 text-amber-300')}>
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{importPreview.conflict === 'same' ? t('session.importConflictSame') : t('session.importConflictDifferent')}</span>
                </div>
              )}
              {importPreview.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 px-3.5 py-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-amber-400">{t('session.importWarnings')}</p>
                  <ul className="space-y-1.5 text-xs leading-5 text-muted-foreground">
                    {importPreview.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                  </ul>
                </div>
              )}
              {importError && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-3 text-xs text-red-300">{importError}</div>}
            </DialogBody>
          )}
          <DialogFooter className="flex items-center justify-end gap-2 bg-muted/20">
            <Button variant="ghost" onClick={() => setImportPreview(null)} disabled={committingImport}>{t('cancel')}</Button>
            <Button className="gap-2 bg-cyan-600 text-white hover:bg-cyan-500" onClick={handleCommitImport} disabled={committingImport}>
              {committingImport ? <RefreshCw className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {committingImport ? t('session.importing') : t('session.importConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

function RemoteSessionRow({ session, selected, onClick, justNowLabel, untitledLabel, noPreviewLabel }: {
  session: Session
  selected: boolean
  onClick: (event: React.MouseEvent) => void
  justNowLabel: string
  untitledLabel: string
  noPreviewLabel: string
}) {
  const platform = session.platform || 'claude'
  const pathParts = session.cwd?.split(/[\\/]/).filter(Boolean) ?? []
  const shortPath = pathParts.slice(-2).join(' / ')
  const match = session.contentMatches?.[0]

  return (
    <button
      type="button"
      className={cn('remote-session-row', selected && 'remote-session-row-selected')}
      onClick={onClick}
      style={SESSION_CARD_RENDER_STYLE}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="remote-session-avatar" data-platform={platform}>
        {platform === 'kiro-ide' ? 'K' : platform === 'opencode' ? 'O' : platform.charAt(0).toUpperCase()}
      </span>
      <span className="remote-session-copy">
        <span className="remote-session-title-line">
          <strong>{session.displayTitle || session.sessionId || untitledLabel}</strong>
          <time dateTime={session.updatedAt} title={formatDateTime(session.updatedAt)}>
            {formatTime(session.updatedAt, justNowLabel)}
          </time>
        </span>
        <span className="remote-session-preview">{session.preview || noPreviewLabel}</span>
        {match && <span className="remote-session-match"><Search className="size-3" />{match.snippet}</span>}
        <span className="remote-session-meta">
          {session.favorite && <Star className="size-3 fill-current" />}
          {shortPath && <span>{shortPath}</span>}
        </span>
      </span>
      <ChevronRight className="remote-session-chevron size-4" />
    </button>
  )
}

function SessionCard({ session, isSelected, showArchived, selectionMode, isMultiSelected, onClick, onToggleFavorite, onToggleArchive, justNowLabel, untitledLabel, noPreviewLabel, archiveLabel, readOnly }: {
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
  readOnly: boolean
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
          {!session.cwd && !selectionMode && !readOnly && (
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
          
          {!selectionMode && !readOnly && (
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
