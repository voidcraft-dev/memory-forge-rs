import { useState, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "./dialog"
import { Button } from "./button"
import { AlertTriangle } from "lucide-react"
import { useDesktop } from "@/features/desktop/provider"
import { cn } from "@/lib/utils"

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
  confirmLabel,
  cancelLabel,
  variant = "warning",
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useDesktop()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle
              className={cn(
                "size-5",
                variant === "danger" ? "text-[var(--crimson-fg)]" : "text-[var(--forge-fg)]"
              )}
            />
            {title}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="py-4">
          <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        </DialogBody>
        <DialogFooter className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t("cancel")}
          </Button>
          <Button
            size="sm"
            className={variant === "danger"
              ? "border border-[var(--crimson-line)] bg-[var(--crimson-dim)] text-[var(--crimson-fg)] hover:bg-[var(--crimson-dim)] hover:brightness-110"
              : "border border-[var(--forge-line)] bg-[var(--forge-dim)] text-[var(--forge-fg)] hover:bg-[var(--forge-dim)] hover:brightness-110"
            }
            onClick={() => { onConfirm(); onOpenChange(false) }}
          >
            {confirmLabel ?? t("hud.confirm")}
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
