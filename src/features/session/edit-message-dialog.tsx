import { useState } from 'react'
import { Clock, Save } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/features/desktop/api'
import { useDesktop } from '@/features/desktop/provider'

export function EditMessageDialog() {
  const { t, state, dispatch } = useDesktop()
  const currentPlatform = state.currentPlatform
  const editingBlock = state.editingBlock
  const selectedSessionKey = state.selectedSessionKey
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

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
    dispatch({ type: 'setEditingBlock', payload: null })
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    dispatch({ type: 'setSessionStatus', payload: null })

    try {
      await api.editMessage(currentPlatform, editingBlock.id, editingBlock.content, selectedSessionKey)
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
      const message = t('session.saveFailed')
      setSaveError(message)
      dispatch({ type: 'setSessionStatus', payload: { tone: 'error', message } })
    }

    setSaving(false)
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
      <DialogContent className="max-w-4xl border-border/70 bg-popover/95 shadow-[0_32px_80px_rgba(30,38,58,0.22)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-xl">
            <span>{t('session.editMessage')}</span>
            <Badge variant={editingBlock.role as 'user' | 'assistant' | 'thinking'} className="px-3 py-1 text-sm">
              {roleLabel}
            </Badge>
          </DialogTitle>
          <p className="pr-8 text-sm leading-6 text-muted-foreground">{t('session.editorHelper')}</p>
        </DialogHeader>

        <DialogBody className="space-y-4 pb-5">
          <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{t('editLog.before')}</p>
            <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{editingBlock.originalContent}</pre>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{t('editLog.after')}</p>
            <Textarea
              value={editingBlock.content}
              onChange={(e) => dispatch({ type: 'setEditingBlock', payload: { ...editingBlock, content: e.target.value } })}
              className="min-h-[280px] bg-background/90 font-mono text-sm md:min-h-[360px]"
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

        <DialogFooter className="flex items-center justify-end gap-3">
          <Button variant="outline" className="min-w-28 justify-center" onClick={handleClose}>
            {t('session.cancel')}
          </Button>
          <Button className="min-w-28 justify-center gap-1.5" onClick={handleSave} disabled={saving}>
            {saving ? <Clock className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('session.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
