import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import type { RemoteTerminalSnapshot } from "@/features/remote/protocol";
import type {
  EmbeddedTerminalSession,
  TerminalUiStatus,
} from "./terminal-types";

const MAX_OUTPUT_HISTORY_BYTES = 4 * 1024 * 1024;
const POLL_INTERVAL_MS = 300;
const ACTIVE_STATUSES = new Set<TerminalUiStatus>([
  "starting",
  "running",
  "stopping",
]);

type OutputHandler = (data: Uint8Array) => void;
type TerminalMap = Record<string, EmbeddedTerminalSession[]>;

interface PendingOutput {
  bytes: number;
  chunks: Uint8Array[];
}

interface StartRemoteTerminalInput {
  commandKind: "resume" | "fork";
  platform: string;
  sessionKey: string;
  sessionTitle: string;
}

export interface RemoteTerminalController {
  activeTerminalId: string | null;
  closeTerminal: (sessionKey: string, terminalId: string) => Promise<void>;
  refreshTerminals: () => Promise<void>;
  renameTerminal: (terminalId: string, newTitle: string) => void;
  resizeTerminal: (
    terminalId: string,
    cols: number,
    rows: number
  ) => Promise<void>;
  restartTerminal: (terminalId: string) => Promise<string | null>;
  setActiveTerminal: (terminalId: string | null) => void;
  startTerminal: (input: StartRemoteTerminalInput) => Promise<string | null>;
  stopTerminal: (terminalId: string, force: boolean) => Promise<void>;
  subscribeToOutput: (terminalId: string, handler: OutputHandler) => () => void;
  terminals: TerminalMap;
  writeTerminal: (
    terminalId: string,
    data: string,
    binary?: boolean
  ) => Promise<void>;
}

const RemoteTerminalContext = createContext<RemoteTerminalController | null>(
  null
);

