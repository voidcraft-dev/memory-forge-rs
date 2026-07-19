import {
  Bot,
  CheckCircle2,
  Code,
  Eye,
  Gem,
  KeyRound,
  LoaderCircle,
  Menu,
  MousePointer2,
  Orbit,
  Pi,
  Radio,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { AppLogo } from "@/components/logo";
import { api, hasRemoteAccessToken, setRemoteAccessToken } from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
import { useDesktop } from "@/features/desktop/provider";
import { cn } from "@/lib/utils";

type RemotePlatformItem = {
  id: string;
  labelKey: MessageKey;
  icon: LucideIcon;
};

const REMOTE_PLATFORMS: RemotePlatformItem[] = [
  { id: "claude", labelKey: "platformClaude", icon: Bot },
  { id: "codex", labelKey: "platformCodex", icon: Terminal },
  { id: "cursor", labelKey: "platformCursor", icon: MousePointer2 },
  { id: "opencode", labelKey: "platformOpencode", icon: Code },
  { id: "kiro", labelKey: "platformKiro", icon: Sparkles },
  { id: "kiro-ide", labelKey: "platformKiroIde", icon: Sparkles },
  { id: "gemini", labelKey: "platformGemini", icon: Gem },
  { id: "grok", labelKey: "platformGrok", icon: Orbit },
  { id: "pi", labelKey: "platformPi", icon: Pi },
];

export default function RemoteShellLayout() {
  const {
    snapshot,
    notice,
    error,
    t,
    isReadOnlyRemote,
    remoteBootstrap,
    state,
    dispatch,
  } = useDesktop();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteAccessReady, setRemoteAccessReady] = useState(false);
  const [remoteAccessChecking, setRemoteAccessChecking] = useState(() => hasRemoteAccessToken());
  const [remoteConnecting, setRemoteConnecting] = useState(false);
  const [remoteTokenError, setRemoteTokenError] = useState(false);

  const visiblePlatforms = useMemo(() => {
    const available = new Set(
      remoteBootstrap?.platforms
        .filter((platform) => platform.available)
        .map((platform) => platform.id) ?? [],
    );
    const configured = snapshot?.settings.navigationItems ?? [];
    const orderedIds = [
      ...configured.filter((id) => available.has(id)),
      ...Array.from(available).filter((id) => !configured.includes(id)),
    ];
    return orderedIds.flatMap((id) => {
      const item = REMOTE_PLATFORMS.find((candidate) => candidate.id === id);
      return item ? [item] : [];
    });
  }, [remoteBootstrap?.platforms, snapshot?.settings.navigationItems]);

  const activePlatform = visiblePlatforms.find((item) => item.id === state.currentPlatform)
    ?? visiblePlatforms.find((item) => location.pathname === `/${item.id}`)
    ?? visiblePlatforms[0];
  const hasSelectedSession = Boolean(state.selectedSessionKey);

  useEffect(() => {
    if (location.pathname === "/" && visiblePlatforms[0]) {
      navigate(`/${visiblePlatforms[0].id}`, { replace: true });
    }
  }, [location.pathname, navigate, visiblePlatforms]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!remoteBootstrap?.auth.required) {
      setRemoteAccessReady(true);
      setRemoteAccessChecking(false);
      return;
    }
    setRemoteAccessReady(false);
    if (!hasRemoteAccessToken()) {
      setRemoteAccessChecking(false);
      return;
    }
    let cancelled = false;
    setRemoteAccessChecking(true);
    api.getDashboard()
      .then((dashboard) => {
        if (cancelled) return;
        dispatch({ type: "setDashboard", payload: dashboard });
        setRemoteAccessReady(true);
        setRemoteTokenError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRemoteAccessToken("");
        setRemoteTokenError(true);
      })
      .finally(() => {
        if (!cancelled) setRemoteAccessChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, remoteBootstrap?.auth.required]);

  const connectRemote = async () => {
    if (!remoteToken.trim()) return;
    setRemoteConnecting(true);
    setRemoteTokenError(false);
    setRemoteAccessToken(remoteToken);
    try {
      const dashboard = await api.getDashboard();
      dispatch({ type: "setDashboard", payload: dashboard });
      setRemoteAccessReady(true);
      setRemoteToken("");
    } catch {
      setRemoteAccessToken("");
      setRemoteTokenError(true);
    } finally {
      setRemoteConnecting(false);
    }
  };

  const contentReady = remoteBootstrap?.auth.required !== true || remoteAccessReady;

  return (
    <div className="remote-shell h-[100dvh] overflow-hidden bg-background text-foreground">
      {notice && (
        <div className="remote-toast remote-toast-success" role="status">
          <CheckCircle2 className="size-4" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="remote-toast remote-toast-error" role="alert">
          <span>{t("saveError")}: {error}</span>
        </div>
      )}

      {remoteBootstrap?.auth.required && !remoteAccessReady && !remoteAccessChecking && (
        <div className="remote-auth" role="dialog" aria-modal="true" aria-labelledby="remote-access-title">
          <form
            className="remote-auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void connectRemote();
            }}
          >
            <AppLogo className="size-12" />
            <p className="remote-kicker">Memory Forge Remote</p>
            <h1 id="remote-access-title">{t("remoteAccessTitle")}</h1>
            <div className="remote-host-line">
              <Wifi className="size-4" />
              <span>{remoteBootstrap.serverName}</span>
            </div>
            <label htmlFor="remote-access-token">{t("remoteAccessToken")}</label>
            <div className="remote-token-field">
              <KeyRound className="size-4" />
              <input
                id="remote-access-token"
                type="password"
                autoComplete="off"
                value={remoteToken}
                onChange={(event) => setRemoteToken(event.target.value)}
                autoFocus
              />
            </div>
            {remoteTokenError && <p className="remote-auth-error" role="alert">{t("remoteAccessInvalid")}</p>}
            <button type="submit" disabled={remoteConnecting || !remoteToken.trim()}>
              {remoteConnecting && <LoaderCircle className="size-4 animate-spin" />}
              {t("remoteConnect")}
            </button>
          </form>
        </div>
      )}

      <header className={cn("remote-topbar lg:hidden", hasSelectedSession && "max-md:hidden")}>
        <button
          type="button"
          className="remote-icon-button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t("remoteOpenNavigation")}
          title={t("remoteOpenNavigation")}
        >
          <Menu className="size-5" />
        </button>
        <div className="remote-topbar-title">
          <AppLogo className="size-6" />
          <div>
            <span>{activePlatform ? t(activePlatform.labelKey) : t("appName")}</span>
            <small>{t("remoteSessions")}</small>
          </div>
        </div>
        <span className="remote-online" title={`${t("remoteServer")}: ${remoteBootstrap?.serverName ?? "Memory Forge"}`}>
          <Radio className="size-3.5" />
          <span>{t("remoteOnline")}</span>
        </span>
      </header>

      {drawerOpen && (
        <button
          type="button"
          className="remote-drawer-scrim lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-label={t("remoteCloseNavigation")}
        />
      )}

      <div className={cn("remote-layout", hasSelectedSession && "remote-layout-detail")}>
        <aside className={cn("remote-drawer", drawerOpen && "remote-drawer-open")}>
          <div className="remote-drawer-brand">
            <AppLogo className="size-9" />
            <div>
              <strong>{t("appName")}</strong>
              <span>{t("remoteCompanion")}</span>
            </div>
            <button
              type="button"
              className="remote-icon-button ml-auto lg:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-label={t("remoteCloseNavigation")}
              title={t("remoteCloseNavigation")}
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="remote-server-card">
            <span className="remote-server-icon"><Wifi className="size-4" /></span>
            <div>
              <strong>{remoteBootstrap?.serverName ?? "Memory Forge"}</strong>
              <span>{t("remoteLocalConnection")}</span>
            </div>
            <span className="remote-status-dot" />
          </div>

          <p className="remote-nav-label">{t("remoteWorkspaces")}</p>
          <nav className="remote-platform-nav" aria-label={t("remoteWorkspaces")}>
            {visiblePlatforms.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={`/${item.id}`}
                  className={({ isActive }) => cn("remote-platform-link", isActive && "remote-platform-link-active")}
                >
                  <Icon className="size-4" />
                  <span>{t(item.labelKey)}</span>
                  <span className="remote-platform-chevron">›</span>
                </NavLink>
              );
            })}
          </nav>

          <div className="remote-drawer-footer">
            {isReadOnlyRemote ? <Eye className="size-4" /> : <ShieldCheck className="size-4" />}
            <div>
              <strong>{isReadOnlyRemote ? t("remoteReadOnly") : t("remoteEditsEnabled")}</strong>
              <span>{isReadOnlyRemote ? t("remoteSourceOnHost") : t("remoteRevisionProtected")}</span>
            </div>
          </div>
        </aside>

        <main className="remote-main">
          <Suspense fallback={<RemoteLoading label={t("loading")} />}>
            {contentReady ? <Outlet /> : <RemoteLoading label={t("loading")} />}
          </Suspense>
        </main>
      </div>

      {remoteAccessChecking && <div className="remote-loading-overlay"><RemoteLoading label={t("loading")} /></div>}
    </div>
  );
}

function RemoteLoading({ label }: { label: string }) {
  return (
    <div className="remote-loading" role="status" aria-live="polite">
      <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />
      <span>{label}</span>
    </div>
  );
}
