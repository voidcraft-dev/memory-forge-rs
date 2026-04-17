import { useState, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "./dialog"
import { Button } from "./button"
import { AlertTriangle } from "lucide-react"

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: "warning" | "danger"
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "warning",
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className={`size-5 ${variant === "danger" ? "text-red-400" : "text-amber-400"}`} />
            {title}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="py-4">
          <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            className={variant === "danger"
              ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
              : "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/30"
            }
            onClick={() => { onConfirm(); onOpenChange(false) }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function useConfirmDialog() {
  const [state, setState] = useState<{
    open: boolean
    title: string
    description: string
    variant: "warning" | "danger"
    resolve: ((value: boolean) => void) | null
  }>({ open: false, title: "", description: "", variant: "warning", resolve: null })

  const confirm = useCallback((opts: { title: string; description: string; variant?: "warning" | "danger" }) => {
    return new Promise<boolean>((resolve) => {
      setState({ open: true, title: opts.title, description: opts.description, variant: opts.variant ?? "warning", resolve })
    })
  }, [])

  const dialogProps = {
    open: state.open,
    onOpenChange: (open: boolean) => {
      if (!open && state.resolve) state.resolve(false)
      setState(s => ({ ...s, open: false }))
    },
    title: state.title,
    description: state.description,
    variant: state.variant as "warning" | "danger",
    onConfirm: () => {
      if (state.resolve) state.resolve(true)
      setState(s => ({ ...s, open: false }))
    },
  }

  return { confirm, dialogProps }
}
