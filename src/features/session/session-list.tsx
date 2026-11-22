import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileJson,
  Folder,
  FolderOpen,
  Hash,
  LayoutGrid,
  Pencil,
  Pin,
  RefreshCw,
  Search,
  Settings,
  Star,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import {
  formatWorkspaceShortName,
  normalizeCleanPath,
} from "@/components/layout/shell-layout";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FloatingMenu } from "@/components/ui/floating-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
import { useDesktop } from "@/features/desktop/provider";
import type { RawJsonlImportPreview, Session } from "@/features/desktop/types";
import {
  readCachedDetail,
  writeCachedDetail,
} from "@/features/session/detail-cache";
import { useTerminal } from "@/features/terminal/terminal-context";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 60;
let handledLocateNonce = 0;
const JSONL_TRANSFER_PLATFORMS = ["claude", "codex", "pi"] as const;
const DEFAULT_FALLBACK_PLATFORMS = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "devin",
];

export const PLATFORM_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  devin: "Devin",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  gemini: "Gemini",
  pi: "Pi",
  grok: "Grok",
  zcode: "ZCode",
  workbuddy: "WorkBuddy",
  cindy: "Cindy",
  "cindy-global": "Cindy Global",
  zed: "Zed",
  dsh: "DSH",
  "qoder-cn": "Qoder",
  qwen: "Qwen",
  cline: "Cline",
  codebuddy: "CodeBuddy",
  antigravity: "Antigravity",
};

const CLAUDE_PATH =
  "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998zM6 10.949h1.488V8.102H6zm10.51 0H18V8.102h-1.49z";

const PLATFORM_ACCENT_COLOR: Record<string, string> = {
  claude: "#d97757",
  pi: "#6b72d6",
  devin: "#0ea5e9",
  codex: "#10b981",
  opencode: "#6366f1",
  cursor: "#2563eb",
  kiro: "#8b5cf6",
  "kiro-ide": "#8b5cf6",
  cindy: "#ec4899",
  "cindy-global": "#ec4899",
  gemini: "#3b82f6",
  qwen: "#7c3aed",
  zed: "#ca8a04",
};

export function PlatformMark({
  platform,
  size = 13,
  className,
}: {
  platform: string;
  size?: number;
  className?: string;
}) {
  const color = PLATFORM_ACCENT_COLOR[platform] ?? "var(--text-mid)";

  if (platform === "claude") {
    return (
      <svg
        aria-hidden="true"
        className={cn("shrink-0", className)}
        height={size}
        style={{ color }}
        viewBox="0 0 24 24"
        width={size}
      >
        <path
          clipRule="evenodd"
          d={CLAUDE_PATH}
          fill="currentColor"
          fillRule="evenodd"
        />
      </svg>
    );
  }

  if (platform === "pi") {
    return (
      <svg
        aria-hidden="true"
        className={cn("shrink-0", className)}
        height={size}
        style={{ color }}
        viewBox="0 0 24 24"
        width={size}
      >
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.4}
        >
          <path d="M3.6 6.6h16.8" />
          <path d="M8.4 6.6v11.8" />
          <path d="M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2" />
        </g>
      </svg>
    );
  }

  if (platform === "devin") {
    return (
      <svg
        aria-hidden="true"
        className={cn("shrink-0", className)}
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.2}
        style={{ color }}
        viewBox="0 0 24 24"
        width={size}
      >
        <path d="M12 2.5L4 7.2v9.6l8 4.7 8-4.7V7.2L12 2.5z" />
        <circle cx="12" cy="12" fill="currentColor" r="2.3" />
      </svg>
    );
  }

  if (platform === "codex") {
    return (
      <svg
        aria-hidden="true"
        className={cn("shrink-0", className)}
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.3}
        style={{ color }}
        viewBox="0 0 24 24"
        width={size}
      >
        <polyline points="5 8 10 12 5 16" />
        <line x1="12" x2="19" y1="16" y2="16" />
      </svg>
    );
  }

  if (platform === "opencode") {
    return (
      <svg
        aria-hidden="true"
        className={cn("shrink-0", className)}
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.2}
        style={{ color }}
        viewBox="0 0 24 24"
        width={size}
      >
        <rect height="15" rx="3.5" width="15" x="4.5" y="4.5" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    );
  }

  const initial = (PLATFORM_LABELS[platform] ?? platform)
    .slice(0, 1)
    .toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "hud-mono inline-grid shrink-0 place-items-center rounded-[3px] text-[9.5px] font-bold leading-none",
        className
      )}
      style={{
        width: size,
        height: size,
        color,
        backgroundColor: "var(--bg-elevated)",
      }}
    >
      {initial}
    </span>
  );
}

export function getPlatformBadgeStyle(platform: string): string {
  switch (platform) {
    case "claude":
      return "border-[var(--forge-line)] bg-[var(--forge-dim)] text-[var(--forge-fg)]";
    case "codex":
      return "border-[var(--emerald-line)] bg-[var(--emerald-dim)] text-[var(--emerald-fg)]";
    case "opencode":
    case "kiro":
    case "kiro-ide":
      return "border-[var(--violet-line)] bg-[var(--violet-dim)] text-[var(--violet-fg)]";
    case "cursor":
    case "devin":
      return "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]";
    default:
      return "border-[var(--line-hair)] bg-[var(--bg-elevated)] text-[var(--text-mid)]";
  }
}

function makeCompositeKey(session: Pick<Session, "platform" | "sessionKey">) {
  return `${session.platform}::${session.sessionKey}`;
}

type PlatformCursor = { loaded: number; total: number };

function allModePageSize(platformCount: number): number {
  return Math.max(20, Math.ceil(PAGE_SIZE / Math.max(1, platformCount)) + 10);
}

function sortByUpdatedDesc(list: Session[]): Session[] {
  return [...list].sort(
    (a, b) =>
      parseSessionTimestampMs(b.updatedAt) - parseSessionTimestampMs(a.updatedAt)
  );
}