function createRemoteTerminalId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `remote_${uuid.replace(/-/g, "_")}`;
  }
  return `remote_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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

function terminalFromSnapshot(
  snapshot: RemoteTerminalSnapshot,
  previous?: EmbeddedTerminalSession
): EmbeddedTerminalSession {
  return {
    id: snapshot.terminalId,
    sessionKey: snapshot.sessionKey,
    title: snapshot.commandKind === "resume" ? "Resume" : "Fork",
    status: snapshot.status,
    commandKind: snapshot.commandKind,
    command: "",
    cwd: snapshot.cwd || null,
    platform: snapshot.platform || null,
    sessionTitle:
      previous?.sessionTitle || snapshot.title || snapshot.sessionKey,
    createdAt: snapshot.createdAt,
    processId: snapshot.processId,
    exitCode: snapshot.exitCode,
    errorMessage: snapshot.errorMessage,
  };
}

function groupTerminals(terminals: EmbeddedTerminalSession[]) {
  return terminals.reduce<TerminalMap>((groups, terminal) => {
    groups[terminal.sessionKey] = [
      ...(groups[terminal.sessionKey] ?? []),
      terminal,
    ];
    return groups;
  }, {});
}

export function RemoteTerminalProvider({ children }: { children: ReactNode }) {
  const { isRemote, remoteCapabilities, t } = useDesktop();
  const [terminals, setTerminals] = useState<TerminalMap>({});
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const terminalsRef = useRef<TerminalMap>({});
  const cursorsRef = useRef<Map<string, number>>(new Map());
  const pollingRef = useRef<Set<string>>(new Set());
  const outputSubscribersRef = useRef<Map<string, Set<OutputHandler>>>(
    new Map()
  );
  const pendingOutputRef = useRef<Map<string, PendingOutput>>(new Map());

  const mutateTerminals = useCallback(
    (updater: (current: TerminalMap) => TerminalMap) => {
      const next = updater(terminalsRef.current);
      terminalsRef.current = next;
      setTerminals(next);
    },
    []
  );

  const findTerminal = useCallback((terminalId: string) => {
    return Object.values(terminalsRef.current)
      .flat()
      .find((terminal) => terminal.id === terminalId);
  }, []);

  const upsertSnapshot = useCallback(
    (snapshot: RemoteTerminalSnapshot) => {
      mutateTerminals((current) => {
        const flattened = Object.values(current).flat();
        const previous = flattened.find(
          (terminal) => terminal.id === snapshot.terminalId
        );
        const next = flattened.filter(
          (terminal) => terminal.id !== snapshot.terminalId
        );
        next.push(terminalFromSnapshot(snapshot, previous));
        return groupTerminals(next);
      });
    },
    [mutateTerminals]
  );

  const removeTerminal = useCallback(
    (terminalId: string) => {
      mutateTerminals((current) => {
        const next = Object.values(current)
          .flat()
          .filter((terminal) => terminal.id !== terminalId);
        return groupTerminals(next);
      });
      cursorsRef.current.delete(terminalId);
      pendingOutputRef.current.delete(terminalId);
      outputSubscribersRef.current.delete(terminalId);
      setActiveTerminalId((current) =>
        current === terminalId ? null : current
      );
    },
    [mutateTerminals]
  );

  const queueOutput = useCallback((terminalId: string, data: Uint8Array) => {
    const pending = pendingOutputRef.current.get(terminalId) ?? {
      chunks: [],
      bytes: 0,
    };
    pending.chunks.push(data);
    pending.bytes += data.byteLength;
    while (
      pending.bytes > MAX_OUTPUT_HISTORY_BYTES &&
      pending.chunks.length > 1
    ) {
      const removed = pending.chunks.shift();
      if (removed) {
        pending.bytes -= removed.byteLength;
      }
    }
    pendingOutputRef.current.set(terminalId, pending);
    const subscribers = outputSubscribersRef.current.get(terminalId);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber(data);
    }
  }, []);

  const pollTerminal = useCallback(
    async (terminalId: string) => {
      // An optimistic "starting" tab exists before the host has registered the PTY.
      // Only poll terminals that received a start response or came from the host list.
      if (!cursorsRef.current.has(terminalId)) {
        return;
      }
      if (pollingRef.current.has(terminalId)) {
        return;
      }
      pollingRef.current.add(terminalId);
      try {
        const cursor = cursorsRef.current.get(terminalId) ?? 0;
        const output = await api.remoteReadTerminal(terminalId, cursor);
        if (output.truncated) {
          queueOutput(
            terminalId,
            new TextEncoder().encode(
              `\r\n\u001b[33m${t("remoteTerminalHistoryTruncated")}\u001b[0m\r\n`
            )
          );
        }
        for (const chunk of output.chunks) {
          queueOutput(terminalId, decodeBase64(chunk.data));
        }
        cursorsRef.current.set(terminalId, output.nextCursor);
        upsertSnapshot(output.terminal);
      } catch (error) {
        if (errorMessage(error).includes("NOT_FOUND")) {
          removeTerminal(terminalId);
        }
      } finally {
        pollingRef.current.delete(terminalId);
      }
    },
    [queueOutput, removeTerminal, t, upsertSnapshot]
  );

  const refreshTerminals = useCallback(async () => {
    if (!isRemote || remoteCapabilities?.terminal !== true) {
      return;
    }
    const snapshots = await api.remoteListTerminals();
    const previous = Object.values(terminalsRef.current).flat();
    const next = snapshots.map((snapshot) =>
      terminalFromSnapshot(
        snapshot,
        previous.find((terminal) => terminal.id === snapshot.terminalId)
      )
    );
    const nextIds = new Set(next.map((terminal) => terminal.id));
    for (const terminalId of cursorsRef.current.keys()) {
      if (!nextIds.has(terminalId)) {
        cursorsRef.current.delete(terminalId);
      }
    }
    for (const terminal of next) {
      if (!cursorsRef.current.has(terminal.id)) {
        cursorsRef.current.set(terminal.id, 0);
      }
    }
    mutateTerminals(() => groupTerminals(next));
    if (next.length > 0) {
      setActiveTerminalId((current) =>
        current && nextIds.has(current) ? current : next[0].id
      );
      await Promise.all(next.map((terminal) => pollTerminal(terminal.id)));
    }
  }, [isRemote, mutateTerminals, pollTerminal, remoteCapabilities?.terminal]);

  useEffect(() => {
    if (!isRemote || remoteCapabilities?.terminal !== true) {
      terminalsRef.current = {};
      setTerminals({});
      setActiveTerminalId(null);
      cursorsRef.current.clear();
      pollingRef.current.clear();
      pendingOutputRef.current.clear();
      outputSubscribersRef.current.clear();
      return;
    }

    let disposed = false;
    refreshTerminals().catch(() => {
      // The access gate can still be waiting for a valid token.
    });
    const interval = window.setInterval(() => {
      if (disposed) {
        return;
      }
      const active = Object.values(terminalsRef.current)
        .flat()
        .filter((terminal) => ACTIVE_STATUSES.has(terminal.status));
      for (const terminal of active) {
        pollTerminal(terminal.id).catch(() => undefined);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [isRemote, pollTerminal, refreshTerminals, remoteCapabilities?.terminal]);

  const setActiveTerminal = useCallback((terminalId: string | null) => {
    setActiveTerminalId(terminalId);
  }, []);

  const startTerminal = useCallback(
    async (input: StartRemoteTerminalInput) => {
      if (!isRemote || remoteCapabilities?.terminal !== true) {
        return null;
      }
      const terminalId = createRemoteTerminalId();
      const optimistic: EmbeddedTerminalSession = {
        id: terminalId,
        sessionKey: input.sessionKey,
        title: input.commandKind === "resume" ? "Resume" : "Fork",
        status: "starting",
        commandKind: input.commandKind,
        command: "",
        cwd: null,
        platform: input.platform,
        sessionTitle: input.sessionTitle || input.sessionKey,
        createdAt: Date.now(),
        exitCode: null,
        errorMessage: null,
      };
      mutateTerminals((current) => ({
        ...current,
        [input.sessionKey]: [...(current[input.sessionKey] ?? []), optimistic],
      }));
      setActiveTerminalId(terminalId);

      try {
        const snapshot = await api.remoteStartTerminal({
          terminalId,
          platform: input.platform,
          sessionKey: input.sessionKey,
          commandKind: input.commandKind,
          cols: 100,
          rows: 30,
        });
        cursorsRef.current.set(terminalId, 0);
        upsertSnapshot(snapshot);
        pollTerminal(terminalId).catch(() => undefined);
      } catch (error) {
        mutateTerminals((current) => {
          const flattened = Object.values(current).flat();
          return groupTerminals(
            flattened.map((terminal) =>
              terminal.id === terminalId
                ? {
                    ...terminal,
                    status: "failed",
                    errorMessage: errorMessage(error),
                  }
                : terminal
            )
          );
        });
      }
      return terminalId;
    },
    [
      isRemote,
      mutateTerminals,
      pollTerminal,
      remoteCapabilities?.terminal,
      upsertSnapshot,
    ]
  );

  const stopTerminal = useCallback(
    async (terminalId: string, force: boolean) => {
      const terminal = findTerminal(terminalId);
      if (!terminal) {
        return;
      }
      mutateTerminals((current) =>
        groupTerminals(
          Object.values(current)
            .flat()
            .map((candidate) =>
              candidate.id === terminalId
                ? { ...candidate, status: "stopping" }
                : candidate
            )
        )
      );
      const snapshot = await api.remoteStopTerminal(terminalId, force);
      upsertSnapshot(snapshot);
    },
    [findTerminal, mutateTerminals, upsertSnapshot]
  );

  const closeTerminal = useCallback(
    async (_sessionKey: string, terminalId: string) => {
      try {
        await api.remoteCloseTerminal(terminalId);
      } catch (error) {
        if (!errorMessage(error).includes("NOT_FOUND")) {
          throw error;
        }
      }
      removeTerminal(terminalId);
    },
    [removeTerminal]
  );

  const restartTerminal = useCallback(
    async (terminalId: string) => {
      const terminal = findTerminal(terminalId);
      if (!terminal || terminal.commandKind === "shell" || !terminal.platform) {
        return null;
      }
      await closeTerminal(terminal.sessionKey, terminal.id);
      return startTerminal({
        sessionKey: terminal.sessionKey,
        commandKind: terminal.commandKind,
        platform: terminal.platform,
        sessionTitle: terminal.sessionTitle,
      });
    },
    [closeTerminal, findTerminal, startTerminal]
  );

  const writeTerminal = useCallback(
    async (terminalId: string, data: string, binary = false) => {
      await api.remoteWriteTerminal(terminalId, data, binary);
    },
    []
  );

  const resizeTerminal = useCallback(
    async (terminalId: string, cols: number, rows: number) => {
      await api.remoteResizeTerminal(terminalId, cols, rows);
    },
    []
  );

  const subscribeToOutput = useCallback(
    (terminalId: string, handler: OutputHandler) => {
      const subscribers =
        outputSubscribersRef.current.get(terminalId) ??
        new Set<OutputHandler>();
      subscribers.add(handler);
      outputSubscribersRef.current.set(terminalId, subscribers);
      const pending = pendingOutputRef.current.get(terminalId);
      if (pending) {
        for (const chunk of pending.chunks) {
          handler(chunk);
        }
      }
      return () => {
        const current = outputSubscribersRef.current.get(terminalId);
        current?.delete(handler);
        if (current?.size === 0) {
          outputSubscribersRef.current.delete(terminalId);
        }
      };
    },
    []
  );

  const renameTerminal = useCallback(
    (terminalId: string, newTitle: string) => {
      mutateTerminals((current) =>
        groupTerminals(
          Object.values(current)
            .flat()
            .map((terminal) =>
              terminal.id === terminalId
                ? { ...terminal, sessionTitle: newTitle }
                : terminal
            )
        )
      );
    },
    [mutateTerminals]
  );

  const value = useMemo<RemoteTerminalController>(
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
      renameTerminal,
      refreshTerminals,
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
      renameTerminal,
      refreshTerminals,
    ]
  );

  return (
    <RemoteTerminalContext.Provider value={value}>
      {children}
    </RemoteTerminalContext.Provider>
  );
}

export function useRemoteTerminal() {
  const context = useContext(RemoteTerminalContext);
  if (!context) {
    throw new Error(
      "useRemoteTerminal must be used within a RemoteTerminalProvider"
    );
  }
  return context;
}
