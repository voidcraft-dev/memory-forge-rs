import React from "react";
import { MessageSquare, Terminal as TerminalIcon, X } from "lucide-react";
import { useDesktop } from "@/features/desktop/provider";
import type { EmbeddedTerminalSession } from "./terminal-types";
import { terminalTheme } from "./terminal-theme";
import { cn } from "@/lib/utils";

interface TerminalTabStripProps {
  activeTab: string;
  onTabChange: (tabId: string) => void;
  terminals: EmbeddedTerminalSession[];
  onCloseTab: (terminalId: string, e: React.MouseEvent) => void;
}

export function TerminalTabStrip({
  activeTab,
  onTabChange,
  terminals,
  onCloseTab,
}: TerminalTabStripProps) {
  const { t } = useDesktop();

  return (
    <div className="flex items-center gap-1 border-b bg-card/10 px-5 py-1.5 md:px-6 select-none overflow-x-auto scrollbar-none">
      {/* Session Record Tab */}
      <button
        type="button"
        onClick={() => onTabChange("record")}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all cursor-pointer border",
          activeTab === "record"
            ? "bg-primary/10 text-primary border-primary/20"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent"
        )}
      >
        <MessageSquare className="size-3.5 shrink-0" />
        <span>{t("terminal.sessionRecord")}</span>
      </button>

      {/* Terminal Tabs */}
      {terminals.map((term) => {
        const isActive = activeTab === term.id;
        const config = terminalTheme.statusConfig[term.status] || terminalTheme.statusConfig.idle;
        
        return (
          <div key={term.id} className="relative flex items-center group">
            <button
              type="button"
              onClick={() => onTabChange(term.id)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg pl-3 pr-8 text-xs font-semibold transition-all cursor-pointer border",
                isActive
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent"
              )}
            >
              <TerminalIcon className="size-3.5 shrink-0 opacity-80" />
              <span>{t("terminal.tabTitle", { kind: term.title })}</span>
              
              {/* Status dot */}
              <span className={cn("size-1.5 rounded-full shrink-0", config.dot)} />
            </button>

            {/* Close button inside tab */}
            <button
              type="button"
              onClick={(e) => onCloseTab(term.id, e)}
              className={cn(
                "absolute right-1.5 top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer",
                isActive ? "text-emerald-400/60 hover:text-red-400" : ""
              )}
              title={t("terminal.btn.close")}
              aria-label={t("terminal.btn.close")}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