function parseSessionTimestampMs(value?: string | number | null): number {
  if (!value) return 0;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    if (num > 10 ** 17) return num / 1_000_000;
    if (num > 10 ** 15) return num / 1000;
    if (num > 10 ** 12) return num;
    return num * 1000;
  }
  const ts = new Date(String(value)).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function formatCompactTime(
  updatedAt: string | undefined,
  isEn: boolean
): string {
  const ts = parseSessionTimestampMs(updatedAt);
  if (!ts) return "";
  const diffMin = Math.floor((Date.now() - ts) / 60_000);
  if (diffMin < 5) return isEn ? "now" : "刚刚";
  if (diffMin < 60) return isEn ? `${diffMin}m` : `${diffMin}分`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return isEn ? `${diffHour}h` : `${diffHour}时`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return isEn ? `${diffDay}d` : `${diffDay}天`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  return UUID_LIKE_RE.test(title.trim());
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

export function getSessionReadableTitle(
  session: Pick<Session, "aliasTitle" | "displayTitle" | "preview" | "sessionId">,
  untitledLabel: string
): string {
  if (session.aliasTitle?.trim()) return session.aliasTitle.trim();
  const cleanedDisplay = session.displayTitle
    ? normalizeCleanPath(session.displayTitle)
    : "";
  const isRawPathTitle =
    /^[A-Za-z]:\//.test(cleanedDisplay) || cleanedDisplay.startsWith("/");
  if (cleanedDisplay && !isUuidLikeTitle(cleanedDisplay) && !isRawPathTitle) {
    return cleanedDisplay;
  }
  const preview = cleanHumanPreview(session.preview);
  if (preview) return preview.slice(0, 64);
  return cleanedDisplay || session.sessionId.slice(0, 8) || untitledLabel;
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
  const isEn = snapshot?.settings.locale === "en";

  const [searchInput, setSearchInput] = useState(searchQuery);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [allCursors, setAllCursors] = useState<Record<string, PlatformCursor>>(
    {}
  );
  const [loading, setLoading] = useState(false);
  const [searchIndex, setSearchIndex] = useState({
    supported: false,
    running: false,
    indexed: 0,
    total: 0,
  });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [batchOperating, setBatchOperating] = useState(false);

  // Rin-style collapsible sections & locate flash
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set()
  );
  const [locatedCompositeKey, setLocatedCompositeKey] = useState<string | null>(
    null
  );

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

  const { confirm, dialogProps } = useConfirmDialog();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const requestIdRef = useRef(0);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const latestSelectionRef = useRef({
    key: selectedSessionKey,
    platform: selectedSessionPlatform,
  });

  useEffect(() => {
    latestSelectionRef.current = {
      key: selectedSessionKey,
      platform: selectedSessionPlatform,
    };
  }, [selectedSessionKey, selectedSessionPlatform]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("[data-context-menu]")) return;
      setCtxMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // Active platforms derived from dashboard summary
  const { activePlatformList, idlePlatforms, totalActiveCount } =
    useMemo(() => {
      const visible = new Set(
        snapshot?.settings.visiblePlatforms ?? DEFAULT_FALLBACK_PLATFORMS
      );
      const dashPlatforms = state.dashboard?.platforms ?? [];
      if (dashPlatforms.length === 0) {
        return {
          activePlatformList: DEFAULT_FALLBACK_PLATFORMS.filter((p) =>
            visible.has(p)
          ).map((platform) => ({ platform, count: 0 })),
          idlePlatforms: [] as string[],
          totalActiveCount: 0,
        };
      }
      const order = snapshot?.settings.navigationItems ?? [];
      const rank = (platform: string) => {
        const idx = order.indexOf(platform);
        return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
      };
      const byNavigationOrder = <T extends { platform: string }>(list: T[]) =>
        [...list].sort((a, b) => rank(a.platform) - rank(b.platform));
      const withData = byNavigationOrder(
        dashPlatforms.filter((p) => visible.has(p.platform) && p.count > 0)
      );
      const sum = withData.reduce((acc, p) => acc + p.count, 0);
      const listed =
        withData.length > 0
          ? withData
          : byNavigationOrder(
              dashPlatforms.filter((p) => visible.has(p.platform))
            ).slice(0, 5);
      const listedKeys = new Set(listed.map((p) => p.platform));
      return {
        activePlatformList: listed,
        idlePlatforms: byNavigationOrder(
          dashPlatforms.filter(
            (p) =>
              visible.has(p.platform) &&
              p.count === 0 &&
              !listedKeys.has(p.platform)
          )
        ).map((p) => p.platform),
        totalActiveCount: sum,
      };
    }, [
      snapshot?.settings.navigationItems,
      snapshot?.settings.visiblePlatforms,
      state.dashboard?.platforms,
    ]);

  const activePlatformsKey = activePlatformList.map((p) => p.platform).join("|");
  const platformsToQueryInAll = useMemo(
    () =>
      activePlatformsKey
        ? activePlatformsKey.split("|")
        : DEFAULT_FALLBACK_PLATFORMS,
    [activePlatformsKey]
  );

  const fetchSessionFeed = useCallback(
    async (offset = 0) => {
      if (currentPlatform !== "all") {
        const page = await api.getSessions(
          currentPlatform,
          searchQuery,
          PAGE_SIZE,
          offset,
          showArchived
        );
        return { ...page, cursors: {} as Record<string, PlatformCursor> };
      }

      const perPlatformLimit = allModePageSize(platformsToQueryInAll.length);
      const results = await Promise.allSettled(
        platformsToQueryInAll.map((plat) =>
          api.getSessions(plat, searchQuery, perPlatformLimit, 0, showArchived)
        )
      );

      const merged: Session[] = [];
      const cursors: Record<string, PlatformCursor> = {};
      let total = 0;
      let anyRunning = false;
      let indexedSum = 0;
      let totalIdxSum = 0;

      results.forEach((r, idx) => {
        if (r.status !== "fulfilled") return;
        merged.push(...r.value.items);
        total += r.value.total;
        cursors[platformsToQueryInAll[idx]] = {
          loaded: r.value.items.length,
          total: r.value.total,
        };
        if (r.value.searchIndex?.running) anyRunning = true;
        indexedSum += r.value.searchIndex?.indexed ?? 0;
        totalIdxSum += r.value.searchIndex?.total ?? 0;
      });

      return {
        items: sortByUpdatedDesc(merged),
        cursors,
        total,
        searchIndex: {
          supported: totalIdxSum > 0,
          running: anyRunning,
          indexed: indexedSum,
          total: totalIdxSum,
        },
      };
    },
    [currentPlatform, platformsToQueryInAll, searchQuery, showArchived]
  );

  // Load session list
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    const requestId = ++requestIdRef.current;

    setLoading(true);
    fetchSessionFeed(0)
      .then((page) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        dispatch({ type: "setSessions", payload: page.items });
        setTotalCount(page.total);
        setAllCursors(page.cursors);
        if (page.searchIndex) setSearchIndex(page.searchIndex);

        if (page.items.length > 0 && !selectedSessionKey) {
          const first = page.items[0];
          dispatch({
            type: "selectSession",
            payload: { platform: first.platform, sessionKey: first.sessionKey },
          });
        }
      })
      .catch(() => {
        if (cancelled || requestId !== requestIdRef.current) return;
        dispatch({ type: "setSessions", payload: [] });
        setTotalCount(0);
        setAllCursors({});
      })
      .finally(() => {
        if (!(cancelled || requestId !== requestIdRef.current)) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, fetchSessionFeed, Boolean(snapshot)]);

  useEffect(() => {
    setSelectionMode(false);
    setSelectedKeys(new Set());
    setLastClickedIndex(null);
  }, [currentPlatform, showArchived, searchQuery]);

  // Poll search index progress if building
  useEffect(() => {
    if (!(searchQuery.trim() && searchIndex.running)) return;
    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      fetchSessionFeed(0)
        .then((page) => {
          if (requestId !== requestIdRef.current) return;
          dispatch({ type: "setSessions", payload: page.items });
          setTotalCount(page.total);
          setAllCursors(page.cursors);
          if (page.searchIndex) setSearchIndex(page.searchIndex);
        })
        .catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [dispatch, fetchSessionFeed, searchIndex.running, searchQuery]);

  // Load session detail whenever selected session changes
  useEffect(() => {
    if (!selectedSessionKey) {
      dispatch({ type: "setSessionDetail", payload: null });
      dispatch({ type: "setEditLog", payload: [] });
      return;
    }
    const targetPlatform =
      selectedSessionPlatform ||
      (currentPlatform === "all" ? "claude" : currentPlatform);
    const cacheKey = `${targetPlatform}::${selectedSessionKey}`;
    const cached = readCachedDetail(cacheKey);
    if (cached) {
      dispatch({ type: "setSessionDetail", payload: cached.detail });
      dispatch({ type: "setEditLog", payload: cached.logs });
    }
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        Promise.all([
          api.getSessionDetail(targetPlatform, selectedSessionKey),
          api.getEditLog(targetPlatform, selectedSessionKey),
        ])
          .then(([detail, logs]) => {
            if (cancelled) return;
            dispatch({ type: "setSessionDetail", payload: detail });
            dispatch({ type: "setEditLog", payload: logs });
          })
          .catch(() => {
            if (cancelled) return;
            if (!cached) {
              dispatch({ type: "setSessionDetail", payload: null });
              dispatch({ type: "setEditLog", payload: [] });
            }
            dispatch({
              type: "setSessionStatus",
              payload: { tone: "error", message: t("hud.sessionLoadFailed") },
            });
          });
      },
      cached ? 200 : 120
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentPlatform, dispatch, selectedSessionKey, selectedSessionPlatform, t]);

  useEffect(() => {
    const detail = state.sessionDetail;
    if (!detail || detail.sessionKey !== selectedSessionKey) return;
    writeCachedDetail(
      `${detail.platform}::${detail.sessionKey}`,
      detail,
      state.editLog
    );
  }, [selectedSessionKey, state.editLog, state.sessionDetail]);

  // Handle "Locate Active Session in Sidebar" (Rin F-182)
  useEffect(() => {
    if (state.locateRequestNonce === handledLocateNonce || !selectedSessionKey) {
      return;
    }
    const plat = selectedSessionPlatform || currentPlatform;
    const compKey = `${plat}::${selectedSessionKey}`;
    const matched = sessions.find(
      (s) => s.sessionKey === selectedSessionKey && s.platform === plat
    );
    if (!matched && loading) return;
    handledLocateNonce = state.locateRequestNonce;
    if (!matched) return;
    setPinnedCollapsed(false);
    setProjectsCollapsed(false);
    if (matched.cwd) {
      const folderKey = formatWorkspaceShortName(matched.cwd);
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        next.delete(folderKey);
        return next;
      });
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = listScrollRef.current?.querySelector<HTMLElement>(
          `[data-session-row-key="${CSS.escape(compKey)}"]`
        );
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          setLocatedCompositeKey(compKey);
          setTimeout(() => setLocatedCompositeKey(null), 1300);
        }
      })
    );
  }, [
    currentPlatform,
    loading,
    selectedSessionKey,
    selectedSessionPlatform,
    sessions,
    state.locateRequestNonce,
  ]);

  const debouncedSetSearch = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        dispatch({ type: "setSearchQuery", payload: value });
      }, 220);
    },
    [dispatch]
  );

  // Filtered display list
  const workspaceFilterActive = Boolean(
    state.workspaceFilter && state.workspaceFilter !== "all"
  );
  const clearWorkspaceFilter = () =>
    dispatch({ type: "setWorkspaceFilter", payload: "all" });
  const displaySessions = useMemo(() => {
    if (!workspaceFilterActive) return sessions;
    const target = normalizeCleanPath(state.workspaceFilter);
    return sessions.filter(
      (s) => Boolean(s.cwd?.trim()) && normalizeCleanPath(s.cwd) === target
    );
  }, [sessions, state.workspaceFilter, workspaceFilterActive]);

  // Rin-style Pinned + Project Folder Grouping
  const { pinnedSessions, projectGroups } = useMemo(() => {
    const pinned = displaySessions.filter((s) => s.favorite);
    const unpinned = displaySessions.filter((s) => !s.favorite);

    const groupMap = new Map<
      string,
      { label: string; fullCwd: string; items: Session[]; latestTs: number }
    >();
    const ungroupedKey = "__ungrouped__";

    for (const s of unpinned) {
      const rawCwd = s.cwd?.trim() ?? "";
      const folderKey = rawCwd ? formatWorkspaceShortName(rawCwd) : ungroupedKey;
      const existing = groupMap.get(folderKey);
      const ts = parseSessionTimestampMs(s.updatedAt);
      if (existing) {
        existing.items.push(s);
        if (ts > existing.latestTs) existing.latestTs = ts;
      } else {
        groupMap.set(folderKey, {
          label: rawCwd ? folderKey : t("hud.ungroupedSessions"),
          fullCwd: rawCwd,
          items: [s],
          latestTs: ts,
        });
      }
    }

    const groups = Array.from(groupMap.entries())
      .map(([key, val]) => ({ key, ...val }))
      .sort((a, b) => {
        if (a.key === ungroupedKey) return 1;
        if (b.key === ungroupedKey) return -1;
        return b.latestTs - a.latestTs;
      });

    return { pinnedSessions: pinned, projectGroups: groups };
  }, [displaySessions, t]);

  const visibleOrder = useMemo(() => {
    if (searchQuery.trim() || showArchived) return displaySessions;
    const list: Session[] = [];
    if (!pinnedCollapsed) list.push(...pinnedSessions);
    if (!projectsCollapsed) {
      for (const group of projectGroups) {
        if (!collapsedFolders.has(group.key)) list.push(...group.items);
      }
    }
    return list;
  }, [
    collapsedFolders,
    displaySessions,
    pinnedCollapsed,
    pinnedSessions,
    projectGroups,
    projectsCollapsed,
    searchQuery,
    showArchived,
  ]);
  const visibleIndex = useMemo(
    () => new Map(visibleOrder.map((s, idx) => [makeCompositeKey(s), idx])),
    [visibleOrder]
  );

  const handleRefresh = async ({
    reloadDetail = true,
  }: { reloadDetail?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    setRefreshDone(false);
    try {
      const [page, dash] = await Promise.all([
        fetchSessionFeed(0),
        api.getDashboard().catch(() => null),
      ]);
      if (requestId === requestIdRef.current) {
        dispatch({ type: "setSessions", payload: page.items });
        setTotalCount(page.total);
        setAllCursors(page.cursors);
      }
      if (dash) dispatch({ type: "setDashboard", payload: dash });

      const { key: targetKey, platform: targetPlatform } =
        latestSelectionRef.current;
      if (reloadDetail && targetKey) {
        const targetPlat =
          targetPlatform ||
          (currentPlatform === "all" ? "claude" : currentPlatform);
        const [detail, logs] = await Promise.all([
          api.getSessionDetail(targetPlat, targetKey),
          api.getEditLog(targetPlat, targetKey),
        ]);
        if (latestSelectionRef.current.key === targetKey) {
          dispatch({ type: "setSessionDetail", payload: detail });
          dispatch({ type: "setEditLog", payload: logs });
        }
      }
      setRefreshDone(true);
      setTimeout(() => setRefreshDone(false), 1200);
    } catch {
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.refreshFailed") },
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleLoadMore = async () => {
    if (loadingMore) return;
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    try {
      if (currentPlatform === "all") {
        const pending = Object.entries(allCursors).filter(
          ([, cursor]) => cursor.loaded < cursor.total
        );
        if (pending.length === 0) return;
        const limit = allModePageSize(platformsToQueryInAll.length);
        const results = await Promise.allSettled(
          pending.map(([plat, cursor]) =>
            api.getSessions(plat, searchQuery, limit, cursor.loaded, showArchived)
          )
        );
        if (requestId !== requestIdRef.current) return;
        const existing = new Set(sessions.map(makeCompositeKey));
        const additions: Session[] = [];
        const nextCursors = { ...allCursors };
        results.forEach((r, idx) => {
          if (r.status !== "fulfilled") return;
          const [plat, cursor] = pending[idx];
          const fetched = r.value.items.length;
          nextCursors[plat] = {
            loaded: fetched > 0 ? cursor.loaded + fetched : r.value.total,
            total: r.value.total,
          };
          for (const item of r.value.items) {
            if (!existing.has(makeCompositeKey(item))) additions.push(item);
          }
        });
        dispatch({
          type: "setSessions",
          payload: sortByUpdatedDesc([...sessions, ...additions]),
        });
        setAllCursors(nextCursors);
        setTotalCount(
          Object.values(nextCursors).reduce((sum, c) => sum + c.total, 0)
        );
        return;
      }

      const page = await api.getSessions(
        currentPlatform,
        searchQuery,
        PAGE_SIZE,
        sessions.length,
        showArchived
      );
      if (requestId !== requestIdRef.current) return;
      const existing = new Set(sessions.map((s) => s.sessionKey));
      const merged = [
        ...sessions,
        ...page.items.filter((s) => !existing.has(s.sessionKey)),
      ];
      dispatch({ type: "setSessions", payload: merged });
      setTotalCount(page.total);
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  };

  const handleChooseImport = async () => {
    const targetPlat = JSONL_TRANSFER_PLATFORMS.includes(
      currentPlatform as (typeof JSONL_TRANSFER_PLATFORMS)[number]
    )
      ? currentPlatform
      : importPlatform;
    setImportPlatform(targetPlat);
    setImportError(null);
    setProbingImport(true);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Session JSONL", extensions: ["jsonl"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const preview = await api.probeJsonlImport(targetPlat, selected);
      setImportPreview(preview);
    } catch (err) {
      dispatch({
        type: "setSessionStatus",
        payload: {
          tone: "error",
          message: err instanceof Error ? err.message : String(err),
        },
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
        importPlatform,
        importPreview.sourcePath
      );
      setImportPreview(null);
      if (showArchived) dispatch({ type: "setShowArchived", payload: false });
      await handleRefresh();
      dispatch({
        type: "selectSession",
        payload: { platform: importPlatform, sessionKey: result.sessionKey },
      });
      const msgKey = result.alreadyExists
        ? "session.importExists"
        : result.renamed
          ? "session.importedRenamed"
          : "session.imported";
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t(msgKey) },
      });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommittingImport(false);
    }
  };

  const handleCardClick = (
    session: Session,
    index: number,
    e: React.MouseEvent
  ) => {
    if (!selectionMode) {
      dispatch({
        type: "selectSession",
        payload: { platform: session.platform, sessionKey: session.sessionKey },
      });
      return;
    }
    const key = makeCompositeKey(session);
    const next = new Set(selectedKeys);
    if (e.shiftKey && lastClickedIndex !== null) {
      const lo = Math.min(lastClickedIndex, index);
      const hi = Math.max(lastClickedIndex, index);
      for (let i = lo; i <= hi; i++) {
        const s = visibleOrder[i];
        if (s) next.add(makeCompositeKey(s));
      }
    } else if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelectedKeys(next);
    setLastClickedIndex(index);
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedKeys(new Set());
    setLastClickedIndex(null);
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
    if (!showArchived) {
      dispatch({
        type: "closeSessionTab",
        payload: { platform: session.platform, sessionKey: session.sessionKey },
      });
    }
    await handleRefresh({ reloadDetail: false });
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
            sessionTitle: getSessionReadableTitle(session, t("session.untitled")),
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

  const handleBatchAction = async (
    flag: "archived" | "favorite",
    set: boolean
  ) => {
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
    currentPlatform === "all"
      ? Object.values(allCursors).reduce(
          (sum, cursor) => sum + Math.max(0, cursor.total - cursor.loaded),
          0
        )
      : Math.max(0, totalCount - sessions.length);

  const renderSessionRow = (session: Session) => {
    const compKey = makeCompositeKey(session);
    const globalIdx = visibleIndex.get(compKey) ?? -1;
    return (
      <RinSessionRow
        autoExpandSubagents={searchQuery.trim().length > 0}
        isEn={isEn}
        isLocated={locatedCompositeKey === compKey}
        isMultiSelected={selectedKeys.has(compKey)}
        isRenaming={renamingKey === compKey}
        isSelected={
          selectedSessionKey === session.sessionKey &&
          (selectedSessionPlatform || session.platform) === session.platform
        }
        key={compKey}
        onCancelRename={() => setRenamingKey(null)}
        onChangeRename={setRenameDraft}
        onClick={(e) => handleCardClick(session, globalIdx, e)}
        onCommitRename={(val) => void handleSaveCardAlias(session, val)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
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
        renameDraft={renamingKey === compKey ? renameDraft : ""}
        rowDataKey={compKey}
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
  };

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--line-hair)] bg-[var(--bg-rack)] select-none",
        collapsed && "hidden"
      )}
    >
      {/* ==================== RIN-STYLE CLEAN SIDEBAR HEADER ==================== */}
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2 pb-1.5">
        {/* Search Row + Ghost Utility Icons */}
        <div className="flex items-center gap-1">
          <div className="flex h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-[6px] border border-[var(--line-hair)] bg-[var(--bg-void)] px-2 focus-within:border-[var(--line-strong)]">
            <Search className="size-3.5 shrink-0 text-[var(--text-low)]" />
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

          <button
            type="button"
            onClick={handleChooseImport}
            disabled={probingImport}
            className="grid size-6 shrink-0 place-items-center rounded-[5px] text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
            title={t("session.importJsonl")}
          >
            <Upload className={cn("size-3.5", probingImport && "animate-pulse")} />
          </button>
          <button
            type="button"
            onClick={() =>
              selectionMode ? exitSelectionMode() : setSelectionMode(true)
            }
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-[5px] transition-colors",
              selectionMode
                ? "bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                : "text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
            )}
            title={
              selectionMode ? t("session.exitSelect") : t("session.selectMode")
            }
          >
            <CheckSquare className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() =>
              dispatch({ type: "setShowArchived", payload: !showArchived })
            }
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-[5px] transition-colors",
              showArchived
                ? "bg-[var(--forge-dim)] text-[var(--forge-fg)]"
                : "text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
            )}
            title={
              showArchived ? t("session.sessionsView") : t("session.archiveView")
            }
          >
            <Archive className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-[5px] text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]",
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
        </div>

        {/* Engine / Platform Icon Filter Bar (Rin ENGINE_FILTERS style!) */}
        <PlatformSwitcher
          activePlatforms={activePlatformList}
          currentPlatform={currentPlatform}
          idlePlatforms={idlePlatforms}
          onManage={() => navigate("/settings")}
          onSelect={(platform) =>
            navigate(platform === "all" ? "/" : `/${platform}`)
          }
          t={t}
          totalCount={totalActiveCount}
        />

        {workspaceFilterActive && (
          <div
            className="flex h-[24px] min-w-0 items-center gap-1.5 rounded-[5px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] pr-1 pl-2 text-[11px] text-[var(--cyan-fg)]"
            title={state.workspaceFilter}
          >
            <Folder className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {formatWorkspaceShortName(state.workspaceFilter)}
            </span>
            <button
              type="button"
              aria-label={t("hud.clearWorkspaceFilter")}
              onClick={clearWorkspaceFilter}
              className="grid size-5 shrink-0 place-items-center rounded-[4px] hover:bg-[var(--bg-panel)]"
              title={t("hud.clearWorkspaceFilter")}
            >
              <X className="size-3" />
            </button>
          </div>
        )}
      </div>

      {/* Multi-Select Batch Action Strip */}
      {selectionMode && (
        <div className="flex shrink-0 flex-col gap-1.5 border-y border-[var(--cyan-line)] bg-[var(--cyan-dim)] px-2.5 py-2">
          <div className="hud-mono flex items-center gap-1.5 text-[10.5px]">
            <strong className="text-[var(--cyan-fg)]">
              {t("session.selectedCount", { count: selectedKeys.size })}
            </strong>
            <button
              type="button"
              onClick={() =>
                setSelectedKeys(new Set(displaySessions.map(makeCompositeKey)))
              }
              className="rounded px-1.5 py-0.5 text-[var(--text-mid)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-hi)]"
            >
              {t("session.selectAll")}
            </button>
            <button
              type="button"
              onClick={() => {
                const next = new Set<string>();
                for (const s of displaySessions) {
                  const k = makeCompositeKey(s);
                  if (!selectedKeys.has(k)) next.add(k);
                }
                setSelectedKeys(next);
              }}
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
              className="hud-btn text-[11px]"
            >
              <Star className="size-3" />
            </button>
          </div>
        </div>
      )}

      {/* Search Index Building Banner */}
      {searchQuery.trim() && searchIndex.supported && searchIndex.running && (
        <div className="hud-mono border-b border-[var(--forge-line)] bg-[var(--forge-dim)] px-2.5 py-1 text-[10px] text-[var(--forge-fg)]">
          {t("session.searchIndexing", {
            indexed: searchIndex.indexed,
            total: searchIndex.total,
          })}
        </div>
      )}

      {/* ==================== RIN-STYLE COMPACT TREE BODY ==================== */}
      <div
        ref={listScrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1"
      >
        {loading && displaySessions.length === 0 ? (
          <div className="space-y-1 px-1 pt-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-7 animate-pulse rounded-[6px] bg-[var(--bg-hover)]/70"
              />
            ))}
          </div>
        ) : displaySessions.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-[var(--text-low)]">
            <p>
              {workspaceFilterActive
                ? t("hud.workspaceFilterEmpty")
                : showArchived
                  ? t("session.noArchivedSessions")
                  : t("session.noSessions")}
            </p>
            {workspaceFilterActive && (
              <button
                type="button"
                onClick={clearWorkspaceFilter}
                className="hud-btn mt-2.5 text-[11px]"
              >
                <X className="size-3" />
                <span>{t("hud.clearWorkspaceFilter")}</span>
              </button>
            )}
          </div>
        ) : searchQuery.trim() || showArchived ? (
          /* Flat list during search or archive view */
          <div className="space-y-0.5">
            {displaySessions.map(renderSessionRow)}
          </div>
        ) : (
          /* Grouped view: ▾ 置顶 + ▾ 项目 → 📁 Folders */
          <div className="space-y-2">
            {pinnedSessions.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setPinnedCollapsed((v) => !v)}
                  className="flex h-6 w-full items-center gap-1 rounded px-1.5 text-[11.5px] font-medium text-[var(--text-mid)] hover:text-[var(--text-hi)]"
                >
                  {pinnedCollapsed ? (
                    <ChevronRight className="size-3 text-[var(--text-low)]" />
                  ) : (
                    <ChevronDown className="size-3 text-[var(--text-low)]" />
                  )}
                  <span>{t("hud.pinnedSection")}</span>
                  <span className="hud-mono text-[10.5px] text-[var(--text-low)]">
                    {pinnedSessions.length}
                  </span>
                </button>
                {!pinnedCollapsed && (
                  <div className="mt-0.5 space-y-[1px]">
                    {pinnedSessions.map(renderSessionRow)}
                  </div>
                )}
              </div>
            )}

            {projectGroups.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setProjectsCollapsed((v) => !v)}
                  className="flex h-6 w-full items-center gap-1 rounded px-1.5 text-[11.5px] font-medium text-[var(--text-mid)] hover:text-[var(--text-hi)]"
                >
                  {projectsCollapsed ? (
                    <ChevronRight className="size-3 text-[var(--text-low)]" />
                  ) : (
                    <ChevronDown className="size-3 text-[var(--text-low)]" />
                  )}
                  <span>{t("hud.projectsSection")}</span>
                  <span className="hud-mono text-[10.5px] text-[var(--text-low)]">
                    {projectGroups.length}
                  </span>
                </button>

                {!projectsCollapsed && (
                  <div className="mt-0.5 space-y-1">
                    {projectGroups.map((group) => {
                      const folderClosed = collapsedFolders.has(group.key);
                      const hasSelectedInside = group.items.some(
                        (s) =>
                          s.sessionKey === selectedSessionKey &&
                          (selectedSessionPlatform || s.platform) === s.platform
                      );
                      return (
                        <div key={group.key}>
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsedFolders((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.key)) next.delete(group.key);
                                else next.add(group.key);
                                return next;
                              })
                            }
                            className="group/folder flex h-[28px] w-full items-center gap-1.5 rounded-[6px] px-2 text-left text-[12.5px] text-[var(--text-mid)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                            title={group.fullCwd || group.label}
                          >
                            {folderClosed ? (
                              <Folder className="size-3.5 shrink-0 text-[var(--text-low)]" />
                            ) : (
                              <FolderOpen className="size-3.5 shrink-0 text-[var(--text-mid)]" />
                            )}
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {group.label}
                            </span>
                            {hasSelectedInside && folderClosed && (
                              <span className="size-1.5 shrink-0 rounded-full bg-[var(--cyan)]" />
                            )}
                            <span className="hud-mono text-[10.5px] text-[var(--text-low)]">
                              {group.items.length}
                            </span>
                          </button>

                          {!folderClosed && (
                            <div className="mt-[1px] space-y-[1px] pl-2">
                              {group.items.map(renderSessionRow)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {remaining > 0 &&
          !selectionMode &&
          !(loading && displaySessions.length === 0) && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void handleLoadMore()}
              className="hud-mono mt-1.5 w-full rounded-[6px] py-1.5 text-[11px] text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
            >
              {loadingMore
                ? t("loading")
                : t("session.loadMore", { count: remaining })}
            </button>
          )}
      </div>

      {/* Session Right-Click Context Menu + Click-Catcher Backdrop */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu(null);
            }}
          />
          <FloatingMenu
            className="w-[208px] rounded-[7px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 text-xs shadow-2xl"
            x={ctxMenu.x}
            y={ctxMenu.y}
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--emerald-fg)] hover:bg-[var(--emerald-dim)]"
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <ExternalLink className="size-3.5 shrink-0 text-[var(--cyan-fg)]" />
            <span className="truncate">{t("terminal.resumeExternal")}</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              const s = ctxMenu.session;
              setCtxMenu(null);
              try {
                const detail =
                  state.sessionDetail?.sessionKey === s.sessionKey
                    ? state.sessionDetail
                    : await api.getSessionDetail(s.platform, s.sessionKey);
                const cmd = detail.commands?.resume;
                if (!cmd) {
                  dispatch({
                    type: "setSessionStatus",
                    payload: { tone: "error", message: t("hud.ctxNoResumeCmd") },
                  });
                  return;
                }
                await navigator.clipboard.writeText(cmd);
                dispatch({
                  type: "setSessionStatus",
                  payload: { tone: "success", message: t("session.copied") },
                });
              } catch {
                dispatch({
                  type: "setSessionStatus",
                  payload: {
                    tone: "error",
                    message: t("hud.copyResumeFailed"),
                  },
                });
              }
            }}
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <Copy className="size-3.5 shrink-0 text-[var(--text-mid)]" />
            <span className="truncate">{t("terminal.copyResumeCmd")}</span>
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
          >
            <Pin
              className={cn(
                "size-3.5 shrink-0",
                ctxMenu.session.favorite
                  ? "text-[var(--forge-fg)]"
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-hi)] hover:bg-[var(--bg-hover)]"
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
              className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
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
            className="flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-[var(--crimson-fg)] hover:bg-[var(--crimson-dim)]"
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
          </FloatingMenu>
        </>
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

              <div className="space-y-1.5 rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] p-3">
                <div className="font-semibold text-[var(--text-hi)]">
                  {importPreview.title || t("session.untitled")}
                </div>
                <div className="hud-mono text-[11px] text-[var(--text-low)]">
                  {importPreview.sessionId}
                  {importPreview.cwd ? ` · ${importPreview.cwd}` : ""}
                </div>
                <div className="hud-mono break-all text-[10.5px] text-[var(--text-low)]">
                  {importPreview.sourcePath}
                </div>
              </div>

              {importPreview.conflict !== null && (
                <div className="rounded-[5px] border border-[var(--forge-line)] bg-[var(--forge-dim)] p-2.5 text-[var(--forge-fg)]">
                  {importPreview.conflict === "same"
                    ? t("session.importConflictSame")
                    : t("session.importConflictDifferent")}
                </div>
              )}
              {importPreview.warnings.length > 0 && (
                <div className="space-y-1 rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] p-2.5">
                  <div className="flex items-center gap-1.5 font-semibold text-[var(--forge-fg)]">
                    <AlertTriangle className="size-3.5" />
                    <span>{t("session.importWarnings")}</span>
                  </div>
                  {importPreview.warnings.map((w) => (
                    <p key={w} className="text-[var(--text-mid)]">
                      {w}
                    </p>
                  ))}
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

/* ==================== RIN-STYLE 30PX BORDERLESS SESSION ROW ==================== */
type PlatformOption = {
  platform: string;
  label: string;
  count: number;
  idle: boolean;
};

function SwitcherIcon({ platform }: { platform: string }) {
  return platform === "all" ? (
    <LayoutGrid className="size-3.5 shrink-0 text-[var(--text-mid)]" />
  ) : (
    <PlatformMark platform={platform} size={13} />
  );
}

function PlatformSwitcher({
  currentPlatform,
  activePlatforms,
  idlePlatforms,
  totalCount,
  onSelect,
  onManage,
  t,
}: {
  currentPlatform: string;
  activePlatforms: Array<{ platform: string; count: number }>;
  idlePlatforms: string[];
  totalCount: number;
  onSelect: (platform: string) => void;
  onManage: () => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const labelOf = (platform: string) => PLATFORM_LABELS[platform] ?? platform;
  const options: PlatformOption[] = [
    {
      platform: "all",
      label: t("session.filter.all"),
      count: totalCount,
      idle: false,
    },
    ...activePlatforms.map((p) => ({
      platform: p.platform,
      label: labelOf(p.platform),
      count: p.count,
      idle: false,
    })),
    ...idlePlatforms.map((platform) => ({
      platform,
      label: labelOf(platform),
      count: 0,
      idle: true,
    })),
  ];
  const current = options.find((o) => o.platform === currentPlatform) ?? {
    platform: currentPlatform,
    label: labelOf(currentPlatform),
    count: 0,
    idle: true,
  };

  const close = (refocus: boolean) => {
    setMenu(null);
    if (refocus) triggerRef.current?.focus();
  };
  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const selected = options.findIndex((o) => o.platform === currentPlatform);
    setHighlight(selected < 0 ? 0 : selected);
    setMenu({ x: rect.left, y: rect.bottom + 4, width: rect.width });
  };
  const choose = (platform: string) => {
    close(true);
    if (platform !== currentPlatform) onSelect(platform);
  };

  useEffect(() => {
    if (!menu) return;
    listRef.current?.focus();
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        (listRef.current?.contains(target) ||
          triggerRef.current?.contains(target))
      ) {
        return;
      }
      setMenu(null);
    };
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, menu]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = options[highlight];
      if (option) choose(option.platform);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        aria-expanded={Boolean(menu)}
        aria-haspopup="listbox"
        aria-label={t("hud.platformSwitcher")}
        className={cn(
          "flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[6px] border bg-[var(--bg-void)] px-2 text-xs transition-colors",
          menu
            ? "border-[var(--line-strong)]"
            : "border-[var(--line-hair)] hover:border-[var(--line-strong)]"
        )}
        onClick={() => (menu ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu();
          }
        }}
        ref={triggerRef}
        title={t("hud.platformSwitcher")}
        type="button"
      >
        <SwitcherIcon platform={current.platform} />
        <span className="min-w-0 flex-1 truncate text-left font-medium text-[var(--text-hi)]">
          {current.label}
        </span>
        {current.count > 0 && (
          <span className="hud-mono shrink-0 text-[10.5px] text-[var(--text-low)]">
            {current.count}
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-[var(--text-low)] transition-transform",
            menu && "rotate-180"
          )}
        />
      </button>

      {menu && (
        <FloatingMenu
          className="rounded-[8px] border border-[var(--line-strong)] bg-[var(--bg-panel)] p-1 text-xs shadow-2xl"
          width={menu.width}
          x={menu.x}
          y={menu.y}
        >
          <div
            aria-label={t("hud.platformSwitcher")}
            className="outline-none"
            onKeyDown={onListKeyDown}
            ref={listRef}
            role="listbox"
            tabIndex={-1}
          >
            {options.map((option, idx) => {
              const selected = option.platform === currentPlatform;
              const firstIdle = option.idle && !options[idx - 1]?.idle;
              return (
                <Fragment key={option.platform}>
                  {firstIdle && (
                    <div className="mt-1 border-t border-[var(--line-subtle)] px-2 pt-1.5 pb-1 text-[10.5px] text-[var(--text-low)]">
                      {t("hud.idlePlatformsGroup")}
                    </div>
                  )}
                  <button
                    aria-selected={selected}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-[5px] px-2 text-left",
                      idx === highlight && "bg-[var(--bg-hover)]",
                      option.idle
                        ? "text-[var(--text-low)]"
                        : "text-[var(--text-hi)]"
                    )}
                    data-highlighted={idx === highlight}
                    onClick={() => choose(option.platform)}
                    onMouseEnter={() => setHighlight(idx)}
                    role="option"
                    type="button"
                  >
                    <SwitcherIcon platform={option.platform} />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {!option.idle && (
                      <span className="hud-mono shrink-0 text-[10.5px] text-[var(--text-low)]">
                        {option.count}
                      </span>
                    )}
                    <Check
                      className={cn(
                        "size-3.5 shrink-0 text-[var(--cyan-fg)]",
                        !selected && "invisible"
                      )}
                    />
                  </button>
                </Fragment>
              );
            })}
            <div className="my-1 border-t border-[var(--line-subtle)]" />
            <button
              className="flex h-8 w-full items-center gap-2 rounded-[5px] px-2 text-left text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
              onClick={() => {
                close(false);
                onManage();
              }}
              type="button"
            >
              <Settings className="size-3.5 shrink-0" />
              <span className="truncate">{t("hud.managePlatforms")}</span>
            </button>
          </div>
        </FloatingMenu>
      )}
    </>
  );
}

