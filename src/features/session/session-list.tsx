import { useEffect, useRef, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useDesktop } from '@/features/desktop/provider'
import { api } from '@/features/desktop/api'
import { RefreshCw, Search, CheckCircle } from 'lucide-react'
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

const platformColors = {
  claude: 'bg-gradient-to-br from-blue-500 to-indigo-600',
  codex: 'bg-gradient-to-br from-orange-500 to-red-500',
  opencode: 'bg-gradient-to-br from-green-500 to-emerald-600',
}

const platformBorderColors = {
  claude: 'border-l-blue-500',
  codex: 'border-l-orange-500',
  opencode: 'border-l-green-500',
}

export function SessionList() {
  const { t, state, dispatch } = useDesktop()
  const currentPlatform = state.currentPlatform
  const sessions = state.sessions
  const selectedSessionKey = state.selectedSessionKey
  const searchQuery = state.searchQuery
  const [refreshing, setRefreshing] = useState(false)
  const [refreshDone, setRefreshDone] = useState(false)

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
      try {
        const data = await api.getSessions(currentPlatform, searchQuery)
        dispatch({ type: 'setSessions', payload: data })
        if (data.length > 0 && !selectedSessionKey) {
          dispatch({ type: 'setSelectedSessionKey', payload: data[0].sessionKey })
        }
        dispatch({ type: 'setEditingBlock', payload: null })
        dispatch({ type: 'setSessionStatus', payload: null })
      } catch (err) {
        console.error('Failed to load sessions:', err)
        dispatch({ type: 'setSessions', payload: [] })
        dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
      }
    }
    loadSessions()
  }, [currentPlatform, searchQuery])

  useEffect(() => {
    if (!selectedSessionKey || currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings') return
    const loadDetail = async () => {
      try {
        const detail = await api.getSessionDetail(currentPlatform, selectedSessionKey)
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
      const data = await api.getSessions(currentPlatform, searchQuery)
      dispatch({ type: 'setSessions', payload: data })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.refreshed') } })
      setRefreshDone(true)
      setTimeout(() => setRefreshDone(false), 1500)
    } catch (err) {
      console.error('Failed to refresh:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
    }
    setRefreshing(false)
  }

  if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings') {
    return null
  }

  return (
    <aside className="flex h-full w-[320px] flex-shrink-0 flex-col border-r border-border/50 bg-gradient-to-b from-card to-card/55 backdrop-blur-xl xl:w-[360px]">
      <div className="border-b border-border/50 p-4 md:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-foreground text-lg">
            {currentPlatform.charAt(0).toUpperCase() + currentPlatform.slice(1)} {t('session.sessions')}
          </h2>
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing} className={cn("h-8 w-8 transition-all duration-300", refreshDone && "text-green-400")}>
            {refreshDone ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />}
          </Button>
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
          {sessions.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-muted/50 flex items-center justify-center">
                <Search className="w-6 h-6 text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground">{t('session.noSessions')}</p>
            </div>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.sessionKey}
                session={session}
                isSelected={selectedSessionKey === session.sessionKey}
                onClick={() => {
                  dispatch({ type: 'setSelectedSessionKey', payload: session.sessionKey })
                  dispatch({ type: 'setEditingBlock', payload: null })
                }}
                justNowLabel={t('session.justNow')}
                untitledLabel={t('session.untitled')}
                noPreviewLabel={t('session.noPreview')}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}

function SessionCard({ session, isSelected, onClick, justNowLabel, untitledLabel, noPreviewLabel }: {
  session: Session
  isSelected: boolean
  onClick: () => void
  justNowLabel: string
  untitledLabel: string
  noPreviewLabel: string
}) {
  const platform = session.platform || 'claude'
  const borderColor = platformBorderColors[platform as keyof typeof platformBorderColors] || platformBorderColors.claude

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
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={cn(
            "w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-xs flex-shrink-0 shadow-lg",
            platformColors[platform as keyof typeof platformColors] || platformColors.claude
          )}>
            {platform[0].toUpperCase()}
          </span>
          <h3 className={cn("font-semibold text-sm truncate", isSelected ? "text-blue-400" : "text-foreground")}>
            {session.displayTitle || session.sessionId || untitledLabel}
          </h3>
        </div>
        <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 bg-muted/30 px-2 py-1 rounded-md">
          {formatTime(session.updatedAt, justNowLabel)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground/70 line-clamp-2 leading-relaxed">
        {session.preview || noPreviewLabel}
      </p>
      {session.cwd && (
        <p className="text-[10px] text-muted-foreground/50 mt-2 truncate font-mono">{session.cwd}</p>
      )}
    </div>
  )
}
