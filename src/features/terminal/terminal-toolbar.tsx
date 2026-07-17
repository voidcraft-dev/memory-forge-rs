import { useEffect, useState } from "react";
import {
  RotateCcw,
  Square,
  Flame,
  ExternalLink,
  Folder,
  X,
  AlertTriangle,
} from "lucide-react";
import { useDesktop } from "@/features/desktop/provider";
import type { TerminalUiStatus } from "./terminal-types";
import { terminalTheme } from "./terminal-theme";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TerminalToolbarProps {
  status: TerminalUiStatus;
  commandKind: "resume" | "fork" | "shell";
  cwd: string | null;
  onRestart: () => void;
  onStop: () => void;
  onForceStop: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
}

export function TerminalToolbar({
  status,
  commandKind,
  cwd,
  onRestart,
  onStop,
  onForceStop,
  onOpenExternal,
  onClose,
}: TerminalToolbarProps) {
  const { t } = useDesktop();
  const [showForceStopConfirm, setShowForceStopConfirm] = useState(false);

  const statusConfig = terminalTheme.statusConfig[status] || terminalTheme.statusConfig.idle;

  useEffect(() => {
    if (status !== "stopping") setShowForceStopConfirm(false);
  }, [status]);

  const handleStopClick = () => {
    if (status === "stopping") {
      setShowForceStopConfirm(true);
    } else {
      onStop();
    }
  };

  const handleForceStopConfirm = () => {
    onForceStop();
    setShowForceStopConfirm(false);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/20 bg-[#0d1117] px-5 py-2.5 md:px-6">
      {/* Left side: status & CWD */}
      <div className="flex flex-wrap items-center gap-3 min-w-0">
        {/* Status Indicator */}
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 border text-[11px] font-semibold tracking-wide",
            statusConfig.bg,
            statusConfig.color
          )}
        >
          <span className={cn("size-1.5 rounded-full motion-reduce:animate-none", statusConfig.dot)} />
          <span className="capitalize">{t(`terminal.status.${status}` as any)}</span>
        </div>

        {/* Command type badge */}
        <div className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
          {commandKind}
        </div>

        {/* CWD Truncated path with Tooltip */}
        {cwd && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="max-w-[140px] cursor-help truncate border-b border-dashed border-muted-foreground/30 transition-colors hover:border-foreground/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[220px] md:max-w-[340px] lg:max-w-[480px]"
                  tabIndex={0}
                >
                  {cwd}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="max-w-md select-all font-mono text-[10px] break-all">
                {cwd}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Right side: controls */}
      <div className="flex flex-wrap items-center gap-2">
        {showForceStopConfirm ? (
          <div
            className="flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 p-0.5 animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none"
            role="alert"
          >
            <span className="flex items-center gap-1 px-2 text-[10px] font-bold text-red-400">
              <AlertTriangle className="size-3 shrink-0" />
              {t("terminal.btn.confirmForceStop")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground hover:bg-muted"
              onClick={() => setShowForceStopConfirm(false)}
            >
              {t("terminal.btn.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 gap-1 px-2.5 text-xs"
              onClick={handleForceStopConfirm}
            >
              <Flame className="size-3" />
              {t("terminal.btn.forceStop")}
            </Button>
          </div>
        ) : (
          <>
            {/* Restart Button */}
            {(status === "exited" || status === "failed" || status === "running") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 gap-1.5 rounded-lg border border-border/20 hover:bg-emerald-500/10 hover:text-emerald-400"
                onClick={onRestart}
                title={t("terminal.btn.restart")}
                aria-label={t("terminal.btn.restart")}
              >
                <RotateCcw className="size-3.5" />
                <span className="hidden md:inline">{t("terminal.btn.restart")}</span>
              </Button>
            )}

            {/* Stop Button */}
            {(status === "running" || status === "starting" || status === "stopping") && (
              <Button
                variant={status === "stopping" ? "destructive" : "ghost"}
                size="sm"
                className={cn(
                  "h-9 gap-1.5 rounded-lg border border-border/20 transition-colors",
                  status === "stopping"
                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border-red-500/30"
                    : "hover:bg-red-500/10 hover:text-red-400"
                )}
                onClick={handleStopClick}
                title={status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}
                aria-label={status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}
              >
                {status === "stopping" ? (
                  <Flame className="size-3.5 text-red-400" />
                ) : (
                  <Square className="size-3.5 fill-current" />
                )}
                <span className="hidden md:inline">
                  {status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}
                </span>
              </Button>
            )}

            {/* Open Externally Button */}
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 rounded-lg border border-border/20 hover:bg-primary/10 hover:text-primary"
              onClick={onOpenExternal}
              title={t("terminal.btn.openExternal")}
              aria-label={t("terminal.btn.openExternal")}
            >
              <ExternalLink className="size-3.5" />
              <span className="hidden md:inline">{t("terminal.btn.openExternal")}</span>
            </Button>

            {/* Close Button */}
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 rounded-lg border border-border/20 hover:bg-red-500/10 hover:text-red-400"
              onClick={onClose}
              title={t("terminal.btn.close")}
              aria-label={t("terminal.btn.close")}
            >
              <X className="size-3.5" />
              <span className="hidden md:inline">{t("terminal.btn.close")}</span>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
