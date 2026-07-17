import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { api } from "@/features/desktop/api";
import type {
  EmbeddedTerminalEvent,
  EmbeddedTerminalSession,
  TerminalCommandKind,
  TerminalUiStatus,
} from "./terminal-types";

const TERMINAL_EVENT_NAME = "embedded-terminal-event";
const MAX_TERMINALS_PER_SESSION = 5;
const MAX_OUTPUT_HISTORY_BYTES = 4 * 1024 * 1024;

type OutputHandler = (data: Uint8Array) => void;
type TerminalMap = Record<string, EmbeddedTerminalSession[]>;

interface PendingOutput {
  chunks: Uint8Array[];
  bytes: number;
}

interface TerminalContextType {
  terminals: TerminalMap;
  activeTerminalId: string | null;
  setActiveTerminal: (terminalId: string | null) => void;
  startTerminal: (
    sessionKey: string,
    commandKind: "resume" | "fork",
    command: string,
    cwd: string | null,
    metadata?: { platform?: string | null; sessionTitle?: string }
  ) => Promise<string | null>;
  restartTerminal: (terminalId: string) => Promise<string | null>;
  stopTerminal: (terminalId: string, force: boolean) => Promise<void>;
  closeTerminal: (sessionKey: string, terminalId: string) => Promise<void>;
  writeTerminal: (terminalId: string, data: string, binary?: boolean) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  subscribeToOutput: (terminalId: string, handler: OutputHandler) => () => void;
}

const TerminalContext = createContext<TerminalContextType | null>(null);

