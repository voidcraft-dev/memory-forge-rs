import React, { createContext, useContext, useState, useRef } from "react";
import type { TerminalUiStatus, EmbeddedTerminalSession } from "./terminal-types";

interface TerminalContextType {
  terminals: Record<string, EmbeddedTerminalSession[]>;
  activeTabIds: Record<string, string>;
  setActiveTab: (sessionKey: string, tabId: string) => void;
  startTerminal: (sessionKey: string, commandKind: "resume" | "fork", command: string, cwd: string | null) => string;
  restartTerminal: (terminalId: string) => void;
  stopTerminal: (terminalId: string, force: boolean) => void;
  closeTerminal: (sessionKey: string, terminalId: string) => void;
  setTerminalStatus: (terminalId: string, status: TerminalUiStatus, exitCode?: number | null, error?: string | null) => void;
}

const TerminalContext = createContext<TerminalContextType | null>(null);

const MOCK_STARTUP_LOGS_RESUME = [
  "\x1b[1;36m[Phase 0 Mock] Memory Forge Embedded PTY Engine Initialized.\x1b[0m",
  "\x1b[33m[Phase 0 Mock] System Host: Windows ConPTY integration ready.\x1b[0m",
  "\x1b[90m[Phase 0 Mock] Spawning PTY session worker thread...\x1b[0m",
  "",
  "\x1b[1;32m> Executing command:\x1b[0m {command}",
  "\x1b[1;32m> Working directory:\x1b[0m {cwd}",
  "",
  "----------------------------------------------------------------",
  "\x1b[1;35mWelcome to Memory Forge Embedded Terminal (Phase 0 UI Shell)\x1b[0m",
  "\x1b[36mThis is a visual preview mock. Real xterm.js terminal is not connected.\x1b[0m",
  "\x1b[36mBackend hooks will be connected in Phase 1.\x1b[0m",
  "----------------------------------------------------------------",
  "",
  "\x1b[1mCodex CLI v1.4.2 starting...\x1b[0m",
  "Reading local sqlite database schema...",
  "Scanning workspace filesystem directories...",
  "Loading active context: 14 messages (approx. 2480 tokens).",
  "\x1b[32m✔ Context loaded successfully.\x1b[0m",
  "",
  "\x1b[33m[Codex] Ready. Enter code or command to prompt AI.\x1b[0m",
  "codex-session-bash$ \x1b[5m█\x1b[0m"
];

