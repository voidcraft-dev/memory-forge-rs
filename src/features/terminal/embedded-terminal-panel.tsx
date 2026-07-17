import { useDesktop } from "@/features/desktop/provider";
import type { EmbeddedTerminalPanelProps } from "./terminal-types";
import { TerminalToolbar } from "./terminal-toolbar";
import { TerminalViewport } from "./terminal-viewport";
import { Button } from "@/components/ui/button";
import {
  Play,
  Loader2,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Terminal,
} from "lucide-react";

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
  mockLogs = [],
  children,
}: EmbeddedTerminalPanelProps) {
  const { t } = useDesktop();

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Toolbar is always visible at the top */}
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

      {/* Main Content Area based on Status */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {status === "idle" && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
            <div className="rounded-2xl bg-primary/5 p-4 mb-4 border border-primary/10">
              <Terminal className="size-8 text-primary" />
            </div>
            <h3 className="text-base font-bold mb-2">{t("terminal.idle.title")}</h3>
            <p className="text-sm text-muted-foreground mb-6">
              {t("terminal.idle.desc")}
            </p>
            <Button onClick={onStart} className="gap-2 rounded-xl">
              <Play className="size-4 fill-current" />
              {t("terminal.idle.btn")}
            </Button>
          </div>
        )}

        {status === "starting" && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Loader2 className="size-8 text-primary animate-spin mb-4" />
            <h3 className="text-sm font-semibold text-muted-foreground">
              {t("terminal.starting.title")}
            </h3>
          </div>
        )}

        {status === "running" && (
          <>
            {children ? (
              <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
                {children}
              </div>
            ) : (
              // Renders mock logs for Phase 0
              <TerminalViewport mockLogs={mockLogs} />
            )}
          </>
        )}

        {status === "stopping" && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-card/10">
            <Loader2 className="size-8 text-amber-500 animate-spin mb-4" />
            <h3 className="text-sm font-semibold text-amber-500/80">
              {t("terminal.status.stopping")}...
            </h3>
          </div>
        )}

        {status === "exited" && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-md mx-auto">
            <div className="rounded-2xl bg-zinc-500/5 p-4 mb-4 border border-zinc-500/10">
              <CheckCircle className="size-8 text-muted-foreground" />
            </div>
            <h3 className="text-base font-bold mb-2">
              {t("terminal.exited.title", { code: exitCode !== undefined && exitCode !== null ? String(exitCode) : "0" })}
            </h3>
            <div className="flex items-center gap-2 mt-4">
              <Button onClick={onRestart} variant="outline" className="rounded-xl">
                {t("terminal.failed.retry")}
              </Button>
              <Button onClick={onClose} variant="ghost" className="rounded-xl">
                {t("terminal.btn.close")}
              </Button>
            </div>
          </div>
        )}

        {status === "failed" && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto">
            <div className="rounded-2xl bg-red-500/5 p-4 mb-4 border border-red-500/10">
              <AlertTriangle className="size-8 text-red-500" />
            </div>
            <h3 className="text-base font-bold mb-2">{t("terminal.failed.title")}</h3>
            {errorMessage && (
              <p className="text-xs font-mono bg-red-500/5 border border-red-500/10 p-3 rounded-lg text-red-400 break-all mb-6 text-left max-w-md">
                {errorMessage}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={onRestart} className="rounded-xl">
                {t("terminal.failed.retry")}
              </Button>
              <Button onClick={onOpenExternal} variant="outline" className="gap-1.5 rounded-xl">
                <ExternalLink className="size-3.5" />
                {t("terminal.failed.external")}
              </Button>
              <Button onClick={onClose} variant="ghost" className="rounded-xl">
                {t("terminal.btn.close")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