function createTerminalId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `terminal_${uuid.replace(/-/g, "_")}`;
  return `terminal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function decodeBase64(value: string) {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [terminals, setTerminals] = useState<TerminalMap>({});
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const terminalsRef = useRef<TerminalMap>({});
  const outputSubscribersRef = useRef<Map<string, Set<OutputHandler>>>(new Map());
  const pendingOutputRef = useRef<Map<string, PendingOutput>>(new Map());

  const mutateTerminals = useCallback((updater: (current: TerminalMap) => TerminalMap) => {
    const next = updater(terminalsRef.current);
    terminalsRef.current = next;
    setTerminals(next);
  }, []);

  const updateTerminal = useCallback(
    (
      terminalId: string,
      updater: (terminal: EmbeddedTerminalSession) => EmbeddedTerminalSession
    ) => {
      mutateTerminals((current) => {
        for (const [sessionKey, sessionTerminals] of Object.entries(current)) {
          const index = sessionTerminals.findIndex((terminal) => terminal.id === terminalId);
          if (index === -1) continue;
          const updated = [...sessionTerminals];
          updated[index] = updater(updated[index]);
          return { ...current, [sessionKey]: updated };
        }
        return current;
      });
    },
    [mutateTerminals]
  );

  const setTerminalStatus = useCallback(
    (
      terminalId: string,
      status: TerminalUiStatus,
      details?: { exitCode?: number | null; errorMessage?: string | null }
    ) => {
      updateTerminal(terminalId, (terminal) => ({
        ...terminal,
        status,
        ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
        ...(details?.errorMessage !== undefined
          ? { errorMessage: details.errorMessage }
          : {}),
      }));
    },
    [updateTerminal]
  );

  const queuePendingOutput = useCallback((terminalId: string, data: Uint8Array) => {
    const pending = pendingOutputRef.current.get(terminalId) ?? { chunks: [], bytes: 0 };
    pending.chunks.push(data);
    pending.bytes += data.byteLength;
    while (pending.bytes > MAX_OUTPUT_HISTORY_BYTES && pending.chunks.length > 1) {
      const removed = pending.chunks.shift();
      if (removed) pending.bytes -= removed.byteLength;
    }
    pendingOutputRef.current.set(terminalId, pending);
  }, []);

  const handleTerminalEvent = useCallback(
    (event: EmbeddedTerminalEvent) => {
      if (event.type === "output") {
        let data: Uint8Array;
        try {
          data = decodeBase64(event.data);
        } catch (error) {
          setTerminalStatus(event.terminalId, "failed", {
            errorMessage: `Failed to decode terminal output: ${errorMessage(error)}`,
          });
          return;
        }

        queuePendingOutput(event.terminalId, data);
        const subscribers = outputSubscribersRef.current.get(event.terminalId);
        if (!subscribers || subscribers.size === 0) return;
        for (const subscriber of subscribers) subscriber(data);
        return;
      }

      if (event.type === "exit") {
        setTerminalStatus(event.terminalId, "exited", {
          exitCode: event.exitCode,
          errorMessage: null,
        });
        return;
      }

      setTerminalStatus(event.terminalId, "failed", {
        errorMessage: event.message,
      });
    },
    [queuePendingOutput, setTerminalStatus]
  );

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<EmbeddedTerminalEvent>(TERMINAL_EVENT_NAME, ({ payload }) => {
      handleTerminalEvent(payload);
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else unlisten = disposeListener;
    });

    return () => {
      disposed = true;
      unlisten?.();
      outputSubscribersRef.current.clear();
      pendingOutputRef.current.clear();
    };
  }, [handleTerminalEvent]);

  const setActiveTerminal = useCallback((terminalId: string | null) => {
    setActiveTerminalId(terminalId);
  }, []);

  const addStartingTerminal = useCallback(
    (input: {
      terminalId: string;
      sessionKey: string;
      commandKind: TerminalCommandKind;
      command: string;
      cwd: string | null;
      platform?: string | null;
      sessionTitle?: string;
    }) => {
      const currentList = terminalsRef.current[input.sessionKey] ?? [];
      if (currentList.length >= MAX_TERMINALS_PER_SESSION) return false;

      const sameKindCount = currentList.filter(
        (terminal) => terminal.commandKind === input.commandKind
      ).length;
      const title = `${input.commandKind === "resume" ? "Resume" : "Fork"}${
        sameKindCount > 0 ? ` ${sameKindCount + 1}` : ""
      }`;
      const terminal: EmbeddedTerminalSession = {
        id: input.terminalId,
        sessionKey: input.sessionKey,
        title,
        status: "starting",
        commandKind: input.commandKind,
        command: input.command,
        cwd: input.cwd,
        platform: input.platform ?? null,
        sessionTitle: input.sessionTitle?.trim() || input.sessionKey,
        createdAt: Date.now(),
        exitCode: null,
        errorMessage: null,
      };

      mutateTerminals((current) => ({
        ...current,
        [input.sessionKey]: [...(current[input.sessionKey] ?? []), terminal],
      }));
      setActiveTerminal(input.terminalId);
      return true;
    },
    [mutateTerminals, setActiveTerminal]
  );

  const startTerminal = useCallback(
    async (
      sessionKey: string,
      commandKind: "resume" | "fork",
      command: string,
      cwd: string | null,
      metadata?: { platform?: string | null; sessionTitle?: string }
    ) => {
      const terminalId = createTerminalId();
      if (!addStartingTerminal({
        terminalId,
        sessionKey,
        commandKind,
        command,
        cwd,
        platform: metadata?.platform,
        sessionTitle: metadata?.sessionTitle,
      })) {
        return null;
      }

      try {
        const started = await api.startEmbeddedTerminal({
          terminalId,
          sessionKey,
          command,
          commandKind,
          cwd,
          cols: 100,
          rows: 30,
        });
        updateTerminal(terminalId, (terminal) => ({
          ...terminal,
          status: "running",
          cwd: started.cwd,
          processId: started.processId,
          errorMessage: null,
        }));
      } catch (error) {
        setTerminalStatus(terminalId, "failed", {
          errorMessage: errorMessage(error),
        });
      }
      return terminalId;
    },
    [addStartingTerminal, setTerminalStatus, updateTerminal]
  );

  const stopTerminal = useCallback(
    async (terminalId: string, force: boolean) => {
      setTerminalStatus(terminalId, "stopping", { errorMessage: null });
      try {
        await api.stopEmbeddedTerminal(terminalId, force);
      } catch (error) {
        // A process may have exited between the UI action and the command.
        const stillPresent = Object.values(terminalsRef.current)
          .flat()
          .some((terminal) => terminal.id === terminalId);
        if (stillPresent) {
          setTerminalStatus(terminalId, "failed", {
            errorMessage: errorMessage(error),
          });
        }
      }
    },
    [setTerminalStatus]
  );

  const removeTerminalUi = useCallback(
    (sessionKey: string, terminalId: string) => {
      const currentList = terminalsRef.current[sessionKey] ?? [];
      const updated = currentList.filter((terminal) => terminal.id !== terminalId);
      mutateTerminals((current) => ({ ...current, [sessionKey]: updated }));
      pendingOutputRef.current.delete(terminalId);
      outputSubscribersRef.current.delete(terminalId);
      setActiveTerminalId((current) => {
        if (current !== terminalId) return current;
        return Object.values(terminalsRef.current)
          .flat()
          .sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
      });
    },
    [mutateTerminals]
  );

  const closeTerminal = useCallback(
    async (sessionKey: string, terminalId: string) => {
      const terminal = (terminalsRef.current[sessionKey] ?? []).find(
        (candidate) => candidate.id === terminalId
      );
      if (terminal && !["exited", "failed", "idle"].includes(terminal.status)) {
        try {
          await api.stopEmbeddedTerminal(terminalId, true);
        } catch {
          // The backend may already have removed a naturally exited process.
        }
      }
      removeTerminalUi(sessionKey, terminalId);
    },
    [removeTerminalUi]
  );

  const restartTerminal = useCallback(
    async (terminalId: string) => {
      const terminal = Object.values(terminalsRef.current)
        .flat()
        .find((candidate) => candidate.id === terminalId);
      if (!terminal || terminal.commandKind === "shell") return null;

      try {
        await api.stopEmbeddedTerminal(terminalId, true);
      } catch {
        // It is valid to restart an already exited terminal.
      }
      removeTerminalUi(terminal.sessionKey, terminalId);
      return startTerminal(
        terminal.sessionKey,
        terminal.commandKind,
        terminal.command,
        terminal.cwd,
        { platform: terminal.platform, sessionTitle: terminal.sessionTitle }
      );
    },
    [removeTerminalUi, startTerminal]
  );

  const writeTerminal = useCallback(async (terminalId: string, data: string, binary = false) => {
    await api.writeEmbeddedTerminal(terminalId, data, binary);
  }, []);

  const resizeTerminal = useCallback(
    async (terminalId: string, cols: number, rows: number) => {
      await api.resizeEmbeddedTerminal(terminalId, cols, rows);
    },
    []
  );

  const subscribeToOutput = useCallback((terminalId: string, handler: OutputHandler) => {
    const subscribers = outputSubscribersRef.current.get(terminalId) ?? new Set<OutputHandler>();
    subscribers.add(handler);
    outputSubscribersRef.current.set(terminalId, subscribers);

    const pending = pendingOutputRef.current.get(terminalId);
    if (pending) {
      for (const chunk of pending.chunks) handler(chunk);
    }

    return () => {
      const current = outputSubscribersRef.current.get(terminalId);
      current?.delete(handler);
      if (current?.size === 0) outputSubscribersRef.current.delete(terminalId);
    };
  }, []);

  const value = useMemo<TerminalContextType>(
    () => ({
      terminals,
      activeTerminalId,
      setActiveTerminal,
      startTerminal,
      restartTerminal,
      stopTerminal,
      closeTerminal,
      writeTerminal,
      resizeTerminal,
      subscribeToOutput,
    }),
    [
      terminals,
      activeTerminalId,
      setActiveTerminal,
      startTerminal,
      restartTerminal,
      stopTerminal,
      closeTerminal,
      writeTerminal,
      resizeTerminal,
      subscribeToOutput,
    ]
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal() {
  const context = useContext(TerminalContext);
  if (!context) throw new Error("useTerminal must be used within a TerminalProvider");
  return context;
}
