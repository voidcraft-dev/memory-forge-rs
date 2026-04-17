import { useState, useEffect, useRef, useCallback, useMemo, forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDesktop } from '@/features/desktop/provider'
import { api } from '@/features/desktop/api'
import type { MessageKey } from '@/features/desktop/i18n'
import { Clock, Pencil, Check, User, Bot, Lightbulb, RefreshCw, Terminal, FileText, CheckCircle, Download, Trash2, Search, ChevronUp, ChevronDown, X, Star, Archive } from 'lucide-react'

const PAGE_SIZE = 50
import { save, ask } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'

export function SessionDetail() {
  const { t, state, dispatch } = useDesktop()
  const currentPlatform = state.currentPlatform
  const sessionDetail = state.sessionDetail
  const sessions = state.sessions
  const roleFilter = state.roleFilter
  const selectedSessionKey = state.selectedSessionKey
  const showEditLog = state.showEditLog
  const sessionStatus = state.sessionStatus
  const globalSearchQuery = state.searchQuery

  const [aliasTitle, setAliasTitle] = useState('')
  const [savingAlias, setSavingAlias] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshDone, setRefreshDone] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const [inlineSearch, setInlineSearch] = useState('')
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0)
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  useEffect(() => {
    setAliasTitle(sessionDetail?.aliasTitle || '')
  }, [sessionDetail?.sessionKey, sessionDetail?.aliasTitle])

  useEffect(() => {
    if (globalSearchQuery.trim()) {
      setInlineSearch(globalSearchQuery.trim())
    } else {
      setInlineSearch('')
    }
  }, [sessionDetail?.sessionKey, globalSearchQuery])

  useEffect(() => {
    if (!sessionStatus) {
      return
    }

    const timer = window.setTimeout(() => {
      dispatch({ type: 'setSessionStatus', payload: null })
    }, 2200)

    return () => window.clearTimeout(timer)
  }, [dispatch, sessionStatus])

  const blocks = sessionDetail?.blocks ?? []
  const filteredBlocks = roleFilter === 'all'
    ? blocks
    : blocks.filter(b => b.role === roleFilter)

  const searchNeedle = inlineSearch.trim().toLowerCase()
  const matchingBlockIds = useMemo(() => {
    if (!searchNeedle) return [] as string[]
    return filteredBlocks
      .filter(b => b.content.toLowerCase().includes(searchNeedle))
      .map(b => b.id)
  }, [filteredBlocks, searchNeedle])

  const scrollToMatch = useCallback((idx: number) => {
    const id = matchingBlockIds[idx]
    if (!id) return
    const el = blockRefs.current.get(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [matchingBlockIds])

  const handleSearchNav = useCallback((dir: 'next' | 'prev') => {
    if (matchingBlockIds.length === 0) return
    const next = dir === 'next'
      ? (currentMatchIdx + 1) % matchingBlockIds.length
      : (currentMatchIdx - 1 + matchingBlockIds.length) % matchingBlockIds.length
    setCurrentMatchIdx(next)
    scrollToMatch(next)
  }, [matchingBlockIds, currentMatchIdx, scrollToMatch])

  useEffect(() => {
    if (matchingBlockIds.length > 0) {
      setCurrentMatchIdx(0)
      scrollToMatch(0)
    }
  }, [matchingBlockIds])

  if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings' || !sessionDetail) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground bg-gradient-to-br from-background to-muted/20">
        <div className="text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center">
            <Clock className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <p className="text-lg font-medium mb-2">{t('session.selectToView')}</p>
          <p className="text-sm">{t('session.selectFromList')}</p>
        </div>
      </div>
    )
  }

  const handleSaveAlias = async () => {
    setSavingAlias(true)
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      await api.setAlias(currentPlatform, sessionDetail.sessionKey, aliasTitle)
      const newTitle = aliasTitle || sessionDetail.sessionId
      dispatch({ type: 'setSessionDetail', payload: { ...sessionDetail, aliasTitle, title: newTitle } })
      dispatch({ type: 'updateSession', payload: { sessionKey: sessionDetail.sessionKey, updates: { displayTitle: newTitle, aliasTitle } } })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.aliasSaved') } })
    } catch (err) {
      console.error('Failed to save alias:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.aliasSaveFailed') } })
    }

    setSavingAlias(false)
  }

  const handleEditBlock = (block: typeof sessionDetail.blocks[0]) => {
    dispatch({ type: 'setShowEditLog', payload: true })
    dispatch({
      type: 'setEditingBlock',
      payload: {
        id: block.editTarget || block.id,
        content: block.content,
        originalContent: block.content,
        role: block.role,
      },
    })
  }

  const handleEraseBlock = async (block: typeof sessionDetail.blocks[0]) => {
    if (!window.confirm(t('session.eraseConfirm'))) return
    try {
      await api.editMessage(currentPlatform, block.editTarget || block.id, '', sessionDetail.sessionKey)
      const updatedBlocks = sessionDetail.blocks.map(b =>
        (b.editTarget || b.id) === (block.editTarget || block.id) ? { ...b, content: '' } : b
      )
      dispatch({ type: 'setSessionDetail', payload: { ...sessionDetail, blocks: updatedBlocks } })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.messageSaved') } })
    } catch (err) {
      console.error('Failed to erase message:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.saveFailed') } })
    }
  }

  const handleRefresh = async () => {
    if (!selectedSessionKey) return

    setRefreshing(true)
    setRefreshDone(false)
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      const [detail, result, logs] = await Promise.all([
        api.getSessionDetail(currentPlatform, selectedSessionKey),
        api.getSessions(currentPlatform, '', PAGE_SIZE, 0),
        showEditLog ? api.getEditLog(currentPlatform, selectedSessionKey) : Promise.resolve(null),
      ])
      dispatch({ type: 'setSessionDetail', payload: detail })
      dispatch({ type: 'setSessions', payload: result.items })
      if (logs) {
        dispatch({ type: 'setEditLog', payload: logs })
      }
      setRefreshDone(true)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.refreshed') } })
      setTimeout(() => setRefreshDone(false), 1500)
    } catch (err) {
      console.error('Failed to refresh:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
    }

    setRefreshing(false)
  }

  const handleCopyCommand = async (label: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedKey(label)
      setTimeout(() => setCopiedKey(null), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleExportMarkdown = async () => {
    if (!sessionDetail) return

    const lines: string[] = []
    lines.push(`# ${sessionDetail.title || sessionDetail.sessionId}`)
    lines.push('')
    lines.push(`- Platform: ${sessionDetail.platform}`)
    lines.push(`- Session ID: ${sessionDetail.sessionId}`)
    if (sessionDetail.cwd) {
      lines.push(`- Working Dir: ${sessionDetail.cwd}`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')

    for (const block of sessionDetail.blocks) {
      const roleLabel = block.role === 'user' ? 'User' : block.role === 'assistant' ? 'Assistant' : 'Thinking'
      lines.push(`## ${roleLabel}`)
      lines.push('')
      lines.push(block.content)
      lines.push('')
      lines.push('---')
      lines.push('')
    }

    const content = lines.join('\n')
    const fileName = `${sessionDetail.title || sessionDetail.sessionId}.md`

    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

    if (isTauri) {
      const filePath = await save({
        defaultPath: fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!filePath) return
      await invoke('write_text_file', { path: filePath, content })
    } else {
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    setExportDone(true)
    dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.exported') } })
    setTimeout(() => setExportDone(false), 2000)
  }

  const detailLoading = selectedSessionKey !== sessionDetail.sessionKey

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-gradient-to-br from-background via-background to-muted/10">
      {detailLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <header className="border-b bg-card/50 px-5 py-4 backdrop-blur-xl md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex items-center gap-3">
            <h2 className="truncate text-xl font-bold text-foreground">
              {sessionDetail.title || sessionDetail.sessionId}
            </h2>
            <button
              type="button"
              onClick={async () => {
                const isNow = await api.toggleFlag(currentPlatform, sessionDetail.sessionKey, 'favorite')
                dispatch({ type: 'updateSession', payload: { sessionKey: sessionDetail.sessionKey, updates: { favorite: isNow } } })
              }}
              className={cn(
                "p-1.5 rounded-lg transition-colors flex-shrink-0",
                sessions.find(s => s.sessionKey === sessionDetail.sessionKey)?.favorite
                  ? "text-amber-400 hover:text-amber-300"
                  : "text-muted-foreground/40 hover:text-amber-400"
              )}
              title={t('session.favorite')}
            >
              <Star className={cn("w-5 h-5", sessions.find(s => s.sessionKey === sessionDetail.sessionKey)?.favorite && "fill-current")} />
            </button>
            {sessionDetail.aliasTitle && (
              <Badge variant="outline" className="text-xs">{sessionDetail.aliasTitle}</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" className={cn("gap-2", refreshDone ? "bg-green-500/10 text-green-400" : "hover:bg-blue-500/10")} onClick={handleRefresh} disabled={refreshing}>
              {refreshDone ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />}
              <span className="hidden sm:inline">{refreshDone ? t('session.refreshed') : t('session.refresh')}</span>
            </Button>
            {['resume', 'fork'].filter(label => sessionDetail.commands?.[label]).map(label => {
              const command = sessionDetail.commands[label]
              return (
                <Button key={label} variant={copiedKey === label ? "secondary" : "ghost"} size="sm"
                  className={cn("gap-1.5 font-mono text-xs", copiedKey === label ? "border border-green-500/30 bg-green-500/20 text-green-400" : "text-muted-foreground hover:bg-blue-500/10 hover:text-foreground")}
                  onClick={() => handleCopyCommand(label, command)}>
                  <Terminal className="w-3.5 h-3.5" />
                  {copiedKey === label ? <><Check className="w-3.5 h-3.5" /> {t('session.copied')}</> : label}
                </Button>
              )
            })}
            <Button variant="ghost" size="sm"
              className={cn("gap-2", exportDone ? "bg-green-500/10 text-green-400" : "hover:bg-blue-500/10")}
              onClick={handleExportMarkdown}>
              {exportDone ? <CheckCircle className="w-4 h-4" /> : <Download className="w-4 h-4" />}
              <span className="hidden sm:inline">{exportDone ? t('session.exported') : t('session.export')}</span>
            </Button>
            <Button variant="ghost" size="sm"
              className="gap-2 hover:bg-amber-500/10 hover:text-amber-400"
              onClick={async () => {
                if (!await ask(t('session.archiveConfirm'), { title: t('session.archive'), kind: 'warning' })) return
                await api.toggleFlag(currentPlatform, sessionDetail.sessionKey, 'archived')
                dispatch({ type: 'setSessions', payload: sessions.filter(s => s.sessionKey !== sessionDetail.sessionKey) })
                dispatch({ type: 'setSelectedSessionKey', payload: null })
                dispatch({ type: 'setSessionDetail', payload: null })
                dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.archived') } })
              }}>
              <Archive className="w-4 h-4" />
              <span className="hidden sm:inline">{t('session.archive')}</span>
            </Button>
            <Button variant={showEditLog ? "secondary" : "ghost"} size="sm"
              className={cn("gap-2", showEditLog && "border border-amber-500/30 bg-amber-500/20 text-amber-400")}
              onClick={() => {
                const next = !showEditLog
                dispatch({ type: 'setShowEditLog', payload: next })
                if (next && selectedSessionKey) {
                  api.getEditLog(currentPlatform, selectedSessionKey)
                    .then(logs => dispatch({ type: 'setEditLog', payload: logs }))
                    .catch(err => {
                      console.error('Failed to load edit log:', err)
                      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
                    })
                }
              }}>
              <FileText className={cn("w-4 h-4", showEditLog && "text-amber-400")} />
              <span className="hidden sm:inline">{t('session.editLog')}</span>
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {sessionStatus && (
            <span
              className={cn(
                'rounded-full px-3 py-1',
                sessionStatus.tone === 'success'
                  ? 'bg-emerald-500/12 text-emerald-500'
                  : 'bg-red-500/12 text-red-400'
              )}
            >
              {sessionStatus.message}
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b bg-card/30 px-5 py-3 md:px-6">
        <span className="text-xs text-muted-foreground font-medium">{t('session.alias')}:</span>
        <Input value={aliasTitle} onChange={(e) => setAliasTitle(e.target.value)}
          className="max-w-md flex-1 bg-background/50" placeholder={t('session.setAlias')}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveAlias()} />
        <Button size="sm" onClick={handleSaveAlias} disabled={savingAlias} className="gap-1">
          {savingAlias ? <Clock className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          {t('session.save')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b bg-card/30 px-5 py-3 md:px-6">
        {(['all', 'user', 'assistant', 'thinking'] as const).map((filter) => {
          const isActive = roleFilter === filter
          const filterConfig = {
            all: { label: t('session.filter.all'), icon: null, gradient: 'from-slate-500/20 to-slate-600/20', textColor: 'text-slate-400', borderColor: 'border-slate-500/30' },
            user: { label: t('session.filter.user'), icon: User, gradient: 'from-blue-500/20 to-blue-600/20', textColor: 'text-blue-400', borderColor: 'border-blue-500/40' },
            assistant: { label: t('session.filter.assistant'), icon: Bot, gradient: 'from-green-500/20 to-green-600/20', textColor: 'text-green-400', borderColor: 'border-green-500/40' },
            thinking: { label: t('session.filter.thinking'), icon: Lightbulb, gradient: 'from-orange-500/20 to-orange-600/20', textColor: 'text-orange-400', borderColor: 'border-orange-500/40' },
          }
          const config = filterConfig[filter]
          const Icon = config.icon
          return (
            <Button key={filter} variant="ghost" size="sm" onClick={() => dispatch({ type: 'setRoleFilter', payload: filter })}
              className={cn("gap-1.5 h-8 px-4 rounded-lg font-medium", isActive ? cn("bg-gradient-to-r shadow-lg", config.gradient, config.textColor, "border", config.borderColor) : "hover:bg-muted/50 text-muted-foreground")}>
              {Icon && <Icon className={cn("w-3.5 h-3.5", isActive && config.textColor)} />}
              <span>{config.label}</span>
              {isActive && <span className={cn("ml-1 text-[10px] px-1.5 py-0.5 rounded bg-background/30", config.textColor)}>{filteredBlocks.length}</span>}
            </Button>
          )
        })}
        <span className="ml-auto text-xs text-muted-foreground/60">
          {t('session.totalMessages', { count: sessionDetail.blocks.length })}
        </span>
      </div>

      {/* Inline search */}
      <div className="flex items-center gap-2 border-b border-border/50 bg-card/30 px-5 py-2 md:px-6">
        <Search className="size-3.5 text-muted-foreground/50 shrink-0" />
        <input
          type="text"
          value={inlineSearch}
          onChange={e => setInlineSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSearchNav(e.shiftKey ? 'prev' : 'next')
            if (e.key === 'Escape') setInlineSearch('')
          }}
          placeholder={t('session.search')}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 outline-none"
        />
        {searchNeedle && (
          <>
            <span className="text-[10px] text-muted-foreground/60 shrink-0">
              {matchingBlockIds.length > 0 ? `${currentMatchIdx + 1}/${matchingBlockIds.length}` : '0/0'}
            </span>
            <button type="button" onClick={() => handleSearchNav('prev')} className="p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors" disabled={matchingBlockIds.length === 0}>
              <ChevronUp className="size-3.5" />
            </button>
            <button type="button" onClick={() => handleSearchNav('next')} className="p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors" disabled={matchingBlockIds.length === 0}>
              <ChevronDown className="size-3.5" />
            </button>
            <button type="button" onClick={() => setInlineSearch('')} className="p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors">
              <X className="size-3.5" />
            </button>
          </>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex w-full flex-col gap-4 p-4 md:p-6">
          {filteredBlocks.map((block, index) => (
            <MessageBlock
              key={block.id}
              block={block}
              index={index}
              onEdit={() => handleEditBlock(block)}
              onErase={() => handleEraseBlock(block)}
              t={t}
              searchHighlight={searchNeedle}
              isSearchMatch={matchingBlockIds.includes(block.id)}
              isCurrentMatch={matchingBlockIds[currentMatchIdx] === block.id}
              ref={(el: HTMLDivElement | null) => {
                if (el) blockRefs.current.set(block.id, el)
                else blockRefs.current.delete(block.id)
              }}
            />
          ))}
        </div>
      </ScrollArea>
    </section>
  )
}

const MessageBlock = forwardRef<HTMLDivElement, {
  block: { role: string; content: string; id: string; editable?: boolean }
  index: number
  onEdit: () => void
  onErase: () => void
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  searchHighlight?: string
  isSearchMatch?: boolean
  isCurrentMatch?: boolean
}>(function MessageBlock({ block, index, onEdit, onErase, t, searchHighlight, isCurrentMatch }, ref) {
  const roleConfig = {
    user: { label: t('session.filter.user'), icon: User, bgGradient: 'from-blue-500/10 to-blue-500/5', borderColor: 'border-l-blue-500', iconBg: 'bg-blue-500/20 text-blue-400', badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    assistant: { label: t('session.filter.assistant'), icon: Bot, bgGradient: 'from-green-500/10 to-green-500/5', borderColor: 'border-l-green-500', iconBg: 'bg-green-500/20 text-green-400', badgeClass: 'bg-green-500/15 text-green-400 border-green-500/30' },
    thinking: { label: t('session.filter.thinking'), icon: Lightbulb, bgGradient: 'from-orange-500/10 to-orange-500/5', borderColor: 'border-l-orange-500', iconBg: 'bg-orange-500/20 text-orange-400', badgeClass: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  }
  const config = roleConfig[block.role as keyof typeof roleConfig] || roleConfig.assistant
  const Icon = config.icon

  const renderContent = () => {
    if (!searchHighlight) return block.content
    const regex = new RegExp(`(${searchHighlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = block.content.split(regex)
    if (parts.length === 1) return block.content
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="bg-amber-400/30 text-foreground rounded-sm px-0.5">{part}</mark>
        : part
    )
  }

  return (
    <div
      ref={ref}
      className={cn(
        "group animate-in fade-in slide-in-from-bottom-2 duration-300",
        `rounded-r-2xl border-l-4 ${config.borderColor}`,
        isCurrentMatch && "ring-2 ring-amber-400/50 rounded-2xl"
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className={cn("ml-0 rounded-2xl rounded-l-none border border-border/50 bg-gradient-to-r p-4", `bg-gradient-to-b ${config.bgGradient}`)}>
        <div className="flex items-start gap-3">
          <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 shadow-lg", config.iconBg)}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-3">
              <Badge variant="outline" className={cn("text-xs", config.badgeClass)}>{config.label}</Badge>
              <span className="text-[10px] text-muted-foreground/50">#{index + 1}</span>
            </div>
            <div className="overflow-hidden rounded-xl p-3 bg-background/50 border border-border/30">
              <pre className="text-sm text-foreground whitespace-pre-wrap break-words font-mono leading-relaxed">{renderContent()}</pre>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 gap-1.5 border-border/60 bg-background/55 text-xs hover:bg-background/80"
              onClick={(e) => { e.stopPropagation(); onEdit() }}
            >
              <Pencil className="w-3 h-3" />{t('session.editThisMessage')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 gap-1.5 border-red-500/30 bg-red-500/5 text-red-400 text-xs hover:bg-red-500/15 hover:text-red-300"
              onClick={(e) => { e.stopPropagation(); onErase() }}
            >
              <Trash2 className="w-3 h-3" />{t('session.erase')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
})
