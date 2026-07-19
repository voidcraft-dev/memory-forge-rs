import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Code,
  Copy,
  ExternalLink,
  Folder,
  Gem,
  Maximize2,
  Minimize2,
  MousePointer2,
  Orbit,
  PenLine,
  Pi as PiIcon,
  RotateCw,
  Sparkles,
  Square,
  SquareTerminal,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
import { useDesktop } from "@/features/desktop/provider";
import { EmbeddedTerminalPanel } from "@/features/terminal/embedded-terminal-panel";
import { useTerminal } from "@/features/terminal/terminal-context";
import { useRemoteTerminal } from "@/features/terminal/remote-terminal-context";
import { terminalTheme } from "@/features/terminal/terminal-theme";
import type { EmbeddedTerminalSession } from "@/features/terminal/terminal-types";
import { TerminalViewport } from "@/features/terminal/terminal-viewport";
import { RemoteTerminalComposer } from "@/features/terminal/remote-terminal-composer";
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

const platformConfigs: Record<
  string,
  { label: string; icon: LucideIcon; color: string; hoverColor: string }
> = {
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
  const { t, isRemote } = useDesktop();
  const localTerminal = useTerminal();
  const remoteTerminal = useRemoteTerminal();
  const {
    terminals,
    activeTerminalId,
    setActiveTerminal,
    restartTerminal,
    stopTerminal,
    closeTerminal,
    renameTerminal,
  } = isRemote ? remoteTerminal : localTerminal;
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
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
      window.removeEventListener("keydown", handleGlobalKeyDown);
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
  const canRestart = selectedTerminal
    ? ["running", "exited", "failed"].includes(selectedTerminal.status)
    : false;
  const canStop = selectedTerminal
    ? ACTIVE_STATUSES.has(selectedTerminal.status)
    : false;

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

  const handleStop = async (terminal: EmbeddedTerminalSession) => {
    if (terminal.status === "stopping") {
      const accepted = await confirm({
        title: t("terminal.btn.confirmForceStop"),
        description: t("terminal.forceStopDesc"),
        variant: "danger",
      });
      if (!accepted) return;
      await stopTerminal(terminal.id, true);
      return;
    }
    if (terminal.status === "starting" || terminal.status === "running") {
      await stopTerminal(terminal.id, false);
    }
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
    <section
      data-terminal-status={selectedTerminal?.status ?? "idle"}
      className={cn(
      "flex h-full min-h-0 flex-col overflow-hidden bg-background transition-all",
      isRemote && "remote-terminal-workspace",
      isMaximized ? "rounded-none border-none" : "rounded-[22px] border border-border/60"
      )}
    >
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
          <h3 className="text-base font-bold text-foreground">
            {t("terminal.workspace.emptyTitle")}
          </h3>
          <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            {t("terminal.workspace.emptyDesc")}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Custom Terminal Tabs Bar at the top */}
          <div className="terminal-workspace-tabs flex h-11 shrink-0 items-end justify-between border-b border-border/30 bg-muted/20 px-4">
            <div
              className="terminal-workspace-tablist flex items-end gap-1 overflow-x-auto overflow-y-hidden scrollbar-none"
              role="tablist"
              aria-label={t("terminal.tabsLabel")}
            >
              {allTerminals.map((terminal) => {
                const active = terminal.id === selectedTerminal?.id;
                const statusConfig = terminalTheme.statusConfig[terminal.status];
                const config = getPlatformConfig(terminal.platform);
                const PlatformIcon = config.icon;
                const statusLabel = t(
                  `terminal.status.${terminal.status}` as MessageKey
                );
                const displayTitle = formatSessionTitle(terminal.sessionTitle);
                return (
                  <div key={terminal.id} className="group relative flex shrink-0 items-end">
                    {editingTerminalId === terminal.id ? (
                      <div
                        className={cn(
                          "relative z-10 -mb-px flex h-9 items-center gap-2 rounded-t-md border-x border-t px-3.5 pr-10 text-xs font-semibold",
                          active
                            ? "border-border/40 border-b-transparent bg-background text-emerald-400"
                            : "border-border/30 bg-muted/10 text-foreground"
                        )}
                      >
                        <PlatformIcon
                          className={cn("size-3.5 shrink-0", config.color)}
                        />
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
                          aria-label={t("terminal.menu.rename")}
                        />
                        <span className={cn("shrink-0 text-[10px] font-bold", config.color)}>
                          ({config.label})
                        </span>
                        <span className={cn("size-1.5 shrink-0 rounded-full", statusConfig.dot)} />
                      </div>
                    ) : (
                      <button
                        id={`terminal-tab-${terminal.id}`}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-controls={`terminal-panel-${terminal.id}`}
                        aria-label={`${displayTitle} (${config.label}) · ${statusLabel}`}
                        onClick={() => setActiveTerminal(terminal.id)}
                        onDoubleClick={() => {
                          setActiveTerminal(terminal.id);
                          setEditingTerminalId(terminal.id);
                          setEditingTitle(terminal.sessionTitle);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            terminal,
                          });
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ContextMenu" ||
                            (event.shiftKey && event.key === "F10")
                          ) {
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            setContextMenu({
                              x: rect.left,
                              y: rect.bottom + 4,
                              terminal,
                            });
                            return;
                          }
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          const index = allTerminals.findIndex(
                            (candidate) => candidate.id === terminal.id
                          );
                          const offset = event.key === "ArrowRight" ? 1 : -1;
                          const next =
                            allTerminals[
                              (index + offset + allTerminals.length) % allTerminals.length
                            ];
                          setActiveTerminal(next.id);
                          requestAnimationFrame(() => {
                            document.getElementById(`terminal-tab-${next.id}`)?.focus();
                          });
                        }}
                        className={cn(
                          "relative z-10 -mb-px flex h-9 cursor-pointer select-none items-center gap-2 rounded-t-md border-x border-t px-3.5 pr-10 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-inset",
                          active
                            ? "border-border/40 border-b-transparent bg-background text-emerald-400"
                            : "mb-0 h-8 border-transparent bg-transparent text-muted-foreground hover:bg-muted/10 hover:text-foreground"
                        )}
                      >
                        <PlatformIcon
                          className={cn(
                            "size-3.5 shrink-0 transition-colors duration-200",
                            active
                              ? config.color
                              : `text-muted-foreground/80 ${config.hoverColor}`
                          )}
                        />
                        <span
                          className="max-w-[120px] truncate cursor-text hover:underline decoration-dotted decoration-zinc-500/45"
                          title={t("terminal.renameHint")}
                        >
                          {displayTitle}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-[10px] font-bold opacity-80",
                            active
                              ? config.color
                              : `text-muted-foreground/60 ${config.hoverColor}`
                          )}
                        >
                          ({config.label})
                        </span>
                        <span className={cn("size-1.5 shrink-0 rounded-full", statusConfig.dot)} />
                      </button>
                    )}
                    {/* Close Tab Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleClose(terminal);
                      }}
                      className="absolute right-0.5 top-1/2 z-20 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/45"
                      title={t("terminal.btn.close")}
                      aria-label={`${t("terminal.btn.close")}: ${displayTitle}`}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            
            {/* Compact Toolbar on the right side of tab bar */}
            {selectedTerminal && (
              <div className="terminal-workspace-toolbar flex items-center gap-3 shrink-0 h-9 mb-1 pl-4 ml-auto">
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
                  {canRestart && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-md text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-400"
                      onClick={() => void restartTerminal(selectedTerminal.id)}
                      title={t("terminal.btn.restart")}
                      aria-label={t("terminal.btn.restart")}
                    >
                      <RotateCw className="size-3.5" />
                    </Button>
                  )}
                  
                  {canStop && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "size-7 rounded-md transition-colors",
                        selectedTerminal.status === "stopping"
                          ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                          : "text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                      )}
                      onClick={() => void handleStop(selectedTerminal)}
                      title={selectedTerminal.status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}
                      aria-label={selectedTerminal.status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}
                    >
                      <Square className="size-3.5" />
                    </Button>
                  )}
                  
                   {!isRemote && (
                     <Button
                       variant="ghost"
                       size="icon"
                       className="size-7 rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                       onClick={() => void handleOpenExternal(selectedTerminal)}
                       title={t("terminal.btn.openExternal")}
                       aria-label={t("terminal.btn.openExternal")}
                     >
                       <ExternalLink className="size-3.5" />
                     </Button>
                   )}

                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    onClick={toggleMaximize}
                    title={isMaximized ? t("terminal.btn.restoreLayout") : t("terminal.btn.maximize")}
                    aria-label={isMaximized ? t("terminal.btn.restoreLayout") : t("terminal.btn.maximize")}
                    aria-pressed={isMaximized}
                  >
                    {isMaximized ? (
                      <Minimize2 className="size-3.5" />
                    ) : (
                      <Maximize2 className="size-3.5" />
                    )}
                  </Button>

                  <div className="h-4 w-px bg-border/20 mx-1" />

                  {/* Running Count Stat */}
                  <div
                    className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground select-none pr-1"
                    role="status"
                    aria-label={t("terminal.workspace.runningCount", {
                      running: runningCount,
                      total: allTerminals.length,
                    })}
                  >
                    <span className={cn("size-1.5 rounded-full", runningCount > 0 ? "bg-emerald-500 animate-pulse" : "bg-zinc-500")} />
                    <span className="tabular-nums">{runningCount}/{allTerminals.length}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Viewports Container */}
          <div className="terminal-workspace-viewports relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0d1117]">
            {allTerminals.map((terminal) => {
              const active = terminal.id === selectedTerminal?.id;
              return (
                <div
                  key={terminal.id}
                  id={`terminal-panel-${terminal.id}`}
                  role="tabpanel"
                  aria-labelledby={`terminal-tab-${terminal.id}`}
                  className={cn("absolute inset-0 min-h-0", active ? "flex" : "hidden")}
                  aria-hidden={!active}
                >
                  <EmbeddedTerminalPanel
                    status={terminal.status}
                    exitCode={terminal.exitCode}
                    errorMessage={terminal.errorMessage}
                    onStart={() => void restartTerminal(terminal.id)}
                    onRestart={() => void restartTerminal(terminal.id)}
                    onOpenExternal={() => void handleOpenExternal(terminal)}
                    onClose={() => void handleClose(terminal)}
                  >
                     <TerminalViewport
                       terminalId={terminal.id}
                       isActive={active}
                       transport={isRemote ? remoteTerminal : undefined}
                     />
                  </EmbeddedTerminalPanel>
                </div>
              );
            })}
          </div>
          {isRemote && selectedTerminal && (
            <RemoteTerminalComposer
              terminalId={selectedTerminal.id}
              transport={remoteTerminal}
              disabled={selectedTerminal.status !== "running"}
            />
          )}
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
            role="menu"
            aria-label={contextMenu.terminal.sessionTitle}
            tabIndex={-1}
            style={{
              top: `${y}px`,
              left: `${x}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {/* rename */}
            <button
              type="button"
              onClick={() => {
                setActiveTerminal(contextMenu.terminal.id);
                setEditingTerminalId(contextMenu.terminal.id);
                setEditingTitle(contextMenu.terminal.sessionTitle);
                setContextMenu(null);
              }}
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <PenLine className="size-3.5 opacity-80" />
              <span>{t("terminal.menu.rename")}</span>
            </button>

            {/* copy command */}
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(contextMenu.terminal.command);
                  setNotice(t("copied"));
                  setTimeout(() => setNotice(null), 2200);
                } catch (error) {
                  console.error("Failed to copy terminal command:", error);
                }
                setContextMenu(null);
              }}
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <Copy className="size-3.5 opacity-80" />
              <span>{t("terminal.menu.copyCommand")}</span>
            </button>

            <div className="my-1 h-px bg-border/20" />

            {/* restart */}
            <button
              type="button"
              onClick={() => {
                void restartTerminal(contextMenu.terminal.id);
                setContextMenu(null);
              }}
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              <RotateCw className="size-3.5 opacity-80" />
              <span>{t("terminal.btn.restart")}</span>
            </button>

            {/* stop */}
            <button
              type="button"
              onClick={() => {
                void handleStop(contextMenu.terminal);
                setContextMenu(null);
              }}
              role="menuitem"
              disabled={!ACTIVE_STATUSES.has(contextMenu.terminal.status)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Square className="size-3.5 opacity-80" />
              <span>{contextMenu.terminal.status === "stopping" ? t("terminal.btn.forceStop") : t("terminal.btn.stop")}</span>
            </button>

            {!isRemote && (
              <>
                {/* open external */}
                <button
                  type="button"
                  onClick={() => {
                    void handleOpenExternal(contextMenu.terminal);
                    setContextMenu(null);
                  }}
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                >
                  <ExternalLink className="size-3.5 opacity-80" />
                  <span>{t("terminal.btn.openExternal")}</span>
                </button>
              </>
            )}

            <div className="my-1 h-px bg-border/20" />

            {/* close */}
            <button
              type="button"
              onClick={() => {
                void handleClose(contextMenu.terminal);
                setContextMenu(null);
              }}
              role="menuitem"
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
