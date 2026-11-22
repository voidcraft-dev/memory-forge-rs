import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileJson,
  Folder,
  Hash,
  Pencil,
  RefreshCw,
  Search,
  Star,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { formatWorkspaceShortName } from "@/components/layout/shell-layout";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import type { RawJsonlImportPreview, Session } from "@/features/desktop/types";
import { useTerminal } from "@/features/terminal/terminal-context";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const JSONL_TRANSFER_PLATFORMS = ["claude", "codex", "pi"] as const;
const DEFAULT_FALLBACK_PLATFORMS = ["claude", "codex", "opencode", "cursor", "devin"];

const SESSION_CARD_RENDER_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "96px",
};

export const PLATFORM_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  devin: "Devin",
  gemini: "Gemini",
  kiro: "Kiro",
  "kiro-ide": "Kiro IDE",
  grok: "Grok",
  pi: "Pi",
  zed: "Zed",
  cline: "Cline",
  qwen: "Qwen",
  zcode: "ZCode",
  workbuddy: "WorkBuddy",
  cindy: "Cindy",
  "cindy-global": "Cindy Intl",
  dsh: "DSH",
  "qoder-cn": "Qoder CN",
  antigravity: "Antigravity",
  codebuddy: "CodeBuddy",
};

export function getPlatformBadgeStyle(platform: string): string {
  switch (platform) {
    case "claude":
      return "border-[var(--forge-line)] bg-[var(--forge-dim)] text-[var(--forge-fg)]";
    case "codex":
    case "codebuddy":
      return "border-[var(--emerald-line)] bg-[var(--emerald-dim)] text-[var(--emerald-fg)]";
    case "devin":
    case "cursor":
    case "qwen":
    case "zcode":
      return "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]";
    case "opencode":
    case "kiro":
    case "kiro-ide":
    case "cline":
      return "border-[var(--violet-line)] bg-[var(--violet-dim)] text-[var(--violet-fg)]";
    default:
      return "border-[var(--line-strong)] bg-[var(--bg-elevated)] text-[var(--text-hi)]";
  }
}

