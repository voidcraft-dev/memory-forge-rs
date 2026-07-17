export type TerminalUiStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";

export interface EmbeddedTerminalSession {
  id: string;
  sessionKey: string;
  title: string;
  status: TerminalUiStatus;
  commandKind: "resume" | "fork" | "shell";
  cwd: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  mockLogs: string[];
}

export interface EmbeddedTerminalPanelProps {
  status: TerminalUiStatus;
  title: string;
  platformName: string;
  commandKind: "resume" | "fork" | "shell";
  cwd: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  onStart: () => void;
  onStop: () => void;
  onForceStop: () => void;
  onRestart: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
  mockLogs?: string[];
  children?: React.ReactNode;
}
