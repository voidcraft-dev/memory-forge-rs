import { useState } from 'react'
import { ChevronDown, ChevronUp, Clock, Save, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { api, isSessionRevisionConflict } from '@/features/desktop/api'
import { useDesktop } from '@/features/desktop/provider'

export function EditMessageDialog() {
  const { t, state, dispatch, isRemote } = useDesktop()
  const currentPlatform = state.currentPlatform
  const editingBlock = state.editingBlock
  const selectedSessionKey = state.selectedSessionKey
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [revisionConflict, setRevisionConflict] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)

  if (!editingBlock || !selectedSessionKey) {
    return null
  }

  const roleLabelMap = {
    user: t('session.filter.user'),
    assistant: t('session.filter.assistant'),
    thinking: t('session.filter.thinking'),
  } as const
  const roleLabel = roleLabelMap[editingBlock.role as keyof typeof roleLabelMap] ?? t('session.filter.assistant')

  const handleClose = () => {
    setSaveError(null)
    setRevisionConflict(false)
    dispatch({ type: 'setEditingBlock', payload: null })
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    setRevisionConflict(false)
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      await api.editMessage(
        currentPlatform,
        editingBlock.id,
        editingBlock.content,
        selectedSessionKey,
        editingBlock.revision,
      )
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(currentPlatform, selectedSessionKey),
        api.getEditLog(currentPlatform, selectedSessionKey),
      ])

      dispatch({ type: 'setSessionDetail', payload: updated })
      dispatch({ type: 'setEditLog', payload: logs })
      dispatch({ type: 'setEditingBlock', payload: null })
      dispatch({ type: 'setShowEditLog', payload: true })
      dispatch({ type: 'setSessionStatus', payload: { tone: 'success', message: t('session.messageSaved') } })
    } catch (error) {
      console.error('Failed to save edit:', error)
      const conflict = isSessionRevisionConflict(error)
      if (conflict) {
        setRevisionConflict(true)
        try {
          const [updated, logs] = await Promise.all([
            api.getSessionDetail(currentPlatform, selectedSessionKey),
            api.getEditLog(currentPlatform, selectedSessionKey),
          ])
          dispatch({ type: 'setSessionDetail', payload: updated })
          dispatch({ type: 'setEditLog', payload: logs })
        } catch (refreshError) {
          console.error('Failed to refresh after revision conflict:', refreshError)
        }
      }
      const message = conflict ? t('session.revisionConflict') : t('session.saveFailed')
      setSaveError(message)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message } })
    } finally {
      setSaving(false)
    }
  }

  if (isRemote) {
    return (
      <Dialog
        open={Boolean(editingBlock)}
        onOpenChange={(open) => {
          if (!open) handleClose()
        }}
      >
        <DialogContent className="remote-editor-sheet">
          <DialogHeader className="remote-editor-header">
            <p className="remote-kicker">{roleLabel}</p>
            <DialogTitle>{t('session.editMessage')}</DialogTitle>
            <DialogDescription className="sr-only">{t('session.editWarning')}</DialogDescription>
            <div className="remote-editor-revision">
              <ShieldCheck className="size-3.5" />
              <span>{t('remoteRevisionProtected')}</span>
            </div>
          </DialogHeader>

          <DialogBody className="remote-editor-body">
            <button
              type="button"
              className="remote-original-toggle"
              onClick={() => setShowOriginal((value) => !value)}
              aria-expanded={showOriginal}
            >
              <span>{t('editLog.before')}</span>
              {showOriginal ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
            {showOriginal && <pre className="remote-original-content">{editingBlock.originalContent}</pre>}

            <label className="remote-editor-label" htmlFor="remote-message-editor">{t('editLog.after')}</label>
            <Textarea
              id="remote-message-editor"
              value={editingBlock.content}
              onChange={(event) => dispatch({ type: 'setEditingBlock', payload: { ...editingBlock, content: event.target.value } })}
              className="remote-editor-textarea"
              placeholder={t('session.enterContent')}
              autoFocus
            />

            {saveError && <div className="remote-editor-error" role="alert">{saveError}</div>}
            <p className="remote-editor-warning">{t('session.editWarning')}</p>
          </DialogBody>

          <DialogFooter className="remote-editor-footer">
            <Button variant="ghost" onClick={handleClose}>{t('session.cancel')}</Button>
            <Button onClick={() => void handleSave()} disabled={saving || revisionConflict}>
              {saving ? <Clock className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t('session.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={Boolean(editingBlock)}
      onOpenChange={(open) => {
        if (!open) {
          handleClose()
        }
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl border-border/70 bg-popover/95 shadow-[0_32px_80px_rgba(30,38,58,0.22)]">
        <DialogHeader className="p-4 pr-12 md:p-6 md:pr-14">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-lg md:gap-3 md:text-xl">
            <span>{t('session.editMessage')}</span>
            <Badge variant={editingBlock.role as 'user' | 'assistant' | 'thinking'} className="px-3 py-1 text-sm">
              {roleLabel}
            </Badge>
          </DialogTitle>
          <DialogDescription className="pr-8 leading-6">{t('session.editorHelper')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4 p-4 pb-5 md:p-6">
          <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{t('editLog.before')}</p>
            <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{editingBlock.originalContent}</pre>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{t('editLog.after')}</p>
            <Textarea
              value={editingBlock.content}
              onChange={(e) => dispatch({ type: 'setEditingBlock', payload: { ...editingBlock, content: e.target.value } })}
              className="min-h-[200px] bg-background/90 font-mono text-base md:min-h-[360px] md:text-sm"
              placeholder={t('session.enterContent')}
            />
          </div>

          {saveError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {saveError}
            </div>
          )}

          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-xs leading-6 text-muted-foreground">
            {t('session.editWarning')}
          </div>
        </DialogBody>

        <DialogFooter className="flex items-center justify-end gap-3 p-3 md:p-4">
          <Button variant="outline" className="min-h-11 min-w-28 justify-center" onClick={handleClose}>
            {t('session.cancel')}
          </Button>
          <Button className="min-h-11 min-w-28 justify-center gap-1.5" onClick={handleSave} disabled={saving || revisionConflict}>
            {saving ? <Clock className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('session.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