const MOCK_STARTUP_LOGS_FORK = [
  "\x1b[1;36m[Phase 0 Mock] Memory Forge Embedded PTY Engine Initialized.\x1b[0m",
  "\x1b[33m[Phase 0 Mock] System Host: Windows ConPTY integration ready.\x1b[0m",
  "\x1b[90m[Phase 0 Mock] Spawning PTY session worker thread...\x1b[0m",
  "",
  "\x1b[1;34m> Executing command (FORK):\x1b[0m {command}",
  "\x1b[1;34m> Working directory:\x1b[0m {cwd}",
  "",
  "----------------------------------------------------------------",
  "\x1b[1;35mWelcome to Memory Forge Embedded Terminal (Phase 0 UI Shell)\x1b[0m",
  "\x1b[36mThis is a visual preview mock. Real xterm.js terminal is not connected.\x1b[0m",
  "\x1b[36mBackend hooks will be connected in Phase 1.\x1b[0m",
  "----------------------------------------------------------------",
  "",
  "\x1b[1mForking session into new branch context...\x1b[0m",
  "Cloning session message blocks up to last verified state...",
  "Creating branch metadata in DB...",
  "\x1b[32m✔ Branch created: session_fork_2026_07_17\x1b[0m",
  "",
  "\x1b[33m[Codex Fork] Branch active. Interactive terminal session ready.\x1b[0m",
  "codex-fork-bash$ \x1b[5m█\x1b[0m"
];

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [terminals, setTerminals] = useState<Record<string, EmbeddedTerminalSession[]>>({});
  const [activeTabIds, setActiveTabIds] = useState<Record<string, string>>({});
  const timersRef = useRef<Record<string, number>>({});

  const setActiveTab = (sessionKey: string, tabId: string) => {
    setActiveTabIds((prev) => ({ ...prev, [sessionKey]: tabId }));
  };

  const setTerminalStatus = (
    terminalId: string,
    status: TerminalUiStatus,
    exitCode?: number | null,
    error?: string | null
  ) => {
    setTerminals((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const list = next[key];
        const idx = list.findIndex((t) => t.id === terminalId);
        if (idx !== -1) {
          const updated = [...list];
          updated[idx] = {
            ...updated[idx],
            status,
            ...(exitCode !== undefined && { exitCode }),
            ...(error !== undefined && { errorMessage: error }),
          };
          next[key] = updated;
          break;
        }
      }
      return next;
    });
  };

  const startTerminal = (
    sessionKey: string,
    commandKind: "resume" | "fork",
    command: string,
    cwd: string | null
  ): string => {
    const list = terminals[sessionKey] ?? [];
    if (list.length >= 5) {
      alert("终端页签已达上限 (最多5个)");
      return activeTabIds[sessionKey] || "record";
    }

    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const title = commandKind === "resume" ? "Resume" : "Fork";

    // Detect if we should simulate failure
    const isFailSimulated = command.toLowerCase().includes("fail") || cwd === "failed";
    const status: TerminalUiStatus = "starting";

    // Generate mock logs with command and cwd interpolated
    const logTemplate = commandKind === "resume" ? MOCK_STARTUP_LOGS_RESUME : MOCK_STARTUP_LOGS_FORK;
    const mockLogs = logTemplate.map((line) =>
      line
        .replace("{command}", command || "N/A")
        .replace("{cwd}", cwd || "N/A")
    );

    const newTerm: EmbeddedTerminalSession = {
      id: terminalId,
      sessionKey,
      title,
      status,
      commandKind,
      cwd,
      mockLogs: isFailSimulated ? ["\x1b[1;31m[Phase 0 Error Mock] Failed to start terminal child process.\x1b[0m", `\x1b[31mError details: Command execution error for command: "${command}"\x1b[0m`] : mockLogs,
    };

    setTerminals((prev) => ({
      ...prev,
      [sessionKey]: [...(prev[sessionKey] ?? []), newTerm],
    }));

    setActiveTab(sessionKey, terminalId);

    // Simulate startup delays
    if (timersRef.current[terminalId]) {
      window.clearTimeout(timersRef.current[terminalId]);
    }

    timersRef.current[terminalId] = window.setTimeout(() => {
      if (isFailSimulated) {
        setTerminalStatus(terminalId, "failed", null, "Executable file not found in %PATH% or permission denied.");
      } else {
        setTerminalStatus(terminalId, "running");
      }
    }, 1000);

    return terminalId;
  };

  const restartTerminal = (terminalId: string) => {
    setTerminals((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const list = next[key];
        const idx = list.findIndex((t) => t.id === terminalId);
        if (idx !== -1) {
          const updated = [...list];
          const term = updated[idx];
          
          updated[idx] = {
            ...term,
            status: "starting",
            exitCode: null,
            errorMessage: null,
          };
          next[key] = updated;

          if (timersRef.current[terminalId]) {
            window.clearTimeout(timersRef.current[terminalId]);
          }

          const isFailSimulated = (term.cwd === "failed");
          timersRef.current[terminalId] = window.setTimeout(() => {
            if (isFailSimulated) {
              setTerminalStatus(terminalId, "failed", null, "Executable file not found in %PATH% or permission denied.");
            } else {
              setTerminalStatus(terminalId, "running");
            }
          }, 1000);
          break;
        }
      }
      return next;
    });
  };

  const stopTerminal = (terminalId: string, force: boolean) => {
    if (timersRef.current[terminalId]) {
      window.clearTimeout(timersRef.current[terminalId]);
    }

    if (force) {
      setTerminalStatus(terminalId, "exited", -1, null);
      return;
    }

    setTerminalStatus(terminalId, "stopping");

    timersRef.current[terminalId] = window.setTimeout(() => {
      setTerminalStatus(terminalId, "exited", 130, null);
    }, 800);
  };

  const closeTerminal = (sessionKey: string, terminalId: string) => {
    if (timersRef.current[terminalId]) {
      window.clearTimeout(timersRef.current[terminalId]);
      delete timersRef.current[terminalId];
    }

    setTerminals((prev) => {
      const list = prev[sessionKey] ?? [];
      const updated = list.filter((t) => t.id !== terminalId);
      return {
        ...prev,
        [sessionKey]: updated,
      };
    });

    setActiveTabIds((prev) => {
      const currentActive = prev[sessionKey];
      if (currentActive === terminalId) {
        return {
          ...prev,
          [sessionKey]: "record",
        };
      }
      return prev;
    });
  };

  return (
    <TerminalContext.Provider
      value={{
        terminals,
        activeTabIds,
        setActiveTab,
        startTerminal,
        restartTerminal,
        stopTerminal,
        closeTerminal,
        setTerminalStatus,
      }}
    >
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminal() {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error("useTerminal must be used within a TerminalProvider");
  }
  return context;
}
