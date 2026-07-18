import type { ReactNode } from "react";

export type TerminalUiStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";

export type TerminalCommandKind = "resume" | "fork" | "shell";

export interface EmbeddedTerminalSession {
  id: string;
  sessionKey: string;
  title: string;
  status: TerminalUiStatus;
  commandKind: TerminalCommandKind;
  command: string;
  cwd: string | null;
  platform: string | null;
  sessionTitle: string;
  createdAt: number;
  processId?: number | null;
  exitCode?: number | null;
  errorMessage?: string | null;
}

export type EmbeddedTerminalEvent =
  | { type: "output"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number | null }
  | { type: "error"; terminalId: string; message: string };

export interface EmbeddedTerminalPanelProps {
  status: TerminalUiStatus;
  exitCode?: number | null;
  errorMessage?: string | null;
  onStart: () => void;
  onRestart: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
  children?: ReactNode;
}
