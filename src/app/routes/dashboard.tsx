import {
  ArrowUpRight,
  Folder,
  RefreshCw,
  Scissors,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { formatWorkspaceShortName } from "@/components/layout/shell-layout";
import { api } from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import {
  getPlatformBadgeStyle,
  PLATFORM_LABELS,
} from "@/features/session/session-list";
import { useTerminal } from "@/features/terminal/terminal-context";
import { cn } from "@/lib/utils";

const ALL_21_PLATFORMS = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "devin",
  "gemini",
  "kiro",
  "kiro-ide",
  "zed",
  "cline",
  "qwen",
  "grok",
  "pi",
  "zcode",
  "workbuddy",
  "codebuddy",
  "dsh",
  "qoder-cn",
  "cindy",
  "cindy-global",
  "antigravity",
] as const;

export default function DashboardPage() {
  const navigate = useNavigate();
  const { snapshot, t, state, dispatch } = useDesktop();
  const { terminals } = useTerminal();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visiblePlatforms = snapshot?.settings?.visiblePlatforms ?? [
    ...ALL_21_PLATFORMS,
  ];
  const visibleKey = visiblePlatforms.join("|");
  const snapshotReady = Boolean(snapshot);

  const loadDashboard = () => {
    setLoading(true);
    setError(null);
    api
      .getDashboard()
      .then((data) => dispatch({ type: "setDashboard", payload: data }))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!snapshotReady) return;
    loadDashboard();
  }, [snapshotReady, visibleKey]);

  const platforms = state.dashboard?.platforms ?? [];
  const recentSessions = state.dashboard?.recentSessions ?? [];
  const trend = state.dashboard?.trend ?? [];

  const totalSessions = useMemo(
    () => platforms.reduce((sum, p) => sum + p.count, 0),
    [platforms]
  );
  const activePlatformsCount = useMemo(
    () => platforms.filter((p) => p.count > 0).length,
    [platforms]
  );
  const sevenDaySum = useMemo(
    () => trend.reduce((sum, pt) => sum + pt.count, 0),
    [trend]
  );
  const maxTrend = useMemo(
    () => Math.max(1, ...trend.map((pt) => pt.count)),
    [trend]
  );

  const allPtyList = useMemo(
    () => Object.values(terminals).flat(),
    [terminals]
  );

  const topWorkspaces = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of platforms) {
      for (const item of p.items ?? []) {
        const cwd = item.cwd?.trim();
        if (!cwd) continue;
        map.set(cwd, (map.get(cwd) ?? 0) + 1);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [platforms]);

  return (
    <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-3.5">
        {/* Top Radar Action Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="hud-mono text-[10px] font-bold tracking-[0.08em] text-[var(--cyan-fg)]">
              {t("hud.radarSubtitle")}
            </span>
            <h1 className="text-base font-bold text-[var(--text-hi)]">
              {t("welcomeTitle")}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={loadDashboard}
              className="hud-btn"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
              <span>{t("session.refresh")}</span>
            </button>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="hud-btn hud-btn-forge"
            >
              <Scissors className="size-3" />
              <span>{t("hud.enterWorkbench")}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="hud-mono rounded-[5px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-3 py-2 text-xs text-[var(--crimson-fg)]">
            {error}
          </div>
        )}

        {/* 4 Precision Telemetry KPI Cards */}
        <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <div className="reticle reticle-cyan hud-panel p-3.5">
            <div className="hud-mono text-[10.5px] font-semibold text-[var(--text-low)]">
              {t("hud.kpiPlatformsTitle")}
            </div>
            <div className="hud-mono mt-1 text-2xl font-bold text-[var(--cyan-fg)]">
              {activePlatformsCount}{" "}
              <span className="text-xs font-normal text-[var(--text-low)]">
                {t("hud.kpiPlatformsSub", { total: visiblePlatforms.length })}
              </span>
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--text-mid)]">
              {t("hud.kpiPlatformsDesc")}
            </p>
          </div>

          <div className="hud-panel p-3.5">
            <div className="hud-mono text-[10.5px] font-semibold text-[var(--text-low)]">
              {t("hud.kpiSessionsTitle")}
            </div>
            <div className="hud-mono mt-1 text-2xl font-bold text-[var(--forge-fg)]">
              {loading && totalSessions === 0 ? "…" : totalSessions}
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--text-mid)]">
              {t("hud.kpiSessionsDesc")}
            </p>
          </div>

          <div className="hud-panel p-3.5">
            <div className="hud-mono flex items-center justify-between text-[10.5px] font-semibold text-[var(--text-low)]">
              <span>{t("hud.kpiTrendTitle")}</span>
              <strong className="text-[var(--text-hi)]">{sevenDaySum}</strong>
            </div>
            <div className="mt-2 flex h-7 items-end gap-1.5">
              {(trend.length > 0
                ? trend
                : Array.from({ length: 7 }, (_, i) => ({
                    day: String(i),
                    count: 0,
                  }))
              ).map((pt) => {
                const h = Math.max(16, Math.round((pt.count / maxTrend) * 100));
                return (
                  <div
                    key={pt.day}
                    className="flex h-full flex-1 flex-col justify-end"
                    title={`${pt.day}: ${pt.count}`}
                  >
                    <span
                      className={cn(
                        "w-full rounded-t-[2px]",
                        pt.count > 0
                          ? "bg-[var(--cyan)]"
                          : "bg-[var(--line-hair)]"
                      )}
                      style={{ height: `${h}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--text-low)]">
              {t("hud.kpiTrendDesc")}
            </p>
          </div>

          <div className="hud-panel p-3.5">
            <div className="hud-mono text-[10.5px] font-semibold text-[var(--text-low)]">
              {t("hud.kpiPtyTitle")}
            </div>
            <div className="hud-mono mt-1 flex items-center gap-2 text-2xl font-bold text-[var(--emerald-fg)]">
              <span>{allPtyList.length}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "setPtyBayOpen", payload: !state.ptyBayOpen })
              }
              className="hud-mono mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--emerald-fg)] hover:underline"
            >
              <Terminal className="size-3" />
              <span>{t("hud.kpiPtyBtn")}</span>
            </button>
          </div>
        </section>

        {/* Main 2-Column Telemetry Matrix */}
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.25fr_1fr]">
          {/* Left: 21-Platform Local Signal Matrix */}
          <section className="hud-panel flex flex-col gap-3 p-3.5">
            <div className="hud-mono flex items-center justify-between border-b border-[var(--line-subtle)] pb-2 text-[11px] font-bold text-[var(--text-mid)]">
              <span>{t("hud.matrixTitle")}</span>
              <span className="text-[var(--text-low)]">
                {t("hud.matrixBadge")}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {visiblePlatforms.map((platKey) => {
                const summary = platforms.find((p) => p.platform === platKey);
                const count = summary?.count ?? 0;
                const latest = summary?.latest || "—";
                const hot = count > 0;
                const label = PLATFORM_LABELS[platKey] ?? platKey;

                return (
                  <button
                    key={platKey}
                    type="button"
                    onClick={() => navigate(`/${platKey}`)}
                    className={cn(
                      "group flex flex-col justify-between rounded-[4px] border px-2.5 py-2 text-left transition-all",
                      hot
                        ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)] hover:brightness-110"
                        : "border-[var(--line-hair)] bg-[var(--bg-elevated)] opacity-55 hover:opacity-95"
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-1">
                      <span className="hud-mono truncate text-[11px] font-semibold text-[var(--text-hi)]">
                        {label}
                      </span>
                      <strong
                        className={cn(
                          "hud-mono text-xs",
                          hot
                            ? "text-[var(--cyan-fg)]"
                            : "text-[var(--text-low)]"
                        )}
                      >
                        {loading && !summary ? "…" : count}
                      </strong>
                    </div>
                    <div className="hud-mono mt-1 flex items-center justify-between text-[9.5px] text-[var(--text-low)]">
                      <span className="truncate">{latest}</span>
                      <ArrowUpRight className="size-2.5 opacity-0 group-hover:opacity-100" />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Active Workspaces Strip */}
            {topWorkspaces.length > 0 && (
              <div className="mt-1 border-t border-[var(--line-subtle)] pt-2.5">
                <div className="hud-mono mb-2 text-[10.5px] font-bold text-[var(--text-low)]">
                  {t("hud.workspacesTitle")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {topWorkspaces.map(([cwd, cnt]) => (
                    <button
                      key={cwd}
                      type="button"
                      onClick={() => {
                        dispatch({ type: "setWorkspaceFilter", payload: cwd });
                        navigate("/");
                      }}
                      className="hud-mono inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[10.5px] text-[var(--text-hi)] hover:border-[var(--cyan-line)] hover:text-[var(--cyan-fg)]"
                      title={cwd}
                    >
                      <Folder className="size-3 text-[var(--cyan-fg)]" />
                      <span>{formatWorkspaceShortName(cwd)}</span>
                      <span className="text-[var(--text-low)]">({cnt})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Right: Recent Active Sessions Queue */}
          <section className="hud-panel flex flex-col gap-2.5 p-3.5">
            <div className="hud-mono flex items-center justify-between border-b border-[var(--line-subtle)] pb-2 text-[11px] font-bold text-[var(--text-mid)]">
              <span>{t("hud.recentSessionsTitle")}</span>
              <span className="text-[var(--text-low)]">
                {t("hud.recentCount", { count: recentSessions.length })}
              </span>
            </div>

            {recentSessions.length === 0 ? (
              <div className="py-12 text-center text-xs text-[var(--text-low)]">
                {loading ? t("loading") : t("session.noSessions")}
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentSessions.map((sess) => {
                  const platLabel =
                    PLATFORM_LABELS[sess.platform] ??
                    sess.platform.toUpperCase();
                  return (
                    <button
                      key={`${sess.platform}::${sess.sessionKey}`}
                      type="button"
                      onClick={() => {
                        navigate(`/${sess.platform}`);
                        setTimeout(() => {
                          dispatch({
                            type: "selectSession",
                            payload: {
                              platform: sess.platform,
                              sessionKey: sess.sessionKey,
                            },
                          });
                        }, 0);
                      }}
                      className="w-full rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-3 py-2 text-left transition-colors hover:border-[var(--cyan-line)] hover:bg-[var(--bg-hover)]"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "hud-mono rounded-[2px] border px-1.5 py-[0.5px] text-[9px] font-bold uppercase",
                            getPlatformBadgeStyle(sess.platform)
                          )}
                        >
                          {platLabel}
                        </span>
                        {sess.cwd && (
                          <span className="hud-mono truncate text-[9.5px] text-[var(--text-low)]">
                            {formatWorkspaceShortName(sess.cwd)}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs font-semibold text-[var(--text-hi)]">
                        {sess.aliasTitle || sess.displayTitle || sess.sessionId}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
