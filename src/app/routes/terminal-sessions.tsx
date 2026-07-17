import { useEffect, useMemo, useState } from "react";
import { SquareTerminal, Terminal, X, Bot, Code, Sparkles, Orbit, Pi as PiIcon, MousePointer2, Gem } from "lucide-react";
import { api } from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import { EmbeddedTerminalPanel } from "@/features/terminal/embedded-terminal-panel";
import { useTerminal } from "@/features/terminal/terminal-context";
import { terminalTheme } from "@/features/terminal/terminal-theme";
import type { EmbeddedTerminalSession } from "@/features/terminal/terminal-types";
import { TerminalViewport } from "@/features/terminal/terminal-viewport";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"]);

function formatSessionTitle(title: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title);
  if (isUuid) {
    return title.split("-")[0];
  }
  return title;
}

const platformConfigs: Record<string, { label: string; icon: any; color: string; hoverColor: string }> = {
  claude: { label: "Claude", icon: Bot, color: "text-amber-400", hoverColor: "group-hover:text-amber-300" },
  codex: { label: "Codex", icon: Terminal, color: "text-blue-400", hoverColor: "group-hover:text-blue-300" },
  cursor: { label: "Cursor", icon: MousePointer2, color: "text-sky-400", hoverColor: "group-hover:text-sky-300" },
  opencode: { label: "OpenCode", icon: Code, color: "text-emerald-400", hoverColor: "group-hover:text-emerald-300" },
  kiro: { label: "Kiro CLI", icon: Sparkles, color: "text-purple-400", hoverColor: "group-hover:text-purple-300" },
  "kiro-ide": { label: "Kiro IDE", icon: Sparkles, color: "text-purple-400", hoverColor: "group-hover:text-purple-300" },
  gemini: { label: "Gemini", icon: Gem, color: "text-rose-400", hoverColor: "group-hover:text-rose-300" },
  grok: { label: "Grok", icon: Orbit, color: "text-cyan-400", hoverColor: "group-hover:text-cyan-300" },
  pi: { label: "Pi", icon: PiIcon, color: "text-pink-400", hoverColor: "group-hover:text-pink-300" },
};

function getPlatformConfig(platform: string | null) {
  return platformConfigs[platform || ""] || { label: "CLI", icon: Terminal, color: "text-zinc-400", hoverColor: "group-hover:text-zinc-300" };
}

