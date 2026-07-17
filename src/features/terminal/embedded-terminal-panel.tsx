import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Loader2,
  Play,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDesktop } from "@/features/desktop/provider";
import type { EmbeddedTerminalPanelProps } from "./terminal-types";
import { TerminalToolbar } from "./terminal-toolbar";

export function EmbeddedTerminalPanel({
  status,
  commandKind,
  cwd,
  exitCode,
  errorMessage,
  onStart,
  onStop,
  onForceStop,
  onRestart,
  onOpenExternal,
  onClose,
  children,
}: EmbeddedTerminalPanelProps) {
  const { t } = useDesktop();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0d1117]">
      <TerminalToolbar
        status={status}
        commandKind={commandKind}
        cwd={cwd}
        onRestart={onRestart}
        onStop={onStop}
        onForceStop={onForceStop}
        onOpenExternal={onOpenExternal}
        onClose={onClose}
      />

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0d1117]">
        {children ?? <div className="min-h-0 flex-1" />}

        {status === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background p-8 text-center">
            <div className="mb-4 rounded-2xl border border-primary/10 bg-primary/5 p-4">
              <Terminal className="size-8 text-primary" />
            </div>
            <h3 className="mb-2 text-base font-bold">{t("terminal.idle.title")}</h3>
            <p className="mb-6 max-w-md text-sm text-muted-foreground">
              {t("terminal.idle.desc")}
            </p>
            <Button onClick={onStart} className="min-h-9 gap-2 rounded-xl">
              <Play className="size-4 fill-current" />
              {t("terminal.idle.btn")}
            </Button>
          </div>
        )}

        {status === "starting" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-background/90 p-8 text-center backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="mb-4 size-8 animate-spin text-primary motion-reduce:animate-none" />
            <h3 className="text-sm font-semibold text-muted-foreground">
              {t("terminal.starting.title")}
            </h3>
          </div>
        )}

        {status === "stopping" && (
          <div
            className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-amber-500/30 bg-background/90 px-3 py-1.5 text-xs font-medium text-amber-400 shadow-lg backdrop-blur"
            role="status"
            aria-live="polite"
          >
            {t("terminal.status.stopping")}
          </div>
        )}

        {status === "exited" && (
          <div
            className="absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-background/95 px-4 py-3 shadow-xl backdrop-blur"
            role="status"
            aria-live="polite"
          >
            <div className="flex min-w-0 items-center gap-2">
              <CheckCircle className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">
                {t("terminal.exited.title", {
                  code:
                    exitCode !== undefined && exitCode !== null ? String(exitCode) : "?",
                })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={onRestart} variant="outline" size="sm" className="min-h-8">
                {t("terminal.btn.restart")}
              </Button>
              <Button onClick={onClose} variant="ghost" size="sm" className="min-h-8">
                {t("terminal.btn.close")}
              </Button>
            </div>
          </div>
        )}

        {status === "failed" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-background/95 p-8 text-center backdrop-blur-sm"
            role="alert"
          >
            <div className="mb-4 rounded-2xl border border-red-500/10 bg-red-500/5 p-4">
              <AlertTriangle className="size-8 text-red-500" />
            </div>
            <h3 className="mb-2 text-base font-bold">{t("terminal.failed.title")}</h3>
            {errorMessage && (
              <p className="mb-6 max-w-lg break-words rounded-lg border border-red-500/10 bg-red-500/5 p-3 text-left font-mono text-xs text-red-400">
                {errorMessage}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={onRestart} className="min-h-9 rounded-xl">
                {t("terminal.failed.retry")}
              </Button>
              <Button
                onClick={onOpenExternal}
                variant="outline"
                className="min-h-9 gap-1.5 rounded-xl"
              >
                <ExternalLink className="size-3.5" />
                {t("terminal.failed.external")}
              </Button>
              <Button onClick={onClose} variant="ghost" className="min-h-9 rounded-xl">
                {t("terminal.btn.close")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
