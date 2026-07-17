import { useEffect, useMemo, useState } from "react";
import { Clock3, Folder, Layers3, SquareTerminal, Terminal } from "lucide-react";
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

function platformLabel(platform: string | null) {
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
    kiro: "Kiro CLI",
    "kiro-ide": "Kiro IDE",
    gemini: "Gemini CLI",
    grok: "Grok Build",
    pi: "Pi",
  };
  return platform ? labels[platform] ?? platform : "CLI";
}

export default function TerminalSessionsPage() {
  const { snapshot, t } = useDesktop();
  const {
    terminals,
    activeTerminalId,
    setActiveTerminal,
    restartTerminal,
    stopTerminal,
    closeTerminal,
  } = useTerminal();
  const { confirm, dialogProps } = useConfirmDialog();
  const [notice, setNotice] = useState<string | null>(null);

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

  const locale = snapshot?.settings.locale === "en" ? "en-US" : "zh-CN";

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-border/60 bg-white/4">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border/60 bg-card/45 px-5 py-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 shadow-sm">
            <SquareTerminal className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground">
              {t("terminal.workspace.title")}
            </h2>
            <p className="mt-0.5 max-w-3xl text-xs leading-5 text-muted-foreground">
              {t("terminal.workspace.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/55 px-3 py-1.5 text-xs font-semibold text-muted-foreground tabular-nums">
          <span className="size-2 rounded-full bg-emerald-500" />
          {t("terminal.workspace.runningCount", {
            running: runningCount,
            total: allTerminals.length,
          })}
        </div>
      </header>

      {notice && (
        <div
          className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-5 py-2.5 text-xs font-medium text-amber-500 md:px-6"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-52 w-full shrink-0 flex-col border-b border-border/60 bg-card/20 md:max-h-none md:w-72 md:border-r md:border-b-0 lg:w-80">
          <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
              <Layers3 className="size-3.5" />
              {t("terminal.workspace.collection")}
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground tabular-nums">
              {allTerminals.length}
            </span>
          </div>

          <div
            className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5"
            role="listbox"
            aria-label={t("terminal.tabsLabel")}
          >
            {allTerminals.map((terminal) => {
              const active = terminal.id === selectedTerminal?.id;
              const statusConfig = terminalTheme.statusConfig[terminal.status];
              return (
                <button
                  key={terminal.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => setActiveTerminal(terminal.id)}
                  className={cn(
                    "group w-full cursor-pointer rounded-2xl border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                    active
                      ? "border-primary/30 bg-primary/8 shadow-sm shadow-primary/5"
                      : "border-transparent bg-background/25 hover:border-border/70 hover:bg-background/55"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border",
                        statusConfig.bg,
                        statusConfig.color
                      )}
                    >
                      <Terminal className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {terminal.sessionTitle}
                        </span>
                        <span className={cn("size-1.5 shrink-0 rounded-full", statusConfig.dot)} />
                      </div>
                      <p className="mt-1 truncate text-[11px] font-medium text-muted-foreground">
                        {t("terminal.workspace.source", {
                          platform: platformLabel(terminal.platform),
                        })}
                        <span className="px-1.5 text-border">·</span>
                        <span className="uppercase">{terminal.commandKind}</span>
                      </p>
                      <p className="mt-1.5 flex items-center gap-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
                        <Folder className="size-3 shrink-0" />
                        <span className="truncate">{terminal.cwd || "~"}</span>
                      </p>
                      <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/55">
                        <Clock3 className="size-3" />
                        {t("terminal.workspace.openedAt", {
                          time: new Date(terminal.createdAt).toLocaleTimeString(locale, {
                            hour: "2-digit",
                            minute: "2-digit",
                          }),
                        })}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0d1117]">
          {allTerminals.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
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
            allTerminals.map((terminal) => {
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
            })
          )}
        </div>
      </div>

      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
