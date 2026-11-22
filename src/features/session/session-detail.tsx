import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  Archive,
  BookOpen,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  GitFork,
  MousePointer2,
  Pencil,
  Play,
  RefreshCw,
  Scissors,
  Search,
  Sparkles,
  Star,
  Terminal,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  estimateBlockTokens,
  formatTokenCount,
} from "@/components/layout/shell-layout";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  api,
  createPrompt,
  describeSaveError,
  listPrompts,
} from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
import { useDesktop } from "@/features/desktop/provider";
import type {
  EditLogEntry,
  EditorTarget,
  PromptItem,
  TimelineBlock,
  ToolCallBlock,
} from "@/features/desktop/types";
import {
  cleanHumanPreview,
  getPlatformBadgeStyle,
  isUuidLikeTitle,
  PLATFORM_LABELS,
} from "@/features/session/session-list";
import { useTerminal } from "@/features/terminal/terminal-context";
import { cn } from "@/lib/utils";

const TOOL_INPUT_EXPORT_LIMIT = 8192;
const TOOL_OUTPUT_EXPORT_LIMIT = 32_768;
const PREFERRED_EDITOR_STORAGE_KEY = "memory-forge.preferred-editor";
const LONG_BLOCK_COLLAPSE_THRESHOLD = 3200;
const LONG_BLOCK_PREVIEW_CHARS = 1600;
const SPIKE_TOKEN_THRESHOLD = 3500;
const MAX_DNA_CELLS = 72;