function RinSessionRow({
  session,
  rowDataKey,
  isSelected,
  isLocated,
  selectedSessionKey,
  showArchived,
  selectionMode,
  isMultiSelected,
  isRenaming,
  renameDraft,
  isEn,
  onClick,
  onContextMenu,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onOpenSubagent,
  onToggleFavorite,
  onToggleArchive,
  untitledLabel,
  subagentsCountLabel,
  autoExpandSubagents,
}: {
  session: Session;
  rowDataKey: string;
  isSelected: boolean;
  isLocated: boolean;
  selectedSessionKey: string | null;
  showArchived: boolean;
  selectionMode: boolean;
  isMultiSelected: boolean;
  isRenaming: boolean;
  renameDraft: string;
  isEn: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onChangeRename: (val: string) => void;
  onCommitRename: (val: string) => void;
  onCancelRename: () => void;
  onOpenSubagent: (sub: Session) => void;
  onToggleFavorite: (session: Session, e: React.MouseEvent) => void;
  onToggleArchive: (session: Session, e: React.MouseEvent) => void;
  untitledLabel: string;
  subagentsCountLabel: string;
  autoExpandSubagents: boolean;
}) {
  const [agentsExpanded, setAgentsExpanded] = useState(autoExpandSubagents);
  const subagentCount = countSubagents(session);
  const highlight = selectionMode ? isMultiSelected : isSelected;
  const relTime = formatCompactTime(session.updatedAt, isEn);
  const readableTitle = getSessionReadableTitle(session, untitledLabel);

  useEffect(() => {
    if (autoExpandSubagents) setAgentsExpanded(true);
  }, [autoExpandSubagents]);

  return (
    <div data-session-row-key={rowDataKey}>
      <div
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={
          session.cwd
            ? `${readableTitle}\n${session.cwd}`
            : readableTitle
        }
        className={cn(
          "group/row flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-[13px] transition-colors",
          highlight
            ? "bg-[var(--row-selected)] font-medium text-[var(--text-hi)]"
            : "text-[var(--text-mid)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]",
          isLocated && "sidebar-session-located"
        )}
      >
        {selectionMode ? (
          <span className="hud-mono text-[10.5px] font-bold text-[var(--cyan-fg)]">
            [{isMultiSelected ? "✓" : " "}]
          </span>
        ) : (
          <PlatformMark platform={session.platform} size={13} />
        )}

        {isRenaming ? (
          <input
            autoFocus
            className="h-5 min-w-0 flex-1 rounded-[4px] border border-[var(--cyan)] bg-[var(--bg-void)] px-1.5 text-xs font-medium text-[var(--text-hi)] outline-none"
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
          <span className="min-w-0 flex-1 truncate">{readableTitle}</span>
        )}

        {!selectionMode && !isRenaming && (
          <>
            <span className="hud-mono shrink-0 text-[11px] text-[var(--text-low)] group-hover/row:hidden">
              {relTime}
            </span>
            <div className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
              <button
                type="button"
                onClick={(e) => onToggleFavorite(session, e)}
                className={cn(
                  "grid size-5 place-items-center rounded-[4px] hover:bg-[var(--bg-void)]",
                  session.favorite
                    ? "text-[var(--forge-fg)]"
                    : "text-[var(--text-low)] hover:text-[var(--forge-fg)]"
                )}
              >
                <Pin className="size-3" />
              </button>
              <button
                type="button"
                onClick={(e) => onToggleArchive(session, e)}
                className="grid size-5 place-items-center rounded-[4px] text-[var(--text-low)] hover:bg-[var(--bg-void)] hover:text-[var(--crimson-fg)]"
              >
                {showArchived ? (
                  <ArchiveRestore className="size-3" />
                ) : (
                  <Archive className="size-3" />
                )}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Content Search Hits (only during FTS search) */}
      {session.contentMatches && session.contentMatches.length > 0 && (
        <div className="mb-1 ml-6 space-y-0.5">
          {session.contentMatches.slice(0, 2).map((m, i) => (
            <div
              key={i}
              onClick={onClick}
              className="hud-mono cursor-pointer truncate rounded-[4px] bg-[var(--forge-dim)] px-1.5 py-0.5 text-[10px] text-[var(--forge-fg)]"
            >
              #{m.matchIndex + 1}: {m.snippet}
            </div>
          ))}
        </div>
      )}

      {/* Subagent Children */}
      {subagentCount > 0 && (
        <div className="ml-5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAgentsExpanded((v) => !v);
            }}
            className="hud-mono flex h-5 items-center gap-1 px-1.5 text-[10.5px] text-[var(--text-low)] hover:text-[var(--text-hi)]"
          >
            {agentsExpanded ? (
              <ChevronDown className="size-2.5" />
            ) : (
              <ChevronRight className="size-2.5" />
            )}
            <span>{subagentsCountLabel}</span>
          </button>
          {agentsExpanded && (
            <div className="space-y-[1px] border-l border-[var(--line-hair)] pl-2">
              {(session.agentGroup?.children ?? []).map((sub) => {
                const subActive = selectedSessionKey === sub.sessionKey;
                return (
                  <button
                    key={sub.sessionKey}
                    type="button"
                    onClick={() => onOpenSubagent(sub)}
                    className={cn(
                      "flex h-[26px] w-full items-center gap-1.5 truncate rounded-[5px] px-2 text-left text-[12px]",
                      subActive
                        ? "bg-[var(--row-selected)] font-medium text-[var(--text-hi)]"
                        : "text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                    )}
                  >
                    <span className="truncate">
                      {sub.agentGroup?.nickname ||
                        sub.agentGroup?.role ||
                        sub.displayTitle ||
                        sub.sessionId}
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
