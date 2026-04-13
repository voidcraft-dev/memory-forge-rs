import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useDesktop } from '@/features/desktop/provider'
import { cn } from '@/lib/utils'
import { FileText, ArrowRight, Clock, Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import type { MessageKey } from '@/features/desktop/i18n'
import type { EditLogEntry } from '@/features/desktop/types'

function DiffView({ oldText, newText, t }: { oldText: string; newText: string; t: (key: MessageKey) => string }) {
  const [expanded, setExpanded] = useState(false)
  const maxLen = 120
  const oldPreview = oldText.length > maxLen && !expanded ? oldText.slice(0, maxLen) + '...' : oldText
  const newPreview = newText.length > maxLen && !expanded ? newText.slice(0, maxLen) + '...' : newText

  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-medium text-red-400/80 uppercase tracking-wider">{t('editLog.before')}</span>
          {!expanded && oldText.length > maxLen && (
            <button onClick={() => setExpanded(true)} className="text-[10px] text-muted-foreground/50 hover:text-foreground">{t('editLog.expand')}</button>
          )}
        </div>
        <pre className="text-xs text-red-300/80 whitespace-pre-wrap font-mono leading-relaxed">{oldPreview}</pre>
      </div>
      <div className="flex justify-center"><ArrowRight className="w-3.5 h-3.5 text-muted-foreground/30" /></div>
      <div className="rounded-lg bg-green-500/5 border border-green-500/20 p-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-medium text-green-400/80 uppercase tracking-wider">{t('editLog.after')}</span>
          {!expanded && newText.length > maxLen && (
            <button onClick={() => setExpanded(true)} className="text-[10px] text-muted-foreground/50 hover:text-foreground">{t('editLog.expand')}</button>
          )}
        </div>
        <pre className="text-xs text-green-300/80 whitespace-pre-wrap font-mono leading-relaxed">{newPreview}</pre>
      </div>
    </div>
  )
}

export function EditLogPanel() {
  const { t, state, dispatch } = useDesktop()
  const currentPlatform = state.currentPlatform
  const editLog = state.editLog
  const selectedSessionKey = state.selectedSessionKey
  const showEditLog = state.showEditLog
  const [expandedId, setExpandedId] = useState<number | null>(null)

  if (currentPlatform === 'dashboard' || currentPlatform === 'about' || currentPlatform === 'prompts' || currentPlatform === 'settings' || !selectedSessionKey) return null
  if (!showEditLog) return null

  return (
    <aside className="hidden h-full w-[360px] flex-shrink-0 flex-col border-l border-border/50 bg-gradient-to-b from-card to-card/60 backdrop-blur-xl xl:flex">
      <div className="border-b border-border/50 p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <FileText className="w-5 h-5 text-amber-500" />
            {t('editLog.title')}
          </h2>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => dispatch({ type: 'setShowEditLog', payload: false })}>
            {t('editLog.collapse')}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground/60">{t('editLog.readonlyTrace')}</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4 space-y-3">
          {editLog.length === 0 ? (
            <div className="text-center py-12 px-4">
              <div className="w-20 h-20 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 flex items-center justify-center">
                <FileText className="w-8 h-8 text-amber-400/60" />
              </div>
              <p className="text-sm font-medium text-foreground/70">{t('editLog.noRecords')}</p>
              <p className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">{t('editLog.afterEditHint')}</p>
            </div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground/60 mb-2">{t('editLog.recordCount', { count: editLog.length })}</div>
              {editLog.map((entry: EditLogEntry) => (
                <div key={entry.id} className={cn("group relative p-4 rounded-xl border transition-all duration-300", "bg-gradient-to-r from-amber-500/5 to-orange-500/5", "border-border/30 hover:border-amber-500/30", "hover:shadow-lg hover:shadow-amber-500/10")}>
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-3 h-3 text-muted-foreground/50" />
                    <span className="text-[10px] text-muted-foreground/60">
                      {new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                  <Badge variant="outline" className="text-[10px] mb-3 block w-fit">
                    {entry.editTarget.length > 40 ? entry.editTarget.slice(0, 40) + '...' : entry.editTarget}
                  </Badge>
                  {expandedId === entry.id ? (
                    <>
                      <DiffView oldText={entry.oldContent} newText={entry.newContent} t={t} />
                      <Button variant="ghost" size="sm" className="mt-2 w-full text-xs" onClick={() => setExpandedId(null)}>
                        <EyeOff className="w-3 h-3 mr-1" />{t('editLog.collapse')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-red-300/60 line-clamp-1 font-mono mb-1">- {entry.oldContent.slice(0, 80)}</p>
                      <p className="text-xs text-green-300/60 line-clamp-1 font-mono mb-2">+ {entry.newContent.slice(0, 80)}</p>
                      <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs border-amber-500/20 hover:bg-amber-500/10 hover:border-amber-500/30" onClick={() => setExpandedId(entry.id)}>
                        <Eye className="w-3 h-3" />{t('editLog.viewDetail')}
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <div className="p-4 border-t border-border/50 bg-gradient-to-r from-amber-500/5 to-orange-500/5">
        <div className="flex items-start gap-2 text-[10px] text-muted-foreground/80">
          <FileText className="w-3 h-3 flex-shrink-0 mt-0.5 text-amber-500" />
          <div>
            <p className="font-medium text-foreground/70">{t('editLog.traceTitle')}</p>
            <p className="mt-1 leading-relaxed">{t('editLog.traceDesc')}</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