function estimateMessageBlockSize(block?: TimelineBlock, isEditing?: boolean) {
  if (!block) return 120;
  if (isEditing) return 380;
  if (block.role === "thinking") return 34;
  const contentChars = block.content.trim().length;
  if (contentChars === 0 && (block.toolCalls?.length ?? 0) > 0) return 40;
  const visibleChars = Math.min(contentChars, LONG_BLOCK_PREVIEW_CHARS);
  const textRows = Math.ceil(visibleChars / 95);
  const codeFenceCount = (
    block.content.slice(0, LONG_BLOCK_PREVIEW_CHARS).match(/```/g) ?? []
  ).length;
  const hasTools = (block.toolCalls?.length ?? 0) > 0 ? 34 : 0;
  return Math.min(680, 96 + textRows * 21 + codeFenceCount * 32 + hasTools);
}

function truncateExportText(value: string, maxChars: number) {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}\n\n[truncated: showing first ${maxChars} chars of ${chars.length}]`;
}

function markdownFence(value: string) {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function safeExportFileName(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "session"
  );
}

function pushMarkdownCodeBlock(
  lines: string[],
  label: string,
  language: string,
  value: string,
  maxChars: number
) {
  const text = truncateExportText(value, maxChars);
  const fence = markdownFence(text);
  lines.push(`${label}:`);
  lines.push(`${fence}${language}`);
  lines.push(text);
  lines.push(fence);
  lines.push("");
}

function cleanAnsiCodes(text: string): string {
  if (!text) return "";
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\[[0-9;]+m/g, "");
}

const getEditorIcon = (id: string) => {
  const lower = id.toLowerCase();
  if (lower.includes("cursor")) return MousePointer2;
  if (lower.includes("code") || lower.includes("vscode")) return Code;
  if (lower.includes("zed")) return Sparkles;
  return FolderOpen;
};

type DnaCellBucket = {
  startIndex: number;
  endIndex: number;
  tokens: number;
  role: "user" | "assistant" | "thinking";
  forged: boolean;
  spike: boolean;
  representativeId: string;
  previewTurnNum: number;
  previewRole: "user" | "assistant" | "thinking";
  previewText: string;
  previewTime: string;
};

function formatBlockShortTime(block: TimelineBlock): string {
  const raw =
    block.createdAt ??
    (typeof block.sourceMeta?.createdAt === "string" ||
    typeof block.sourceMeta?.createdAt === "number"
      ? block.sourceMeta.createdAt
      : typeof block.sourceMeta?.timestamp === "string" ||
          typeof block.sourceMeta?.timestamp === "number"
        ? block.sourceMeta.timestamp
        : null);
  if (!raw) return "";
  const num = Number(raw);
  let d: Date;
  if (Number.isFinite(num) && num > 0) {
    if (num > 10 ** 17) d = new Date(num / 1_000_000);
    else if (num > 10 ** 15) d = new Date(num / 1000);
    else if (num > 10 ** 12) d = new Date(num);
    else d = new Date(num * 1000);
  } else {
    d = new Date(raw);
  }
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionDetail() {
  const { t, state, dispatch } = useDesktop();
  const { startTerminal } = useTerminal();
  const { confirm, dialogProps: confirmDialogProps } = useConfirmDialog();

  const sessionDetail = state.sessionDetail;
  const sessions = state.sessions;
  const roleFilter = state.roleFilter;
  const selectedSessionKey = state.selectedSessionKey;
  const showEditLog = state.showEditLog;
  const sessionStatus = state.sessionStatus;
  const globalSearchQuery = state.searchQuery;
  const editingBlock = state.editingBlock;
  const editLog = state.editLog;

  const activePlatform =
    sessionDetail?.platform ||
    state.selectedSessionPlatform ||
    (state.currentPlatform !== "all" ? state.currentPlatform : "claude");

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [exportingRawJsonl, setExportingRawJsonl] = useState(false);
  const [inlineSearch, setInlineSearch] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [loadingExecutionTargets, setLoadingExecutionTargets] = useState<
    Set<string>
  >(new Set());
  const [loadingAllExecutionOutputs, setLoadingAllExecutionOutputs] =
    useState(false);
  const [erasingToolCallId, setErasingToolCallId] = useState<string | null>(
    null
  );

  // Export options
  const [includeToolCallsInExport, setIncludeToolCallsInExport] =
    useState(false);
  const [exportRange, setExportRange] = useState<
    "all" | "recent20" | "recent50" | "recent100" | "since"
  >("all");
  const [exportSinceDate, setExportSinceDate] = useState("");

  // IDE & Popovers
  const [editorTargets, setEditorTargets] = useState<EditorTarget[]>([]);
  const [preferredEditorId, setPreferredEditorId] = useState<string | null>(
    null
  );
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [openingEditorId, setOpeningEditorId] = useState<string | null>(null);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Inline alias editing
  const [isEditingAlias, setIsEditingAlias] = useState(false);
  const [tempAlias, setTempAlias] = useState("");

  // Context DNA Range Selection & Hover Telemetry
  const [dnaRangeStart, setDnaRangeStart] = useState<number | null>(null);
  const [dnaRangeEnd, setDnaRangeEnd] = useState<number | null>(null);
  const [hoveredDnaIdx, setHoveredDnaIdx] = useState<number | null>(null);
  const [hoveredRail, setHoveredRail] = useState<{
    idx: number;
    offsetTop: number;
  } | null>(null);
  const [isDraggingDna, setIsDraggingDna] = useState(false);
  const [batchErasing, setBatchErasing] = useState(false);

  // Inline Surgery Saving & Arsenal Quick-Insert
  const [savingEdit, setSavingEdit] = useState(false);
  const [arsenalPrompts, setArsenalPrompts] = useState<PromptItem[] | null>(
    null
  );
  const [msgCtxMenu, setMsgCtxMenu] = useState<{
    x: number;
    y: number;
    block: TimelineBlock;
    forgedEntry?: EditLogEntry;
  } | null>(null);

  useEffect(() => {
    if (!msgCtxMenu) return;
    const close = () => setMsgCtxMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMsgCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [msgCtxMenu]);

  const messageScrollRef = useRef<HTMLDivElement>(null);
  const activeSessionKeyRef = useRef<string | null>(null);
  const editorMenuRef = useRef<HTMLDivElement>(null);
  const terminalMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeSessionKeyRef.current = selectedSessionKey;
    setDnaRangeStart(null);
    setDnaRangeEnd(null);
    setTerminalMenuOpen(false);
    setEditorMenuOpen(false);
    setExportMenuOpen(false);
  }, [selectedSessionKey]);

  useEffect(() => {
    const onMouseUp = () => setIsDraggingDna(false);
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        terminalMenuRef.current &&
        !terminalMenuRef.current.contains(event.target as Node)
      ) {
        setTerminalMenuOpen(false);
      }
      if (
        editorMenuRef.current &&
        !editorMenuRef.current.contains(event.target as Node)
      ) {
        setEditorMenuOpen(false);
      }
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(event.target as Node)
      ) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listEditorTargets()
      .then((targets) => {
        if (!cancelled) setEditorTargets(targets);
      })
      .catch(() => {
        if (!cancelled) setEditorTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPreferredEditorId(
      window.localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY)
    );
  }, []);

  useEffect(() => {
    setInlineSearch(globalSearchQuery.trim());
  }, [sessionDetail?.sessionKey, globalSearchQuery]);

  useEffect(() => {
    if (!sessionStatus) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "setSessionStatus", payload: null });
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [dispatch, sessionStatus]);

  const blocks = sessionDetail?.blocks ?? [];

  // Map editTarget -> latest EditLogEntry so Forged stamps & 1-click Revert work directly on turns!
  const forgedByTarget = useMemo(() => {
    const map = new Map<
      string,
      { count: number; latest: EditLogEntry }
    >();
    for (const entry of editLog) {
      const existing = map.get(entry.editTarget);
      if (!existing) {
        map.set(entry.editTarget, { count: 1, latest: entry });
      } else {
        map.set(entry.editTarget, {
          count: existing.count + 1,
          latest: entry.id > existing.latest.id ? entry : existing.latest,
        });
      }
    }
    return map;
  }, [editLog]);

  const blockTokensList = useMemo(
    () => blocks.map((b) => estimateBlockTokens(b)),
    [blocks]
  );

  const isTauriRuntime =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const preferredEditor = useMemo(() => {
    if (editorTargets.length === 0) return null;
    return (
      (preferredEditorId
        ? editorTargets.find((target) => target.id === preferredEditorId)
        : null) ?? editorTargets[0]
    );
  }, [editorTargets, preferredEditorId]);

  const PreferredIcon = preferredEditor
    ? getEditorIcon(preferredEditor.id)
    : FolderOpen;
  const canOpenWorkspace = Boolean(
    sessionDetail?.cwd?.trim() && preferredEditor
  );
  const hasExportableToolCalls = blocks.some(
    (block) => (block.toolCalls?.length ?? 0) > 0
  );
  const canExportRawJsonl =
    isTauriRuntime && ["claude", "codex", "pi"].includes(activePlatform);

  const kiroExecutionPlaceholderBlocks = useMemo(() => {
    if (activePlatform !== "kiro-ide") return [];
    return blocks.filter(
      (block) =>
        block.role === "assistant" &&
        block.content.trim() === "On it." &&
        block.editTarget?.includes("::execution::")
    );
  }, [activePlatform, blocks]);

  // Filtered blocks for Causal Tape
  const filteredBlocks = useMemo(() => {
    if (roleFilter === "all") return blocks;
    if (roleFilter === "spike") {
      return blocks.filter(
        (_, idx) => (blockTokensList[idx] ?? 0) >= SPIKE_TOKEN_THRESHOLD
      );
    }
    return blocks.filter((b) => b.role === roleFilter);
  }, [blockTokensList, blocks, roleFilter]);

  const blockIndexById = useMemo(() => {
    const index = new Map<string, number>();
    filteredBlocks.forEach((block, idx) => index.set(block.id, idx));
    return index;
  }, [filteredBlocks]);

  // Calibrated DNA Spectrum Buckets (caps DOM nodes at 56 even on 1000-message sessions!)
  const dnaCells = useMemo<DnaCellBucket[]>(() => {
    if (blocks.length === 0) return [];
    const bucketSize = Math.max(1, Math.ceil(blocks.length / MAX_DNA_CELLS));
    const cells: DnaCellBucket[] = [];
    for (let i = 0; i < blocks.length; i += bucketSize) {
      const slice = blocks.slice(i, i + bucketSize);
      let tokSum = 0;
      let forged = false;
      let spike = false;
      for (let j = 0; j < slice.length; j++) {
        const b = slice[j];
        const bt = blockTokensList[i + j] ?? 0;
        tokSum += bt;
        if (forgedByTarget.has(b.editTarget || b.id)) forged = true;
        if (bt >= SPIKE_TOKEN_THRESHOLD) spike = true;
      }
      // Pick the most informative block inside this bucket (prefer User or Forged or non-empty Assistant)
      let bestOffset = 0;
      const userIdx = slice.findIndex(
        (b) => b.role === "user" && b.content.trim().length > 0
      );
      const forgedIdx = slice.findIndex((b) =>
        forgedByTarget.has(b.editTarget || b.id)
      );
      const proseIdx = slice.findIndex((b) => b.content.trim().length > 0);
      if (forgedIdx >= 0) bestOffset = forgedIdx;
      else if (userIdx >= 0) bestOffset = userIdx;
      else if (proseIdx >= 0) bestOffset = proseIdx;

      const repBlock = slice[bestOffset] ?? slice[0];
      const rawText = repBlock.content.trim();
      const toolSummary =
        !rawText && repBlock.toolCalls?.length
          ? t("hud.previewTools", {
              tools: repBlock.toolCalls
                .map((tc) => tc.name || tc.kind || "tool")
                .join(", "),
            })
          : "";
      const cleanPreview = (rawText || toolSummary || t("hud.previewEmpty"))
        .replace(/```[\w-]*\n?/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);

      cells.push({
        startIndex: i,
        endIndex: Math.min(blocks.length - 1, i + slice.length - 1),
        tokens: tokSum,
        role: repBlock.role,
        forged,
        spike,
        representativeId: repBlock.id,
        previewTurnNum: i + bestOffset + 1,
        previewRole: repBlock.role,
        previewText: cleanPreview,
        previewTime: formatBlockShortTime(repBlock),
      });
    }
    return cells;
    }, [blockTokensList, blocks, forgedByTarget, t]);

  const maxDnaTok = useMemo(
    () => Math.max(3000, ...dnaCells.map((c) => c.tokens)),
    [dnaCells]
  );

  const estimateVirtualItemSize = useCallback(
    (index: number) => {
      const b = filteredBlocks[index];
      const isEd = Boolean(
        b && editingBlock && editingBlock.id === (b.editTarget || b.id)
      );
      return estimateMessageBlockSize(b, isEd);
    },
    [editingBlock, filteredBlocks]
  );

  const getVirtualItemKey = useCallback(
    (index: number) => filteredBlocks[index]?.id ?? index,
    [filteredBlocks]
  );

  const messageVirtualizer = useVirtualizer({
    count: filteredBlocks.length,
    getScrollElement: () => messageScrollRef.current,
    estimateSize: estimateVirtualItemSize,
    getItemKey: getVirtualItemKey,
    overscan: 8,
    gap: 10,
    paddingStart: 12,
    paddingEnd: 28,
  });

  const virtualItems = messageVirtualizer.getVirtualItems();

  const searchNeedle = inlineSearch.trim().toLowerCase();
  const matchingBlockIds = useMemo(() => {
    if (!searchNeedle) return [] as string[];
    return filteredBlocks
      .filter((b) => b.content.toLowerCase().includes(searchNeedle))
      .map((b) => b.id);
  }, [filteredBlocks, searchNeedle]);

  const scrollToBlockId = useCallback(
    (blockId: string) => {
      const idx = blockIndexById.get(blockId);
      if (idx !== undefined) {
        messageVirtualizer.scrollToIndex(idx, {
          align: "center",
          behavior: "smooth",
        });
      } else if (roleFilter !== "all") {
        dispatch({ type: "setRoleFilter", payload: "all" });
      }
    },
    [blockIndexById, dispatch, messageVirtualizer, roleFilter]
  );

  const handleSearchNav = useCallback(
    (dir: "next" | "prev") => {
      if (matchingBlockIds.length === 0) return;
      const next =
        dir === "next"
          ? (currentMatchIdx + 1) % matchingBlockIds.length
          : (currentMatchIdx - 1 + matchingBlockIds.length) %
            matchingBlockIds.length;
      setCurrentMatchIdx(next);
      const id = matchingBlockIds[next];
      if (id) scrollToBlockId(id);
    },
    [currentMatchIdx, matchingBlockIds, scrollToBlockId]
  );

  useEffect(() => {
    if (matchingBlockIds.length > 0) {
      setCurrentMatchIdx(0);
      scrollToBlockId(matchingBlockIds[0]);
    }
  }, [matchingBlockIds]);

  useEffect(() => {
    messageScrollRef.current?.scrollTo({ top: 0 });
  }, [sessionDetail?.sessionKey]);

  // Empty State
  if (!sessionDetail) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center bg-[var(--bg-void)] px-6 text-center">
        <div className="reticle reticle-cyan mb-4 grid size-14 place-items-center rounded-[5px] border border-[var(--line-strong)] bg-[var(--bg-panel)] text-[var(--cyan-fg)]">
          <Scissors className="size-6" />
        </div>
        <p className="hud-mono text-sm font-bold tracking-wider text-[var(--text-hi)] uppercase">
          {t("session.selectToView")}
        </p>
        <p className="mt-1 text-xs text-[var(--text-low)]">
          {t("session.selectFromList")} · {t("hud.doubleClickEditHint")}
        </p>
      </section>
    );
  }

  const handleSaveAlias = async (newVal: string) => {
    try {
      await api.setAlias(activePlatform, sessionDetail.sessionKey, newVal);
      const newTitle = newVal || sessionDetail.title || sessionDetail.sessionId;
      dispatch({
        type: "setSessionDetail",
        payload: { ...sessionDetail, aliasTitle: newVal, title: newTitle },
      });
      dispatch({
        type: "updateSession",
        payload: {
          sessionKey: sessionDetail.sessionKey,
          updates: { displayTitle: newTitle, aliasTitle: newVal },
        },
      });
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("session.aliasSaved") },
      });
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.aliasSaveFailed") },
      });
    }
  };

  const handleStartInlineEdit = (block: TimelineBlock) => {
    if (block.editable === false) return;
    dispatch({
      type: "setEditingBlock",
      payload: {
        id: block.editTarget || block.id,
        content: block.content,
        originalContent: block.content,
        role: block.role,
      },
    });
  };

  const handleCommitInlineEdit = async () => {
    if (!editingBlock || !selectedSessionKey) return;
    setSavingEdit(true);
    dispatch({ type: "setSessionStatus", payload: null });
    try {
      await api.editMessage(
        activePlatform,
        editingBlock.id,
        editingBlock.content,
        selectedSessionKey,
        editingBlock.originalContent
      );
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, selectedSessionKey),
        api.getEditLog(activePlatform, selectedSessionKey),
      ]);
      dispatch({ type: "setSessionDetail", payload: updated });
      dispatch({ type: "setEditLog", payload: logs });
      dispatch({ type: "setEditingBlock", payload: null });
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "success",
          message: `${t("session.messageSaved")} · ${t("hud.safeWriteBadge")}`,
        },
      });
    } catch (error) {
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "error",
          message: describeSaveError(t("session.saveFailed"), error),
        },
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const handleRevertForgedBlock = async (entry: EditLogEntry) => {
    if (
      !selectedSessionKey ||
      !(await confirm({
        title: t("session.restore"),
        description: t("session.restoreConfirm"),
      }))
    ) {
      return;
    }
    try {
      await api.restoreMessage(activePlatform, entry.id, selectedSessionKey);
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, selectedSessionKey),
        api.getEditLog(activePlatform, selectedSessionKey),
      ]);
      dispatch({ type: "setSessionDetail", payload: updated });
      dispatch({ type: "setEditLog", payload: logs });
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("hud.revertedToast") },
      });
    } catch (err) {
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "error",
          message: describeSaveError(t("session.saveFailed"), err),
        },
      });
    }
  };

  const handleEraseBlock = async (block: TimelineBlock) => {
    if (
      !(await confirm({
        title: t("session.erase"),
        description: t("session.eraseConfirm"),
        variant: "danger",
      }))
    ) {
      return;
    }
    try {
      await api.editMessage(
        activePlatform,
        block.editTarget || block.id,
        "",
        sessionDetail.sessionKey,
        block.content
      );
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, sessionDetail.sessionKey),
        api.getEditLog(activePlatform, sessionDetail.sessionKey),
      ]);
      dispatch({ type: "setSessionDetail", payload: updated });
      dispatch({ type: "setEditLog", payload: logs });
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("session.messageSaved") },
      });
    } catch (err) {
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "error",
          message: describeSaveError(t("session.saveFailed"), err),
        },
      });
    }
  };

  const handleBatchEraseDnaRange = async () => {
    if (dnaRangeStart === null || dnaRangeEnd === null) return;
    const loCell = dnaCells[Math.min(dnaRangeStart, dnaRangeEnd)];
    const hiCell = dnaCells[Math.max(dnaRangeStart, dnaRangeEnd)];
    if (!loCell || !hiCell) return;

    const targetBlocks = blocks
      .slice(loCell.startIndex, hiCell.endIndex + 1)
      .filter((b) => b.editable !== false && b.content.trim().length > 0);

    if (targetBlocks.length === 0) return;
    if (
      !(await confirm({
        title: t("hud.batchEraseTitle", {
          start: loCell.startIndex + 1,
          end: hiCell.endIndex + 1,
        }),
        description: t("hud.batchEraseDesc", { count: targetBlocks.length }),
        variant: "danger",
      }))
    ) {
      return;
    }

    setBatchErasing(true);
    try {
      for (const b of targetBlocks) {
        await api.editMessage(
          activePlatform,
          b.editTarget || b.id,
          "",
          sessionDetail.sessionKey,
          b.content
        );
      }
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, sessionDetail.sessionKey),
        api.getEditLog(activePlatform, sessionDetail.sessionKey),
      ]);
      dispatch({ type: "setSessionDetail", payload: updated });
      dispatch({ type: "setEditLog", payload: logs });
      setDnaRangeStart(null);
      setDnaRangeEnd(null);
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "success",
          message: t("hud.batchErasedToast", { count: targetBlocks.length }),
        },
      });
    } catch (err) {
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "error",
          message: describeSaveError(t("session.saveFailed"), err),
        },
      });
    } finally {
      setBatchErasing(false);
    }
  };

  const handleLocateNoiseSpike = () => {
    if (dnaCells.length === 0) return;
    let maxIdx = 0;
    for (let i = 1; i < dnaCells.length; i++) {
      if (dnaCells[i].tokens > dnaCells[maxIdx].tokens) maxIdx = i;
    }
    const targetCell = dnaCells[maxIdx];
    if (targetCell.tokens < 1500) {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("hud.cleanSessionToast") },
      });
      scrollToBlockId(targetCell.representativeId);
      return;
    }
    setDnaRangeStart(Math.max(0, maxIdx - 1));
    setDnaRangeEnd(maxIdx);
    scrollToBlockId(targetCell.representativeId);
  };

  const handleEraseToolCall = async (
    blockId: string,
    toolCall: ToolCallBlock
  ) => {
    if (activePlatform !== "opencode") return;
    const sessionKey = sessionDetail.sessionKey;
    if (
      !(await confirm({
        title: t("session.eraseToolCall"),
        description: t("session.eraseToolCallConfirm"),
        variant: "danger",
      }))
    ) {
      return;
    }
    setErasingToolCallId(toolCall.id);
    try {
      await api.eraseToolCall(activePlatform, toolCall.id, sessionKey);
      if (activeSessionKeyRef.current !== sessionKey) return;
      const updatedBlocks = sessionDetail.blocks.map((block) =>
        block.id === blockId
          ? {
              ...block,
              toolCalls: block.toolCalls?.filter(
                (item) => item.id !== toolCall.id
              ),
            }
          : block
      );
      const logs = await api.getEditLog(activePlatform, sessionKey);
      dispatch({
        type: "setSessionDetail",
        payload: { ...sessionDetail, blocks: updatedBlocks },
      });
      dispatch({ type: "setEditLog", payload: logs });
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("session.toolCallErased") },
      });
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.saveFailed") },
      });
    } finally {
      setErasingToolCallId(null);
    }
  };

  const handleLoadExecutionOutput = async (block: TimelineBlock) => {
    if (!block.editTarget) return;
    const target = block.editTarget;
    setLoadingExecutionTargets((prev) => new Set(prev).add(target));
    try {
      const output = await api.getExecutionOutput(
        activePlatform,
        sessionDetail.sessionKey,
        target
      );
      if (activeSessionKeyRef.current !== sessionDetail.sessionKey) return;
      const updatedBlocks = sessionDetail.blocks.map((b) =>
        (b.editTarget || b.id) === target ? { ...b, content: output } : b
      );
      dispatch({
        type: "setSessionDetail",
        payload: { ...sessionDetail, blocks: updatedBlocks },
      });
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.refreshFailed") },
      });
    } finally {
      setLoadingExecutionTargets((prev) => {
        const next = new Set(prev);
        next.delete(target);
        return next;
      });
    }
  };

  const handleLoadAllExecutionOutputs = async () => {
    const targets = kiroExecutionPlaceholderBlocks
      .map((block) => block.editTarget)
      .filter((target): target is string => Boolean(target));
    if (targets.length === 0) return;

    setLoadingAllExecutionOutputs(true);
    setLoadingExecutionTargets(new Set(targets));
    try {
      const outputs = await api.getExecutionOutputs(
        activePlatform,
        sessionDetail.sessionKey,
        targets
      );
      if (activeSessionKeyRef.current !== sessionDetail.sessionKey) return;
      const updatedBlocks = sessionDetail.blocks.map((block) => {
        const target = block.editTarget || block.id;
        const output = outputs[target];
        return output ? { ...block, content: output } : block;
      });
      dispatch({
        type: "setSessionDetail",
        payload: { ...sessionDetail, blocks: updatedBlocks },
      });
    } finally {
      setLoadingAllExecutionOutputs(false);
      setLoadingExecutionTargets(new Set());
    }
  };

  const handleRefresh = async () => {
    if (!selectedSessionKey) return;
    setRefreshing(true);
    setRefreshDone(false);
    try {
      const [detail, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, selectedSessionKey),
        api.getEditLog(activePlatform, selectedSessionKey).catch(() => []),
      ]);
      dispatch({ type: "setSessionDetail", payload: detail });
      dispatch({ type: "setEditLog", payload: logs });
      setRefreshDone(true);
      setTimeout(() => setRefreshDone(false), 1400);
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.refreshFailed") },
      });
    }
    setRefreshing(false);
  };

  const handleCopyCommand = async (label: string, command: string) => {
    const operationKey = `${sessionDetail.sessionKey}::${label}`;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedKey(operationKey);
      setTimeout(
        () => setCopiedKey((cur) => (cur === operationKey ? null : cur)),
        1800
      );
    } catch {
      // ignore
    }
  };

  const handleOpenExternalTerminal = async (label: string, command: string) => {
    const operationKey = `${sessionDetail.sessionKey}::${label}`;
    setOpeningKey(operationKey);
    try {
      await api.launchSessionTerminal(command, sessionDetail.cwd || null);
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("session.terminalOpened") },
      });
    } catch {
      await handleCopyCommand(label, command);
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.terminalOpenFailed") },
      });
    } finally {
      setOpeningKey((cur) => (cur === operationKey ? null : cur));
    }
  };

  // Same-Screen Live PTY Verification! (Opens bottom PTY bay without leaving conversation!)
  const handleStartEmbeddedPty = async (
    commandKind: "resume" | "fork",
    command: string
  ) => {
    const terminalId = await startTerminal(
      sessionDetail.sessionKey,
      commandKind,
      command,
      sessionDetail.cwd || null,
      {
        platform: activePlatform,
        sessionTitle:
          sessionDetail.aliasTitle ||
          sessionDetail.title ||
          sessionDetail.sessionId,
      }
    );
    if (!terminalId) {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("terminal.tabs.maxWarning") },
      });
      return;
    }
    dispatch({ type: "setPtyBayOpen", payload: true });
  };

  const handleOpenWorkspace = async (target: EditorTarget | null) => {
    if (!target || !sessionDetail.cwd) return;
    const operationKey = `${sessionDetail.sessionKey}::${target.id}`;
    setOpeningEditorId(operationKey);
    setEditorMenuOpen(false);
    setPreferredEditorId(target.id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PREFERRED_EDITOR_STORAGE_KEY, target.id);
    }
    try {
      await api.openPathInEditor(target.id, sessionDetail.cwd);
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "success",
          message: `${t("session.workspaceOpened")} · ${target.label}`,
        },
      });
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.workspaceOpenFailed") },
      });
    } finally {
      setOpeningEditorId((cur) => (cur === operationKey ? null : cur));
    }
  };

  const handleExportMarkdown = async (customSlice?: TimelineBlock[]) => {
    const lines: string[] = [];
    lines.push(`# ${sessionDetail.title || sessionDetail.sessionId}`);
    lines.push("");
    lines.push(`- Platform: ${sessionDetail.platform}`);
    lines.push(`- Session ID: ${sessionDetail.sessionId}`);
    if (sessionDetail.cwd) lines.push(`- Working Dir: ${sessionDetail.cwd}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    let blocksToExport = customSlice ?? sessionDetail.blocks;
    if (!customSlice) {
      if (exportRange.startsWith("recent")) {
        const count = Number.parseInt(exportRange.replace("recent", ""), 10);
        blocksToExport = blocksToExport.slice(-count);
      } else if (exportRange === "since" && exportSinceDate) {
        const since = new Date(`${exportSinceDate}T00:00:00`).getTime();
        blocksToExport = blocksToExport.filter((block) => {
          const raw =
            block.createdAt ??
            (typeof block.sourceMeta.createdAt === "string" ||
            typeof block.sourceMeta.createdAt === "number"
              ? block.sourceMeta.createdAt
              : null);
          if (!raw) return false;
          const ts = new Date(raw).getTime();
          return Number.isFinite(ts) && ts >= since;
        });
      }
    }

    for (const block of blocksToExport) {
      const toolCalls = block.toolCalls ?? [];
      const hasContent = block.content.trim().length > 0;
      const hasToolCalls = includeToolCallsInExport && toolCalls.length > 0;
      if (!hasContent && !hasToolCalls) continue;

      const roleLabel =
        block.role === "user"
          ? "User"
          : block.role === "assistant"
            ? "Assistant"
            : "Thinking";
      lines.push(`## ${roleLabel}`);
      lines.push("");
      if (hasContent) {
        lines.push(block.content);
        lines.push("");
      }
      if (hasToolCalls) {
        lines.push("### Tool Calls");
        lines.push("");
        toolCalls.forEach((tc, idx) => {
          lines.push(`#### ${idx + 1}. ${tc.name || tc.kind || "tool"}`);
          lines.push("");
          if (tc.input) {
            pushMarkdownCodeBlock(
              lines,
              "Input",
              "json",
              tc.input,
              TOOL_INPUT_EXPORT_LIMIT
            );
          }
          if (tc.output) {
            pushMarkdownCodeBlock(
              lines,
              "Output",
              "text",
              tc.output,
              TOOL_OUTPUT_EXPORT_LIMIT
            );
          }
        });
      }
      lines.push("---");
      lines.push("");
    }

    const content = lines.join("\n");
    const fileName = `${safeExportFileName(sessionDetail.title || sessionDetail.sessionId)}.md`;

    if (isTauriRuntime) {
      const saved = await api.exportMarkdown(fileName, content);
      if (!saved) return;
    } else {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    }

    setExportDone(true);
    dispatch({
      type: "setSessionStatus",
      payload: { tone: "success", message: t("session.exported") },
    });
    setTimeout(() => setExportDone(false), 1800);
  };

  const handleExportRawJsonl = async () => {
    if (!canExportRawJsonl) return;
    const baseName = safeExportFileName(
      `${activePlatform}-${sessionDetail.sessionId || sessionDetail.sessionKey}`
    );
    setExportingRawJsonl(true);
    try {
      const exported = await api.exportRawJsonl(
        activePlatform,
        sessionDetail.sessionKey,
        `${baseName}.jsonl`
      );
      if (!exported) return;
      setExportDone(true);
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("session.rawExported") },
      });
      setTimeout(() => setExportDone(false), 1800);
    } catch (err) {
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      setExportingRawJsonl(false);
      setExportMenuOpen(false);
    }
  };

  const loadArsenalIfNeeded = async () => {
    if (arsenalPrompts !== null) return;
    try {
      const list = await listPrompts();
      setArsenalPrompts(list);
    } catch {
      setArsenalPrompts([]);
    }
  };

  const detailLoading =
    Boolean(selectedSessionKey) &&
    selectedSessionKey !== sessionDetail.sessionKey;
  const isStarred = sessions.find(
    (s) => s.sessionKey === sessionDetail.sessionKey
  )?.favorite;
  const resumeCommand = sessionDetail.commands?.resume;
  const forkCommand = sessionDetail.commands?.fork;

  const hasDnaRange =
    dnaRangeStart !== null &&
    dnaRangeEnd !== null &&
    dnaRangeStart !== dnaRangeEnd;
  const loDnaIdx = hasDnaRange ? Math.min(dnaRangeStart, dnaRangeEnd) : null;
  const hiDnaIdx = hasDnaRange ? Math.max(dnaRangeStart, dnaRangeEnd) : null;
  const rangeTurnStart =
    loDnaIdx !== null ? (dnaCells[loDnaIdx]?.startIndex ?? 0) : 0;
  const rangeTurnEnd =
    hiDnaIdx !== null ? (dnaCells[hiDnaIdx]?.endIndex ?? 0) : 0;
  const rangeTokSum =
    loDnaIdx !== null && hiDnaIdx !== null
      ? dnaCells
          .slice(loDnaIdx, hiDnaIdx + 1)
          .reduce((acc, c) => acc + c.tokens, 0)
      : 0;

  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-void)]">
      {detailLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--bg-void)]/65 backdrop-blur-[1px]">
          <RefreshCw className="size-5 animate-spin text-[var(--cyan-fg)]" />
        </div>
      )}

      {/* ==================== 40PX COMPACT 1-ROW STAGE HEADER ==================== */}
      <header className="z-20 flex h-[40px] shrink-0 items-center gap-2 border-b border-[var(--line-hair)] bg-[var(--bg-panel)] px-3">
        <span
          className={cn(
            "hud-mono shrink-0 rounded-[2px] border px-1.5 py-[1px] text-[9.5px] font-bold tracking-wider uppercase",
            getPlatformBadgeStyle(activePlatform)
          )}
        >
          {PLATFORM_LABELS[activePlatform] ?? activePlatform}
        </span>

        {/* Inline Editable Session Title / Alias */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {isEditingAlias ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                className="h-6 w-56 rounded-[3px] border border-[var(--cyan)] bg-[var(--bg-void)] px-2 text-xs font-semibold text-[var(--text-hi)] outline-none md:w-72"
                onBlur={() => {
                  void handleSaveAlias(tempAlias);
                  setIsEditingAlias(false);
                }}
                onChange={(e) => setTempAlias(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleSaveAlias(tempAlias);
                    setIsEditingAlias(false);
                  } else if (e.key === "Escape") {
                    setIsEditingAlias(false);
                  }
                }}
                placeholder={t("session.setAlias")}
                value={tempAlias}
              />
              <button
                type="button"
                onClick={() => {
                  void handleSaveAlias(tempAlias);
                  setIsEditingAlias(false);
                }}
                className="grid size-6 place-items-center rounded-[3px] text-[var(--emerald-fg)] hover:bg-[var(--emerald-dim)]"
              >
                <Check className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTempAlias(sessionDetail.aliasTitle || "");
                setIsEditingAlias(true);
              }}
              className="group flex min-w-0 items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-left hover:bg-[var(--bg-hover)]"
              title={`${t("session.setAlias")} · ID: ${sessionDetail.sessionId}`}
            >
              <span className="truncate text-[13.5px] font-bold text-[var(--text-hi)]">
                {sessionDetail.aliasTitle ||
                  (!isUuidLikeTitle(sessionDetail.title)
                    ? sessionDetail.title
                    : cleanHumanPreview(
                        blocks.find((b) => b.role === "user")?.content
                      ).slice(0, 72) ||
                      sessionDetail.title ||
                      sessionDetail.sessionId)}
              </span>
              <Pencil className="size-3 shrink-0 text-[var(--text-low)] opacity-0 group-hover:opacity-100" />
            </button>
          )}

          <button
            type="button"
            onClick={async () => {
              const isNow = await api.toggleFlag(
                activePlatform,
                sessionDetail.sessionKey,
                "favorite"
              );
              dispatch({
                type: "updateSession",
                payload: {
                  sessionKey: sessionDetail.sessionKey,
                  updates: { favorite: isNow },
                },
              });
            }}
            className={cn(
              "shrink-0 rounded p-1 transition-colors",
              isStarred
                ? "text-[var(--forge-fg)]"
                : "text-[var(--text-low)] hover:text-[var(--forge-fg)]"
            )}
            title={t("session.favorite")}
          >
            <Star className={cn("size-3.5", isStarred && "fill-current")} />
          </button>

          {sessionStatus && (
            <span
              className={cn(
                "hud-mono hidden truncate rounded-[3px] border px-2 py-0.5 text-[10px] lg:inline-block",
                sessionStatus.tone === "success"
                  ? "border-[var(--emerald-line)] bg-[var(--emerald-dim)] text-[var(--emerald-fg)]"
                  : "border-[var(--crimson-line)] bg-[var(--crimson-dim)] text-[var(--crimson-fg)]"
              )}
            >
              {sessionStatus.message}
            </span>
          )}
        </div>

        {/* Right Stage Actions */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {kiroExecutionPlaceholderBlocks.length > 0 && (
            <button
              type="button"
              disabled={loadingAllExecutionOutputs}
              onClick={() => void handleLoadAllExecutionOutputs()}
              className="hud-btn"
            >
              <RefreshCw
                className={cn(
                  "size-3",
                  loadingAllExecutionOutputs && "animate-spin"
                )}
              />
              <span className="hidden xl:inline">
                {t("hud.loadOutputs", {
                  count: kiroExecutionPlaceholderBlocks.length,
                })}
              </span>
            </button>
          )}

          {/* Open Workspace in IDE */}
          {canOpenWorkspace && (
            <div className="relative flex" ref={editorMenuRef}>
              <button
                type="button"
                disabled={Boolean(openingEditorId)}
                onClick={() => void handleOpenWorkspace(preferredEditor)}
                className="hud-btn rounded-r-none border-r-0 pr-2"
                title={`${t("session.openWorkspace")} · ${preferredEditor?.label ?? ""}`}
              >
                <PreferredIcon className="size-3 text-[var(--cyan-fg)]" />
                <span className="hidden lg:inline">
                  {preferredEditor?.label ?? t("session.openWorkspace")}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setEditorMenuOpen((v) => !v)}
                className="hud-btn rounded-l-none px-1.5"
                title={t("session.chooseEditor")}
              >
                <ChevronDown className="size-3" />
              </button>
              {editorMenuOpen && (
                <div className="absolute top-full right-0 z-50 mt-1 w-48 rounded-[5px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 shadow-2xl">
                  {editorTargets.map((target) => {
                    const TargetIcon = getEditorIcon(target.id);
                    const isPref = target.id === preferredEditor?.id;
                    return (
                      <button
                        key={target.id}
                        type="button"
                        onClick={() => void handleOpenWorkspace(target)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-[3px] px-2.5 py-1.5 text-left text-xs",
                          isPref
                            ? "bg-[var(--cyan-dim)] font-semibold text-[var(--cyan-fg)]"
                            : "hover:bg-[var(--bg-hover)]"
                        )}
                      >
                        <TargetIcon className="size-3.5 shrink-0" />
                        <span className="flex-1 truncate">{target.label}</span>
                        {isPref && <Check className="size-3" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Export Split Popover */}
          <div className="relative" ref={exportMenuRef}>
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              className={cn(
                "hud-btn",
                exportDone &&
                  "border-[var(--emerald-line)] text-[var(--emerald-fg)]"
              )}
            >
              {exportDone ? (
                <CheckCircle className="size-3" />
              ) : (
                <Download className="size-3" />
              )}
              <span className="hidden sm:inline">{t("session.export")}</span>
              <ChevronDown className="size-3 opacity-70" />
            </button>
            {exportMenuOpen && (
              <div className="absolute top-full right-0 z-50 mt-1 w-68 rounded-[6px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-3 shadow-2xl">
                <p className="hud-mono mb-2 text-[10px] font-bold tracking-wider text-[var(--text-low)] uppercase">
                  {t("session.exportRange")}
                </p>
                <div className="mb-2.5 grid grid-cols-3 gap-1">
                  {(
                    [
                      ["all", t("session.exportAll")],
                      ["recent20", t("session.exportRecent", { count: 20 })],
                      ["recent50", t("session.exportRecent", { count: 50 })],
                      ["recent100", t("session.exportRecent", { count: 100 })],
                      ["since", t("session.exportSince")],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setExportRange(val)}
                      className={cn(
                        "hud-mono rounded-[3px] border px-1.5 py-1 text-[10px]",
                        exportRange === val
                          ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)] font-semibold text-[var(--cyan-fg)]"
                          : "border-[var(--line-hair)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {exportRange === "since" && (
                  <input
                    className="hud-mono mb-2.5 w-full rounded-[3px] border border-[var(--line-strong)] bg-[var(--bg-void)] px-2 py-1 text-xs"
                    onChange={(e) => setExportSinceDate(e.target.value)}
                    type="date"
                    value={exportSinceDate}
                  />
                )}
                <label
                  className={cn(
                    "mb-2.5 flex items-center gap-2 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs",
                    hasExportableToolCalls
                      ? "cursor-pointer"
                      : "cursor-not-allowed opacity-50"
                  )}
                >
                  <input
                    checked={includeToolCallsInExport}
                    disabled={!hasExportableToolCalls}
                    onChange={(e) =>
                      setIncludeToolCallsInExport(e.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>{t("session.includeToolCalls")}</span>
                </label>
                <button
                  type="button"
                  disabled={exportRange === "since" && !exportSinceDate}
                  onClick={() => {
                    setExportMenuOpen(false);
                    void handleExportMarkdown();
                  }}
                  className="hud-btn hud-btn-forge w-full justify-center"
                >
                  <Download className="size-3" />
                  <span>{t("session.exportMarkdown")}</span>
                </button>
                {canExportRawJsonl && (
                  <button
                    type="button"
                    disabled={exportingRawJsonl}
                    onClick={() => void handleExportRawJsonl()}
                    className="hud-btn mt-1.5 w-full justify-center border-[var(--cyan-line)] text-[var(--cyan-fg)]"
                  >
                    <FileText className="size-3" />
                    <span>{t("session.exportRawJsonl")}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleLocateNoiseSpike}
            className="hud-btn"
            title={t("hud.locateSpike")}
          >
            <Scissors className="size-3 text-[var(--crimson-fg)]" />
            <span className="hidden lg:inline">{t("hud.locateSpike")}</span>
          </button>

          {/* Same-Screen Live PTY Resume Split Button */}
          {(resumeCommand || forkCommand) && (
            <div className="relative flex" ref={terminalMenuRef}>
              {resumeCommand && (
                <button
                  type="button"
                  onClick={() =>
                    void handleStartEmbeddedPty("resume", resumeCommand)
                  }
                  className="hud-btn hud-btn-emerald rounded-r-none border-r-0"
                  title={`${t("hud.liveVerify")} (${resumeCommand})`}
                >
                  <Play className="size-3 fill-current" />
                  <span>{t("hud.liveVerify")}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setTerminalMenuOpen((v) => !v)}
                className={cn(
                  "hud-btn hud-btn-emerald px-1.5",
                  resumeCommand && "rounded-l-none"
                )}
                title={t("hud.moreTerminalOpts")}
              >
                <ChevronDown className="size-3" />
              </button>
              {terminalMenuOpen && (
                <div className="absolute top-full right-0 z-50 mt-1 w-60 rounded-[6px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1.5 shadow-2xl">
                  {(["resume", "fork"] as const)
                    .filter((k) => Boolean(sessionDetail.commands?.[k]))
                    .map((kind, idx, arr) => {
                      const cmd = sessionDetail.commands[kind];
                      const opKey = `${sessionDetail.sessionKey}::${kind}`;
                      const isResume = kind === "resume";
                      return (
                        <div key={kind} className="space-y-0.5">
                          <div className="hud-mono px-2 py-1 text-[9.5px] font-bold tracking-wider text-[var(--text-low)] uppercase">
                            {t(isResume ? "hud.resumeGroup" : "hud.forkGroup")}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setTerminalMenuOpen(false);
                              void handleStartEmbeddedPty(kind, cmd);
                            }}
                            className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-xs text-[var(--emerald-fg)] hover:bg-[var(--emerald-dim)]"
                          >
                            <Terminal className="size-3.5 shrink-0" />
                            <span>
                              {t(
                                isResume
                                  ? "terminal.resumeEmbedded"
                                  : "terminal.forkEmbedded"
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={openingKey === opKey}
                            onClick={() => {
                              setTerminalMenuOpen(false);
                              void handleOpenExternalTerminal(kind, cmd);
                            }}
                            className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-hover)]"
                          >
                            <ExternalLink className="size-3.5 shrink-0 text-[var(--cyan-fg)]" />
                            <span>
                              {t(
                                isResume
                                  ? "terminal.resumeExternal"
                                  : "terminal.forkExternal"
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTerminalMenuOpen(false);
                              void handleCopyCommand(kind, cmd);
                            }}
                            className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-xs text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                          >
                            <Copy className="size-3.5 shrink-0" />
                            <span>
                              {copiedKey === opKey
                                ? t("session.copied")
                                : t(
                                    isResume
                                      ? "terminal.copyResumeCmd"
                                      : "terminal.copyForkCmd"
                                  )}
                            </span>
                          </button>
                          {idx < arr.length - 1 && (
                            <div className="my-1 border-t border-[var(--line-subtle)]" />
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            className={cn(
              "grid size-[27px] place-items-center rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] text-[var(--text-mid)] hover:text-[var(--text-hi)]",
              refreshDone && "text-[var(--emerald-fg)]"
            )}
            title={t("session.refresh")}
          >
            {refreshDone ? (
              <CheckCircle className="size-3.5" />
            ) : (
              <RefreshCw
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
            )}
          </button>

          <button
            type="button"
            onClick={async () => {
              if (
                !(await confirm({
                  title: t("session.archive"),
                  description: t("session.archiveConfirm"),
                }))
              ) {
                return;
              }
              await api.toggleFlag(
                activePlatform,
                sessionDetail.sessionKey,
                "archived"
              );
              dispatch({
                type: "setSessions",
                payload: sessions.filter(
                  (s) => s.sessionKey !== sessionDetail.sessionKey
                ),
              });
              dispatch({ type: "setSelectedSessionKey", payload: null });
              dispatch({ type: "setSessionDetail", payload: null });
            }}
            className="grid size-[27px] place-items-center rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] text-[var(--text-mid)] hover:border-[var(--forge-line)] hover:text-[var(--forge-fg)]"
            title={t("session.archive")}
          >
            <Archive className="size-3.5" />
          </button>
        </div>
      </header>

      {/* ==================== SIGNATURE COMPONENT: CONTEXT DNA SPECTRUM BAR ==================== */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--line-hair)] bg-[var(--bg-rack)] px-3 py-1.5 select-none">
        <div className="hud-mono flex items-center gap-2 overflow-hidden text-[10px]">
          <span className="shrink-0 font-bold tracking-[0.06em] text-[var(--text-mid)]">
            {t("hud.dnaTitle")}
          </span>

          {/* Integrated Inline Session Search */}
          <div className="flex h-[22px] w-44 items-center gap-1.5 rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-panel)] px-2 transition-all focus-within:w-56 focus-within:border-[var(--cyan-line)]">
            <Search className="size-3 shrink-0 text-[var(--text-low)]" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-hi)] placeholder:text-[var(--text-low)] outline-none"
              onChange={(e) => setInlineSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearchNav(e.shiftKey ? "prev" : "next");
                } else if (e.key === "Escape") {
                  setInlineSearch("");
                }
              }}
              placeholder={t("session.search")}
              value={inlineSearch}
            />
            {searchNeedle && (
              <div className="flex shrink-0 items-center gap-0.5 text-[9.5px] text-[var(--forge-fg)]">
                <span>
                  {matchingBlockIds.length > 0
                    ? `${currentMatchIdx + 1}/${matchingBlockIds.length}`
                    : "0/0"}
                </span>
                <button
                  type="button"
                  disabled={matchingBlockIds.length === 0}
                  onClick={() => handleSearchNav("prev")}
                  className="hover:text-[var(--text-hi)]"
                >
                  <ChevronUp className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={matchingBlockIds.length === 0}
                  onClick={() => handleSearchNav("next")}
                  className="hover:text-[var(--text-hi)]"
                >
                  <ChevronDown className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setInlineSearch("")}
                  className="hover:text-[var(--text-hi)]"
                >
                  <X className="size-3" />
                </button>
              </div>
            )}
          </div>

          {sessionDetail.cwd && (
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(sessionDetail.cwd)
              }
              className="hidden max-w-[180px] truncate rounded-[3px] border border-[var(--line-subtle)] bg-[var(--bg-panel)] px-2 py-0.5 text-[10px] text-[var(--text-low)] hover:text-[var(--text-mid)] 2xl:inline-block"
              title={t("hud.copyCwdHint", { cwd: sessionDetail.cwd })}
            >
              {sessionDetail.cwd}
            </button>
          )}

          {/* Live Hover Readout for DNA Spectrum */}
          {hoveredDnaIdx !== null && dnaCells[hoveredDnaIdx] ? (
            <span className="hud-mono truncate rounded-[3px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cyan-fg)]">
              {(() => {
                const c = dnaCells[hoveredDnaIdx];
                const span =
                  c.startIndex === c.endIndex
                    ? `#${c.startIndex + 1}`
                    : `#${c.startIndex + 1}–#${c.endIndex + 1}`;
                const roleLabel =
                  c.role === "user"
                    ? t("session.filter.user")
                    : c.role === "thinking"
                      ? t("session.filter.thinking")
                      : t("session.filter.assistant");
                return `${span} · ${roleLabel} · ${formatTokenCount(c.tokens)} tok`;
              })()}
            </span>
          ) : blocks.length > 0 ? (
            <span className="hidden truncate text-[9.5px] text-[var(--text-low)] lg:inline">
              {t("hud.dnaHint", { count: blocks.length })}
            </span>
          ) : (
            <span className="hidden truncate text-[9.5px] text-[var(--text-low)] lg:inline">
              {t("hud.emptyTape")}
            </span>
          )}

          {/* Compact Role / Signal Filter Micro-Tabs */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {(
              [
                ["all", `${t("session.filter.all")} ${blocks.length}`],
                ["user", t("session.filter.user")],
                ["assistant", t("session.filter.assistant")],
                ["thinking", t("session.filter.thinking")],
                ["spike", `⚠ ${t("hud.filterSpike")}`],
              ] as const
            ).map(([key, label]) => {
              const active = roleFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => dispatch({ type: "setRoleFilter", payload: key })}
                  className={cn(
                    "rounded-[3px] border px-1.5 py-0.5 text-[9.5px] transition-colors",
                    active
                      ? "border-[var(--line-strong)] bg-[var(--bg-panel)] font-bold text-[var(--text-hi)]"
                      : "border-transparent text-[var(--text-low)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-hi)]"
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Zero-Scrollbar Full-Session Oscilloscope Spectrum Track */}
        <div
          onMouseLeave={() => setHoveredDnaIdx(null)}
          className="flex h-[26px] w-full items-end gap-[2px] overflow-hidden rounded-[3px] border border-[var(--line-hair)] bg-[repeating-linear-gradient(90deg,var(--line-subtle)_0_1px,transparent_1px_20px)] bg-[var(--bg-void)] px-1.5 pt-1 pb-[2px]"
        >
          {(() => {
            const firstVisFiltered = virtualItems[0]?.index ?? -1;
            const lastVisFiltered =
              virtualItems[virtualItems.length - 1]?.index ?? -1;
            const visIds = new Set<string>();
            if (firstVisFiltered >= 0 && lastVisFiltered >= firstVisFiltered) {
              for (let vi = firstVisFiltered; vi <= lastVisFiltered; vi++) {
                const id = filteredBlocks[vi]?.id;
                if (id) visIds.add(id);
              }
            }
            const showCellLabels = dnaCells.length <= 12;

            return dnaCells.map((cell, idx) => {
              const ratio = Math.max(0.16, Math.min(1, cell.tokens / maxDnaTok));
              const barColor = cell.forged
                ? "var(--forge)"
                : cell.spike
                  ? "var(--crimson)"
                  : cell.role === "user"
                    ? "var(--cyan)"
                    : "var(--asst-bar)";
              const inRange =
                loDnaIdx !== null &&
                hiDnaIdx !== null &&
                idx >= loDnaIdx &&
                idx <= hiDnaIdx;
              const isHovered = hoveredDnaIdx === idx;
              const inViewport = blocks
                .slice(cell.startIndex, cell.endIndex + 1)
                .some((b) => visIds.has(b.id));

              return (
                <div
                  key={`${cell.startIndex}-${cell.endIndex}`}
                  onClick={() => {
                    if (!hasDnaRange) {
                      setDnaRangeStart(null);
                      setDnaRangeEnd(null);
                      scrollToBlockId(cell.representativeId);
                    }
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsDraggingDna(true);
                    setDnaRangeStart(idx);
                    setDnaRangeEnd(idx);
                  }}
                  onMouseEnter={() => {
                    setHoveredDnaIdx(idx);
                    if (isDraggingDna) setDnaRangeEnd(idx);
                  }}
                  className={cn(
                    "relative flex h-full min-w-0 flex-1 cursor-pointer flex-col justify-end rounded-[1.5px] px-[1px] transition-colors",
                    showCellLabels && "max-w-[76px] px-1",
                    inRange
                      ? "bg-[var(--crimson-dim)] ring-1 ring-[var(--crimson)]"
                      : isHovered
                        ? "bg-[var(--cyan-dim)]"
                        : inViewport
                          ? "border-b-2 border-b-[var(--cyan)] bg-[var(--line-subtle)]"
                          : "hover:bg-[var(--line-subtle)]"
                  )}
                >
                  {showCellLabels && (
                    <div className="hud-mono mb-[1px] flex items-center justify-between overflow-hidden text-[8.5px] leading-none whitespace-nowrap text-[var(--text-low)]">
                      <span>{String(cell.startIndex + 1).padStart(2, "0")}</span>
                      <span>{formatTokenCount(cell.tokens)}</span>
                    </div>
                  )}
                  <span
                    className="w-full rounded-t-[1.5px] transition-[height] duration-150"
                    style={{
                      height: `${Math.max(16, Math.round(ratio * (showCellLabels ? 62 : 94)))}%`,
                      backgroundColor: barColor,
                      opacity: isHovered || inRange || cell.spike || cell.forged ? 1 : 0.82,
                    }}
                  />
                </div>
              );
            });
          })()}
        </div>

        {/* Range Splice Action Bar */}
        {hasDnaRange && (
          <div className="hud-mono flex items-center justify-between gap-2 rounded-[3px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-2.5 py-1 text-[10.5px]">
            <div>
              <strong className="text-[var(--crimson-fg)]">
                {t("hud.rangeSelected", {
                  start: rangeTurnStart + 1,
                  end: rangeTurnEnd + 1,
                })}
              </strong>
              <span className="ml-2 text-[var(--text-mid)]">
                {t("hud.rangeTokens", {
                  tokens: formatTokenCount(rangeTokSum),
                })}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={batchErasing}
                onClick={() => void handleBatchEraseDnaRange()}
                className="hud-btn hud-btn-danger h-[22px] text-[10.5px]"
              >
                <Scissors className="size-3" />
                <span>
                  {batchErasing ? t("hud.rangeErasing") : t("hud.rangeEraseBtn")}
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleExportMarkdown(
                    blocks.slice(rangeTurnStart, rangeTurnEnd + 1)
                  )
                }
                className="hud-btn h-[22px] text-[10.5px]"
              >
                <Download className="size-3" />
                <span>{t("hud.rangeExportBtn")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDnaRangeStart(null);
                  setDnaRangeEnd(null);
                }}
                className="hud-btn h-[22px] px-2 text-[10.5px]"
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ==================== CAUSAL TAPE STREAM + FLOATING SCRUBBER RAIL ==================== */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={messageScrollRef}
          className="h-full w-full min-h-0 overflow-y-auto pr-9 pl-3.5 md:pr-11 md:pl-6"
        >
          {filteredBlocks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-16 text-center">
              <p className="hud-mono text-xs font-semibold text-[var(--text-mid)]">
                {blocks.length === 0
                  ? t("hud.noFramesInSession")
                  : t("hud.noMatchingFilter")}
              </p>
              {blocks.length > 0 && roleFilter !== "all" && (
                <button
                  type="button"
                  onClick={() => dispatch({ type: "setRoleFilter", payload: "all" })}
                  className="hud-btn mt-2.5 text-[11px]"
                >
                  {t("hud.showAllFrames", { count: blocks.length })}
                </button>
              )}
            </div>
          ) : (
          <div
            className="relative mx-auto w-full max-w-[940px]"
            style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const block = filteredBlocks[virtualItem.index];
              if (!block) return null;
              const targetId = block.editTarget || block.id;
              const forgedInfo = forgedByTarget.get(targetId);
              const isEditingThis = editingBlock?.id === targetId;
              const estTok = estimateBlockTokens(block);

              return (
                <div
                  key={virtualItem.key}
                  ref={messageVirtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  data-index={virtualItem.index}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <CausalFrame
                    arsenalPrompts={arsenalPrompts}
                    block={block}
                    canEraseToolCalls={activePlatform === "opencode"}
                    editingContent={isEditingThis ? editingBlock.content : ""}
                    editingOriginal={
                      isEditingThis ? editingBlock.originalContent : ""
                    }
                    erasingToolCallId={erasingToolCallId}
                    estimatedTokens={estTok}
                    forgedInfo={forgedInfo}
                    forkCommand={forkCommand}
                    index={virtualItem.index}
                    isCurrentMatch={
                      matchingBlockIds[currentMatchIdx] === block.id
                    }
                    isEditing={isEditingThis}
                    loadingExecutionOutput={Boolean(
                      block.editTarget &&
                        loadingExecutionTargets.has(block.editTarget)
                    )}
                    onCancelEdit={() =>
                      dispatch({ type: "setEditingBlock", payload: null })
                    }
                    onChangeEdit={(val) => {
                      if (!editingBlock) return;
                      dispatch({
                        type: "setEditingBlock",
                        payload: { ...editingBlock, content: val },
                      });
                    }}
                    onCommitEdit={() => void handleCommitInlineEdit()}
                    onContextMenu={(e) => {
                      if (
                        window.getSelection()?.toString()?.trim() ||
                        isEditingThis
                      ) {
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      setMsgCtxMenu({
                        x: Math.min(window.innerWidth - 216, e.clientX),
                        y: Math.min(window.innerHeight - 220, e.clientY),
                        block,
                        forgedEntry: forgedInfo?.latest,
                      });
                    }}
                    onErase={() => void handleEraseBlock(block)}
                    onEraseToolCall={(tc) =>
                      void handleEraseToolCall(block.id, tc)
                    }
                    onForkInPty={
                      forkCommand
                        ? () => void handleStartEmbeddedPty("fork", forkCommand)
                        : undefined
                    }
                    onLoadArsenal={() => void loadArsenalIfNeeded()}
                    onLoadExecutionOutput={() =>
                      void handleLoadExecutionOutput(block)
                    }
                    onOpenAudit={() =>
                      dispatch({ type: "setShowEditLog", payload: !showEditLog })
                    }
                    onRevert={
                      forgedInfo
                        ? () => void handleRevertForgedBlock(forgedInfo.latest)
                        : undefined
                    }
                    onStartEdit={() => handleStartInlineEdit(block)}
                    savingEdit={savingEdit}
                    searchHighlight={searchNeedle}
                    t={t}
                  />
                </div>
              );
            })}
          </div>
          )}
        </div>

        {/* Floating Right Scrubber Rail (sits inside the outer scrollbar, just like Devin Desktop!) */}
        {dnaCells.length > 0 && (
          <div
            onMouseLeave={() => setHoveredRail(null)}
            className="absolute top-1/2 right-3 z-20 flex max-h-[76%] -translate-y-1/2 flex-col items-end justify-center gap-[5px] py-2 select-none"
          >
            {(() => {
              const railSlice =
                dnaCells.length > 36
                  ? dnaCells.filter(
                      (_, idx) =>
                        idx % Math.ceil(dnaCells.length / 36) === 0 ||
                        idx === dnaCells.length - 1
                    )
                  : dnaCells;

              const firstVis = virtualItems[0]?.index ?? -1;
              const lastVis = virtualItems[virtualItems.length - 1]?.index ?? -1;
              const visIds = new Set<string>();
              if (firstVis >= 0 && lastVis >= firstVis) {
                for (let vi = firstVis; vi <= lastVis; vi++) {
                  const id = filteredBlocks[vi]?.id;
                  if (id) visIds.add(id);
                }
              }

              return railSlice.map((cell) => {
                const origIdx = dnaCells.indexOf(cell);
                const isHovered = hoveredRail?.idx === origIdx;
                const inView = blocks
                  .slice(cell.startIndex, cell.endIndex + 1)
                  .some((b) => visIds.has(b.id));

                const barTone = isHovered
                  ? "bg-[var(--cyan)]"
                  : cell.forged
                    ? "bg-[var(--forge)]"
                    : inView
                      ? "bg-[var(--text-hi)]"
                      : "bg-[var(--text-low)]/40";

                const barWidth = isHovered
                  ? "w-4"
                  : inView
                    ? "w-3"
                    : cell.previewRole === "user" || cell.forged
                      ? "w-2.5"
                      : "w-1.5";

                return (
                  <button
                    key={`mm-${cell.startIndex}`}
                    type="button"
                    onClick={() => scrollToBlockId(cell.representativeId)}
                    onMouseEnter={(e) => {
                      const parentRect =
                        e.currentTarget.parentElement?.getBoundingClientRect();
                      const btnRect = e.currentTarget.getBoundingClientRect();
                      const rawTop = parentRect
                        ? btnRect.top - parentRect.top - 42
                        : 0;
                      const maxTop = parentRect
                        ? Math.max(-20, parentRect.height - 110)
                        : 240;
                      setHoveredRail({
                        idx: origIdx,
                        offsetTop: Math.max(-24, Math.min(maxTop, rawTop)),
                      });
                    }}
                    className="group flex h-[6px] items-center justify-end pl-2"
                  >
                    <span
                      className={cn(
                        "h-[1.5px] rounded-full transition-all duration-100 group-hover:h-[2.5px] group-hover:w-4",
                        barTone,
                        barWidth
                      )}
                    />
                  </button>
                );
              });
            })()}

            {/* Instant Floating Preview Card */}
            {hoveredRail !== null && dnaCells[hoveredRail.idx] && (
              <div
                style={{ top: `${hoveredRail.offsetTop}px` }}
                className="pointer-events-none absolute right-6 z-40 w-[300px] rounded-[8px] border border-slate-700/80 bg-[#151922]/96 p-3 text-slate-100 shadow-[0_14px_38px_rgba(0,0,0,0.48)] backdrop-blur-md"
              >
              {(() => {
                const cell = dnaCells[hoveredRail.idx];
                const roleName =
                  cell.previewRole === "user"
                    ? t("session.filter.user")
                    : cell.previewRole === "thinking"
                      ? t("session.filter.thinking")
                      : t("session.filter.assistant");
                const dotColor =
                  cell.previewRole === "user"
                    ? "bg-cyan-400"
                    : cell.previewRole === "thinking"
                      ? "bg-violet-400"
                      : "bg-slate-300";
                return (
                  <>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", dotColor)}
                      />
                      <span className="font-semibold text-white">
                        {roleName}
                      </span>
                      <span className="hud-mono text-[10px] text-slate-400">
                        #{cell.previewTurnNum}
                        {cell.previewTime ? ` · ${cell.previewTime}` : ""}
                      </span>
                      {cell.forged && (
                        <span className="hud-mono rounded bg-amber-500/20 px-1 text-[9.5px] font-bold text-amber-300">
                          ⚡{t("hud.forgedStamp", { count: 1 }).split(" · ")[0]}
                        </span>
                      )}
                      {cell.spike && (
                        <span className="hud-mono rounded bg-rose-500/20 px-1 text-[9.5px] font-bold text-rose-300">
                          ⚠{formatTokenCount(cell.tokens)}
                        </span>
                      )}
                      <span className="hud-mono ml-auto text-[10px] text-slate-400">
                        {formatTokenCount(cell.tokens)} tok
                      </span>
                    </div>
                    <p className="line-clamp-4 text-xs leading-[1.55] break-words text-slate-200/95">
                      {cell.previewText}
                    </p>
                  </>
                );
              })()}
            </div>
            )}
          </div>
        )}
      </div>

      {/* Message Frame Right-Click Context Menu */}
      {msgCtxMenu && (
        <div
          style={{ left: `${msgCtxMenu.x}px`, top: `${msgCtxMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-50 w-[208px] rounded-[6px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 text-xs shadow-2xl"
        >
          {msgCtxMenu.block.content.trim().length > 0 && (
            <button
              type="button"
              onClick={() => {
                const txt = msgCtxMenu.block.content;
                setMsgCtxMenu(null);
                void navigator.clipboard.writeText(txt);
                dispatch({
                  type: "setSessionStatus",
                  payload: { tone: "success", message: t("session.copied") },
                });
              }}
              className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
            >
              <Copy className="size-3.5 shrink-0 text-[var(--cyan-fg)]" />
              <span className="truncate">{t("hud.ctxCopyMessage")}</span>
            </button>
          )}

          {msgCtxMenu.block.editable !== false && (
            <button
              type="button"
              onClick={() => {
                const b = msgCtxMenu.block;
                setMsgCtxMenu(null);
                handleStartInlineEdit(b);
              }}
              className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--forge-fg)] hover:bg-[var(--forge-dim)]"
            >
              <Pencil className="size-3.5 shrink-0" />
              <span className="truncate">{t("session.editThisMessage")}</span>
            </button>
          )}

          {msgCtxMenu.block.content.trim().length > 0 && (
            <button
              type="button"
              onClick={async () => {
                const txt = msgCtxMenu.block.content.trim();
                setMsgCtxMenu(null);
                const autoName =
                  cleanHumanPreview(txt).slice(0, 32) || "Saved Prompt";
                try {
                  await createPrompt({
                    name: autoName,
                    content: txt,
                    tags: [activePlatform],
                  });
                  setArsenalPrompts(null);
                  dispatch({
                    type: "setSessionStatus",
                    payload: {
                      tone: "success",
                      message: t("hud.ctxSavedAsPrompt"),
                    },
                  });
                } catch {
                  dispatch({
                    type: "setSessionStatus",
                    payload: { tone: "error", message: t("saveError") },
                  });
                }
              }}
              className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
            >
              <BookOpen className="size-3.5 shrink-0 text-[var(--cyan-fg)]" />
              <span className="truncate">{t("hud.ctxSaveAsPrompt")}</span>
            </button>
          )}

          {msgCtxMenu.forgedEntry && (
            <button
              type="button"
              onClick={() => {
                const entry = msgCtxMenu.forgedEntry;
                setMsgCtxMenu(null);
                if (entry) void handleRevertForgedBlock(entry);
              }}
              className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--cyan-fg)] hover:bg-[var(--cyan-dim)]"
            >
              <Undo2 className="size-3.5 shrink-0" />
              <span className="truncate">{t("hud.revertOriginal")}</span>
            </button>
          )}

          {msgCtxMenu.block.editable !== false && (
            <>
              <div className="my-1 border-t border-[var(--line-subtle)]" />
              <button
                type="button"
                onClick={() => {
                  const b = msgCtxMenu.block;
                  setMsgCtxMenu(null);
                  void handleEraseBlock(b);
                }}
                className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--crimson-fg)] hover:bg-[var(--crimson-dim)]"
              >
                <Trash2 className="size-3.5 shrink-0" />
                <span className="truncate">{t("session.erase")}</span>
              </button>
            </>
          )}
        </div>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </section>
  );
}

/* ==================== CODE BLOCK & RICH PARSER ==================== */
function CodeBlockRenderer({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 overflow-hidden rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-code)]">
      <div className="hud-mono flex items-center justify-between border-b border-[var(--line-hair)] bg-[var(--line-subtle)] px-3 py-1 text-[9.5px] text-[var(--text-low)] select-none">
        <span className="font-bold tracking-wider text-[var(--cyan-fg)] uppercase">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 hover:text-[var(--text-hi)]",
            copied && "text-[var(--emerald-fg)]"
          )}
        >
          {copied ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
          <span>{copied ? "COPIED" : "COPY"}</span>
        </button>
      </div>
      <pre className="hud-mono overflow-x-auto px-3 py-2 text-[11.5px] leading-relaxed whitespace-pre text-[var(--text-hi)]">
        {code}
      </pre>
    </div>
  );
}

function CollapsibleSystemTag({
  tagName,
  innerText,
  t,
}: {
  tagName: string;
  innerText: string;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      {open ? (
        <div className="rounded-[4px] border border-dashed border-[var(--line-strong)] bg-[var(--bg-code)] p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="hud-mono text-[10px] font-semibold text-[var(--text-low)]">
              &lt;{tagName}&gt;
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="hud-mono text-[10px] text-[var(--cyan-fg)] hover:underline"
            >
              {t("hud.systemTagCollapse", { tag: tagName })}
            </button>
          </div>
          <pre className="hud-mono max-h-56 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--text-mid)]">
            {innerText.trim()}
          </pre>
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="hud-mono inline-flex items-center gap-1.5 rounded-[3px] border border-dashed border-[var(--line-strong)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-low)] transition-colors hover:border-[var(--cyan-line)] hover:text-[var(--text-hi)]"
        >
          <span>
            {t("hud.systemTagCollapsed", {
              tag: tagName,
              count: innerText.length,
            })}
          </span>
        </button>
      )}
    </div>
  );
}

function parseProseAndCode(
  text: string,
  searchHighlight?: string,
  keySeed = 0
): React.ReactNode[] {
  const highlightText = (val: string) => {
    if (!searchHighlight) return val;
    const escaped = searchHighlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const parts = val.split(regex);
    if (parts.length === 1) return val;
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <mark
          key={i}
          className="rounded-[2px] border border-[var(--forge-line)] bg-[var(--forge-dim)] px-0.5 text-[var(--forge-fg)]"
        >
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  const renderInlineTokens = (segment: string) => {
    const tokenRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    const tokens = segment.split(tokenRegex);
    if (tokens.length === 1) return highlightText(segment);
    return tokens.map((tok, idx) => {
      if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
        return (
          <code
            key={idx}
            className="hud-mono rounded-[3px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-1 py-[0.5px] text-[12px] text-[var(--cyan-fg)]"
          >
            {highlightText(tok.slice(1, -1))}
          </code>
        );
      }
      if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
        return (
          <strong key={idx} className="font-bold text-[var(--text-hi)]">
            {highlightText(tok.slice(2, -2))}
          </strong>
        );
      }
      return <span key={idx}>{highlightText(tok)}</span>;
    });
  };

  const parts: React.ReactNode[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = keySeed;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={`p-${key++}`} className="whitespace-pre-wrap">
          {renderInlineTokens(text.slice(lastIndex, match.index))}
        </span>
      );
    }
    parts.push(
      <CodeBlockRenderer
        code={match[2]?.trim() ?? ""}
        key={`c-${key++}`}
        language={match[1] ?? ""}
      />
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={`p-${key++}`} className="whitespace-pre-wrap">
        {renderInlineTokens(text.slice(lastIndex))}
      </span>
    );
  }
  return parts;
}

function parseContentWithCodeBlocks(
  text: string,
  searchHighlight?: string,
  t?: (key: MessageKey, params?: Record<string, string | number>) => string
) {
  if (!text) return "";
  if (!t) return parseProseAndCode(text, searchHighlight);

  const sysRegex =
    /<(system-reminder|environment_details|additional_metadata|ide_opened_file|user-prompt-submit-hook)(?:\s[^>]*)?>([\s\S]*?)<\/(?:system-reminder|environment_details|additional_metadata|ide_opened_file|user-prompt-submit-hook)>/gi;
  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = sysRegex.exec(text)) !== null) {
    const before = text.slice(lastIdx, m.index).replace(/^\n+|\n+$/g, "");
    if (before) {
      nodes.push(...parseProseAndCode(before, searchHighlight, k * 100));
      k++;
    }
    nodes.push(
      <CollapsibleSystemTag
        innerText={m[2] ?? ""}
        key={`sys-${k++}`}
        t={t}
        tagName={m[1] ?? "system-reminder"}
      />
    );
    lastIdx = sysRegex.lastIndex;
  }

  const tail = text.slice(lastIdx).replace(/^\n+/, "");
  if (tail) {
    nodes.push(...parseProseAndCode(tail, searchHighlight, k * 100));
  }
  return nodes.length > 0 ? nodes : parseProseAndCode(text, searchHighlight);
}

/* ==================== COMPACT PIPELINE CHIPS FOR TOOL CALLS ==================== */
function ToolPipelineStrip({
  toolCalls,
  hasBody,
  canErase,
  eraseLabel,
  erasingToolCallId,
  onErase,
  t,
}: {
  toolCalls: ToolCallBlock[];
  hasBody: boolean;
  canErase: boolean;
  eraseLabel: string;
  erasingToolCallId: string | null;
  onErase: (toolCall: ToolCallBlock) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const activeTool = expandedIdx !== null ? toolCalls[expandedIdx] : null;

  return (
    <div
      className={cn(
        hasBody && "mb-2 border-b border-[var(--line-subtle)] pb-2"
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {toolCalls.map((tc, idx) => {
          const isErr = Boolean(tc.error || tc.status === "error");
          const outChars =
            (tc.input?.length ?? 0) +
            (tc.output?.length ?? 0) +
            (tc.error?.length ?? 0);
          const tok = Math.max(8, Math.ceil(outChars / 3.5));
          const isHeavy = tok >= 2500;
          const isOpen = expandedIdx === idx;

          return (
            <span
              key={tc.id || idx}
              onClick={() => setExpandedIdx(isOpen ? null : idx)}
              className={cn(
                "hud-mono inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] border px-2 py-0.5 text-[10.5px] transition-colors",
                isErr || isHeavy
                  ? "border-[var(--crimson-line)] bg-[var(--crimson-dim)] text-[var(--crimson-fg)]"
                  : isOpen
                    ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                    : "border-[var(--line-hair)] bg-[var(--bg-code)] text-[var(--text-mid)] hover:border-[var(--line-strong)] hover:text-[var(--text-hi)]"
              )}
            >
              <span
                className={cn(
                  "font-bold",
                  isErr
                    ? "text-[var(--crimson-fg)]"
                    : "text-[var(--emerald-fg)]"
                )}
              >
                {isErr ? "×" : isHeavy ? "⚠" : "✓"}
              </span>
              <span className="max-w-[200px] truncate">
                {tc.name || tc.kind || "tool"}
              </span>
              <span className="opacity-70">· {formatTokenCount(tok)}</span>
              {canErase && (
                <button
                  type="button"
                  disabled={erasingToolCallId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    onErase(tc);
                  }}
                  className="ml-0.5 rounded px-1 text-[var(--crimson-fg)] hover:bg-[var(--crimson)] hover:text-white"
                  title={eraseLabel}
                >
                  {erasingToolCallId === tc.id ? "…" : "×"}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {activeTool && (
        <div className="hud-mono mt-2 space-y-2 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-code)] p-2.5 text-[11px]">
          {activeTool.input && (
            <div>
              <div className="mb-1 text-[9.5px] font-bold tracking-wider text-[var(--text-low)] uppercase">
                {t("hud.toolArgs")}
              </div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-[var(--cyan-fg)]">
                {activeTool.input}
              </pre>
            </div>
          )}
          {activeTool.output && (
            <div>
              <div className="mb-1 text-[9.5px] font-bold tracking-wider text-[var(--text-low)] uppercase">
                {t("hud.toolOutput")}
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-[var(--text-hi)]">
                {cleanAnsiCodes(activeTool.output)}
              </pre>
            </div>
          )}
          {activeTool.error && (
            <div>
              <div className="mb-1 text-[9.5px] font-bold tracking-wider text-[var(--crimson-fg)] uppercase">
                {t("hud.toolError")}
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[var(--crimson-fg)]">
                {activeTool.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ==================== CAUSAL FRAME (WITH ZERO-MODAL INLINE SURGERY) ==================== */
const CausalFrame = forwardRef<
  HTMLDivElement,
  {
    block: TimelineBlock;
    index: number;
    estimatedTokens: number;
    forgedInfo?: { count: number; latest: EditLogEntry };
    isEditing: boolean;
    editingContent: string;
    editingOriginal: string;
    savingEdit: boolean;
    arsenalPrompts: PromptItem[] | null;
    forkCommand?: string;
    onStartEdit: () => void;
    onChangeEdit: (val: string) => void;
    onCommitEdit: () => void;
    onCancelEdit: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onRevert?: () => void;
    onOpenAudit: () => void;
    onErase: () => void;
    onEraseToolCall: (toolCall: ToolCallBlock) => void;
    canEraseToolCalls: boolean;
    erasingToolCallId: string | null;
    onLoadExecutionOutput?: () => void;
    loadingExecutionOutput?: boolean;
    onLoadArsenal: () => void;
    onForkInPty?: () => void;
    t: (key: MessageKey, params?: Record<string, string | number>) => string;
    searchHighlight?: string;
    isCurrentMatch?: boolean;
  }
>(function CausalFrame(
  {
    block,
    index,
    estimatedTokens,
    forgedInfo,
    isEditing,
    editingContent,
    editingOriginal,
    savingEdit,
    arsenalPrompts,
    onStartEdit,
    onChangeEdit,
    onCommitEdit,
    onCancelEdit,
    onContextMenu,
    onRevert,
    onOpenAudit,
    onErase,
    onEraseToolCall,
    canEraseToolCalls,
    erasingToolCallId,
    onLoadExecutionOutput,
    loadingExecutionOutput,
    onLoadArsenal,
    onForkInPty,
    t,
    searchHighlight,
    isCurrentMatch,
  },
  ref
) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [longExpanded, setLongExpanded] = useState(false);
  const [arsenalMenuOpen, setArsenalMenuOpen] = useState(false);

  const isThinking = block.role === "thinking";
  const isUser = block.role === "user";
  const isForged = Boolean(forgedInfo);
  const isSpike = estimatedTokens >= SPIKE_TOKEN_THRESHOLD;
  const hasContent = block.content.trim().length > 0;
  const isLong = !isThinking && block.content.length > LONG_BLOCK_COLLAPSE_THRESHOLD;
  const isSearchHit = Boolean(
    searchHighlight &&
      block.content.toLowerCase().includes(searchHighlight.toLowerCase())
  );
  const displayContent =
    isLong && !longExpanded && !isSearchHit
      ? `${block.content.slice(0, LONG_BLOCK_PREVIEW_CHARS)}\n\n...`
      : block.content;

  const isKiroPlaceholder =
    block.role === "assistant" &&
    block.content.trim() === "On it." &&
    block.editTarget?.includes("::execution::");

  const seqLabel = `#${String(index + 1).padStart(2, "0")}`;
  const isCompactBorderless =
    !isEditing &&
    !isForged &&
    ((isThinking && !thinkingExpanded) ||
      (!isUser && !hasContent && (block.toolCalls?.length ?? 0) > 0));

  if (isCompactBorderless) {
    return (
      <div
        ref={ref}
        onContextMenu={onContextMenu}
        className="group/frame relative pl-5"
      >
        <span className="absolute top-0 -bottom-2.5 left-[5px] w-[1.5px] bg-[var(--line-hair)]" />
        <span
          className={cn(
            "absolute top-2.5 left-[2px] z-10 size-1.5 rounded-full",
            isSpike
              ? "bg-[var(--crimson)]"
              : isThinking
                ? "bg-[var(--violet)]/75"
                : "bg-[var(--text-low)]/60"
          )}
        />
        <div className="flex flex-wrap items-center gap-2 rounded-[4px] px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-hover)]/65">
          <span className="hud-mono text-[10px] text-[var(--text-low)]">
            {seqLabel}
          </span>

          {isThinking ? (
            <button
              type="button"
              onClick={() => setThinkingExpanded(true)}
              className="hud-mono inline-flex items-center gap-1.5 text-[11px] text-[var(--text-mid)] hover:text-[var(--violet-fg)]"
            >
              <span>
                {t("hud.expandThinking", { count: block.content.length })}
              </span>
            </button>
          ) : (
            <div className="min-w-0 flex-1">
              <ToolPipelineStrip
                canErase={canEraseToolCalls}
                eraseLabel={t("session.eraseToolCall")}
                erasingToolCallId={erasingToolCallId}
                hasBody={false}
                onErase={onEraseToolCall}
                t={t}
                toolCalls={block.toolCalls ?? []}
              />
            </div>
          )}

          <div className="hud-mono ml-auto flex items-center gap-1.5 text-[10px] text-[var(--text-low)]">
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/frame:opacity-100">
              {block.editable === false && hasContent && (
                <span
                  className="px-1 text-[9.5px] text-[var(--text-low)]"
                  title={t("hud.sealedReadOnlyHint")}
                >
                  {t("hud.sealedReadOnly")}
                </span>
              )}
              {block.editable !== false && (
                <>
                  <button
                    type="button"
                    onClick={onStartEdit}
                    className="rounded px-1.5 py-0.5 text-[var(--text-mid)] hover:bg-[var(--forge-dim)] hover:text-[var(--forge-fg)]"
                  >
                    {t("hud.editMemory")}
                  </button>
                  <button
                    type="button"
                    onClick={onErase}
                    className="rounded px-1.5 py-0.5 text-[var(--text-mid)] hover:bg-[var(--crimson-dim)] hover:text-[var(--crimson-fg)]"
                  >
                    {t("hud.eraseShort")}
                  </button>
                </>
              )}
            </div>
            <span className={cn(isSpike && "font-semibold text-[var(--crimson-fg)]")}>
              {formatTokenCount(estimatedTokens)} tok
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      onContextMenu={onContextMenu}
      className="group/frame relative pl-5"
    >
      {/* Continuous Causal Spine Line */}
      <span className="absolute top-0 -bottom-2.5 left-[5px] w-[1.5px] bg-[var(--line-hair)]" />

      {/* Causal Node Square */}
      <span
        className={cn(
          "absolute top-3 left-[1.5px] z-10 size-2 rounded-[2px] border-[1.5px] bg-[var(--bg-void)]",
          isForged
            ? "border-[var(--forge)] bg-[var(--forge)]"
            : isSpike
              ? "border-[var(--crimson)] bg-[var(--crimson)]"
              : isUser
                ? "border-[var(--cyan)] bg-[var(--cyan-dim)]"
                : isThinking
                  ? "border-[var(--violet)]"
                  : "border-[var(--text-low)]"
        )}
      />

      {/* Frame Box */}
      <div
        className={cn(
          "rounded-[5px] border border-l-[2.5px] px-3.5 py-2.5 transition-colors",
          (isEditing || isForged) && "reticle",
          isEditing
            ? "border-[var(--forge)] bg-[var(--bg-elevated)] shadow-2xl"
            : isForged
              ? "border-[var(--forge-line)] border-l-[var(--forge)] bg-[linear-gradient(90deg,var(--forge-dim),var(--bg-panel)_30%)]"
              : isSpike
                ? "border-[var(--crimson-line)] border-l-[var(--crimson)] bg-[var(--bg-panel)]"
                : isUser
                  ? "border-[var(--line-hair)] border-l-[var(--cyan)] bg-[linear-gradient(90deg,var(--cyan-dim),var(--bg-panel)_24%)]"
                  : isThinking
                    ? "border-[var(--line-hair)] border-l-[var(--violet)] bg-[var(--bg-panel)]"
                    : "border-[var(--line-hair)] border-l-[var(--asst-bar)] bg-[var(--bg-panel)]",
          isCurrentMatch && "ring-1 ring-[var(--cyan)]"
        )}
      >
        {/* Frame Header */}
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="hud-mono text-[10.5px] font-bold text-[var(--text-low)]">
            {seqLabel}
          </span>
          <span
            className={cn(
              "hud-mono rounded-[2px] px-1.5 py-[0.5px] text-[10px] font-bold tracking-wider uppercase",
              isUser
                ? "bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                : isThinking
                  ? "bg-[var(--violet-dim)] text-[var(--violet-fg)]"
                  : "border border-[var(--line-hair)] bg-[var(--bg-elevated)] text-[var(--text-hi)]"
            )}
          >
            {isUser
              ? t("session.filter.user")
              : isThinking
                ? t("session.filter.thinking")
                : t("session.filter.assistant")}
          </span>

          {forgedInfo && (
            <button
              type="button"
              onClick={onOpenAudit}
              className="hud-mono inline-flex items-center gap-1 rounded-[2px] border border-[var(--forge-line)] bg-[var(--forge-dim)] px-1.5 py-[0.5px] text-[9.5px] font-bold text-[var(--forge-fg)] hover:brightness-110"
              title={t("editLog.title")}
            >
              <Zap className="size-2.5" />
              <span>
                {t("hud.forgedStamp", { count: forgedInfo.count })}
              </span>
            </button>
          )}

          {isSpike && (
            <span className="hud-mono inline-flex items-center gap-1 rounded-[2px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-1.5 py-[0.5px] text-[9.5px] font-bold text-[var(--crimson-fg)]">
              <AlertTriangle className="size-2.5" />
              <span>
                {t("hud.spikeStamp", {
                  tokens: formatTokenCount(estimatedTokens),
                })}
              </span>
            </span>
          )}

          {/* Hover / Active Surgical Actions */}
          <div className="hud-mono ml-auto flex items-center gap-2 text-[10.5px] text-[var(--text-low)]">
            <div
              className={cn(
                "flex items-center gap-1 transition-opacity",
                isEditing || isForged
                  ? "opacity-100"
                  : "opacity-0 group-hover/frame:opacity-100"
              )}
            >
              {!isEditing && block.editable === false && hasContent && (
                <span
                  className="rounded-[3px] border border-dashed border-[var(--line-hair)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-low)]"
                  title={t("hud.sealedReadOnlyHint")}
                >
                  {t("hud.sealedReadOnly")}
                </span>
              )}
              {!isEditing && block.editable !== false && (
                <button
                  type="button"
                  onClick={onStartEdit}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-mid)] hover:border-[var(--forge-line)] hover:bg-[var(--forge-dim)] hover:text-[var(--forge-fg)]"
                >
                  <Pencil className="size-2.5" />
                  <span>{t("hud.editMemory")}</span>
                </button>
              )}
              {!isEditing && onRevert && (
                <button
                  type="button"
                  onClick={onRevert}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-1.5 py-0.5 text-[10px] text-[var(--cyan-fg)]"
                >
                  <Undo2 className="size-2.5" />
                  <span>{t("hud.revertOriginal")}</span>
                </button>
              )}
              {isKiroPlaceholder && onLoadExecutionOutput && (
                <button
                  type="button"
                  disabled={loadingExecutionOutput}
                  onClick={onLoadExecutionOutput}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-1.5 py-0.5 text-[10px] text-[var(--cyan-fg)]"
                >
                  <RefreshCw
                    className={cn(
                      "size-2.5",
                      loadingExecutionOutput && "animate-spin"
                    )}
                  />
                  <span>{t("hud.loadOutputs", { count: 1 })}</span>
                </button>
              )}
              {!isEditing && onForkInPty && (
                <button
                  type="button"
                  onClick={onForkInPty}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-mid)] hover:border-[var(--cyan-line)] hover:text-[var(--cyan-fg)]"
                  title={t("terminal.forkEmbedded")}
                >
                  <GitFork className="size-2.5" />
                </button>
              )}
              {!isEditing && block.editable !== false && (
                <button
                  type="button"
                  onClick={onErase}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-mid)] hover:border-[var(--crimson-line)] hover:bg-[var(--crimson-dim)] hover:text-[var(--crimson-fg)]"
                >
                  <Trash2 className="size-2.5" />
                  <span>{t("hud.eraseShort")}</span>
                </button>
              )}
            </div>

            <strong
              className={cn(
                isSpike ? "text-[var(--crimson-fg)]" : "text-[var(--text-mid)]"
              )}
            >
              {formatTokenCount(estimatedTokens)} tok
            </strong>
          </div>
        </div>

        {/* Tool Calls Pipeline Chips */}
        {block.toolCalls && block.toolCalls.length > 0 && (
          <ToolPipelineStrip
            canErase={canEraseToolCalls}
            eraseLabel={t("session.eraseToolCall")}
            erasingToolCallId={erasingToolCallId}
            hasBody={hasContent || isEditing}
            onErase={onEraseToolCall}
            t={t}
            toolCalls={block.toolCalls}
          />
        )}

        {/* Zero-Modal Inline Ghost Surgery Editor OR Message Content */}
        {isEditing ? (
          <div className="mt-1.5 space-y-2">
            {/* Ghost Original Reference Strip */}
            <div className="hud-mono rounded-[3px] border border-dashed border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-2.5 py-2 text-[11px] text-[var(--crimson-fg)]">
              <div className="mb-1 flex items-center justify-between text-[9.5px] font-bold tracking-wider">
                <span>{t("hud.ghostOriginalTitle")}</span>
                <span>{t("hud.safeBackupTag")}</span>
              </div>
              <div className="max-h-28 overflow-y-auto whitespace-pre-wrap opacity-90">
                - {editingOriginal || t("hud.previewEmpty")}
              </div>
            </div>

            <textarea
              autoFocus
              className="hud-mono min-h-[132px] w-full resize-y rounded-[4px] border-[1.5px] border-[var(--forge)] bg-[var(--bg-code)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text-hi)] outline-none"
              onChange={(e) => onChangeEdit(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  onCommitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit();
                }
              }}
              placeholder={t("session.enterContent")}
              value={editingContent}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="hud-mono text-[10.5px] text-[var(--text-mid)]">
                  <kbd className="hud-kbd">Ctrl+S</kbd> {t("save")} ·{" "}
                  <kbd className="hud-kbd">Esc</kbd> {t("cancel")}
                </span>

                {/* Quick Inject from Prompt Arsenal */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      onLoadArsenal();
                      setArsenalMenuOpen((v) => !v);
                    }}
                    className="hud-mono inline-flex items-center gap-1 rounded-[3px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-2 py-0.5 text-[10px] font-semibold text-[var(--cyan-fg)]"
                  >
                    <BookOpen className="size-2.5" />
                    <span>{t("hud.insertFromPrompts")}</span>
                  </button>
                  {arsenalMenuOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-72 overflow-y-auto rounded-[5px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 shadow-2xl">
                      {!arsenalPrompts || arsenalPrompts.length === 0 ? (
                        <div className="px-2.5 py-3 text-center text-[11px] text-[var(--text-low)]">
                          {t("hud.noSavedPrompts")}
                        </div>
                      ) : (
                        arsenalPrompts.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              const sep = editingContent.trim() ? "\n\n" : "";
                              onChangeEdit(`${editingContent}${sep}${p.content}`);
                              setArsenalMenuOpen(false);
                            }}
                            className="block w-full truncate rounded-[3px] px-2.5 py-1.5 text-left text-xs hover:bg-[var(--bg-hover)]"
                          >
                            {p.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={onCancelEdit}
                  className="hud-btn"
                >
                  {t("session.cancel")}
                </button>
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={onCommitEdit}
                  className="hud-btn hud-btn-forge"
                >
                  <Zap className="size-3" />
                  <span>
                    {savingEdit ? t("loading") : t("session.saveChanges")}
                  </span>
                </button>
              </div>
            </div>
          </div>
        ) : isThinking ? (
          hasContent ? (
            thinkingExpanded ? (
              <div
                className="space-y-1.5"
                onDoubleClick={onStartEdit}
                title={
                  block.editable !== false
                    ? t("hud.doubleClickEditHint")
                    : t("hud.sealedReadOnlyHint")
                }
              >
                <div className="hud-mono rounded-[4px] border-l-2 border-[var(--violet)] bg-[var(--bg-code)] px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-[var(--violet-fg)]">
                  {parseContentWithCodeBlocks(block.content, searchHighlight, t)}
                </div>
                <button
                  type="button"
                  onClick={() => setThinkingExpanded(false)}
                  className="hud-mono text-[10px] text-[var(--violet-fg)] hover:underline"
                >
                  {t("hud.collapseThinking")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setThinkingExpanded(true)}
                className="hud-mono inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--violet-line)] bg-[var(--violet-dim)] px-2.5 py-1 text-[10.5px] text-[var(--violet-fg)] hover:brightness-110"
              >
                <span>
                  {t("hud.expandThinking", { count: block.content.length })}
                </span>
              </button>
            )
          ) : null
        ) : hasContent ? (
          <div
            onDoubleClick={onStartEdit}
            title={
              block.editable !== false ? t("hud.doubleClickEditHint") : undefined
            }
          >
            <div className="text-[13.5px] leading-[1.64] break-words text-[var(--text-hi)]">
              {parseContentWithCodeBlocks(displayContent, searchHighlight, t)}
            </div>
            {isLong && !isSearchHit && (
              <button
                type="button"
                onClick={() => setLongExpanded((v) => !v)}
                className="hud-mono mt-1.5 inline-flex items-center gap-1 rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
              >
                {longExpanded ? (
                  <>
                    <ChevronUp className="size-3" />
                    <span>{t("hud.collapseLong")}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3" />
                    <span>
                      {t("hud.expandLong", {
                        count: Math.round(block.content.length / 1000),
                      })}
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        ) : block.toolCalls && block.toolCalls.length > 0 ? null : (
          <div className="hud-mono text-[11px] italic text-[var(--text-low)]">
            {t("hud.emptyFrame")}
          </div>
        )}
      </div>
    </div>
  );
});
