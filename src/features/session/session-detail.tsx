import { useState, useEffect, useRef, useCallback, useMemo, forwardRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDesktop } from '@/features/desktop/provider'
import { api, isSessionRevisionConflict } from '@/features/desktop/api'
import type { MessageKey } from '@/features/desktop/i18n'
import type { EditorTarget, TimelineBlock } from '@/features/desktop/types'
import { Clock, Pencil, Check, Copy, User, Bot, Lightbulb, RefreshCw, Terminal, FileText, CheckCircle, Download, Trash2, Search, ChevronUp, ChevronDown, X, Star, Archive, List, Play, FolderOpen, MousePointer2, Code, Sparkles, ArrowLeft, Eye } from 'lucide-react'
import { ConfirmDialog, useConfirmDialog } from '@/components/ui/confirm-dialog'
import { save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useTerminal } from '@/features/terminal/terminal-context'
import { useNavigate } from 'react-router'

const PAGE_SIZE = 50
const TOOL_INPUT_EXPORT_LIMIT = 8192
const TOOL_OUTPUT_EXPORT_LIMIT = 32768
const PREFERRED_EDITOR_STORAGE_KEY = 'memory-forge.preferred-editor'
const LONG_BLOCK_COLLAPSE_THRESHOLD = 3000
const LONG_BLOCK_PREVIEW_CHARS = 1500

