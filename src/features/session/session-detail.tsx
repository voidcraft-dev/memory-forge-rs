import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  BookOpen,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
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
  memo,
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
import { FloatingMenu } from "@/components/ui/floating-menu";
import {
  api,
  createPrompt,
  describeSaveError,
  listPrompts,
} from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
import { useDesktop } from "@/features/desktop/provider";
import { hasBackupWrite } from "@/features/desktop/write-safety";
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
  questionPreview: string;
  answerPreview: string;
  previewTime: string;
};

function formatBlockShortTime(block: TimelineBlock, locale: string): string {
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
  return d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionDetail() {
  const { t, state, dispatch, snapshot } = useDesktop();
  const locale = snapshot?.settings.locale ?? "zh-CN";
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
  const [editError, setEditError] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set()
  );
  const frameHandlersRef = useRef<FrameActions | null>(null);
  const frameActions = useMemo<FrameActions>(
    () => ({
      startEdit: (block) => frameHandlersRef.current?.startEdit(block),
      cancelEdit: () => frameHandlersRef.current?.cancelEdit(),
      syncDraft: (targetId, content) =>
        frameHandlersRef.current?.syncDraft(targetId, content),
      commitEdit: (content) => frameHandlersRef.current?.commitEdit(content),
      openContextMenu: (e, block) =>
        frameHandlersRef.current?.openContextMenu(e, block),
      erase: (block) => frameHandlersRef.current?.erase(block),
      eraseToolCall: (block, toolCall) =>
        frameHandlersRef.current?.eraseToolCall(block, toolCall),
      forkInPty: () => frameHandlersRef.current?.forkInPty(),
      loadArsenal: () => frameHandlersRef.current?.loadArsenal(),
      loadExecutionOutput: (block) =>
        frameHandlersRef.current?.loadExecutionOutput(block),
      toggleAudit: () => frameHandlersRef.current?.toggleAudit(),
      revert: (entry) => frameHandlersRef.current?.revert(entry),
      toggleExpanded: (key) =>
        setExpandedKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
    }),
    []
  );
  const lastSearchKeyRef = useRef("");
  const hadMatchesRef = useRef(false);
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
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("[data-context-menu]")) return;
      setMsgCtxMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMsgCtxMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
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
    const timer = window.setTimeout(
      () => {
        dispatch({ type: "setSessionStatus", payload: null });
      },
      sessionStatus.tone === "error" ? 6000 : 2400
    );
    return () => window.clearTimeout(timer);
  }, [dispatch, sessionStatus]);

  useEffect(() => {
    setEditError(null);
  }, [editingBlock?.id, editingBlock?.sessionKey]);

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

      // Pair nearest User Question + Assistant Reply (like Rin / Cindy NavRail!)
      let nearUserText = "";
      for (let back = Math.min(blocks.length - 1, i + slice.length - 1); back >= 0; back--) {
        if (blocks[back]?.role === "user") {
          const cleaned = cleanHumanPreview(blocks[back]?.content);
          if (cleaned) {
            nearUserText = cleaned.slice(0, 80);
            break;
          }
        }
      }
      let nearAsstText = "";
      for (let fwd = i; fwd < Math.min(blocks.length, i + slice.length + 4); fwd++) {
        const cand = blocks[fwd];
        if (cand && cand.role === "assistant") {
          const cleaned = cleanHumanPreview(cand.content);
          if (cleaned) {
            nearAsstText = cleaned.slice(0, 160);
            break;
          }
          if (cand.toolCalls?.length && !nearAsstText) {
            nearAsstText = t("hud.previewTools", {
              tools: cand.toolCalls
                .map((tc) => tc.name || tc.kind || "tool")
                .join(", "),
            });
          }
        }
      }

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
        questionPreview: nearUserText,
        answerPreview: nearAsstText || cleanPreview,
        previewTime: formatBlockShortTime(repBlock, locale),
      });
    }
    return cells;
    }, [blockTokensList, blocks, forgedByTarget, locale, t]);

  const maxDnaTok = useMemo(
    () => Math.max(3000, ...dnaCells.map((c) => c.tokens)),
    [dnaCells]
  );

  const estimateVirtualItemSize = useCallback(
    (index: number) => {
      const b = filteredBlocks[index];
      const isEd = Boolean(
        b &&
          editingBlock &&
          editingBlock.id === (b.editTarget || b.id) &&
          (!editingBlock.sessionKey ||
            editingBlock.sessionKey === sessionDetail?.sessionKey)
      );
      return estimateMessageBlockSize(b, isEd);
    },
    [editingBlock, filteredBlocks, sessionDetail?.sessionKey]
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
    const searchKey = `${sessionDetail?.sessionKey ?? ""}::${searchNeedle}`;
    const sameSearch =
      searchKey === lastSearchKeyRef.current && hadMatchesRef.current;
    lastSearchKeyRef.current = searchKey;
    hadMatchesRef.current = matchingBlockIds.length > 0;
    if (sameSearch) {
      setCurrentMatchIdx((idx) =>
        Math.min(idx, Math.max(0, matchingBlockIds.length - 1))
      );
      return;
    }
    if (matchingBlockIds.length > 0) {
      setCurrentMatchIdx(0);
      scrollToBlockId(matchingBlockIds[0]);
    }
  }, [matchingBlockIds]);

  useEffect(() => {
    messageScrollRef.current?.scrollTo({ top: 0 });
    setExpandedKeys(new Set());
  }, [sessionDetail?.sessionKey]);

  const statusToast = sessionStatus ? (
    <div
      aria-live="polite"
      className={cn(
        "hud-mono pointer-events-none absolute top-[46px] left-1/2 z-30 line-clamp-3 max-w-[min(560px,calc(100%-2rem))] -translate-x-1/2 rounded-[4px] border bg-[var(--bg-panel)] px-2.5 py-1 text-[11px] break-words shadow-lg",
        sessionStatus.tone === "success"
          ? "border-[var(--emerald-line)] text-[var(--emerald-fg)]"
          : "border-[var(--crimson-line)] text-[var(--crimson-fg)]"
      )}
      role="status"
    >
      {sessionStatus.message}
    </div>
  ) : null;

  // Empty State
  if (!sessionDetail) {
    return (
      <section className="relative flex flex-1 flex-col items-center justify-center bg-[var(--bg-void)] px-6 text-center">
        {statusToast}
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

  const applyReloaded = (
    sessionKey: string,
    detail: Awaited<ReturnType<typeof api.getSessionDetail>>,
    logs: EditLogEntry[]
  ) => {
    dispatch({ type: "setSessionDetail", payload: detail });
    if (activeSessionKeyRef.current === sessionKey) {
      dispatch({ type: "setEditLog", payload: logs });
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
        platform: activePlatform,
        sessionKey: sessionDetail.sessionKey,
      },
    });
  };

  const handleCommitInlineEdit = async (content: string) => {
    if (!editingBlock) return;
    const targetSessionKey = editingBlock.sessionKey ?? sessionDetail.sessionKey;
    const targetPlatform = editingBlock.platform ?? activePlatform;
    if (targetSessionKey !== sessionDetail.sessionKey) return;
    const draft = { ...editingBlock, content };
    setSavingEdit(true);
    setEditError(null);
    dispatch({ type: "setSessionStatus", payload: null });
    try {
      await api.editMessage(
        targetPlatform,
        draft.id,
        draft.content,
        targetSessionKey,
        draft.originalContent
      );
    } catch (error) {
      const message = describeSaveError(t("session.saveFailed"), error);
      setEditError(message);
      dispatch({ type: "setSessionStatus", payload: { tone: "error", message } });
      setSavingEdit(false);
      return;
    }
    let reloadFailed = false;
    try {
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(targetPlatform, targetSessionKey),
        api.getEditLog(targetPlatform, targetSessionKey),
      ]);
      applyReloaded(targetSessionKey, updated, logs);
    } catch {
      reloadFailed = true;
    }
    dispatch({
      type: "clearEditingBlock",
      payload: { id: draft.id, sessionKey: targetSessionKey },
    });
    dispatch({
      type: "setSessionStatus",
      payload: reloadFailed
        ? {
            tone: "error",
            message: `${t("session.messageSaved")} · ${t("session.refreshFailed")}`,
          }
        : {
            tone: "success",
            message: `${t("session.messageSaved")} · ${t(
              hasBackupWrite(snapshot, targetPlatform)
                ? "hud.safeWriteBadge"
                : "hud.editLogOnlyBadge"
            )}`,
          },
    });
    setSavingEdit(false);
  };

  const handleRevertForgedBlock = async (entry: EditLogEntry) => {
    const targetSessionKey = sessionDetail.sessionKey;
    if (
      !(await confirm({
        title: t("session.restore"),
        description: t("session.restoreConfirm"),
      }))
    ) {
      return;
    }
    try {
      await api.restoreMessage(activePlatform, entry.id, targetSessionKey);
      const [updated, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, targetSessionKey),
        api.getEditLog(activePlatform, targetSessionKey),
      ]);
      applyReloaded(targetSessionKey, updated, logs);
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
      applyReloaded(sessionDetail.sessionKey, updated, logs);
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
        description: t(
          hasBackupWrite(snapshot, activePlatform)
            ? "hud.batchEraseDesc"
            : "hud.batchEraseDescNoBackup",
          { count: targetBlocks.length }
        ),
        variant: "danger",
      }))
    ) {
      return;
    }

    const targetSessionKey = sessionDetail.sessionKey;
    setBatchErasing(true);
    try {
      const result = await api.eraseMessages(
        activePlatform,
        targetSessionKey,
        targetBlocks.map((b) => ({
          editTarget: b.editTarget || b.id,
          expectedContent: b.content,
        }))
      );
      const reloaded = await Promise.all([
        api.getSessionDetail(activePlatform, targetSessionKey),
        api.getEditLog(activePlatform, targetSessionKey),
      ]).catch(() => null);
      if (reloaded) applyReloaded(targetSessionKey, reloaded[0], reloaded[1]);
      setDnaRangeStart(null);
      setDnaRangeEnd(null);
      dispatch({
        type: "setSessionStatus",
        payload: result.error
          ? {
              tone: "error",
              message: t("hud.batchErasePartial", {
                erased: result.erased,
                total: result.total,
                error: result.error,
              }),
            }
          : {
              tone: "success",
              message: t("hud.batchErasedToast", { count: result.erased }),
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
      if (activeSessionKeyRef.current !== sessionKey) return;
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
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.refreshFailed") },
      });
    } finally {
      setLoadingAllExecutionOutputs(false);
      setLoadingExecutionTargets(new Set());
    }
  };

  const handleRefresh = async () => {
    const targetSessionKey = sessionDetail.sessionKey;
    setRefreshing(true);
    setRefreshDone(false);
    try {
      const [detail, logs] = await Promise.all([
        api.getSessionDetail(activePlatform, targetSessionKey),
        api.getEditLog(activePlatform, targetSessionKey).catch(() => []),
      ]);
      applyReloaded(targetSessionKey, detail, logs);
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

  frameHandlersRef.current = {
    startEdit: handleStartInlineEdit,
    cancelEdit: () => dispatch({ type: "setEditingBlock", payload: null }),
    syncDraft: (targetId, content) => {
      if (
        !editingBlock ||
        editingBlock.id !== targetId ||
        (editingBlock.sessionKey &&
          editingBlock.sessionKey !== sessionDetail.sessionKey) ||
        editingBlock.content === content
      ) {
        return;
      }
      dispatch({
        type: "setEditingBlock",
        payload: { ...editingBlock, content },
      });
    },
    commitEdit: (content) => void handleCommitInlineEdit(content),
    openContextMenu: (e, block) => {
      const targetId = block.editTarget || block.id;
      const isEditingThis =
        editingBlock?.id === targetId &&
        (!editingBlock.sessionKey ||
          editingBlock.sessionKey === sessionDetail.sessionKey);
      if (window.getSelection()?.toString()?.trim() || isEditingThis) return;
      e.preventDefault();
      e.stopPropagation();
      setMsgCtxMenu({
        x: e.clientX,
        y: e.clientY,
        block,
        forgedEntry: forgedByTarget.get(targetId)?.latest,
      });
    },
    erase: (block) => void handleEraseBlock(block),
    eraseToolCall: (block, toolCall) =>
      void handleEraseToolCall(block.id, toolCall),
    forkInPty: () => {
      if (forkCommand) void handleStartEmbeddedPty("fork", forkCommand);
    },
    loadArsenal: () => void loadArsenalIfNeeded(),
    loadExecutionOutput: (block) => void handleLoadExecutionOutput(block),
    toggleAudit: () =>
      dispatch({ type: "setShowEditLog", payload: !showEditLog }),
    revert: (entry) => void handleRevertForgedBlock(entry),
    toggleExpanded: frameActions.toggleExpanded,
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

      {statusToast}

      {/* ==================== 40PX COMPACT 1-ROW STAGE HEADER ==================== */}
      <header className="@container z-20 flex h-[40px] shrink-0 items-center gap-2 border-b border-[var(--line-hair)] bg-[var(--bg-panel)] px-3">
        <span
          className={cn(
            "hud-mono shrink-0 rounded-[2px] border px-1.5 py-[1px] text-[10px] font-bold tracking-wider uppercase",
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
              <span className="hidden @5xl:inline">
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
                <span className="hidden @4xl:inline">
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
              <span className="hidden @2xl:inline">{t("session.export")}</span>
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
            <span className="hidden @5xl:inline">{t("hud.locateSpike")}</span>
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
                  <span className="hidden @3xl:inline">
                    {t("hud.liveVerify")}
                  </span>
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
                          <div className="hud-mono px-2 py-1 text-[10.5px] font-bold tracking-wider text-[var(--text-low)] uppercase">
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
                  (s) =>
                    !(
                      s.platform === activePlatform &&
                      s.sessionKey === sessionDetail.sessionKey
                    )
                ),
              });
              dispatch({
                type: "closeSessionTab",
                payload: {
                  platform: activePlatform,
                  sessionKey: sessionDetail.sessionKey,
                },
              });
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
              <div className="flex shrink-0 items-center gap-0.5 text-[10px] text-[var(--forge-fg)]">
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
            <span className="hidden truncate text-[10.5px] text-[var(--text-low)] lg:inline">
              {t("hud.dnaHint", { count: blocks.length })}
            </span>
          ) : (
            <span className="hidden truncate text-[10.5px] text-[var(--text-low)] lg:inline">
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
                    "rounded-[3px] border px-1.5 py-0.5 text-[10.5px] transition-colors",
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
                    <div className="hud-mono mb-[1px] flex items-center justify-between overflow-hidden text-[9.5px] leading-none whitespace-nowrap text-[var(--text-low)]">
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
            className="relative mx-auto w-full max-w-[780px] py-4"
            style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const block = filteredBlocks[virtualItem.index];
              if (!block) return null;
              const targetId = block.editTarget || block.id;
              const forgedInfo = forgedByTarget.get(targetId);
              const isEditingThis =
                editingBlock?.id === targetId &&
                (!editingBlock.sessionKey ||
                  editingBlock.sessionKey === sessionDetail.sessionKey);
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
                    actions={frameActions}
                    arsenalPrompts={arsenalPrompts}
                    backupWrite={hasBackupWrite(snapshot, activePlatform)}
                    block={block}
                    canEraseToolCalls={activePlatform === "opencode"}
                    canFork={Boolean(forkCommand)}
                    editError={isEditingThis ? editError : null}
                    editingContent={isEditingThis ? editingBlock.content : ""}
                    editingOriginal={
                      isEditingThis ? editingBlock.originalContent : ""
                    }
                    erasingToolCallId={erasingToolCallId}
                    estimatedTokens={estTok}
                    expandedKeys={expandedKeys}
                    forgedInfo={forgedInfo}
                    isCurrentMatch={
                      matchingBlockIds[currentMatchIdx] === block.id
                    }
                    isEditing={isEditingThis}
                    loadingExecutionOutput={Boolean(
                      block.editTarget &&
                        loadingExecutionTargets.has(block.editTarget)
                    )}
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

        {/* Floating Right Scrubber Rail (Fisheye + Mouse Wheel + Paired Q&A Preview Card!) */}
        {dnaCells.length > 0 && (
          <div
            onMouseLeave={() => setHoveredRail(null)}
            onWheel={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dnaCells.length === 0) return;
              const cur = hoveredRail?.idx ?? 0;
              const step = e.deltaY > 0 ? 1 : -1;
              const nextIdx = Math.max(
                0,
                Math.min(dnaCells.length - 1, cur + step)
              );
              setHoveredRail((prev) =>
                prev ? { ...prev, idx: nextIdx } : { idx: nextIdx, offsetTop: 60 }
              );
              const target = dnaCells[nextIdx];
              if (target) scrollToBlockId(target.representativeId);
            }}
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

              const hoveredSlicePos =
                hoveredRail !== null
                  ? railSlice.findIndex(
                      (c) => dnaCells.indexOf(c) === hoveredRail.idx
                    )
                  : -1;

              return railSlice.map((cell, sliceIdx) => {
                const origIdx = dnaCells.indexOf(cell);
                const isHovered = hoveredRail?.idx === origIdx;
                const inView = blocks
                  .slice(cell.startIndex, cell.endIndex + 1)
                  .some((b) => visIds.has(b.id));

                // Rin-style smooth fisheye falloff around hovered tick
                const dist =
                  hoveredSlicePos >= 0
                    ? Math.abs(sliceIdx - hoveredSlicePos)
                    : 99;
                const fisheyeWidth =
                  dist === 0
                    ? 18
                    : dist === 1
                      ? 13
                      : dist === 2
                        ? 10
                        : inView
                          ? 11
                          : cell.previewRole === "user" || cell.forged
                            ? 8
                            : 6;

                const barTone = isHovered
                  ? "bg-[var(--text-hi)]"
                  : cell.forged
                    ? "bg-[var(--forge)]"
                    : inView
                      ? "bg-[var(--text-hi)]"
                      : "bg-[var(--text-low)]/40";

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
                        ? btnRect.top - parentRect.top - 48
                        : 0;
                      const maxTop = parentRect
                        ? Math.max(-24, parentRect.height - 120)
                        : 240;
                      setHoveredRail({
                        idx: origIdx,
                        offsetTop: Math.max(-24, Math.min(maxTop, rawTop)),
                      });
                    }}
                    className="group flex h-[6px] items-center justify-end pl-2"
                  >
                    <span
                      style={{ width: `${fisheyeWidth}px` }}
                      className={cn(
                        "h-[2px] rounded-full transition-all duration-100",
                        barTone
                      )}
                    />
                  </button>
                );
              });
            })()}

            {/* Paired Q&A Instant Floating Preview Card (Rin / Cindy Style!) */}
            {hoveredRail !== null && dnaCells[hoveredRail.idx] && (
              <div
                style={{ top: `${hoveredRail.offsetTop}px` }}
                className="pointer-events-none absolute right-6 z-40 w-[310px] rounded-[9px] border border-slate-700/80 bg-[#151922]/96 p-3 text-slate-100 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-md"
              >
                {(() => {
                  const cell = dnaCells[hoveredRail.idx];
                  return (
                    <>
                      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] text-slate-400">
                        <span className="hud-mono font-semibold text-slate-200">
                          #{cell.previewTurnNum}
                        </span>
                        {cell.previewTime && (
                          <span className="hud-mono">{cell.previewTime}</span>
                        )}
                        {cell.forged && (
                          <span className="hud-mono rounded bg-amber-500/20 px-1 text-[10.5px] font-bold text-amber-300">
                            ⚡{t("hud.forgedStamp", { count: 1 }).split(" · ")[0]}
                          </span>
                        )}
                        {cell.spike && (
                          <span className="hud-mono rounded bg-rose-500/20 px-1 text-[10px] font-bold text-rose-300">
                            ⚠{formatTokenCount(cell.tokens)}
                          </span>
                        )}
                        <span className="hud-mono ml-auto">
                          {formatTokenCount(cell.tokens)} tok
                        </span>
                      </div>

                      {cell.questionPreview && (
                        <div className="mb-1 truncate text-xs font-semibold text-white">
                          {cell.questionPreview}
                        </div>
                      )}
                      <p className="line-clamp-3 text-[11.5px] leading-[1.52] break-words text-slate-300">
                        {cell.answerPreview}
                      </p>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Message Frame Right-Click Context Menu + Click-Catcher Backdrop */}
      {msgCtxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onContextMenu={(e) => {
              e.preventDefault();
              setMsgCtxMenu(null);
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMsgCtxMenu(null);
            }}
          />
          <FloatingMenu
            className="w-[208px] rounded-[6px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 text-xs shadow-2xl"
            x={msgCtxMenu.x}
            y={msgCtxMenu.y}
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
          </FloatingMenu>
        </>
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
  const { t } = useDesktop();
  return (
    <div className="my-2 overflow-hidden rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-code)]">
      <div className="hud-mono flex items-center justify-between border-b border-[var(--line-hair)] bg-[var(--line-subtle)] px-3 py-1 text-[10px] text-[var(--text-low)] select-none">
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
          <span>{copied ? t("copied") : t("copy")}</span>
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
  open,
  onToggle,
  t,
}: {
  tagName: string;
  innerText: string;
  open: boolean;
  onToggle: () => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
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
                onToggle();
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
            onToggle();
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
    const tokenRegex =
      /(\[Image \d+:\s*[^\]]+\]|`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    const tokens = segment.split(tokenRegex);
    if (tokens.length === 1) return highlightText(segment);
    return tokens.map((tok, idx) => {
      if (tok.startsWith("[Image ") && tok.endsWith("]")) {
        const colonIdx = tok.indexOf(":");
        const rawP = colonIdx >= 0 ? tok.slice(colonIdx + 1, -1).trim() : tok;
        const shortImg = extractBaseFileName(rawP);
        return (
          <span
            key={idx}
            className="hud-mono my-0.5 mr-1 inline-flex items-center gap-1 rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-panel)] px-2 py-0.5 text-[11.5px] text-[var(--text-mid)]"
            title={rawP}
          >
            <FileText className="size-3 shrink-0 text-[var(--cyan-fg)]" />
            <span className="max-w-[220px] truncate">{shortImg}</span>
          </span>
        );
      }
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
  t?: (key: MessageKey, params?: Record<string, string | number>) => string,
  systemTags?: {
    keyPrefix: string;
    expandedKeys: Set<string>;
    onToggle: (key: string) => void;
  }
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
    const tagKey = `${systemTags?.keyPrefix ?? ""}::sys::${k}`;
    nodes.push(
      <CollapsibleSystemTag
        innerText={m[2] ?? ""}
        key={`sys-${k++}`}
        onToggle={() => systemTags?.onToggle(tagKey)}
        open={systemTags?.expandedKeys.has(tagKey) ?? false}
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

/* ==================== RIN-STYLE SEMANTIC TOOL PARSER & ACTIVITY ROWS ==================== */
type ParsedToolSemantic = {
  verb: string;
  fileName?: string;
  fullPath?: string;
  lineRange?: string;
  summary?: string;
  commandSubline?: string;
  added?: number;
  removed?: number;
  diffPairs?: Array<{ oldText: string; newText: string }>;
};

function extractBaseFileName(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segs = normalized.split("/");
  return segs[segs.length - 1] || rawPath;
}

function describeToolCall(
  tc: ToolCallBlock,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): ParsedToolSemantic {
  const rawName = (tc.name || tc.kind || "tool").trim();
  const lower = rawName.toLowerCase();

  let args: Record<string, unknown> = {};
  if (tc.input) {
    try {
      const parsed = JSON.parse(tc.input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // non-JSON input
    }
  }

  const pickStr = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  const filePath = pickStr(
    "file_path",
    "path",
    "target_file",
    "filePath",
    "filename",
    "notebook_path"
  );
  const fileChip = filePath ? extractBaseFileName(filePath) : undefined;

  // 1. Edit / Replace tools
  if (
    lower === "edit" ||
    lower === "multiedit" ||
    lower === "multi_edit" ||
    lower === "str_replace_editor" ||
    lower === "replace_in_file" ||
    lower.includes("edit_file")
  ) {
    const pairs: Array<{ oldText: string; newText: string }> = [];
    const oldS =
      typeof args.old_string === "string"
        ? args.old_string
        : typeof args.oldText === "string"
          ? args.oldText
          : typeof args.old_str === "string"
            ? args.old_str
            : undefined;
    const newS =
      typeof args.new_string === "string"
        ? args.new_string
        : typeof args.newText === "string"
          ? args.newText
          : typeof args.new_str === "string"
            ? args.new_str
            : undefined;
    if (oldS !== undefined && newS !== undefined) {
      pairs.push({ oldText: oldS, newText: newS });
    }
    if (Array.isArray(args.edits)) {
      for (const item of args.edits) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          const o =
            typeof rec.old_string === "string"
              ? rec.old_string
              : typeof rec.oldText === "string"
                ? rec.oldText
                : undefined;
          const n =
            typeof rec.new_string === "string"
              ? rec.new_string
              : typeof rec.newText === "string"
                ? rec.newText
                : undefined;
          if (o !== undefined && n !== undefined) {
            pairs.push({ oldText: o, newText: n });
          }
        }
      }
    }
    let added = 0;
    let removed = 0;
    for (const p of pairs) {
      removed += p.oldText ? p.oldText.split("\n").length : 0;
      added += p.newText ? p.newText.split("\n").length : 0;
    }
    return {
      verb: t("hud.toolVerbEdit"),
      fileName: fileChip || rawName,
      fullPath: filePath,
      added: pairs.length > 0 ? added : undefined,
      removed: pairs.length > 0 ? removed : undefined,
      diffPairs: pairs.length > 0 ? pairs : undefined,
    };
  }

  // 1b. Codex / OpenCode apply_patch format (*** Begin Patch)
  if (lower === "apply_patch") {
    const patchRaw =
      typeof args.patch === "string"
        ? args.patch
        : typeof args.input === "string"
          ? args.input
          : tc.input ?? "";
    const fileMatches = Array.from(
      patchRaw.matchAll(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*([^\r\n]+)/g)
    ).map((m) => extractBaseFileName((m[1] ?? "").trim()));
    let added = 0;
    let removed = 0;
    const addLines: string[] = [];
    const delLines: string[] = [];
    for (const line of patchRaw.split("\n")) {
      if (line.startsWith("***") || line.startsWith("+++") || line.startsWith("---")) {
        continue;
      }
      if (line.startsWith("+")) {
        added++;
        addLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        removed++;
        delLines.push(line.slice(1));
      }
    }
    return {
      verb: t("hud.toolVerbEdit"),
      fileName: fileMatches[0] || rawName,
      summary:
        fileMatches.length > 1
          ? t("hud.moreFiles", { count: fileMatches.length - 1 })
          : undefined,
      added: added + removed > 0 ? added : undefined,
      removed: added + removed > 0 ? removed : undefined,
      diffPairs:
        addLines.length + delLines.length > 0
          ? [{ oldText: delLines.join("\n"), newText: addLines.join("\n") }]
          : undefined,
    };
  }

  // 2. Write / Create tools
  if (
    lower === "write" ||
    lower === "write_to_file" ||
    lower === "create_file" ||
    lower === "write_file"
  ) {
    const content = typeof args.content === "string" ? args.content : "";
    const lines = content ? content.split("\n").length : undefined;
    return {
      verb: t("hud.toolVerbWrite"),
      fileName: fileChip || rawName,
      fullPath: filePath,
      added: lines,
      removed: lines !== undefined ? 0 : undefined,
      diffPairs: content ? [{ oldText: "", newText: content }] : undefined,
    };
  }

  // 3. Read tools
  if (
    lower === "read" ||
    lower === "read_file" ||
    lower === "view_file" ||
    lower === "notebook_read"
  ) {
    const offset =
      typeof args.offset === "number"
        ? args.offset
        : typeof args.start_line === "number"
          ? args.start_line
          : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const lineRange =
      offset !== undefined
        ? limit !== undefined
          ? `L${offset}–${offset + limit - 1}`
          : `L${offset}+`
        : undefined;
    return {
      verb: t("hud.toolVerbRead"),
      fileName: fileChip || rawName,
      fullPath: filePath,
      lineRange,
    };
  }

  // 4. Shell / Bash / Exec tools
  if (
    lower === "bash" ||
    lower === "exec" ||
    lower === "shell" ||
    lower === "powershell" ||
    lower === "execute_command" ||
    lower === "run_terminal_cmd" ||
    lower === "command"
  ) {
    const cmd = pickStr("command", "cmd", "script") ?? "";
    const desc = pickStr("description", "explanation", "summary");
    const oneLineCmd = cmd.replace(/\s+/g, " ").trim();
    return {
      verb: t("hud.toolVerbRun"),
      summary: desc || oneLineCmd.slice(0, 96) || rawName,
      commandSubline: desc && oneLineCmd ? oneLineCmd.slice(0, 140) : undefined,
    };
  }

  // 5. Search / Grep / Find / List
  if (lower === "grep" || lower === "search_files" || lower === "ripgrep") {
    const pat = pickStr("pattern", "query", "regex") ?? "";
    return {
      verb: t("hud.toolVerbSearch"),
      summary: pat ? `"${pat}"` : fileChip || rawName,
      fullPath: filePath,
    };
  }
  if (
    lower === "glob" ||
    lower === "find_file_by_name" ||
    lower === "find" ||
    lower === "file_search"
  ) {
    const pat = pickStr("pattern", "glob", "query") ?? "";
    return {
      verb: t("hud.toolVerbFind"),
      summary: pat || fileChip || rawName,
    };
  }
  if (lower === "ls" || lower === "list_dir" || lower === "list_directory") {
    return {
      verb: t("hud.toolVerbList"),
      fileName: fileChip,
      fullPath: filePath,
      summary: !fileChip ? rawName : undefined,
    };
  }

  // 6. Todo tools
  if (lower === "todo_write" || lower === "todowrite") {
    const count = Array.isArray(args.todos) ? args.todos.length : undefined;
    return {
      verb: t("hud.toolVerbTodo"),
      summary: count !== undefined ? t("hud.todoItems", { count }) : undefined,
    };
  }

  // Fallback generic tool
  const genericHint =
    fileChip ||
    pickStr("query", "url", "skill", "title", "prompt")?.slice(0, 72);
  return {
    verb: rawName,
    summary: genericHint,
  };
}

function RinToolActivityList({
  toolCalls,
  canErase,
  eraseLabel,
  erasingToolCallId,
  onErase,
  expandedKeys,
  keyPrefix,
  onToggleExpanded,
  t,
}: {
  toolCalls: ToolCallBlock[];
  canErase: boolean;
  eraseLabel: string;
  erasingToolCallId: string | null;
  onErase: (toolCall: ToolCallBlock) => void;
  expandedKeys: Set<string>;
  keyPrefix: string;
  onToggleExpanded: (key: string) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const infos = useMemo(
    () => toolCalls.map((tc) => describeToolCall(tc, t)),
    [toolCalls, t]
  );
  const toolKey = (tc: ToolCallBlock, idx: number) =>
    `${keyPrefix}::tool::${tc.id || idx}`;
  const toggleIdx = (idx: number) => {
    const tc = toolCalls[idx];
    if (tc) onToggleExpanded(toolKey(tc, idx));
  };

  return (
    <div className="my-1 flex flex-col gap-0.5">
      {toolCalls.map((tc, idx) => {
        const isErr = Boolean(tc.error || tc.status === "error");
        const outChars =
          (tc.input?.length ?? 0) +
          (tc.output?.length ?? 0) +
          (tc.error?.length ?? 0);
        const tok = Math.max(8, Math.ceil(outChars / 3.5));
        const isHeavy = tok >= 3500;
        const isOpen = expandedKeys.has(toolKey(tc, idx));
        const info = infos[idx] ?? describeToolCall(tc, t);

        return (
          <div key={tc.id || idx} className="flex flex-col">
            <div
              onClick={() => toggleIdx(idx)}
              className="group/trow flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-[7px] px-2 py-[3px] text-left text-[13px] transition-colors select-none hover:bg-[var(--bg-hover)]/70"
            >
              {/* Status Icon Slot */}
              <span className="inline-flex h-[18px] w-4 shrink-0 items-center justify-center">
                {isErr ? (
                  <X className="size-3.5 text-[var(--crimson-fg)]" />
                ) : (
                  <Check className="size-3.5 text-[var(--text-low)]" />
                )}
              </span>

              {/* Semantic Verb */}
              <span className="shrink-0 text-[var(--text-mid)]">
                {info.verb}
              </span>

              {/* File Chip (if file tool) */}
              {info.fileName && (
                <span
                  className="hud-mono inline-flex max-w-[55%] items-center gap-1 truncate rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-1.5 py-[0.5px] text-[12px] text-[var(--text-hi)]"
                  title={info.fullPath || info.fileName}
                >
                  <FileText className="size-3 shrink-0 text-[var(--text-low)]" />
                  <span className="truncate">{info.fileName}</span>
                </span>
              )}

              {info.lineRange && (
                <span className="hud-mono shrink-0 text-[11.5px] text-[var(--text-low)]">
                  {info.lineRange}
                </span>
              )}

              {info.summary && (
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-mid)]">
                  {info.summary}
                </span>
              )}

              {/* Right Side: +N -M Diff Stats + Heavy Spike Badge + Erase + Chevron */}
              <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                {info.added !== undefined && info.removed !== undefined && (
                  <span className="hud-mono flex items-center gap-1 text-[12px] font-medium">
                    <span className="text-[var(--diff-add-fg)]">
                      +{info.added}
                    </span>
                    <span className="text-[var(--diff-del-fg)]">
                      -{info.removed}
                    </span>
                  </span>
                )}

                {isHeavy && (
                  <span className="hud-mono rounded bg-[var(--crimson-dim)] px-1.5 py-[0.5px] text-[10px] font-semibold text-[var(--crimson-fg)]">
                    {formatTokenCount(tok)}
                  </span>
                )}

                {canErase && (
                  <button
                    type="button"
                    disabled={erasingToolCallId !== null}
                    onClick={(e) => {
                      e.stopPropagation();
                      onErase(tc);
                    }}
                    className="rounded px-1 text-xs text-[var(--text-low)] opacity-0 transition-opacity group-hover/trow:opacity-100 hover:bg-[var(--crimson-dim)] hover:text-[var(--crimson-fg)]"
                    title={eraseLabel}
                  >
                    {erasingToolCallId === tc.id ? "…" : "×"}
                  </button>
                )}

                <span className="flex size-[18px] items-center justify-center rounded-[6px] text-[var(--text-low)] group-hover/trow:bg-[var(--bg-hover)]">
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform duration-150",
                      isOpen && "rotate-90"
                    )}
                  />
                </span>
              </div>
            </div>

            {/* Rin-style subtle 1-line command preview beneath Run description */}
            {!isOpen && info.commandSubline && (
              <div
                onClick={() => toggleIdx(idx)}
                className="hud-mono cursor-pointer truncate pr-6 pl-8 text-[11.5px] text-[var(--text-low)]"
              >
                {info.commandSubline}
              </div>
            )}

            {/* Inline Expanded Detail (Diff View OR Output / Args) */}
            {isOpen && (
              <div className="mx-2 mt-1 mb-1.5 overflow-hidden rounded-[7px] border border-[var(--line-hair)] bg-[var(--bg-code)] text-xs">
                {info.diffPairs && info.diffPairs.length > 0 ? (
                  <div className="hud-mono max-h-72 overflow-auto py-1.5 text-[11.5px] leading-[1.55]">
                    {info.diffPairs.map((pair, pi) => (
                      <div key={pi}>
                        {pair.oldText
                          .split("\n")
                          .slice(0, 120)
                          .map((line, li) =>
                            pair.oldText ? (
                              <div
                                key={`d-${li}`}
                                className="bg-[var(--diff-del-bg)] px-3 whitespace-pre-wrap break-all text-[var(--diff-del-fg)]"
                              >
                                - {line}
                              </div>
                            ) : null
                          )}
                        {pair.newText
                          .split("\n")
                          .slice(0, 160)
                          .map((line, li) => (
                            <div
                              key={`a-${li}`}
                              className="bg-[var(--diff-add-bg)] px-3 whitespace-pre-wrap break-all text-[var(--diff-add-fg)]"
                            >
                              + {line}
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="hud-mono divide-y divide-[var(--line-hair)]">
                    {tc.input && (
                      <div className="p-2.5">
                        <div className="mb-1 text-[10px] font-semibold text-[var(--text-low)]">
                          {t("hud.toolArgs")}
                        </div>
                        <pre className="max-h-36 overflow-auto text-[11.5px] whitespace-pre-wrap break-all text-[var(--text-mid)]">
                          {tc.input}
                        </pre>
                      </div>
                    )}
                    {tc.output && (
                      <div className="p-2.5">
                        <div className="mb-1 text-[10px] font-semibold text-[var(--text-low)]">
                          {t("hud.toolOutput")}
                        </div>
                        <pre className="max-h-60 overflow-auto text-[11.5px] whitespace-pre-wrap break-all text-[var(--text-hi)]">
                          {cleanAnsiCodes(tc.output)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
                {tc.error && (
                  <div className="hud-mono border-t border-[var(--crimson-line)] bg-[var(--crimson-dim)] p-2.5 text-[11.5px] whitespace-pre-wrap break-all text-[var(--crimson-fg)]">
                    {tc.error}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FrameActions = {
  startEdit: (block: TimelineBlock) => void;
  cancelEdit: () => void;
  syncDraft: (targetId: string, content: string) => void;
  commitEdit: (content: string) => void;
  openContextMenu: (e: React.MouseEvent, block: TimelineBlock) => void;
  erase: (block: TimelineBlock) => void;
  eraseToolCall: (block: TimelineBlock, toolCall: ToolCallBlock) => void;
  forkInPty: () => void;
  loadArsenal: () => void;
  loadExecutionOutput: (block: TimelineBlock) => void;
  toggleAudit: () => void;
  revert: (entry: EditLogEntry) => void;
  toggleExpanded: (key: string) => void;
};

const InlineEditor = forwardRef<
  HTMLDivElement,
  {
    targetId: string;
    backupWrite: boolean;
    initialContent: string;
    original: string;
    savingEdit: boolean;
    editError?: string | null;
    arsenalPrompts: PromptItem[] | null;
    actions: FrameActions;
    t: (key: MessageKey, params?: Record<string, string | number>) => string;
  }
>(function InlineEditor(
  {
    targetId,
    backupWrite,
    initialContent,
    original,
    savingEdit,
    editError,
    arsenalPrompts,
    actions,
    t,
  },
  ref
) {
  const [draft, setDraft] = useState(initialContent);
  const [arsenalMenuOpen, setArsenalMenuOpen] = useState(false);
  const draftRef = useRef(draft);
  const syncTimerRef = useRef<number | null>(null);

  const clearSyncTimer = () => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  };

  const flush = () => {
    clearSyncTimer();
    actions.syncDraft(targetId, draftRef.current);
  };

  const handleChange = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    clearSyncTimer();
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      actions.syncDraft(targetId, value);
    }, 400);
  };

  const commit = () => {
    clearSyncTimer();
    actions.commitEdit(draftRef.current);
  };

  const cancel = () => {
    clearSyncTimer();
    actions.cancelEdit();
  };

  useEffect(
    () => () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        actions.syncDraft(targetId, draftRef.current);
      }
    },
    [actions, targetId]
  );

  return (
      <div
        ref={ref}
        className="reticle my-2 rounded-[10px] border-[1.5px] border-[var(--forge)] bg-[var(--bg-panel)] p-3.5 shadow-xl"
      >
        <div className="hud-mono mb-2 rounded-[6px] border border-dashed border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-3 py-2 text-[11.5px] text-[var(--crimson-fg)]">
          <div className="mb-1 flex items-center justify-between text-[10px] font-bold">
            <span>{t("hud.ghostOriginalTitle")}</span>
            <span>
              {backupWrite ? t("hud.safeBackupTag") : t("hud.editLogOnlyBadge")}
            </span>
          </div>
          <div className="max-h-28 overflow-y-auto whitespace-pre-wrap opacity-90">
            - {original || t("hud.previewEmpty")}
          </div>
        </div>

        <textarea
          autoFocus
          onBlur={flush}
          className="hud-mono min-h-[136px] w-full resize-y rounded-[6px] border border-[var(--line-strong)] bg-[var(--bg-void)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text-hi)] outline-none focus:border-[var(--forge)]"
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder={t("session.enterContent")}
          value={draft}
        />

        {editError && (
          <div
            className="hud-mono mt-2 rounded-[6px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-3 py-2 text-[11.5px] break-words whitespace-pre-wrap text-[var(--crimson-fg)]"
            role="alert"
          >
            {editError}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="hud-mono text-[11px] text-[var(--text-mid)]">
              <kbd className="hud-kbd">Ctrl+S</kbd> {t("save")} ·{" "}
              <kbd className="hud-kbd">Esc</kbd> {t("cancel")}
            </span>

            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  actions.loadArsenal();
                  setArsenalMenuOpen((v) => !v);
                }}
                className="hud-mono inline-flex items-center gap-1 rounded-[5px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--cyan-fg)]"
              >
                <BookOpen className="size-3" />
                <span>{t("hud.insertFromPrompts")}</span>
              </button>
              {arsenalMenuOpen && (
                <div className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-72 overflow-y-auto rounded-[7px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 shadow-2xl">
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
                          const sep = draft.trim() ? "\n\n" : "";
                          handleChange(`${draft}${sep}${p.content}`);
                          setArsenalMenuOpen(false);
                        }}
                        className="block w-full truncate rounded-[4px] px-2.5 py-1.5 text-left text-xs hover:bg-[var(--bg-hover)]"
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
              onClick={cancel}
              className="hud-btn"
            >
              {t("session.cancel")}
            </button>
            <button
              type="button"
              disabled={savingEdit}
              onClick={commit}
              className="hud-btn hud-btn-forge"
            >
              <Zap className="size-3" />
              <span>{savingEdit ? t("loading") : t("session.saveChanges")}</span>
            </button>
          </div>
        </div>
      </div>
  );
});

/* ==================== RIN-STYLE EDITORIAL MESSAGE STREAM + INLINE SURGERY ==================== */
const CausalFrame = memo(
  forwardRef<
    HTMLDivElement,
    {
      block: TimelineBlock;
      estimatedTokens: number;
      forgedInfo?: { count: number; latest: EditLogEntry };
      isEditing: boolean;
      editingContent: string;
      editingOriginal: string;
      savingEdit: boolean;
      editError?: string | null;
      arsenalPrompts: PromptItem[] | null;
      canFork: boolean;
      backupWrite: boolean;
      canEraseToolCalls: boolean;
      erasingToolCallId: string | null;
      loadingExecutionOutput?: boolean;
      expandedKeys: Set<string>;
      actions: FrameActions;
      t: (key: MessageKey, params?: Record<string, string | number>) => string;
      searchHighlight?: string;
      isCurrentMatch?: boolean;
    }
  >(function CausalFrame(
    {
      block,
      estimatedTokens,
      forgedInfo,
      isEditing,
      editingContent,
      editingOriginal,
      savingEdit,
      editError,
      arsenalPrompts,
      canFork,
      backupWrite,
      canEraseToolCalls,
      erasingToolCallId,
      loadingExecutionOutput,
      expandedKeys,
      actions,
      t,
      searchHighlight,
      isCurrentMatch,
    },
    ref
  ) {
  const [justCopied, setJustCopied] = useState(false);
  const thinkingKey = `${block.id}::thinking`;
  const longKey = `${block.id}::long`;
  const thinkingExpanded = expandedKeys.has(thinkingKey);
  const longExpanded = expandedKeys.has(longKey);
  const toggleThinking = () => actions.toggleExpanded(thinkingKey);
  const toggleLong = () => actions.toggleExpanded(longKey);
  const systemTags = {
    keyPrefix: block.id,
    expandedKeys,
    onToggle: actions.toggleExpanded,
  };
  const onStartEdit = () => actions.startEdit(block);
  const onContextMenu = (e: React.MouseEvent) => actions.openContextMenu(e, block);
  const onRevert = forgedInfo
    ? () => actions.revert(forgedInfo.latest)
    : undefined;
  const onOpenAudit = actions.toggleAudit;
  const onErase = () => actions.erase(block);
  const onEraseToolCall = (toolCall: ToolCallBlock) =>
    actions.eraseToolCall(block, toolCall);
  const onLoadExecutionOutput = () => actions.loadExecutionOutput(block);
  const onForkInPty = canFork ? actions.forkInPty : undefined;

  const isThinking = block.role === "thinking";
  const isUser = block.role === "user";
  const isForged = Boolean(forgedInfo);
  const isSpike = estimatedTokens >= SPIKE_TOKEN_THRESHOLD;
  const hasContent = block.content.trim().length > 0;
  const isLong =
    !isThinking && block.content.length > LONG_BLOCK_COLLAPSE_THRESHOLD;
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

  if (isEditing) {
    return (
      <InlineEditor
        actions={actions}
        backupWrite={backupWrite}
        arsenalPrompts={arsenalPrompts}
        editError={editError}
        initialContent={editingContent}
        original={editingOriginal}
        ref={ref}
        savingEdit={savingEdit}
        t={t}
        targetId={block.editTarget || block.id}
      />
    );
  }

  // 2. Thinking Block (Rin ThinkingBlock style: ✦ 思考过程 ›)
  if (isThinking) {
    if (!hasContent) return null;
    return (
      <div
        ref={ref}
        onContextMenu={onContextMenu}
        className="group/frame my-0.5 flex flex-col"
      >
        <div className="flex items-center gap-1.5 rounded-[7px] px-2 py-[3px] transition-colors hover:bg-[var(--bg-hover)]/65">
          <button
            type="button"
            onClick={toggleThinking}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span className="inline-flex h-[18px] w-4 shrink-0 items-center justify-center text-[var(--text-low)]">
              <Sparkles className="size-3.5" />
            </span>
            <span className="truncate text-[13px] italic text-[var(--text-low)]">
              {t("session.filter.thinking")}
            </span>
            {forgedInfo && (
              <span className="hud-mono rounded bg-[var(--forge-dim)] px-1.5 text-[10px] font-semibold text-[var(--forge-fg)]">
                ⚡{t("hud.forgedStamp", { count: forgedInfo.count })}
              </span>
            )}
          </button>

          <div className="ml-auto flex items-center gap-1.5 opacity-0 transition-opacity group-hover/frame:opacity-100">
            {block.editable === false ? (
              <span
                className="text-[10px] text-[var(--text-low)]"
                title={t("hud.sealedReadOnlyHint")}
              >
                {t("hud.sealedReadOnly")}
              </span>
            ) : (
              <button
                type="button"
                onClick={onStartEdit}
                className="rounded px-1.5 py-0.5 text-[11px] text-[var(--text-mid)] hover:bg-[var(--forge-dim)] hover:text-[var(--forge-fg)]"
              >
                {t("hud.editMemory")}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={toggleThinking}
            className="flex size-[18px] shrink-0 items-center justify-center rounded-[6px] text-[var(--text-low)]"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform duration-150",
                thinkingExpanded && "rotate-90"
              )}
            />
          </button>
        </div>

        {thinkingExpanded && (
          <div
            onDoubleClick={onStartEdit}
            className="mt-1 mb-1.5 ml-4 max-h-72 overflow-y-auto border-l-2 border-[var(--line-strong)] pl-3 text-[13px] italic leading-relaxed whitespace-pre-wrap text-[var(--text-mid)]"
          >
            {parseContentWithCodeBlocks(block.content, searchHighlight, t, systemTags)}
          </div>
        )}
      </div>
    );
  }

  // 3. User Message (Soft Rin Bubble — no harsh border unless edited!)
  if (isUser) {
    return (
      <div
        ref={ref}
        onContextMenu={onContextMenu}
        onDoubleClick={onStartEdit}
        title={
          block.editable !== false ? t("hud.doubleClickEditHint") : undefined
        }
        className={cn(
          "group/frame relative my-3 rounded-[14px] px-4 py-3 transition-colors",
          isForged
            ? "border border-[var(--forge-line)] bg-[var(--forge-dim)]"
            : "bg-[var(--bubble)]",
          isCurrentMatch && "ring-2 ring-[var(--cyan)]"
        )}
      >
        {forgedInfo && (
          <div className="mb-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenAudit}
              className="hud-mono inline-flex items-center gap-1 rounded-[4px] bg-[var(--forge-dim)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--forge-fg)]"
            >
              <Zap className="size-2.5" />
              <span>{t("hud.forgedStamp", { count: forgedInfo.count })}</span>
            </button>
            {onRevert && (
              <button
                type="button"
                onClick={onRevert}
                className="hud-mono inline-flex items-center gap-1 text-[10.5px] text-[var(--cyan-fg)] hover:underline"
              >
                <Undo2 className="size-3" />
                <span>{t("hud.revertOriginal")}</span>
              </button>
            )}
          </div>
        )}

        {hasContent ? (
          <div className="text-[14px] leading-[1.64] break-words text-[var(--text-hi)]">
            {parseContentWithCodeBlocks(displayContent, searchHighlight, t, systemTags)}
          </div>
        ) : (
          <div className="hud-mono text-xs italic text-[var(--text-low)]">
            {t("hud.emptyFrame")}
          </div>
        )}

        {/* Quiet Hover Action Pill on User Bubble */}
        <div className="absolute top-2 right-2.5 flex items-center gap-0.5 rounded-[6px] border border-[var(--line-hair)] bg-[var(--bg-panel)] px-1 py-0.5 opacity-0 shadow-xs transition-opacity group-hover/frame:opacity-100">
          {hasContent && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(block.content);
                setJustCopied(true);
                setTimeout(() => setJustCopied(false), 1200);
              }}
              className="grid size-5 place-items-center rounded text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              title={t("copy")}
            >
              {justCopied ? (
                <Check className="size-3 text-[var(--emerald-fg)]" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          )}
          {block.editable !== false && (
            <>
              <button
                type="button"
                onClick={onStartEdit}
                className="grid size-5 place-items-center rounded text-[var(--text-mid)] hover:bg-[var(--forge-dim)] hover:text-[var(--forge-fg)]"
                title={t("hud.editMemory")}
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                onClick={onErase}
                className="grid size-5 place-items-center rounded text-[var(--text-mid)] hover:bg-[var(--crimson-dim)] hover:text-[var(--crimson-fg)]"
                title={t("hud.eraseShort")}
              >
                <Trash2 className="size-3" />
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // 4. Assistant Turn (Pure Borderless Prose + Semantic Tool Activity Rows — Rin / OpenCode Style!)
  return (
    <div
      ref={ref}
      onContextMenu={onContextMenu}
      className={cn(
        "group/frame relative my-1.5 transition-colors",
        isForged &&
          "rounded-[10px] border-l-[3px] border-[var(--forge)] bg-[var(--forge-dim)]/45 px-3.5 py-2.5",
        isCurrentMatch && "rounded-[8px] ring-2 ring-[var(--cyan)]"
      )}
    >
      {/* Forged Banner (only if modified!) */}
      {forgedInfo && (
        <div className="mb-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenAudit}
            className="hud-mono inline-flex items-center gap-1 rounded-[4px] border border-[var(--forge-line)] bg-[var(--forge-dim)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--forge-fg)]"
          >
            <Zap className="size-2.5" />
            <span>{t("hud.forgedStamp", { count: forgedInfo.count })}</span>
          </button>
          {onRevert && (
            <button
              type="button"
              onClick={onRevert}
              className="hud-mono inline-flex items-center gap-1 text-[10.5px] text-[var(--cyan-fg)] hover:underline"
            >
              <Undo2 className="size-3" />
              <span>{t("hud.revertOriginal")}</span>
            </button>
          )}
        </div>
      )}

      {/* Semantic Tool Call Activity Rows */}
      {block.toolCalls && block.toolCalls.length > 0 && (
        <RinToolActivityList
          canErase={canEraseToolCalls}
          eraseLabel={t("session.eraseToolCall")}
          erasingToolCallId={erasingToolCallId}
          expandedKeys={expandedKeys}
          keyPrefix={block.id}
          onErase={onEraseToolCall}
          onToggleExpanded={actions.toggleExpanded}
          t={t}
          toolCalls={block.toolCalls}
        />
      )}

      {/* Borderless Assistant Prose */}
      {hasContent ? (
        <div
          onDoubleClick={onStartEdit}
          title={
            block.editable !== false ? t("hud.doubleClickEditHint") : undefined
          }
          className="px-2 py-1"
        >
          <div className="text-[14px] leading-[1.7] break-words text-[var(--text-hi)]">
            {parseContentWithCodeBlocks(displayContent, searchHighlight, t, systemTags)}
          </div>

          {isLong && !isSearchHit && (
            <button
              type="button"
              onClick={toggleLong}
              className="hud-mono mt-1.5 inline-flex items-center gap-1 rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
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

          {/* Rin ReplyFooter-style subtle hover action strip */}
          <div
            className={cn(
              "mt-1 flex items-center gap-1.5 transition-opacity",
              isKiroPlaceholder
                ? "opacity-100"
                : "opacity-0 group-hover/frame:opacity-100"
            )}
          >
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(block.content);
                setJustCopied(true);
                setTimeout(() => setJustCopied(false), 1200);
              }}
              className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              title={t("copy")}
            >
              {justCopied ? (
                <Check className="size-3 text-[var(--emerald-fg)]" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
            {block.editable !== false && (
              <>
                <button
                  type="button"
                  onClick={onStartEdit}
                  className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--text-low)] hover:bg-[var(--forge-dim)] hover:text-[var(--forge-fg)]"
                >
                  <Pencil className="size-3" />
                  <span>{t("hud.editMemory")}</span>
                </button>
                <button
                  type="button"
                  onClick={onErase}
                  className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--text-low)] hover:bg-[var(--crimson-dim)] hover:text-[var(--crimson-fg)]"
                >
                  <Trash2 className="size-3" />
                  <span>{t("hud.eraseShort")}</span>
                </button>
              </>
            )}
            {isKiroPlaceholder && onLoadExecutionOutput && (
              <button
                type="button"
                disabled={loadingExecutionOutput}
                onClick={onLoadExecutionOutput}
                className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--cyan-fg)] hover:bg-[var(--cyan-dim)]"
              >
                <RefreshCw
                  className={cn(
                    "size-3",
                    loadingExecutionOutput && "animate-spin"
                  )}
                />
                <span>{t("hud.loadOutputs", { count: 1 })}</span>
              </button>
            )}
            {onForkInPty && (
              <button
                type="button"
                onClick={onForkInPty}
                className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--text-low)] hover:bg-[var(--cyan-dim)] hover:text-[var(--cyan-fg)]"
                title={t("terminal.forkEmbedded")}
              >
                <GitFork className="size-3" />
              </button>
            )}
            {isSpike && (
              <span className="hud-mono rounded bg-[var(--crimson-dim)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--crimson-fg)]">
                ⚠ {t("hud.spikeStamp", { tokens: formatTokenCount(estimatedTokens) })}
              </span>
            )}
            <span className="hud-mono ml-auto text-[10.5px] text-[var(--text-low)]">
              {formatTokenCount(estimatedTokens)} tok
            </span>
          </div>
        </div>
      ) : block.toolCalls && block.toolCalls.length > 0 ? null : (
        <div className="hud-mono px-2 py-1 text-[11.5px] italic text-[var(--text-low)]">
          {t("hud.emptyFrame")}
        </div>
      )}
    </div>
  );
})
);