function parseTimestampMs(timestamp: string): number {
  const num = Number.parseInt(timestamp, 10);
  if (Number.isFinite(num) && num > 0) {
    if (num > 10 ** 17) return num / 1_000_000;
    if (num > 10 ** 15) return num / 1000;
    if (num > 10 ** 12) return num;
    return num * 1000;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeTime(
  timestamp: string,
  justNowLabel: string,
  hoursAgoLabel: string,
  daysAgoLabel: string
): string {
  const ms = parseTimestampMs(timestamp);
  if (!ms) return "";
  const hours = (Date.now() - ms) / (1000 * 60 * 60);
  if (hours < 1) return justNowLabel;
  if (hours < 24) return hoursAgoLabel.replace("{count}", String(Math.floor(hours)));
  return daysAgoLabel.replace("{count}", String(Math.floor(hours / 24)));
}

function isUpdatedToday(timestamp: string): boolean {
  const ms = parseTimestampMs(timestamp);
  if (!ms) return false;
  const d = new Date(ms);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function sessionTreeSome(
  session: Session,
  predicate: (item: Session) => boolean
): boolean {
  return (
    predicate(session) ||
    (session.agentGroup?.children ?? []).some((child) =>
      sessionTreeSome(child, predicate)
    )
  );
}

function countSubagents(session: Session): number {
  return (session.agentGroup?.children ?? []).reduce(
    (count, child) => count + 1 + countSubagents(child),
    0
  );
}

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidLikeTitle(title?: string | null): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  return UUID_LIKE_RE.test(trimmed);
}

export function cleanHumanPreview(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(
      /<(system-reminder|environment_details|additional_metadata|ide_opened_file|user-prompt-submit-hook)(?:\s[^>]*)?>[\s\S]*?<\/(?:system-reminder|environment_details|additional_metadata|ide_opened_file|user-prompt-submit-hook)>/gi,
      ""
    )
    .replace(/<\/?[a-z_-]+>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function SessionList({ collapsed = false }: { collapsed?: boolean }) {
  const navigate = useNavigate();
  const { t, state, dispatch, snapshot } = useDesktop();
  const { startTerminal } = useTerminal();
  const currentPlatform = state.currentPlatform;
  const sessions = state.sessions;
  const selectedSessionKey = state.selectedSessionKey;
  const selectedSessionPlatform = state.selectedSessionPlatform;
  const searchQuery = state.searchQuery;
  const showArchived = state.showArchived;

  const [searchInput, setSearchInput] = useState(searchQuery);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchIndex, setSearchIndex] = useState({
    supported: false,
    running: false,
    indexed: 0,
    total: 0,
  });
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [batchOperating, setBatchOperating] = useState(false);

  const [importPlatform, setImportPlatform] = useState<string>("claude");
  const [importPreview, setImportPreview] =
    useState<RawJsonlImportPreview | null>(null);
  const [probingImport, setProbingImport] = useState(false);
  const [committingImport, setCommittingImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    session: Session;
  } | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const { confirm, dialogProps } = useConfirmDialog();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);

  // Active platforms derived from dashboard summary (hides 0-session adapters automatically!)
  const { activePlatformList, idlePlatformCount, totalActiveCount } = useMemo(() => {
    const visible = new Set(
      snapshot?.settings.visiblePlatforms ?? DEFAULT_FALLBACK_PLATFORMS
    );
    const dashPlatforms = state.dashboard?.platforms ?? [];
    if (dashPlatforms.length === 0) {
      return {
        activePlatformList: DEFAULT_FALLBACK_PLATFORMS.filter((p) =>
          visible.has(p)
        ).map((p) => ({ platform: p, count: 0 })),
        idlePlatformCount: Math.max(0, visible.size - 5),
        totalActiveCount: sessions.length,
      };
    }
    const nonZero = dashPlatforms.filter(
      (p) => visible.has(p.platform) && p.count > 0
    );
    const idle = dashPlatforms.filter(
      (p) => visible.has(p.platform) && p.count === 0
    ).length;
    const sum = nonZero.reduce((acc, item) => acc + item.count, 0);
    return {
      activePlatformList: nonZero.map((p) => ({
        platform: p.platform,
        count: p.count,
      })),
      idlePlatformCount: idle,
      totalActiveCount: sum,
    };
  }, [sessions.length, snapshot?.settings.visiblePlatforms, state.dashboard?.platforms]);

  const platformsToQueryInAll = useMemo(() => {
    if (activePlatformList.length > 0) {
      return activePlatformList.map((p) => p.platform);
    }
    return DEFAULT_FALLBACK_PLATFORMS;
  }, [activePlatformList]);

  const debouncedSetSearch = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        dispatch({ type: "setSearchQuery", payload: value });
      }, 260);
    },
    [dispatch]
  );

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [currentPlatform, searchQuery]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const fetchSessionFeed = useCallback(async () => {
    if (currentPlatform === "all") {
      const perPlatformLimit = searchQuery.trim() ? 25 : 25;
      const settled = await Promise.allSettled(
        platformsToQueryInAll.map(async (plat) => {
          const res = await api.getSessions(
            plat,
            searchQuery,
            perPlatformLimit,
            0,
            showArchived
          );
          return res.items.map((item) => ({
            ...item,
            platform: item.platform || plat,
          }));
        })
      );
      const merged: Session[] = [];
      for (const entry of settled) {
        if (entry.status === "fulfilled") merged.push(...entry.value);
      }
      merged.sort(
        (a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt)
      );
      return {
        items: merged,
        total: merged.length,
        searchIndex: { supported: false, running: false, indexed: 0, total: 0 },
      };
    }

    const result = await api.getSessions(
      currentPlatform,
      searchQuery,
      PAGE_SIZE,
      0,
      showArchived
    );
    return {
      items: result.items.map((item) => ({
        ...item,
        platform: item.platform || currentPlatform,
      })),
      total: result.total,
      searchIndex: result.searchIndex,
    };
  }, [currentPlatform, platformsToQueryInAll, searchQuery, showArchived]);

  // Load session list (wait for desktop settings snapshot so visiblePlatforms is respected)
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    const requestId = ++requestIdRef.current;

    const load = async () => {
      setLoading(true);
      try {
        const result = await fetchSessionFeed();
        if (cancelled || requestId !== requestIdRef.current) return;
        dispatch({ type: "setSessions", payload: result.items });
        setTotalCount(result.total);
        setSearchIndex(result.searchIndex);
        dispatch({ type: "setEditingBlock", payload: null });
        dispatch({ type: "setSessionStatus", payload: null });

        // Auto-select most recent session if nothing is selected
        if (result.items.length > 0 && !selectedSessionKey) {
          const first = result.items[0];
          dispatch({
            type: "selectSession",
            payload: { platform: first.platform, sessionKey: first.sessionKey },
          });
        }
      } catch (err) {
        if (cancelled || requestId !== requestIdRef.current) return;
        console.error("Failed to load sessions:", err);
        dispatch({ type: "setSessions", payload: [] });
        setTotalCount(0);
      } finally {
        if (!cancelled && requestId === requestIdRef.current) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [dispatch, fetchSessionFeed, Boolean(snapshot)]);

  // Poll search index when running in single-platform search
  useEffect(() => {
    if (
      currentPlatform === "all" ||
      !searchQuery.trim() ||
      !searchIndex.running
    ) {
      return;
    }
    let disposed = false;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      const requestId = ++requestIdRef.current;
      try {
        const result = await api.getSessions(
          currentPlatform,
          searchQuery,
          PAGE_SIZE,
          0,
          showArchived
        );
        if (disposed || requestId !== requestIdRef.current) return;
        dispatch({ type: "setSessions", payload: result.items });
        setTotalCount(result.total);
        setSearchIndex(result.searchIndex);
      } catch {
        // ignore transient poll error
      } finally {
        polling = false;
      }
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [currentPlatform, dispatch, searchIndex.running, searchQuery, showArchived]);

  // Load SessionDetail + EditLog together so FORGED badges & Audit count are always live!
  useEffect(() => {
    if (!selectedSessionKey) return;
    const targetPlatform =
      selectedSessionPlatform ||
      sessions.find((s) => s.sessionKey === selectedSessionKey)?.platform ||
      (currentPlatform !== "all" ? currentPlatform : "claude");

    let cancelled = false;
    const loadDetailAndLogs = async () => {
      try {
        const [detail, logs] = await Promise.all([
          api.getSessionDetail(targetPlatform, selectedSessionKey),
          api
            .getEditLog(targetPlatform, selectedSessionKey)
            .catch(() => []),
        ]);
        if (cancelled) return;
        dispatch({ type: "setSessionDetail", payload: detail });
        dispatch({ type: "setEditLog", payload: logs });
        dispatch({
          type: "updateSession",
          payload: {
            sessionKey: selectedSessionKey,
            updates: {
              displayTitle: detail.aliasTitle || detail.title,
              aliasTitle: detail.aliasTitle,
            },
          },
        });
      } catch (err) {
        console.error("Failed to load session detail:", err);
      }
    };
    void loadDetailAndLogs();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionKey, selectedSessionPlatform]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshDone(false);
    try {
      const [feed, dash] = await Promise.all([
        fetchSessionFeed(),
        api.getDashboard().catch(() => null),
      ]);
      dispatch({ type: "setSessions", payload: feed.items });
      if (dash) dispatch({ type: "setDashboard", payload: dash });
      setTotalCount(feed.total);
      setSearchIndex(feed.searchIndex);
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

  const handleLoadMore = async () => {
    if (currentPlatform === "all") return;
    setLoadingMore(true);
    try {
      const result = await api.getSessions(
        currentPlatform,
        searchQuery,
        PAGE_SIZE,
        sessions.length,
        showArchived
      );
      dispatch({
        type: "setSessions",
        payload: [
          ...sessions,
          ...result.items.map((i) => ({
            ...i,
            platform: i.platform || currentPlatform,
          })),
        ],
      });
      setTotalCount(result.total);
      setSearchIndex(result.searchIndex);
    } catch (err) {
      console.error("Failed to load more:", err);
    }
    setLoadingMore(false);
  };

  const targetImportPlat = (
    JSONL_TRANSFER_PLATFORMS as readonly string[]
  ).includes(currentPlatform)
    ? currentPlatform
    : importPlatform;

  const handleChooseImport = async () => {
    setImportError(null);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Session JSONL", extensions: ["jsonl"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setProbingImport(true);
      const preview = await api.probeJsonlImport(targetImportPlat, selected);
      setImportPreview(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImportError(message);
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message },
      });
    } finally {
      setProbingImport(false);
    }
  };

  const handleCommitImport = async () => {
    if (!importPreview) return;
    setCommittingImport(true);
    setImportError(null);
    try {
      const result = await api.importRawJsonl(
        importPreview.platform || targetImportPlat,
        importPreview.sourcePath
      );
      await handleRefresh();
      dispatch({
        type: "selectSession",
        payload: {
          platform: result.platform || targetImportPlat,
          sessionKey: result.sessionKey,
        },
      });
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "success",
          message: result.alreadyExists
            ? t("session.importExists")
            : result.renamed
              ? t("session.importedRenamed")
              : t("session.imported"),
        },
      });
      setImportPreview(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommittingImport(false);
    }
  };

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedKeys(new Set());
    setLastClickedIndex(null);
  }, []);

  useEffect(() => {
    exitSelectionMode();
  }, [currentPlatform, showArchived, exitSelectionMode]);

  const displaySessions = useMemo(() => {
    return sessions.filter((session) => {
      if (
        favoritesOnly &&
        !sessionTreeSome(session, (item) => Boolean(item.favorite))
      ) {
        return false;
      }
      if (
        state.workspaceFilter !== "all" &&
        !sessionTreeSome(
          session,
          (item) => item.cwd?.trim() === state.workspaceFilter
        )
      ) {
        return false;
      }
      return true;
    });
  }, [favoritesOnly, sessions, state.workspaceFilter]);

  const { todaySessions, earlierSessions } = useMemo(() => {
    const today: Session[] = [];
    const earlier: Session[] = [];
    for (const s of displaySessions) {
      if (isUpdatedToday(s.updatedAt)) today.push(s);
      else earlier.push(s);
    }
    return { todaySessions: today, earlierSessions: earlier };
  }, [displaySessions]);

  const makeCompositeKey = (s: Session) => `${s.platform}::${s.sessionKey}`;

  const handleSelectAll = () => {
    setSelectedKeys(new Set(displaySessions.map(makeCompositeKey)));
    setLastClickedIndex(null);
  };

  const handleInvertSelection = () => {
    const next = new Set<string>();
    for (const s of displaySessions) {
      const ck = makeCompositeKey(s);
      if (!selectedKeys.has(ck)) next.add(ck);
    }
    setSelectedKeys(next);
    setLastClickedIndex(null);
  };

  const handleCardClick = (session: Session, index: number, e: React.MouseEvent) => {
    if (!selectionMode) {
      dispatch({
        type: "selectSession",
        payload: { platform: session.platform, sessionKey: session.sessionKey },
      });
      return;
    }
    const ck = makeCompositeKey(session);
    const next = new Set(selectedKeys);
    if (e.shiftKey && lastClickedIndex !== null) {
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const targetState = !next.has(ck);
      for (let i = start; i <= end; i++) {
        const item = displaySessions[i];
        if (!item) continue;
        const itemCk = makeCompositeKey(item);
        if (targetState) next.add(itemCk);
        else next.delete(itemCk);
      }
    } else if (next.has(ck)) {
      next.delete(ck);
    } else {
      next.add(ck);
    }
    setSelectedKeys(next);
    setLastClickedIndex(index);
  };

  const handleToggleFavorite = async (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    const isNow = await api.toggleFlag(
      session.platform,
      session.sessionKey,
      "favorite"
    );
    dispatch({
      type: "updateSession",
      payload: { sessionKey: session.sessionKey, updates: { favorite: isNow } },
    });
  };

  const handleToggleArchive = async (
    session: Session,
    e?: React.MouseEvent
  ) => {
    e?.stopPropagation();
    if (
      !showArchived &&
      !(await confirm({
        title: t("session.archive"),
        description: t("session.archiveConfirm"),
      }))
    ) {
      return;
    }
    await api.toggleFlag(session.platform, session.sessionKey, "archived");
    if (selectedSessionKey === session.sessionKey) {
      dispatch({ type: "setSelectedSessionKey", payload: null });
      dispatch({ type: "setSessionDetail", payload: null });
    }
    await handleRefresh();
  };

  const handleSaveCardAlias = async (session: Session, val: string) => {
    const trimmed = val.trim();
    setRenamingKey(null);
    try {
      await api.setAlias(session.platform, session.sessionKey, trimmed);
      const nextTitle = trimmed || session.displayTitle || session.sessionId;
      dispatch({
        type: "updateSession",
        payload: {
          sessionKey: session.sessionKey,
          updates: { aliasTitle: trimmed, displayTitle: nextTitle },
        },
      });
      if (state.sessionDetail?.sessionKey === session.sessionKey) {
        dispatch({
          type: "setSessionDetail",
          payload: {
            ...state.sessionDetail,
            aliasTitle: trimmed,
            title: nextTitle,
          },
        });
      }
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.aliasSaveFailed") },
      });
    }
  };

  const handleResumeFromContextMenu = async (
    session: Session,
    embedded: boolean
  ) => {
    try {
      const detail =
        state.sessionDetail?.sessionKey === session.sessionKey
          ? state.sessionDetail
          : await api.getSessionDetail(session.platform, session.sessionKey);
      const cmd = detail.commands?.resume;
      if (!cmd) {
        dispatch({
          type: "setSessionStatus",
          payload: { tone: "error", message: t("hud.ctxNoResumeCmd") },
        });
        return;
      }
      if (embedded) {
        await startTerminal(
          session.sessionKey,
          "resume",
          cmd,
          detail.cwd || session.cwd || null,
          {
            platform: session.platform,
            sessionTitle:
              session.aliasTitle ||
              cleanHumanPreview(session.preview) ||
              session.displayTitle ||
              session.sessionId,
          }
        );
        dispatch({ type: "setPtyBayOpen", payload: true });
      } else {
        await api.launchSessionTerminal(cmd, detail.cwd || session.cwd || null);
      }
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.terminalOpenFailed") },
      });
    }
  };

  const handleBatchAction = async (flag: "archived" | "favorite", set: boolean) => {
    if (selectedKeys.size === 0) return;
    setBatchOperating(true);
    try {
      const byPlatform = new Map<string, string[]>();
      for (const composite of selectedKeys) {
        const sep = composite.indexOf("::");
        const plat = composite.slice(0, sep);
        const sk = composite.slice(sep + 2);
        const list = byPlatform.get(plat) ?? [];
        list.push(sk);
        byPlatform.set(plat, list);
      }
      let affected = 0;
      for (const [plat, keys] of byPlatform.entries()) {
        affected += await api.batchSetFlag(plat, keys, flag, set);
      }
      await handleRefresh();
      const messageKey =
        flag === "archived"
          ? set
            ? "session.batchArchived"
            : "session.batchUnarchived"
          : set
            ? "session.batchFavorited"
            : "session.batchUnfavorited";
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t(messageKey, { count: affected }) },
      });
      exitSelectionMode();
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.batchFailed") },
      });
    } finally {
      setBatchOperating(false);
    }
  };

  const remaining =
    currentPlatform === "all" ? 0 : Math.max(0, totalCount - sessions.length);

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--line-hair)] bg-[var(--bg-rack)]",
        collapsed && "hidden"
      )}
    >
      {/* Rail Tactical Header */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--line-hair)] px-2.5 pt-2 pb-2">
        <div className="flex items-center justify-between gap-1.5">
          {/* Workspace Project Selector (Moved cleanly from Topbar!) */}
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-panel)] px-2 py-1">
            <Folder className="size-3 shrink-0 text-[var(--cyan-fg)]" />
            <select
              aria-label={t("hud.allWorkspaces")}
              className="hud-mono min-w-0 flex-1 truncate bg-transparent text-[10.5px] font-semibold text-[var(--text-hi)] outline-none"
              onChange={(e) =>
                dispatch({ type: "setWorkspaceFilter", payload: e.target.value })
              }
              value={state.workspaceFilter}
            >
              <option value="all">{t("hud.allWorkspaces")}</option>
              {Array.from(
                new Set(
                  sessions
                    .map((s) => s.cwd?.trim())
                    .filter((v): v is string => Boolean(v))
                )
              ).map((cwd) => (
                <option key={cwd} value={cwd}>
                  {formatWorkspaceShortName(cwd)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleChooseImport}
              disabled={probingImport}
              className="grid size-[23px] place-items-center rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:border-[var(--cyan-line)] hover:text-[var(--cyan-fg)]"
              title={t("session.importJsonl")}
            >
              <Upload className={cn("size-3", probingImport && "animate-pulse")} />
            </button>
            <button
              type="button"
              onClick={() =>
                selectionMode ? exitSelectionMode() : setSelectionMode(true)
              }
              className={cn(
                "grid size-[23px] place-items-center rounded-[3px] border transition-colors",
                selectionMode
                  ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                  : "border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
              )}
              title={selectionMode ? t("session.exitSelect") : t("session.selectMode")}
            >
              <CheckSquare className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => setFavoritesOnly((v) => !v)}
              className={cn(
                "grid size-[23px] place-items-center rounded-[3px] border transition-colors",
                favoritesOnly
                  ? "border-[var(--forge-line)] bg-[var(--forge-dim)] text-[var(--forge-fg)]"
                  : "border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
              )}
              title={t("session.favorite")}
            >
              <Star className={cn("size-3", favoritesOnly && "fill-current")} />
            </button>
            <button
              type="button"
              onClick={() => {
                setFavoritesOnly(false);
                dispatch({ type: "setShowArchived", payload: !showArchived });
              }}
              className={cn(
                "grid size-[23px] place-items-center rounded-[3px] border transition-colors",
                showArchived
                  ? "border-[var(--forge-line)] bg-[var(--forge-dim)] text-[var(--forge-fg)]"
                  : "border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
              )}
              title={showArchived ? t("session.sessionsView") : t("session.archiveView")}
            >
              <Archive className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className={cn(
                "grid size-[23px] place-items-center rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:text-[var(--text-hi)]",
                refreshDone && "text-[var(--emerald-fg)]"
              )}
              title={t("session.refresh")}
            >
              {refreshDone ? (
                <CheckCircle className="size-3" />
              ) : (
                <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
              )}
            </button>
          </div>
        </div>

        {/* Dynamic Active Platform Filter Pills (replaces 21-item sidebar!) */}
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => navigate("/")}
            className={cn(
              "hud-mono inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-[9.5px] font-semibold transition-colors",
              currentPlatform === "all"
                ? "border-[var(--text-hi)] bg-[var(--text-hi)] text-[var(--bg-panel)]"
                : "border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:border-[var(--line-strong)] hover:text-[var(--text-hi)]"
            )}
          >
            <span>{t("session.filter.all")}</span>
            {totalActiveCount > 0 && (
              <span className="opacity-70">{totalActiveCount}</span>
            )}
          </button>
          {activePlatformList.map((item) => {
            const active = currentPlatform === item.platform;
            const label =
              PLATFORM_LABELS[item.platform] ?? item.platform.toUpperCase();
            return (
              <button
                key={item.platform}
                type="button"
                onClick={() => navigate(`/${item.platform}`)}
                className={cn(
                  "hud-mono inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-[9.5px] font-semibold transition-colors",
                  active
                    ? "border-[var(--text-hi)] bg-[var(--text-hi)] text-[var(--bg-panel)]"
                    : "border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:border-[var(--line-strong)] hover:text-[var(--text-hi)]"
                )}
              >
                <span>{label.toUpperCase()}</span>
                {item.count > 0 && (
                  <span className="opacity-70">{item.count}</span>
                )}
              </button>
            );
          })}
          {currentPlatform !== "all" &&
            !activePlatformList.some((x) => x.platform === currentPlatform) && (
              <button
                type="button"
                className="hud-mono inline-flex items-center gap-1 rounded-[3px] border border-[var(--text-hi)] bg-[var(--text-hi)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--bg-panel)]"
              >
                <span>
                  {(
                    PLATFORM_LABELS[currentPlatform] ?? currentPlatform
                  ).toUpperCase()}
                </span>
              </button>
            )}
          {idlePlatformCount > 0 && (
            <span
              className="hud-mono inline-flex items-center rounded-[3px] border border-dashed border-[var(--line-hair)] px-1.5 py-0.5 text-[9px] text-[var(--text-low)]"
              title={t("hud.idlePlatformsHint", { count: idlePlatformCount })}
            >
              {t("hud.idlePlatforms", { count: idlePlatformCount })}
            </span>
          )}
        </div>

        {/* Search Input */}
        <div className="flex h-[27px] items-center gap-1.5 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-panel)] px-2 focus-within:border-[var(--cyan-line)]">
          <Search className="size-3 shrink-0 text-[var(--text-low)]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-hi)] placeholder:text-[var(--text-low)] outline-none"
            onChange={(e) => debouncedSetSearch(e.target.value)}
            placeholder={t("session.search")}
            value={searchInput}
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => debouncedSetSearch("")}
              className="text-[var(--text-low)] hover:text-[var(--text-hi)]"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Multi-Select Batch Action Strip */}
      {selectionMode && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-2.5 py-2">
          <div className="hud-mono flex items-center gap-1.5 text-[10.5px]">
            <strong className="text-[var(--cyan-fg)]">
              {t("session.selectedCount", { count: selectedKeys.size })}
            </strong>
            <button
              type="button"
              onClick={handleSelectAll}
              className="rounded px-1.5 py-0.5 text-[var(--text-mid)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-hi)]"
            >
              {t("session.selectAll")}
            </button>
            <button
              type="button"
              onClick={handleInvertSelection}
              className="rounded px-1.5 py-0.5 text-[var(--text-mid)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-hi)]"
            >
              {t("session.invertSelection")}
            </button>
            <button
              type="button"
              onClick={exitSelectionMode}
              className="ml-auto text-[var(--text-mid)] hover:text-[var(--text-hi)]"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={batchOperating || selectedKeys.size === 0}
              onClick={() => void handleBatchAction("archived", !showArchived)}
              className="hud-btn flex-1 justify-center text-[11px]"
            >
              {showArchived ? (
                <ArchiveRestore className="size-3" />
              ) : (
                <Archive className="size-3" />
              )}
              <span>
                {showArchived
                  ? t("session.batchUnarchive")
                  : t("session.batchArchive")}
              </span>
            </button>
            <button
              type="button"
              disabled={batchOperating || selectedKeys.size === 0}
              onClick={() => void handleBatchAction("favorite", true)}
              className="hud-btn flex-1 justify-center text-[11px]"
            >
              <Star className="size-3" />
              <span>{t("session.batchFavorite")}</span>
            </button>
          </div>
        </div>
      )}

      {/* Search Index Banner */}
      {searchQuery.trim() &&
        searchIndex.supported &&
        searchIndex.indexed < searchIndex.total && (
          <div className="hud-mono shrink-0 border-b border-[var(--forge-line)] bg-[var(--forge-dim)] px-2.5 py-1.5 text-[10px] text-[var(--forge-fg)]">
            {searchIndex.running
              ? t("session.searchIndexing", {
                  indexed: searchIndex.indexed,
                  total: searchIndex.total,
                })
              : t("session.searchIndexIncomplete")}
          </div>
        )}

      {/* Session Scroll Feed */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1.5 pb-3">
        {loading ? (
          <div className="space-y-1.5 pt-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-panel)] p-2.5"
              />
            ))}
          </div>
        ) : displaySessions.length === 0 ? (
          <div className="py-14 text-center">
            <p className="hud-mono text-xs text-[var(--text-low)]">
              {showArchived
                ? t("session.noArchivedSessions")
                : t("session.noSessions")}
            </p>
          </div>
        ) : (
          <>
            {todaySessions.length > 0 && (
              <>
                <div className="hud-mono flex justify-between px-1 pt-1.5 pb-1 text-[10px] font-semibold text-[var(--text-low)]">
                  <span>{t("hud.groupToday")}</span>
                  <span>{todaySessions.length}</span>
                </div>
                {todaySessions.map((session) => {
                  const globalIdx = displaySessions.indexOf(session);
                  return (
                    <HudSessionCard
                      autoExpandSubagents={searchQuery.trim().length > 0}
                      daysAgoLabel={t("session.daysAgo")}
                      hoursAgoLabel={t("session.hoursAgo")}
                      isMultiSelected={selectedKeys.has(makeCompositeKey(session))}
                      isSelected={
                        selectedSessionKey === session.sessionKey &&
                        (selectedSessionPlatform || session.platform) ===
                          session.platform
                      }
                      isRenaming={renamingKey === makeCompositeKey(session)}
                      justNowLabel={t("session.justNow")}
                      key={makeCompositeKey(session)}
                      onCancelRename={() => setRenamingKey(null)}
                      onChangeRename={setRenameDraft}
                      onClick={(e) => handleCardClick(session, globalIdx, e)}
                      onCommitRename={(val) =>
                        void handleSaveCardAlias(session, val)
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({
                          x: Math.min(window.innerWidth - 216, e.clientX),
                          y: Math.min(window.innerHeight - 270, e.clientY),
                          session,
                        });
                      }}
                      onOpenSubagent={(sub) =>
                        dispatch({
                          type: "selectSession",
                          payload: {
                            platform: sub.platform || session.platform,
                            sessionKey: sub.sessionKey,
                          },
                        })
                      }
                      onToggleArchive={handleToggleArchive}
                      onToggleFavorite={handleToggleFavorite}
                      readOnlyLabel={t("hud.readOnly")}
                      renameDraft={
                        renamingKey === makeCompositeKey(session)
                          ? renameDraft
                          : ""
                      }
                      selectedSessionKey={selectedSessionKey}
                      selectionMode={selectionMode}
                      session={session}
                      showArchived={showArchived}
                      subagentsCountLabel={t("hud.subagentsCount", {
                        count: countSubagents(session),
                      })}
                      untitledLabel={t("session.untitled")}
                    />
                  );
                })}
              </>
            )}

            {earlierSessions.length > 0 && (
              <>
                <div className="hud-mono flex justify-between px-1 pt-2.5 pb-1 text-[10px] font-semibold text-[var(--text-low)]">
                  <span>{t("hud.groupEarlier")}</span>
                  <span>{earlierSessions.length}</span>
                </div>
                {earlierSessions.map((session) => {
                  const globalIdx = displaySessions.indexOf(session);
                  return (
                    <HudSessionCard
                      autoExpandSubagents={searchQuery.trim().length > 0}
                      daysAgoLabel={t("session.daysAgo")}
                      hoursAgoLabel={t("session.hoursAgo")}
                      isMultiSelected={selectedKeys.has(makeCompositeKey(session))}
                      isSelected={
                        selectedSessionKey === session.sessionKey &&
                        (selectedSessionPlatform || session.platform) ===
                          session.platform
                      }
                      isRenaming={renamingKey === makeCompositeKey(session)}
                      justNowLabel={t("session.justNow")}
                      key={makeCompositeKey(session)}
                      onCancelRename={() => setRenamingKey(null)}
                      onChangeRename={setRenameDraft}
                      onClick={(e) => handleCardClick(session, globalIdx, e)}
                      onCommitRename={(val) =>
                        void handleSaveCardAlias(session, val)
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({
                          x: Math.min(window.innerWidth - 216, e.clientX),
                          y: Math.min(window.innerHeight - 270, e.clientY),
                          session,
                        });
                      }}
                      onOpenSubagent={(sub) =>
                        dispatch({
                          type: "selectSession",
                          payload: {
                            platform: sub.platform || session.platform,
                            sessionKey: sub.sessionKey,
                          },
                        })
                      }
                      onToggleArchive={handleToggleArchive}
                      onToggleFavorite={handleToggleFavorite}
                      readOnlyLabel={t("hud.readOnly")}
                      renameDraft={
                        renamingKey === makeCompositeKey(session)
                          ? renameDraft
                          : ""
                      }
                      selectedSessionKey={selectedSessionKey}
                      selectionMode={selectionMode}
                      session={session}
                      showArchived={showArchived}
                      subagentsCountLabel={t("hud.subagentsCount", {
                        count: countSubagents(session),
                      })}
                      untitledLabel={t("session.untitled")}
                    />
                  );
                })}
              </>
            )}

            {remaining > 0 && !favoritesOnly && !selectionMode && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void handleLoadMore()}
                className="hud-mono mt-1.5 w-full rounded-[5px] border border-dashed border-[var(--line-strong)] py-2 text-[11px] text-[var(--text-mid)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-hi)]"
              >
                {loadingMore
                  ? t("loading")
                  : t("session.loadMore", { count: remaining })}
              </button>
            )}
          </>
        )}
      </div>

      {/* Session Right-Click Context Menu */}
      {ctxMenu && (
        <div
          style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-50 w-[208px] rounded-[6px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 text-xs shadow-2xl"
        >
          <button
            type="button"
            onClick={() => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              dispatch({
                type: "selectSession",
                payload: { platform: s.platform, sessionKey: s.sessionKey },
              });
              void handleResumeFromContextMenu(s, true);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--emerald-fg)] hover:bg-[var(--emerald-dim)]"
          >
            <Terminal className="size-3.5 shrink-0" />
            <span className="truncate">{t("terminal.resumeEmbedded")}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              void handleResumeFromContextMenu(s, false);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <ExternalLink className="size-3.5 shrink-0 text-[var(--cyan-fg)]" />
            <span className="truncate">{t("terminal.resumeExternal")}</span>
          </button>

          <div className="my-1 border-t border-[var(--line-subtle)]" />

          <button
            type="button"
            onClick={() => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              setRenameDraft(
                s.aliasTitle ||
                  (!isUuidLikeTitle(s.displayTitle) ? s.displayTitle : "")
              );
              setRenamingKey(makeCompositeKey(s));
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <Pencil className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("session.setAlias")}</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              const isNow = await api.toggleFlag(
                s.platform,
                s.sessionKey,
                "favorite"
              );
              dispatch({
                type: "updateSession",
                payload: {
                  sessionKey: s.sessionKey,
                  updates: { favorite: isNow },
                },
              });
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <Star
              className={cn(
                "size-3.5 shrink-0",
                ctxMenu.session.favorite
                  ? "fill-current text-[var(--forge-fg)]"
                  : "text-[var(--text-mid)]"
              )}
            />
            <span className="truncate">
              {ctxMenu.session.favorite
                ? t("session.unfavorite")
                : t("session.favorite")}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              setSelectionMode(true);
              setSelectedKeys(new Set([makeCompositeKey(s)]));
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <CheckSquare className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("session.selectMode")}</span>
          </button>

          <div className="my-1 border-t border-[var(--line-subtle)]" />

          {ctxMenu.session.cwd && (
            <button
              type="button"
              onClick={() => {
                const cwd = ctxMenu.session.cwd;
                setCtxMenu(null);
                void navigator.clipboard.writeText(cwd);
              }}
              className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
            >
              <Copy className="size-3.5 shrink-0" />
              <span className="truncate">{t("hud.ctxCopyCwd")}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              const sid = ctxMenu.session.sessionId;
              setCtxMenu(null);
              void navigator.clipboard.writeText(sid);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
          >
            <Hash className="size-3.5 shrink-0" />
            <span className="truncate">{t("hud.ctxCopySessionId")}</span>
          </button>

          <div className="my-1 border-t border-[var(--line-subtle)]" />

          <button
            type="button"
            onClick={() => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              void handleToggleArchive(s);
            }}
            className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[var(--crimson-fg)] hover:bg-[var(--crimson-dim)]"
          >
            {showArchived ? (
              <ArchiveRestore className="size-3.5 shrink-0" />
            ) : (
              <Archive className="size-3.5 shrink-0" />
            )}
            <span className="truncate">
              {showArchived ? t("session.unarchive") : t("session.archive")}
            </span>
          </button>
        </div>
      )}

      <ConfirmDialog {...dialogProps} />

      {/* Raw JSONL Import Probe Dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open && !committingImport) setImportPreview(null);
        }}
        open={importPreview !== null}
      >
        <DialogContent className="max-w-[560px] border-[var(--cyan-line)] bg-[var(--bg-panel)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base">
              <FileJson className="size-4 text-[var(--cyan-fg)]" />
              <span>{t("session.importTitle")}</span>
            </DialogTitle>
          </DialogHeader>
          {importPreview && (
            <DialogBody className="space-y-3 text-xs">
              {currentPlatform === "all" && (
                <div className="flex items-center justify-between rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-3 py-2">
                  <span className="text-[var(--text-mid)]">
                    {t("hud.importTargetPlatform")}
                  </span>
                  <select
                    className="hud-mono rounded border border-[var(--line-strong)] bg-[var(--bg-void)] px-2 py-1 text-xs"
                    onChange={(e) => setImportPlatform(e.target.value)}
                    value={importPlatform}
                  >
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex CLI</option>
                    <option value="pi">Pi</option>
                  </select>
                </div>
              )}
              <div className="rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] p-3">
                <p className="font-semibold text-[var(--text-hi)]">
                  {importPreview.title || "Untitled Session"}
                </p>
                {importPreview.preview && (
                  <p className="mt-1 line-clamp-2 text-[var(--text-mid)]">
                    {importPreview.preview}
                  </p>
                )}
              </div>
              <div className="hud-mono space-y-1.5 rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-code)] p-3 text-[11px]">
                <div>
                  <span className="text-[var(--text-low)]">ID: </span>
                  <span>{importPreview.sessionId}</span>
                </div>
                <div>
                  <span className="text-[var(--text-low)]">CWD: </span>
                  <span className="break-all">{importPreview.cwd || "—"}</span>
                </div>
                <div>
                  <span className="text-[var(--text-low)]">TARGET: </span>
                  <span className="break-all text-[var(--cyan-fg)]">
                    {importPreview.targetPath}
                  </span>
                </div>
              </div>
              {importPreview.conflict && (
                <div className="flex items-start gap-2 rounded-[5px] border border-[var(--forge-line)] bg-[var(--forge-dim)] p-2.5 text-[var(--forge-fg)]">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {importPreview.conflict === "same"
                      ? t("session.importConflictSame")
                      : t("session.importConflictDifferent")}
                  </span>
                </div>
              )}
              {importError && (
                <div className="rounded-[5px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] p-2.5 text-[var(--crimson-fg)]">
                  {importError}
                </div>
              )}
            </DialogBody>
          )}
          <DialogFooter className="flex justify-end gap-2">
            <button
              type="button"
              disabled={committingImport}
              onClick={() => setImportPreview(null)}
              className="hud-btn"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              disabled={committingImport}
              onClick={() => void handleCommitImport()}
              className="hud-btn hud-btn-forge"
            >
              <Upload className="size-3" />
              <span>
                {committingImport
                  ? t("session.importing")
                  : t("session.importConfirm")}
              </span>
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function HudSessionCard({
  session,
  isSelected,
  selectedSessionKey,
  showArchived,
  selectionMode,
  isMultiSelected,
  isRenaming,
  renameDraft,
  onClick,
  onContextMenu,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onOpenSubagent,
  onToggleFavorite,
  onToggleArchive,
  justNowLabel,
  hoursAgoLabel,
  daysAgoLabel,
  untitledLabel,
  readOnlyLabel,
  subagentsCountLabel,
  autoExpandSubagents,
}: {
  session: Session;
  isSelected: boolean;
  selectedSessionKey: string | null;
  showArchived: boolean;
  selectionMode: boolean;
  isMultiSelected: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onChangeRename: (val: string) => void;
  onCommitRename: (val: string) => void;
  onCancelRename: () => void;
  onOpenSubagent: (sub: Session) => void;
  onToggleFavorite: (session: Session, e: React.MouseEvent) => void;
  onToggleArchive: (session: Session, e: React.MouseEvent) => void;
  justNowLabel: string;
  hoursAgoLabel: string;
  daysAgoLabel: string;
  untitledLabel: string;
  readOnlyLabel: string;
  subagentsCountLabel: string;
  autoExpandSubagents: boolean;
}) {
  const [copiedCwd, setCopiedCwd] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(autoExpandSubagents);
  const subagentCount = countSubagents(session);
  const highlight = selectionMode ? isMultiSelected : isSelected;
  const relTime = formatRelativeTime(
    session.updatedAt,
    justNowLabel,
    hoursAgoLabel,
    daysAgoLabel
  );
  const platLabel =
    PLATFORM_LABELS[session.platform] ?? session.platform.toUpperCase();

  useEffect(() => {
    if (autoExpandSubagents) setAgentsExpanded(true);
  }, [autoExpandSubagents]);

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={SESSION_CARD_RENDER_STYLE}
      className={cn(
        "group relative mb-1.5 cursor-pointer rounded-[5px] border py-2 pr-2.5 pl-3 transition-colors select-none",
        highlight
          ? "reticle reticle-cyan border-[var(--cyan-line)] bg-[linear-gradient(90deg,var(--cyan-dim),var(--bg-panel)_65%)]"
          : "border-[var(--line-hair)] bg-[var(--bg-panel)] hover:border-[var(--line-strong)] hover:bg-[var(--bg-elevated)]"
      )}
    >
      {/* Left 2.5px Signal Spine */}
      <span
        className={cn(
          "absolute top-1.5 bottom-1.5 left-0 w-[2.5px] rounded-r",
          highlight
            ? "bg-[var(--cyan)]"
            : "bg-transparent group-hover:bg-[var(--line-strong)]"
        )}
      />

      {/* Top Meta Row */}
      <div className="mb-1 flex items-center gap-1.5">
        {selectionMode && (
          <span className="hud-mono text-[10px] font-bold text-[var(--cyan-fg)]">
            [{isMultiSelected ? "✓" : " "}]
          </span>
        )}
        <span
          className={cn(
            "hud-mono rounded-[2px] border px-1.5 py-[0.5px] text-[9px] font-bold tracking-wider uppercase",
            getPlatformBadgeStyle(session.platform)
          )}
        >
          {platLabel}
        </span>

        {!session.editable && (
          <span className="hud-mono rounded-[2px] border border-[var(--line-hair)] px-1 text-[8.5px] text-[var(--text-low)]">
            {readOnlyLabel}
          </span>
        )}

        {!session.aliasTitle && isUuidLikeTitle(session.displayTitle) && (
          <span className="hud-mono text-[9.5px] text-[var(--text-low)]">
            #{session.sessionId.slice(0, 6)}
          </span>
        )}

        <span className="hud-mono ml-auto text-[10px] text-[var(--text-low)]">
          {relTime}
        </span>

        {!selectionMode && (
          <div
            className={cn(
              "flex items-center gap-0.5 transition-opacity",
              session.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
          >
            <button
              type="button"
              onClick={(e) => onToggleFavorite(session, e)}
              className={cn(
                "rounded p-0.5",
                session.favorite
                  ? "text-[var(--forge-fg)]"
                  : "text-[var(--text-low)] hover:text-[var(--forge-fg)]"
              )}
            >
              <Star className={cn("size-3", session.favorite && "fill-current")} />
            </button>
            <button
              type="button"
              onClick={(e) => onToggleArchive(session, e)}
              className="rounded p-0.5 text-[var(--text-low)] opacity-0 group-hover:opacity-100 hover:text-[var(--crimson-fg)]"
            >
              {showArchived ? (
                <ArchiveRestore className="size-3" />
              ) : (
                <Archive className="size-3" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Session Title (Inline Rename OR Human Preview) */}
      {isRenaming ? (
        <input
          autoFocus
          className="h-6 w-full rounded-[3px] border border-[var(--cyan)] bg-[var(--bg-void)] px-1.5 text-xs font-semibold text-[var(--text-hi)] outline-none"
          onBlur={() => onCommitRename(renameDraft)}
          onChange={(e) => onChangeRename(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onCommitRename(renameDraft);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              onCancelRename();
            }
          }}
          value={renameDraft}
        />
      ) : (
        <div className="truncate text-[12.5px] leading-snug font-semibold text-[var(--text-hi)]">
          {session.aliasTitle ||
            (!isUuidLikeTitle(session.displayTitle)
              ? session.displayTitle
              : cleanHumanPreview(session.preview) ||
                session.displayTitle ||
                untitledLabel)}
        </div>
      )}

      {/* Preview / CWD */}
      {session.cwd ? (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-low)]">
          <span className="hud-mono min-w-0 flex-1 truncate">{session.cwd}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard.writeText(session.cwd);
              setCopiedCwd(true);
              setTimeout(() => setCopiedCwd(false), 1200);
            }}
            className="opacity-0 group-hover:opacity-100 hover:text-[var(--text-hi)]"
            title="复制路径"
          >
            {copiedCwd ? (
              <Check className="size-2.5 text-[var(--emerald-fg)]" />
            ) : (
              <Copy className="size-2.5" />
            )}
          </button>
        </div>
      ) : session.preview ? (
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-low)]">
          {session.preview}
        </p>
      ) : null}

      {/* Content Search Hits */}
      {session.contentMatches && session.contentMatches.length > 0 && (
        <div className="mt-1.5 space-y-1 border-t border-dashed border-[var(--line-hair)] pt-1.5">
          {session.contentMatches.slice(0, 2).map((m, i) => (
            <div
              key={i}
              className="hud-mono truncate rounded-[2px] bg-[var(--forge-dim)] px-1.5 py-0.5 text-[10px] text-[var(--forge-fg)]"
            >
              #{m.matchIndex + 1}: {m.snippet}
            </div>
          ))}
        </div>
      )}

      {/* Subagent Tree */}
      {subagentCount > 0 && (
        <div
          className="mt-1.5 border-t border-dashed border-[var(--line-hair)] pt-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setAgentsExpanded((v) => !v)}
            className="hud-mono flex w-full items-center justify-between text-[10px] text-[var(--cyan-fg)] hover:underline"
          >
            <span>{subagentsCountLabel}</span>
            {agentsExpanded ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
          </button>
          {agentsExpanded && (
            <div className="mt-1 space-y-0.5 pl-1">
              {(session.agentGroup?.children ?? []).map((child) => {
                const subActive = selectedSessionKey === child.sessionKey;
                return (
                  <button
                    key={child.sessionKey}
                    type="button"
                    onClick={() => onOpenSubagent(child)}
                    className={cn(
                      "hud-mono flex w-full items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 text-left text-[10px]",
                      subActive
                        ? "bg-[var(--cyan-dim)] font-semibold text-[var(--cyan-fg)]"
                        : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                    )}
                  >
                    <span className="text-[var(--cyan-fg)]">↳</span>
                    <span className="flex-1 truncate">
                      {child.agentGroup?.nickname ||
                        child.aliasTitle ||
                        child.displayTitle ||
                        child.sessionId}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