function estimateMessageBlockSize(block?: TimelineBlock) {
  if (!block) return 180
  const contentChars = block.content.length
  const visibleChars = Math.min(contentChars, LONG_BLOCK_PREVIEW_CHARS)
  const textRows = Math.ceil(visibleChars / 90)
  const codeFenceCount = (block.content.slice(0, LONG_BLOCK_PREVIEW_CHARS).match(/```/g) ?? []).length
  const toolRows = (block.toolCalls?.length ?? 0) * 48
  const base = block.role === 'thinking' ? 150 : 190
  return Math.min(760, base + textRows * 22 + codeFenceCount * 28 + toolRows)
}

function truncateExportText(value: string, maxChars: number) {
  const chars = Array.from(value)
  if (chars.length <= maxChars) return value
  return `${chars.slice(0, maxChars).join('')}\n\n[truncated: showing first ${maxChars} chars of ${chars.length}]`
}

function markdownFence(value: string) {
  const runs = value.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

function safeExportFileName(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'session'
}

function pushMarkdownCodeBlock(lines: string[], label: string, language: string, value: string, maxChars: number) {
  const text = truncateExportText(value, maxChars)
  const fence = markdownFence(text)
  lines.push(`${label}:`)
  lines.push(`${fence}${language}`)
  lines.push(text)
  lines.push(fence)
  lines.push('')
}

const getEditorIcon = (id: string) => {
  const lower = id.toLowerCase()
  if (lower.includes('cursor')) return MousePointer2
  if (lower.includes('code') || lower.includes('vscode')) return Code
  if (lower.includes('zed')) return Sparkles
  return FolderOpen
}

export function SessionDetail() {
  const navigate = useNavigate()
  const { t, state, dispatch, isRemote, isReadOnlyRemote, remoteCapabilities } = useDesktop()
  const currentPlatform = state.currentPlatform
  const sessionDetail = state.sessionDetail
  const sessions = state.sessions
  const roleFilter = state.roleFilter
  const selectedSessionKey = state.selectedSessionKey
  const showEditLog = state.showEditLog
  const sessionStatus = state.sessionStatus
  const globalSearchQuery = state.searchQuery

  const { startTerminal } = useTerminal()

  const [aliasTitle, setAliasTitle] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshDone, setRefreshDone] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const [exportingRawJsonl, setExportingRawJsonl] = useState(false)
  const [inlineSearch, setInlineSearch] = useState('')
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0)
  const [tocOpen, setTocOpen] = useState(false)
  const [loadingExecutionTargets, setLoadingExecutionTargets] = useState<Set<string>>(new Set())
  const [loadingAllExecutionOutputs, setLoadingAllExecutionOutputs] = useState(false)
  const [includeToolCallsInExport, setIncludeToolCallsInExport] = useState(false)
  const [exportRange, setExportRange] = useState<'all' | 'recent20' | 'recent50' | 'recent100' | 'since'>('all')
  const [exportSinceDate, setExportSinceDate] = useState('')
  const [editorTargets, setEditorTargets] = useState<EditorTarget[]>([])
  const [preferredEditorId, setPreferredEditorId] = useState<string | null>(null)
  const [editorMenuOpen, setEditorMenuOpen] = useState(false)
  const [openingEditorId, setOpeningEditorId] = useState<string | null>(null)

  // New visual states for dropdowns and inline alias editing
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [isEditingAlias, setIsEditingAlias] = useState(false)
  const [tempAlias, setTempAlias] = useState('')

  const messageScrollRef = useRef<HTMLDivElement>(null)
  const activeSessionKeyRef = useRef<string | null>(null)
  const editorMenuRef = useRef<HTMLDivElement>(null)
  const terminalMenuRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  const { confirm, dialogProps: confirmDialogProps } = useConfirmDialog()

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (terminalMenuRef.current && !terminalMenuRef.current.contains(event.target as Node)) {
        setTerminalMenuOpen(false)
      }
      if (editorMenuRef.current && !editorMenuRef.current.contains(event.target as Node)) {
        setEditorMenuOpen(false)
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  useEffect(() => {
    activeSessionKeyRef.current = selectedSessionKey
  }, [selectedSessionKey])

  useEffect(() => {
    setOpeningKey(null)
    setOpeningEditorId(null)
    setCopiedKey(null)
    setTerminalMenuOpen(false)
    setEditorMenuOpen(false)
    setExportMenuOpen(false)
  }, [selectedSessionKey])

  useEffect(() => {
    let cancelled = false
    api.listEditorTargets()
      .then(targets => {
        if (!cancelled) setEditorTargets(targets)
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Failed to list editor targets:', err)
          setEditorTargets([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    setPreferredEditorId(window.localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY))
  }, [])

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
  const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const preferredEditor = useMemo(() => {
    if (editorTargets.length === 0) return null
    const stored = preferredEditorId
      ? editorTargets.find(target => target.id === preferredEditorId)
      : null
    return stored ?? editorTargets[0]
  }, [editorTargets, preferredEditorId])
  const PreferredIcon = preferredEditor ? getEditorIcon(preferredEditor.id) : FolderOpen
  const canOpenWorkspace = Boolean(sessionDetail?.cwd?.trim() && preferredEditor)
  const hasExportableToolCalls = blocks.some(block => (block.toolCalls?.length ?? 0) > 0)
  const canExportRawJsonl = isTauriRuntime && ['claude', 'codex', 'pi'].includes(currentPlatform)
  const kiroExecutionPlaceholderBlocks = useMemo(() => {
    if (currentPlatform !== 'kiro-ide') return []
    return blocks.filter(block =>
      block.role === 'assistant'
      && block.content.trim() === 'On it.'
      && block.editTarget?.includes('::execution::')
    )
  }, [blocks, currentPlatform])
  const filteredBlocks = roleFilter === 'all'
    ? blocks
    : blocks.filter(b => b.role === roleFilter)
  const blockIndexById = useMemo(() => {
    const index = new Map<string, number>()
    filteredBlocks.forEach((block, idx) => index.set(block.id, idx))
    return index
  }, [filteredBlocks])
  const estimateVirtualItemSize = useCallback((index: number) => {
    return estimateMessageBlockSize(filteredBlocks[index])
  }, [filteredBlocks])
  const getVirtualItemKey = useCallback((index: number) => {
    return filteredBlocks[index]?.id ?? index
  }, [filteredBlocks])
  const messageVirtualizer = useVirtualizer({
    count: filteredBlocks.length,
    getScrollElement: () => messageScrollRef.current,
    estimateSize: estimateVirtualItemSize,
    getItemKey: getVirtualItemKey,
    overscan: 8,
    gap: 16,
    paddingStart: 16,
    paddingEnd: 24,
  })
  const virtualItems = messageVirtualizer.getVirtualItems()

  const searchNeedle = inlineSearch.trim().toLowerCase()
  const matchingBlockIds = useMemo(() => {
    if (!searchNeedle) return [] as string[]
    return filteredBlocks
      .filter(b => b.content.toLowerCase().includes(searchNeedle))
      .map(b => b.id)
  }, [filteredBlocks, searchNeedle])

  const scrollToBlockIndex = useCallback((index: number) => {
    if (index < 0 || index >= filteredBlocks.length) return
    messageVirtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
  }, [filteredBlocks.length, messageVirtualizer])

  const scrollToMatch = useCallback((idx: number) => {
    const id = matchingBlockIds[idx]
    if (!id) return
    const blockIndex = blockIndexById.get(id)
    if (blockIndex === undefined) return
    scrollToBlockIndex(blockIndex)
  }, [matchingBlockIds, blockIndexById, scrollToBlockIndex])

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

  useEffect(() => {
    messageScrollRef.current?.scrollTo({ top: 0 })
  }, [sessionDetail?.sessionKey, roleFilter])

  if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings' || !sessionDetail) {
    return (
      <div className="max-md:hidden flex-1 items-center justify-center text-muted-foreground bg-gradient-to-br from-background to-muted/20 md:flex">
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

  const handleSaveAlias = async (newVal?: string) => {
    if (isRemote) return
    const valueToSave = typeof newVal === 'string' ? newVal : aliasTitle
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      await api.setAlias(currentPlatform, sessionDetail.sessionKey, valueToSave)
      const newTitle = valueToSave || sessionDetail.sessionId
      dispatch({ type: 'setSessionDetail', payload: { ...sessionDetail, aliasTitle: valueToSave, title: newTitle } })
      dispatch({ type: 'updateSession', payload: { sessionKey: sessionDetail.sessionKey, updates: { displayTitle: newTitle, aliasTitle: valueToSave } } })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.aliasSaved') } })
      setAliasTitle(valueToSave)
    } catch (err) {
      console.error('Failed to save alias:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.aliasSaveFailed') } })
    }
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
        revision: sessionDetail.revision,
      },
    })
  }

  const handleEraseBlock = async (block: typeof sessionDetail.blocks[0]) => {
    const sessionKey = sessionDetail.sessionKey
    const expectedRevision = sessionDetail.revision
    if (!await confirm({ title: t('session.erase'), description: t('session.eraseConfirm'), variant: 'danger' })) return
    try {
      await api.editMessage(currentPlatform, block.editTarget || block.id, '', sessionKey, expectedRevision)
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(currentPlatform, sessionKey),
        api.getEditLog(currentPlatform, sessionKey),
      ])
      dispatch({ type: 'setSessionDetail', payload: updated })
      dispatch({ type: 'setEditLog', payload: logs })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.messageSaved') } })
    } catch (err) {
      console.error('Failed to erase message:', err)
      const conflict = isSessionRevisionConflict(err)
      if (conflict) {
        try {
          const [updated, logs] = await Promise.all([
            api.getSessionDetail(currentPlatform, sessionKey),
            api.getEditLog(currentPlatform, sessionKey),
          ])
          dispatch({ type: 'setSessionDetail', payload: updated })
          dispatch({ type: 'setEditLog', payload: logs })
        } catch (refreshError) {
          console.error('Failed to refresh after revision conflict:', refreshError)
        }
      }
      dispatch({
        type: 'setSessionStatus',
        payload: { tone: 'error', message: conflict ? t('session.revisionConflict') : t('session.saveFailed') },
      })
    }
  }

  const handleLoadExecutionOutput = async (block: typeof sessionDetail.blocks[0]) => {
    if (!sessionDetail || !block.editTarget) return

    const target = block.editTarget
    setLoadingExecutionTargets(prev => new Set(prev).add(target))
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      const output = await api.getExecutionOutput(currentPlatform, sessionDetail.sessionKey, target)
      if (activeSessionKeyRef.current !== sessionDetail.sessionKey) return
      const updatedBlocks = sessionDetail.blocks.map(b =>
        (b.editTarget || b.id) === target ? { ...b, content: output } : b
      )
      dispatch({ type: 'setSessionDetail', payload: { ...sessionDetail, blocks: updatedBlocks } })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.refreshed') } })
    } catch (err) {
      console.error('Failed to load execution output:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.refreshFailed') } })
    } finally {
      setLoadingExecutionTargets(prev => {
        const next = new Set(prev)
        next.delete(target)
        return next
      })
    }
  }

  const handleLoadAllExecutionOutputs = async () => {
    if (!sessionDetail || kiroExecutionPlaceholderBlocks.length === 0) return

    const targets = kiroExecutionPlaceholderBlocks
      .map(block => block.editTarget)
      .filter((target): target is string => Boolean(target))
    if (targets.length === 0) return

    setLoadingAllExecutionOutputs(true)
    setLoadingExecutionTargets(new Set(targets))
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      const outputs = await api.getExecutionOutputs(currentPlatform, sessionDetail.sessionKey, targets)
      if (activeSessionKeyRef.current !== sessionDetail.sessionKey) return
      const updatedBlocks = sessionDetail.blocks.map(block => {
        const target = block.editTarget || block.id
        const output = outputs[target]
        return output ? { ...block, content: output } : block
      })
      dispatch({ type: 'setSessionDetail', payload: { ...sessionDetail, blocks: updatedBlocks } })
      dispatch({
        type: 'setSessionStatus',
        payload: { tone: 'success', message: `已加载 ${Object.keys(outputs).length}/${targets.length} 条真实输出` },
      })
    } catch (err) {
      console.error('Failed to load all execution outputs:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: '加载真实输出失败' } })
    } finally {
      setLoadingAllExecutionOutputs(false)
      setLoadingExecutionTargets(new Set())
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
    const operationSessionKey = sessionDetail.sessionKey
    const operationKey = `${operationSessionKey}::${label}`
    try {
      await navigator.clipboard.writeText(command)
      if (activeSessionKeyRef.current === operationSessionKey) {
        setCopiedKey(operationKey)
        setTimeout(() => setCopiedKey((current) => current === operationKey ? null : current), 2000)
      }
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleOpenCommand = async (label: string, command: string) => {
    const operationSessionKey = sessionDetail.sessionKey
    const operationKey = `${operationSessionKey}::${label}`
    setOpeningKey(operationKey)
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      await api.launchSessionTerminal(command, sessionDetail.cwd || null)
      if (activeSessionKeyRef.current === operationSessionKey) {
        dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.terminalOpened') } })
      }
    } catch (err) {
      console.error('Failed to launch terminal:', err)
      await handleCopyCommand(label, command)
      if (activeSessionKeyRef.current === operationSessionKey) {
        dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: t('session.terminalOpenFailed') } })
      }
    } finally {
      setOpeningKey((current) => current === operationKey ? null : current)
    }
  }

  const handleStartEmbeddedTerminal = async (
    commandKind: 'resume' | 'fork',
    command: string,
  ) => {
    const terminalId = await startTerminal(
      sessionDetail.sessionKey,
      commandKind,
      command,
      sessionDetail.cwd || null,
      {
        platform: currentPlatform,
        sessionTitle: sessionDetail.aliasTitle || sessionDetail.title || sessionDetail.sessionId,
      },
    )
    if (!terminalId) {
      dispatch({
        type: 'setSessionStatus',
        payload: { tone: 'error', message: t('terminal.tabs.maxWarning') },
      })
      return
    }
    navigate('/terminal-sessions')
  }

  const handleOpenWorkspace = async (target: EditorTarget | null) => {
    if (!target || !sessionDetail.cwd) return

    const operationSessionKey = sessionDetail.sessionKey
    const operationKey = `${operationSessionKey}::${target.id}`
    setOpeningEditorId(operationKey)
    setEditorMenuOpen(false)
    setPreferredEditorId(target.id)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PREFERRED_EDITOR_STORAGE_KEY, target.id)
    }
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      await api.openPathInEditor(target.id, sessionDetail.cwd)
      if (activeSessionKeyRef.current === operationSessionKey) {
        dispatch({
          type: 'setSessionStatus',
          payload: { tone: 'success', message: `${t('session.workspaceOpened')} · ${target.label}` },
        })
      }
    } catch (err) {
      console.error('Failed to open workspace:', err)
      if (activeSessionKeyRef.current === operationSessionKey) {
        dispatch({
          type: 'setSessionStatus',
          payload: { tone: 'error', message: t('session.workspaceOpenFailed') },
        })
      }
    } finally {
      setOpeningEditorId((current) => current === operationKey ? null : current)
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

    let blocksToExport = sessionDetail.blocks
    if (exportRange.startsWith('recent')) {
      const count = Number.parseInt(exportRange.replace('recent', ''), 10)
      blocksToExport = blocksToExport.slice(-count)
    } else if (exportRange === 'since' && exportSinceDate) {
      const since = new Date(`${exportSinceDate}T00:00:00`).getTime()
      blocksToExport = blocksToExport.filter((block) => {
        const metaCreatedAt = block.sourceMeta.createdAt
        const metaTimestamp = block.sourceMeta.timestamp
        const raw = block.createdAt
          ?? (typeof metaCreatedAt === 'string' || typeof metaCreatedAt === 'number' ? metaCreatedAt : null)
          ?? (typeof metaTimestamp === 'string' || typeof metaTimestamp === 'number' ? metaTimestamp : null)
        if (!raw) return false
        const timestamp = new Date(raw).getTime()
        return Number.isFinite(timestamp) && timestamp >= since
      })
    }

    lines.push(`- Export Range: ${exportRange === 'all' ? 'All messages' : exportRange === 'since' ? `Since ${exportSinceDate}` : `Last ${exportRange.replace('recent', '')} blocks`}`)
    lines.push('')

    for (const block of blocksToExport) {
      const toolCalls = block.toolCalls ?? []
      const hasContent = block.content.trim().length > 0
      const hasToolCalls = includeToolCallsInExport && toolCalls.length > 0
      if (!hasContent && !hasToolCalls) continue

      const roleLabel = block.role === 'user' ? 'User' : block.role === 'assistant' ? 'Assistant' : 'Thinking'
      const headingLabel = !hasContent && hasToolCalls && block.role === 'assistant'
        ? 'Assistant Tool Calls'
        : roleLabel
      lines.push(`## ${headingLabel}`)
      lines.push('')

      if (hasContent) {
        lines.push(block.content)
        lines.push('')
      }

      if (hasToolCalls) {
        lines.push('### Tool Calls')
        lines.push('')
        toolCalls.forEach((toolCall, index) => {
          lines.push(`#### ${index + 1}. ${toolCall.name || toolCall.kind || 'tool'}`)
          lines.push('')
          lines.push(`- Type: ${toolCall.kind || 'tool'}`)
          lines.push(`- Status: ${toolCall.status || 'unknown'}`)
          if (toolCall.id) lines.push(`- ID: ${toolCall.id}`)
          if (toolCall.startedAt) lines.push(`- Started At: ${toolCall.startedAt}`)
          if (toolCall.endedAt) lines.push(`- Ended At: ${toolCall.endedAt}`)
          lines.push('')
          if (toolCall.input) {
            pushMarkdownCodeBlock(lines, 'Input', 'json', toolCall.input, TOOL_INPUT_EXPORT_LIMIT)
          }
          if (toolCall.output) {
            pushMarkdownCodeBlock(lines, 'Output', 'text', toolCall.output, TOOL_OUTPUT_EXPORT_LIMIT)
          }
          if (toolCall.error) {
            pushMarkdownCodeBlock(lines, 'Error', 'text', toolCall.error, TOOL_INPUT_EXPORT_LIMIT)
          }
        })
      }

      lines.push('---')
      lines.push('')
    }

    const content = lines.join('\n')
    const fileName = `${sessionDetail.title || sessionDetail.sessionId}.md`

    if (isTauriRuntime) {
      const filePath = await save({
        defaultPath: fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!filePath) return
      await invoke('session_export_markdown', { outputPath: filePath, content })
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

  const handleExportRawJsonl = async () => {
    if (!sessionDetail) return
    if (!canExportRawJsonl) {
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: '当前平台不支持原始 JSONL 导出' } })
      return
    }

    const baseName = safeExportFileName(`${currentPlatform}-${sessionDetail.sessionId || sessionDetail.sessionKey}`)
    const filePath = await save({
      defaultPath: `${baseName}.jsonl`,
      filters: [{ name: 'Session JSONL', extensions: ['jsonl'] }],
    })
    if (!filePath) return

    setExportingRawJsonl(true)
    try {
      await api.exportRawJsonl(currentPlatform, sessionDetail.sessionKey, filePath)
      setExportDone(true)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.rawExported') } })
      setTimeout(() => setExportDone(false), 2000)
    } catch (err) {
      console.error('Failed to export raw JSONL:', err)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message: err instanceof Error ? err.message : String(err) } })
    } finally {
      setExportingRawJsonl(false)
      setExportMenuOpen(false)
    }
  }

  const detailLoading = selectedSessionKey !== sessionDetail.sessionKey

  return (
    <section className="relative z-10 flex min-w-0 flex-1 flex-col bg-gradient-to-br from-background via-background to-muted/10">
      {detailLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <header className="relative z-20 border-b bg-card/50 px-4 py-3 backdrop-blur-xl md:px-6 md:py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-xl md:hidden"
              onClick={() => {
                dispatch({ type: 'setSelectedSessionKey', payload: null })
                dispatch({ type: 'setSessionDetail', payload: null })
              }}
              title={t('mobileBackToSessions')}
              aria-label={t('mobileBackToSessions')}
            >
              <ArrowLeft className="size-4" />
            </Button>
            {isEditingAlias ? (
              <div className="flex items-center gap-1.5 min-w-[200px]">
                <Input
                  value={tempAlias}
                  onChange={(e) => setTempAlias(e.target.value)}
                  className="h-8 px-2 text-sm font-bold bg-background/80 border-primary/40 focus-visible:ring-1 focus-visible:ring-primary rounded-lg max-w-[240px] md:max-w-[360px]"
                  placeholder={t('session.setAlias') || "设置别名"}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveAlias(tempAlias)
                      setIsEditingAlias(false)
                    } else if (e.key === 'Escape') {
                      setIsEditingAlias(false)
                    }
                  }}
                  onBlur={() => {
                    handleSaveAlias(tempAlias)
                    setIsEditingAlias(false)
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-green-500 hover:bg-green-500/10 hover:text-green-400 shrink-0"
                  onClick={() => {
                    handleSaveAlias(tempAlias)
                    setIsEditingAlias(false)
                  }}
                >
                  <Check className="w-4 h-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:bg-muted/10 shrink-0"
                  onClick={() => setIsEditingAlias(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="flex flex-col min-w-0">
                <div
                  onClick={() => {
                    if (isRemote) return
                    setTempAlias(sessionDetail.aliasTitle || '')
                    setIsEditingAlias(true)
                  }}
                  className={cn("group flex items-center gap-2 rounded-lg px-2 py-0.5 -ml-2 transition-all min-w-0", !isRemote && "cursor-pointer hover:bg-muted/30")}
                  title={isRemote ? t('runtimeRemote') : '双击或点击编辑别名'}
                >
                  <span className="text-lg font-bold text-foreground truncate max-w-[240px] md:max-w-[360px]">
                    {sessionDetail.aliasTitle || sessionDetail.title || sessionDetail.sessionId}
                  </span>
                  {!isRemote && <Pencil className="w-3.5 h-3.5 opacity-0 group-hover:opacity-60 transition-opacity text-muted-foreground shrink-0" />}
                </div>
                {sessionDetail.aliasTitle && (
                  <span className="text-[10px] text-muted-foreground/60 font-mono select-all block mt-0.5 truncate max-w-[240px] md:max-w-[360px] pl-0.5">
                    ID: {sessionDetail.sessionId}
                  </span>
                )}
              </div>
            )}
            {!isRemote && <button
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
            </button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" className={cn("gap-2", refreshDone ? "bg-green-500/10 text-green-400" : "hover:bg-blue-500/10")} onClick={handleRefresh} disabled={refreshing} title={t('session.refresh')} aria-label={t('session.refresh')}>
              {refreshDone ? <CheckCircle className="w-4 h-4" /> : <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />}
              <span className="hidden sm:inline">{refreshDone ? t('session.refreshed') : t('session.refresh')}</span>
            </Button>
            {canOpenWorkspace && !isRemote && (
              <div className="relative flex overflow-visible rounded-xl border border-border/40 bg-white/4 shadow-sm hover:border-border/60 transition-all duration-300" ref={editorMenuRef}>
                <button
                  type="button"
                  onClick={() => handleOpenWorkspace(preferredEditor)}
                  disabled={Boolean(openingEditorId)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-l-xl px-3 text-xs font-semibold text-quiet transition-all hover:bg-white/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-60 cursor-pointer group",
                    editorMenuOpen && "bg-white/5 text-foreground"
                  )}
                  title={`${t('session.openWorkspace')} · ${preferredEditor?.label ?? ''}`}
                >
                  {openingEditorId ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
                  ) : (
                    <PreferredIcon className="w-3.5 h-3.5 text-primary/80 group-hover:text-primary transition-colors shrink-0" />
                  )}
                  <span>{t('session.openWorkspace')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMenuOpen(!editorMenuOpen)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-r-xl border-l border-border/30 text-quiet transition-all hover:bg-white/5 hover:text-foreground cursor-pointer",
                    editorMenuOpen && "bg-white/5 text-foreground"
                  )}
                  title={t('session.chooseEditor')}
                  aria-label={t('session.chooseEditor')}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {editorMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-50 w-52 rounded-2xl border border-border/80 bg-card/98 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200">
                    {editorTargets.map((target) => {
                      const isPreferred = target.id === preferredEditor?.id
                      const isOpening = `${sessionDetail.sessionKey}::${target.id}` === openingEditorId
                      const TargetIcon = getEditorIcon(target.id)
                      return (
                        <button
                          key={target.id}
                          type="button"
                          onClick={() => handleOpenWorkspace(target)}
                          disabled={Boolean(openingEditorId)}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-quiet transition-all hover:bg-primary/10 hover:text-foreground disabled:opacity-50 select-none cursor-pointer group",
                            isPreferred && "text-foreground bg-primary/5 hover:bg-primary/10"
                          )}
                        >
                          {isOpening ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0 text-primary" />
                          ) : (
                            <TargetIcon className={cn("w-3.5 h-3.5 shrink-0 transition-transform duration-300 group-hover:scale-110", isPreferred ? "text-primary" : "text-quiet group-hover:text-foreground")} />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {target.label}
                          </span>
                          {isPreferred && <Check className="w-3.5 h-3.5 text-primary shrink-0 animate-in fade-in zoom-in-75 duration-200" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {!isRemote && kiroExecutionPlaceholderBlocks.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 hover:bg-blue-500/10 hover:text-blue-400"
                onClick={handleLoadAllExecutionOutputs}
                disabled={loadingAllExecutionOutputs}
              >
                <RefreshCw className={cn("w-4 h-4", loadingAllExecutionOutputs && "animate-spin")} />
                <span className="hidden sm:inline">
                  {loadingAllExecutionOutputs ? '加载中' : `加载全部真实输出 (${kiroExecutionPlaceholderBlocks.length})`}
                </span>
              </Button>
            )}

            {/* Geek Terminal Dropdown Button */}
            {!isReadOnlyRemote && remoteCapabilities?.terminal !== false && (() => {
              const availableCommands = ['resume', 'fork'].filter(label => sessionDetail.commands?.[label])
              if (availableCommands.length === 0) return null
              return (
                <div className="relative" ref={terminalMenuRef}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "gap-2 hover:bg-emerald-500/10 rounded-xl border border-border/30 px-3.5 shadow-sm",
                      terminalMenuOpen && "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    )}
                    onClick={() => setTerminalMenuOpen(!terminalMenuOpen)}
                  >
                    <Terminal className="w-4 h-4 text-emerald-400" />
                    <span className="hidden sm:inline">终端指令 (Terminal)</span>
                    <ChevronDown className="w-3 h-3 opacity-60" />
                  </Button>
                  {terminalMenuOpen && (
                    <div className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-2xl border border-border/60 bg-card/95 p-2 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200">
                      {availableCommands.map((label, idx, arr) => {
                        const command = sessionDetail.commands[label]
                        const operationKey = `${sessionDetail.sessionKey}::${label}`
                        const isResume = label === 'resume'
                        
                        return (
                          <div key={label} className="space-y-1">
                            {/* Category Header */}
                            <div className="px-2.5 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider select-none">
                              {isResume ? '恢复会话 (Resume)' : '分支会话 (Fork)'}
                            </div>
                            
                            {/* Embedded option */}
                            <button
                              type="button"
                              onClick={() => {
                                setTerminalMenuOpen(false)
                                void handleStartEmbeddedTerminal(label as 'resume' | 'fork', command)
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-emerald-500/10 hover:text-emerald-400 transition-colors cursor-pointer"
                            >
                              <Terminal className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                              <span>{t(isResume ? 'terminal.resumeEmbedded' : 'terminal.forkEmbedded')}</span>
                            </button>

                            {/* External option */}
                            <button
                              type="button"
                              onClick={() => {
                                setTerminalMenuOpen(false)
                                handleOpenCommand(label, command)
                              }}
                              disabled={openingKey === operationKey}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50 cursor-pointer"
                            >
                              {openingKey === operationKey ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
                              ) : (
                                <Play className="w-3.5 h-3.5 shrink-0 text-primary" />
                              )}
                              <span>{t(isResume ? 'terminal.resumeExternal' : 'terminal.forkExternal')}</span>
                            </button>

                            {/* Copy option */}
                            <button
                              type="button"
                              onClick={() => {
                                setTerminalMenuOpen(false)
                                handleCopyCommand(label, command)
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5 shrink-0" />
                              <span>
                                {copiedKey === operationKey ? t('session.copied') : t(isResume ? 'terminal.copyResumeCmd' : 'terminal.copyForkCmd')}
                              </span>
                            </button>
                            
                            {idx < arr.length - 1 && <div className="border-t border-border/20 my-2" />}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Geek Export Popover Button */}
            <div className="relative" ref={exportMenuRef}>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "gap-2 hover:bg-blue-500/10 rounded-xl border border-border/30 px-3.5 shadow-sm",
                  exportMenuOpen && "bg-blue-500/10 text-blue-400 border-blue-500/30",
                  exportDone && "bg-green-500/10 text-green-400 border-green-500/30"
                )}
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
              >
                {exportDone ? <CheckCircle className="w-4 h-4" /> : <Download className="w-4 h-4" />}
                <span>{exportDone ? t('session.exported') : t('session.export')}</span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </Button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-50 w-72 rounded-2xl border border-border/60 bg-card/95 p-3.5 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200 select-none">
                  <h4 className="text-xs font-bold text-foreground mb-3">{t('session.exportOptions')}</h4>
                  <div className="mb-3 rounded-xl border border-border/40 bg-muted/20 p-2.5">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-quiet">{t('session.exportRange')}</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {([
                        ['all', t('session.exportAll')],
                        ['recent20', t('session.exportRecent', { count: 20 })],
                        ['recent50', t('session.exportRecent', { count: 50 })],
                        ['recent100', t('session.exportRecent', { count: 100 })],
                        ['since', t('session.exportSince')],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            'rounded-lg border px-2 py-1.5 text-[10px] font-medium transition-colors',
                            exportRange === value
                              ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                              : 'border-border/30 bg-background/40 text-muted-foreground hover:text-foreground',
                          )}
                          onClick={() => setExportRange(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {exportRange === 'since' && (
                      <input
                        type="date"
                        value={exportSinceDate}
                        onChange={(event) => setExportSinceDate(event.target.value)}
                        className="mt-2 w-full rounded-lg border border-border/50 bg-background/70 px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-blue-500/50"
                      />
                    )}
                  </div>
                  <label
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground mb-3 transition-colors",
                      hasExportableToolCalls ? "cursor-pointer hover:bg-muted/40 hover:text-foreground" : "cursor-not-allowed opacity-50"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary shrink-0"
                      checked={includeToolCallsInExport}
                      disabled={!hasExportableToolCalls}
                      onChange={(event) => setIncludeToolCallsInExport(event.target.checked)}
                    />
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground text-[11px] leading-tight">包含工具调用历史</p>
                      <p className="text-[10px] text-quiet mt-0.5 leading-none">导出各个工具在后台的执行输出</p>
                    </div>
                  </label>
                  <Button
                    size="sm"
                    className="w-full gap-2 rounded-xl bg-primary text-primary-foreground font-semibold shadow-sm hover:shadow"
                    disabled={exportRange === 'since' && !exportSinceDate}
                    onClick={() => {
                      setExportMenuOpen(false)
                      handleExportMarkdown()
                    }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{t('session.exportMarkdown')}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full gap-2 rounded-xl border-cyan-500/25 text-cyan-400 hover:border-cyan-500/40 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={handleExportRawJsonl}
                    disabled={!canExportRawJsonl || exportingRawJsonl}
                    title={canExportRawJsonl ? t('session.exportRawJsonl') : '仅支持 Claude / Codex / Pi'}
                  >
                    {exportingRawJsonl ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                    <span>{exportingRawJsonl ? t('session.exportingRaw') : t('session.exportRawJsonl')}</span>
                  </Button>
                </div>
              )}
            </div>

            {!isRemote && <Button variant="ghost" size="sm"
              className="gap-2 hover:bg-amber-500/10 hover:text-amber-400"
              title={t('session.archive')}
              aria-label={t('session.archive')}
              onClick={async () => {
                if (!await confirm({ title: t('session.archive'), description: t('session.archiveConfirm') })) return
                await api.toggleFlag(currentPlatform, sessionDetail.sessionKey, 'archived')
                dispatch({ type: 'setSessions', payload: sessions.filter(s => s.sessionKey !== sessionDetail.sessionKey) })
                dispatch({ type: 'setSelectedSessionKey', payload: null })
                dispatch({ type: 'setSessionDetail', payload: null })
                dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.archived') } })
              }}>
              <Archive className="w-4 h-4" />
              <span className="hidden sm:inline">{t('session.archive')}</span>
            </Button>}
            <Button variant={showEditLog ? "secondary" : "ghost"} size="sm"
              className={cn("gap-2", showEditLog && "border border-amber-500/30 bg-amber-500/20 text-amber-400")}
              title={t('session.editLog')}
              aria-label={t('session.editLog')}
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
          {isReadOnlyRemote && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/8 px-3 py-1 text-primary/85">
              <Eye className="size-3.5" />
              {t('remoteReadOnly')}
            </span>
          )}
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

      <>
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

          <div ref={messageScrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div
              className="relative w-full"
              style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
            >
              {virtualItems.map((virtualItem) => {
                const block = filteredBlocks[virtualItem.index]
                if (!block) return null

                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={messageVirtualizer.measureElement}
                    className="absolute left-0 top-0 w-full px-4 md:px-6"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <MessageBlock
                      block={block}
                      index={virtualItem.index}
                      onEdit={() => handleEditBlock(block)}
                      onErase={() => handleEraseBlock(block)}
                      onLoadExecutionOutput={isRemote ? undefined : () => handleLoadExecutionOutput(block)}
                      loadingExecutionOutput={Boolean(block.editTarget && loadingExecutionTargets.has(block.editTarget))}
                      t={t}
                      searchHighlight={searchNeedle}
                      isSearchMatch={matchingBlockIds.includes(block.id)}
                      isCurrentMatch={matchingBlockIds[currentMatchIdx] === block.id}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          {/* Floating TOC */}
          <div className="absolute bottom-5 right-5 z-20 flex flex-col items-end">
            {tocOpen && (
              <div className="mb-2 max-h-80 w-72 overflow-y-auto rounded-2xl border border-border/80 bg-card/95 shadow-2xl backdrop-blur-xl">
                <div className="sticky top-0 border-b border-border/50 bg-card/95 px-4 py-2.5">
                  <p className="text-xs font-medium text-muted-foreground">{t('session.filter.user')} · {filteredBlocks.filter(b => b.role === 'user').length}</p>
                </div>
                <div className="p-2 space-y-0.5">
                  {filteredBlocks.map((block, index) => {
                    if (block.role !== 'user') return null
                    return (
                      <button
                        key={block.id}
                        type="button"
                        onClick={() => {
                          scrollToBlockIndex(index)
                          setTocOpen(false)
                        }}
                        className="w-full text-left rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors truncate"
                      >
                        <span className="text-muted-foreground/50 mr-1.5">#{index + 1}</span>
                        {block.content.slice(0, 60).replace(/\n/g, ' ')}
                        {block.content.length > 60 && '...'}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setTocOpen(!tocOpen)}
              className={cn(
                "flex size-10 items-center justify-center rounded-full shadow-lg transition-all",
                tocOpen
                  ? "bg-primary text-primary-foreground"
                  : "bg-card/90 border border-border/80 text-muted-foreground hover:text-foreground hover:bg-card backdrop-blur-xl"
              )}
              title={t('session.filter.user')}
            >
              <List className="size-4" />
            </button>
          </div>
      </>

      <ConfirmDialog {...confirmDialogProps} />
    </section>
  )
}

function CodeBlockRenderer({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border/40 bg-[#0b0e14] text-[#c9d1d9] font-mono text-xs shadow-md">
      <div className="flex items-center justify-between bg-[#11151c] px-4 py-2 border-b border-border/30 text-[10px] text-muted-foreground select-none">
        <span className="font-bold uppercase tracking-wider text-[#79c0ff]">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-1.5 hover:text-foreground transition-colors px-2.5 py-1 rounded bg-white/5 border border-border/20",
            copied && "text-green-400 bg-green-500/10 border-green-500/20"
          )}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto whitespace-pre leading-relaxed">{code}</pre>
    </div>
  )
}

function parseContentWithCodeBlocks(text: string, searchHighlight?: string) {
  if (!text) return ''

  const highlightWord = (val: string) => {
    if (!searchHighlight) return val
    const regex = new RegExp(`(${searchHighlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = val.split(regex)
    if (parts.length === 1) return val
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="bg-amber-400/35 text-foreground rounded-sm px-0.5">{part}</mark>
        : part
    )
  }

  const parts: React.ReactNode[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++} className="whitespace-pre-wrap leading-relaxed text-sm">
          {highlightWord(text.slice(lastIndex, match.index))}
        </span>
      );
    }
    parts.push(
      <CodeBlockRenderer
        key={key++}
        language={match[1]}
        code={match[2]?.trim()}
      />
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={key++} className="whitespace-pre-wrap leading-relaxed text-sm">
        {highlightWord(text.slice(lastIndex))}
      </span>
    );
  }

  return parts.length > 0 ? parts : text;
}

function cleanAnsiCodes(text: string): string {
  if (!text) return ''
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[0-9;]+m/g, '')
}

function ToolCallsConsole({ toolCalls }: {
  toolCalls: Array<any>;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  return (
    <div className="mt-4 space-y-2 border-t border-border/30 pt-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-semibold">
        <Terminal className="size-3.5 text-primary" />
        <span>Executed Tools ({toolCalls.length})</span>
      </div>
      <div className="space-y-2">
        {toolCalls.map((tc, idx) => {
          const isExpanded = expandedIndex === idx
          const isSuccess = tc.status === 'success' || (!tc.error && tc.status !== 'error')
          const isError = tc.status === 'error' || tc.error

          return (
            <div key={idx} className="rounded-xl border border-border/40 bg-[#0a0d13] overflow-hidden text-xs shadow-sm">
              <div
                onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                className="flex items-center justify-between px-3.5 py-2.5 hover:bg-white/4 cursor-pointer transition-all duration-200 select-none"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn(
                    "size-2 rounded-full",
                    isSuccess && "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]",
                    isError && "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]",
                    !isSuccess && !isError && "bg-amber-500 animate-pulse shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                  )} />
                  <code className="text-[#79c0ff] font-mono text-[11px] font-bold truncate">{tc.name || tc.kind || 'tool_call'}</code>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 text-[10px] text-quiet">
                  <span className="font-mono text-fine uppercase tracking-wider">{tc.status || 'completed'}</span>
                  {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-border/20 bg-[#07090e] p-3.5 space-y-3.5 font-mono animate-in fade-in duration-200">
                  {tc.input && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold select-none">Arguments</div>
                      <pre className="p-3 rounded-xl bg-[#0d1017] border border-zinc-800/80 overflow-x-auto text-[11px] leading-relaxed text-cyan-400 select-all font-mono">{tc.input}</pre>
                    </div>
                  )}
                  {tc.output && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold select-none">Stdout/Output</div>
                      <pre className="p-3 rounded-xl bg-[#0d1017] border border-zinc-800/80 overflow-x-auto text-[11px] leading-relaxed text-zinc-200 select-all font-mono whitespace-pre-wrap break-all max-h-[280px] overflow-y-auto">{cleanAnsiCodes(tc.output)}</pre>
                    </div>
                  )}
                  {tc.error && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-rose-500/80 uppercase tracking-wider font-bold select-none">Stderr/Error</div>
                      <pre className="p-3 rounded-xl bg-rose-950/20 border border-rose-500/30 overflow-x-auto text-[11px] leading-relaxed text-rose-300 font-mono whitespace-pre-wrap break-all">{tc.error}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const MessageBlock = forwardRef<HTMLDivElement, {
  block: {
    role: string
    content: string
    id: string
    editTarget?: string
    editable?: boolean
    toolCalls?: Array<any>
  }
  index: number
  onEdit: () => void
  onErase: () => void
  onLoadExecutionOutput?: () => void
  loadingExecutionOutput?: boolean
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  searchHighlight?: string
  isSearchMatch?: boolean
  isCurrentMatch?: boolean
}>(function MessageBlock({ block, index, onEdit, onErase, onLoadExecutionOutput, loadingExecutionOutput, t, searchHighlight, isCurrentMatch }, ref) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [longContentExpanded, setLongContentExpanded] = useState(false)

  const roleConfig = {
    user: {
      label: t('session.filter.user'),
      icon: User,
      bgGradient: 'from-blue-500/10 via-blue-500/3 to-transparent',
      borderColor: 'border-l-blue-500/60',
      iconBg: 'bg-blue-500/20 text-blue-400',
      badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/30'
    },
    assistant: {
      label: t('session.filter.assistant'),
      icon: Bot,
      bgGradient: 'from-green-500/8 via-green-500/2 to-transparent',
      borderColor: 'border-l-green-500/60',
      iconBg: 'bg-green-500/20 text-green-400',
      badgeClass: 'bg-green-500/15 text-green-400 border-green-500/30'
    },
    thinking: {
      label: t('session.filter.thinking'),
      icon: Lightbulb,
      bgGradient: 'from-amber-500/8 via-amber-500/2 to-transparent',
      borderColor: 'border-l-amber-500/60 border-l-dashed',
      iconBg: 'bg-amber-500/20 text-amber-400',
      badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30'
    },
  }
  const config = roleConfig[block.role as keyof typeof roleConfig] || roleConfig.assistant
  const Icon = config.icon
  const isKiroExecutionPlaceholder = block.role === 'assistant'
    && block.content.trim() === 'On it.'
    && block.editTarget?.includes('::execution::')

  const isThinking = block.role === 'thinking'
  const hasContent = block.content.trim().length > 0
  const isLongContent = !isThinking && block.content.length > LONG_BLOCK_COLLAPSE_THRESHOLD
  const isSearchHit = Boolean(searchHighlight && block.content.toLowerCase().includes(searchHighlight.toLowerCase()))
  const showFullLongContent = longContentExpanded || isSearchHit
  const displayContent = isLongContent && !showFullLongContent
    ? `${block.content.slice(0, LONG_BLOCK_PREVIEW_CHARS)}\n\n...`
    : block.content

  return (
    <div
      ref={ref}
      className={cn(
        "group animate-in fade-in slide-in-from-bottom-2 duration-300",
        `rounded-r-2xl border-l-4 ${config.borderColor}`,
        isCurrentMatch && "ring-2 ring-amber-400/50 rounded-2xl"
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      <div className={cn("ml-0 rounded-2xl rounded-l-none border border-border/40 p-4 backdrop-blur-sm", `bg-gradient-to-b ${config.bgGradient}`)}>
        <div className="flex items-start gap-3">
          <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 shadow-md", config.iconBg)}>
            <Icon className={cn("w-4 h-4", isThinking && "animate-pulse")} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-3 select-none">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={cn("text-xs font-semibold rounded-lg", config.badgeClass)}>{config.label}</Badge>
                <span className="text-[10px] text-muted-foreground/50">#{index + 1}</span>
              </div>

              {isThinking && (
                <button
                  type="button"
                  onClick={() => setThinkingExpanded(!thinkingExpanded)}
                  className="text-[10px] font-semibold text-amber-500 hover:text-amber-400 border border-amber-500/30 rounded-lg px-2.5 py-1 bg-amber-500/5 transition-all"
                >
                  {thinkingExpanded ? '隐藏思考过程' : '查看思考过程'}
                </button>
              )}
            </div>

            {/* Collapsible content log wrapper for Thinking Logs */}
            {hasContent && (
              (!isThinking || thinkingExpanded) ? (
                <div className="space-y-2">
                  <div className={cn(
                    "overflow-hidden rounded-xl p-4 bg-background/55 border border-border/30",
                    isThinking && "bg-amber-500/3 border-dashed border-amber-500/20"
                  )}>
                    <div className={cn(
                      "text-sm font-sans leading-relaxed text-foreground whitespace-pre-wrap break-words",
                      isThinking && "font-mono text-xs text-quiet"
                    )}>
                      {parseContentWithCodeBlocks(displayContent, searchHighlight)}
                    </div>
                  </div>
                  {isLongContent && !isSearchHit && (
                    <button
                      type="button"
                      onClick={() => setLongContentExpanded(value => !value)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-background/60 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                    >
                      {longContentExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      {longContentExpanded ? '收起长内容' : `展开完整内容 (${Math.round(block.content.length / 1000)}k)`}
                    </button>
                  )}
                </div>
              ) : (
                <div
                  onClick={() => setThinkingExpanded(true)}
                  className="overflow-hidden rounded-xl px-4 py-3 bg-amber-500/3 border border-dashed border-amber-500/20 cursor-pointer hover:bg-amber-500/6 text-[11px] text-amber-500/80 font-mono flex items-center gap-2 transition-all select-none"
                >
                  <Lightbulb className="size-3.5 text-amber-500 animate-pulse shrink-0" />
                  <span>已折叠系统思维链路 ({block.content.length} 字符)，点击此处展开...</span>
                </div>
              )
            )}

            {/* Interactive console widget for tool calls if available */}
            {block.toolCalls && block.toolCalls.length > 0 && (
              <ToolCallsConsole toolCalls={block.toolCalls} />
            )}

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {block.editable !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-border/50 bg-background/60 text-xs hover:bg-background/80 rounded-xl"
                  onClick={(e) => { e.stopPropagation(); onEdit() }}
                >
                  <Pencil className="w-3 h-3" />{t('session.editThisMessage')}
                </Button>
              )}
              {isKiroExecutionPlaceholder && onLoadExecutionOutput && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-blue-500/35 bg-blue-500/5 text-blue-400 text-xs hover:bg-blue-500/15 hover:text-blue-300 rounded-xl"
                  disabled={loadingExecutionOutput}
                  onClick={(e) => { e.stopPropagation(); onLoadExecutionOutput() }}
                >
                  <RefreshCw className={cn("w-3 h-3", loadingExecutionOutput && "animate-spin")} />
                  {loadingExecutionOutput ? '加载中' : '加载真实输出'}
                </Button>
              )}
              {block.editable !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-red-500/35 bg-red-500/5 text-red-400 text-xs hover:bg-red-500/15 hover:text-red-300 rounded-xl"
                  onClick={(e) => { e.stopPropagation(); onErase() }}
                >
                  <Trash2 className="w-3 h-3" />{t('session.erase')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