export default function TerminalSessionsPage() {
  const { t } = useDesktop();
  const {
    terminals,
    activeTerminalId,
    setActiveTerminal,
    restartTerminal,
    stopTerminal,
    closeTerminal,
    renameTerminal,
  } = useTerminal();
  const { confirm, dialogProps } = useConfirmDialog();
  const [notice, setNotice] = useState<string | null>(null);

  // States for renaming tab
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");

  const handleSaveRename = (terminalId: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      renameTerminal(terminalId, trimmed);
    }
    setEditingTerminalId(null);
  };

  const allTerminals = useMemo(
    () =>
      Object.values(terminals)
        .flat()
        .sort((a, b) => b.createdAt - a.createdAt),
    [terminals]
  );
  const selectedTerminal =
    allTerminals.find((terminal) => terminal.id === activeTerminalId) ??
    allTerminals[0] ??
    null;
  const runningCount = allTerminals.filter((terminal) =>
    ACTIVE_STATUSES.has(terminal.status)
  ).length;

  useEffect(() => {
    if (selectedTerminal && selectedTerminal.id !== activeTerminalId) {
      setActiveTerminal(selectedTerminal.id);
    } else if (!selectedTerminal && activeTerminalId) {
      setActiveTerminal(null);
    }
  }, [activeTerminalId, selectedTerminal, setActiveTerminal]);

  const handleClose = async (terminal: EmbeddedTerminalSession) => {
    if (ACTIVE_STATUSES.has(terminal.status)) {
      const accepted = await confirm({
        title: t("terminal.closeRunningTitle"),
        description: t("terminal.closeRunningDesc"),
        variant: "danger",
      });
      if (!accepted) return;
    }
    await closeTerminal(terminal.sessionKey, terminal.id);
  };

  const handleOpenExternal = async (terminal: EmbeddedTerminalSession) => {
    setNotice(null);
    try {
      await api.launchSessionTerminal(terminal.command, terminal.cwd);
    } catch {
      try {
        await navigator.clipboard.writeText(terminal.command);
      } catch {
        // The actionable error below is still useful if clipboard access is unavailable.
      }
      setNotice(t("terminal.workspace.externalFailed"));
    }
  };


  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-border/60 bg-[#0d1117]">
      {notice && (
        <div
          className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-5 py-2.5 text-xs font-medium text-amber-500 md:px-6"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      )}

      {allTerminals.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center bg-[#0d1117]">
          <div className="mb-5 flex size-16 items-center justify-center rounded-[22px] border border-emerald-500/15 bg-emerald-500/8 text-emerald-400">
            <SquareTerminal className="size-7" />
          </div>
          <h3 className="text-base font-bold text-white">
            {t("terminal.workspace.emptyTitle")}
          </h3>
          <p className="mt-2 max-w-lg text-sm leading-6 text-zinc-400">
            {t("terminal.workspace.emptyDesc")}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Custom Terminal Tabs Bar at the top */}
          <div className="flex h-11 shrink-0 items-end justify-between border-b border-border/30 bg-[#090c10] px-4">
            <div className="flex items-end gap-1 overflow-x-auto scrollbar-none">
              {allTerminals.map((terminal) => {
                const active = terminal.id === selectedTerminal?.id;
                const statusConfig = terminalTheme.statusConfig[terminal.status];
                const config = getPlatformConfig(terminal.platform);
                const PlatformIcon = config.icon;
                return (
                  <div key={terminal.id} className="relative flex items-end group">
                    <button
                      type="button"
                      onClick={() => setActiveTerminal(terminal.id)}
                      className={cn(
                        "flex h-9 items-center gap-2 rounded-t-md border-t border-x px-3.5 pl-3.5 pr-8 text-xs font-semibold transition-all cursor-pointer select-none relative -mb-px z-10",
                        active
                          ? "bg-[#0d1117] text-emerald-400 border-border/40 border-b-transparent"
                          : "bg-[#090c10]/80 text-muted-foreground border-transparent hover:bg-[#161b22]/50 hover:text-foreground h-8 mb-0"
                      )}
                    >
                      <PlatformIcon className={cn("size-3.5 shrink-0 transition-colors duration-200", active ? config.color : "text-muted-foreground/80 " + config.hoverColor)} />
                      {editingTerminalId === terminal.id ? (
                        <input
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onBlur={() => handleSaveRename(terminal.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveRename(terminal.id);
                            if (e.key === "Escape") setEditingTerminalId(null);
                          }}
                          className="h-5 w-24 rounded border border-emerald-500/30 bg-[#0d1117] px-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="max-w-[120px] truncate cursor-text hover:underline decoration-dotted decoration-zinc-500/45"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditingTerminalId(terminal.id);
                            setEditingTitle(terminal.sessionTitle);
                          }}
                          title="双击重命名 (Double-click to rename)"
                        >
                          {formatSessionTitle(terminal.sessionTitle)}
                        </span>
                      )}
                      <span className={cn("text-[10px] font-bold shrink-0 opacity-80", active ? config.color : "text-muted-foreground/60 " + config.hoverColor)}>
                        ({config.label})
                      </span>
                      <span className={cn("size-1.5 shrink-0 rounded-full", statusConfig.dot)} />
                    </button>
                    {/* Close Tab Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClose(terminal);
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded-md text-muted-foreground/40 hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer"
                      title={t("terminal.btn.close")}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            
            {/* Quick stats on the right side of tab bar */}
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground tabular-nums select-none shrink-0 pl-4">
              <span className="size-2 rounded-full bg-emerald-500" />
              <span>
                {t("terminal.workspace.runningCount", {
                  running: runningCount,
                  total: allTerminals.length,
                })}
              </span>
            </div>
          </div>

          {/* Viewports Container */}
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0d1117]">
            {allTerminals.map((terminal) => {
              const active = terminal.id === selectedTerminal?.id;
              return (
                <div
                  key={terminal.id}
                  className={cn("absolute inset-0 min-h-0", active ? "flex" : "hidden")}
                  aria-hidden={!active}
                >
                  <EmbeddedTerminalPanel
                    status={terminal.status}
                    commandKind={terminal.commandKind}
                    cwd={terminal.cwd}
                    exitCode={terminal.exitCode}
                    errorMessage={terminal.errorMessage}
                    onStart={() => void restartTerminal(terminal.id)}
                    onStop={() => void stopTerminal(terminal.id, false)}
                    onForceStop={() => void stopTerminal(terminal.id, true)}
                    onRestart={() => void restartTerminal(terminal.id)}
                    onOpenExternal={() => void handleOpenExternal(terminal)}
                    onClose={() => void handleClose(terminal)}
                  >
                    <TerminalViewport terminalId={terminal.id} isActive={active} />
                  </EmbeddedTerminalPanel>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
