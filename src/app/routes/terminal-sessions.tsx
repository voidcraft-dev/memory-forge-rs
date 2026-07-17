import { useEffect, useMemo, useState } from "react";
import { SquareTerminal, Terminal, X, Bot, Code, Sparkles, Orbit, Pi as PiIcon, MousePointer2, Gem, Folder, RotateCw, Square, ExternalLink, Copy, PenLine, Maximize2, Minimize2 } from "lucide-react";
import { api } from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import { EmbeddedTerminalPanel } from "@/features/terminal/embedded-terminal-panel";
import { useTerminal } from "@/features/terminal/terminal-context";
import { terminalTheme } from "@/features/terminal/terminal-theme";
import type { EmbeddedTerminalSession } from "@/features/terminal/terminal-types";
import { TerminalViewport } from "@/features/terminal/terminal-viewport";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
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

  // States for context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    terminal: EmbeddedTerminalSession;
  } | null>(null);

  // States for maximize mode
  const [isMaximized, setIsMaximized] = useState(false);

  const toggleMaximize = () => {
    const next = !isMaximized;
    setIsMaximized(next);
    window.dispatchEvent(new CustomEvent("toggle-terminal-maximize", { detail: next }));
  };

  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
    };
  }, []);

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent("toggle-terminal-maximize", { detail: false }));
    };
  }, []);

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
    <section className={cn(
      "flex h-full min-h-0 flex-col overflow-hidden bg-background transition-all",
      isMaximized ? "rounded-none border-none" : "rounded-[22px] border border-border/60"
    )}>
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
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center bg-background">
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
          <div className="flex h-11 shrink-0 items-end justify-between border-b border-border/30 bg-muted/20 px-4">
            <div className="flex items-end gap-1 overflow-x-auto overflow-y-hidden scrollbar-none">
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          terminal,
                        });
                      }}
                      className={cn(
                        "flex h-9 items-center gap-2 rounded-t-md border-t border-x px-3.5 pl-3.5 pr-8 text-xs font-semibold transition-all cursor-pointer select-none relative -mb-px z-10",
                        active
                          ? "bg-background text-emerald-400 border-border/40 border-b-transparent"
                          : "bg-transparent text-muted-foreground border-transparent hover:bg-muted/10 hover:text-foreground h-8 mb-0"
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
                          className="h-5 w-24 rounded border border-emerald-500/30 bg-background px-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
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
            
            {/* Compact Toolbar on the right side of tab bar */}
            {selectedTerminal && (
              <div className="flex items-center gap-3 shrink-0 h-9 mb-1 pl-4 ml-auto">
                {/* Active Terminal Status Badge & CWD */}
                {selectedTerminal.cwd && (
                  <div className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 select-all">
                    <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
                    <span
                      className="max-w-[200px] truncate font-mono text-[11px]"
                      title={selectedTerminal.cwd}
                    >
                      {selectedTerminal.cwd}
                    </span>
                  </div>
                )}

                {selectedTerminal.cwd && <div className="h-4 w-px bg-border/20 hidden lg:block" />}

                {/* Actions */}
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-400"
                    onClick={() => restartTerminal(selectedTerminal.id)}
                    title={t("terminal.btn.restart")}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                  
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "size-7 rounded-md transition-colors",
                      selectedTerminal.status === "stopping"
                        ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                        : "text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                    )}
                    onClick={() => {
                      if (selectedTerminal.status === "stopping") {
                        stopTerminal(selectedTerminal.id, true);
                      } else {
                        stopTerminal(selectedTerminal.id, false);
                      }
                    }}
                    title={selectedTerminal.status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}
                  >
                    <Square className="size-3.5" />
                  </Button>
                  
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    onClick={() => handleOpenExternal(selectedTerminal)}
                    title={t("terminal.btn.openExternal")}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    onClick={toggleMaximize}
                    title={isMaximized ? "恢复窗口 (Restore Layout)" : "最大化吃满窗口 (Maximize Layout)"}
                  >
                    {isMaximized ? (
                      <Minimize2 className="size-3.5" />
                    ) : (
                      <Maximize2 className="size-3.5" />
                    )}
                  </Button>

                  <div className="h-4 w-px bg-border/20 mx-1" />

                  {/* Running Count Stat */}
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground select-none pr-1">
                    <span className={cn("size-1.5 rounded-full", runningCount > 0 ? "bg-emerald-500 animate-pulse" : "bg-zinc-500")} />
                    <span className="tabular-nums">{runningCount}/{allTerminals.length}</span>
                  </div>
                </div>
              </div>
            )}
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

      {contextMenu && (() => {
        const menuWidth = 160;
        const menuHeight = 220;
        const x = Math.min(contextMenu.x, window.innerWidth - menuWidth - 8);
        const y = Math.min(contextMenu.y, window.innerHeight - menuHeight - 8);
        return (
          <div
            className="fixed z-50 min-w-[160px] rounded-xl border border-border/40 bg-popover/90 px-1.5 py-1.5 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{
              top: `${y}px`,
              left: `${x}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* rename */}
            <button
              onClick={() => {
                setEditingTerminalId(contextMenu.terminal.id);
                setEditingTitle(contextMenu.terminal.sessionTitle);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <PenLine className="size-3.5 opacity-80" />
              <span>{t("terminal.menu.rename")}</span>
            </button>

            {/* copy command */}
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(contextMenu.terminal.command);
                  setNotice(t("copied"));
                  setTimeout(() => setNotice(null), 2200);
                } catch {}
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <Copy className="size-3.5 opacity-80" />
              <span>{t("terminal.menu.copyCommand")}</span>
            </button>

            <div className="my-1 h-px bg-border/20" />

            {/* restart */}
            <button
              onClick={() => {
                restartTerminal(contextMenu.terminal.id);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <RotateCw className="size-3.5 opacity-80" />
              <span>{t("terminal.btn.restart")}</span>
            </button>

            {/* stop */}
            <button
              onClick={() => {
                if (contextMenu.terminal.status === "stopping") {
                  stopTerminal(contextMenu.terminal.id, true);
                } else {
                  stopTerminal(contextMenu.terminal.id, false);
                }
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <Square className="size-3.5 opacity-80" />
              <span>{contextMenu.terminal.status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}</span>
            </button>

            {/* open external */}
            <button
              onClick={() => {
                handleOpenExternal(contextMenu.terminal);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <ExternalLink className="size-3.5 opacity-80" />
              <span>{t("terminal.btn.openExternal")}</span>
            </button>

            <div className="my-1 h-px bg-border/20" />

            {/* close */}
            <button
              onClick={() => {
                handleClose(contextMenu.terminal);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors cursor-pointer"
            >
              <X className="size-3.5 opacity-80" />
              <span>{t("terminal.btn.close")}</span>
            </button>
          </div>
        );
      })()}

      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
