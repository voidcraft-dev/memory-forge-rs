import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  CheckCircle,
  Copy,
  FolderOpen,
  GripVertical,
  Languages,
  QrCode,
  RefreshCw,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type ComponentType, useEffect, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getRemoteServerStatus, restartRemoteServer } from "@/features/desktop/api";
import { localeCatalog, themeCatalog } from "@/features/desktop/catalog";
import { useDesktop } from "@/features/desktop/provider";
import type { RemoteServerStatus, ThemeId } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

const PLATFORM_ITEMS = [
  { id: "claude", labelKey: "platformClaude" as const, isPlatform: true },
  { id: "codex", labelKey: "platformCodex" as const, isPlatform: true },
  { id: "terminal-sessions", labelKey: "terminalSessions" as const, isPlatform: false },
  { id: "opencode", labelKey: "platformOpencode" as const, isPlatform: true },
  { id: "grok", labelKey: "platformGrok" as const, isPlatform: true },
  { id: "pi", labelKey: "platformPi" as const, isPlatform: true },
  { id: "cursor", labelKey: "platformCursor" as const, isPlatform: true },
  { id: "kiro", labelKey: "platformKiro" as const, isPlatform: true },
  { id: "kiro-ide", labelKey: "platformKiroIde" as const, isPlatform: true },
  { id: "gemini", labelKey: "platformGemini" as const, isPlatform: true },
];

const TERMINAL_OPTIONS = {
  windows: [
    { value: "cmd", labelKey: "terminalCmd" as const },
    { value: "powershell", labelKey: "terminalPowerShell" as const },
    { value: "wt", labelKey: "terminalWindowsTerminal" as const },
  ],
  macos: [
    { value: "terminal", labelKey: "terminalMacTerminal" as const },
    { value: "iterm2", labelKey: "terminalITerm2" as const },
    { value: "alacritty", labelKey: "terminalAlacritty" as const },
    { value: "kitty", labelKey: "terminalKitty" as const },
    { value: "ghostty", labelKey: "terminalGhostty" as const },
    { value: "wezterm", labelKey: "terminalWezTerm" as const },
    { value: "kaku", labelKey: "terminalKaku" as const },
  ],
  linux: [
    { value: "gnome-terminal", labelKey: "terminalGnomeTerminal" as const },
    { value: "konsole", labelKey: "terminalKonsole" as const },
    { value: "xfce4-terminal", labelKey: "terminalXfceTerminal" as const },
    { value: "alacritty", labelKey: "terminalAlacritty" as const },
    { value: "kitty", labelKey: "terminalKitty" as const },
    { value: "ghostty", labelKey: "terminalGhostty" as const },
  ],
} as const;

function getDesktopPlatform(): keyof typeof TERMINAL_OPTIONS {
  if (typeof navigator === "undefined") return "windows";
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("linux")) return "linux";
  return "windows";
}

function getTerminalOptions() {
  return TERMINAL_OPTIONS[getDesktopPlatform()];
}

function getDefaultTerminal() {
  const platform = getDesktopPlatform();
  if (platform === "macos") return "terminal";
  if (platform === "linux") return "gnome-terminal";
  return "cmd";
}

export default function SettingsPage() {
  const {
    snapshot,
    loading,
    saving,
    t,
    setTheme,
    setLocale,
    setCloseToTrayOnClose,
    setLaunchOnStartup,
    setReduceMotion,
    updateSettings,
    isRemote,
  } = useDesktop();
  const [draggingPlatformId, setDraggingPlatformId] = useState<string | null>(null);
  const [dragOverPlatformId, setDragOverPlatformId] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteServerStatus | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteLinkCopied, setRemoteLinkCopied] = useState(false);
  const [remoteQrOpen, setRemoteQrOpen] = useState(false);
  const [remotePortDraft, setRemotePortDraft] = useState("7331");

  useEffect(() => {
    if (!snapshot || snapshot.runtime !== "tauri") return;
    setRemotePortDraft(String(snapshot.settings.remotePort));
    void getRemoteServerStatus().then(setRemoteStatus).catch(() => setRemoteStatus(null));
  }, [snapshot?.runtime, snapshot?.settings.remotePort]);

  if (loading || !snapshot) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="panel-surface animate-pulse rounded-[24px] px-5 py-4 text-quiet text-sm">
          {t("loading")}
        </div>
      </div>
    );
  }

  const visiblePlatforms = snapshot.settings.visiblePlatforms ?? [
    "claude",
    "codex",
    "opencode",
    "grok",
    "pi",
  ];
  const navigationItems = snapshot.settings.navigationItems ?? [
    "claude",
    "codex",
    "terminal-sessions",
    "opencode",
    "grok",
    "pi",
  ];
  const orderedPlatformItems = [
    ...navigationItems.flatMap((navigationId) => {
      const item = PLATFORM_ITEMS.find(({ id }) => id === navigationId);
      return item ? [item] : [];
    }),
    ...PLATFORM_ITEMS.filter(({ id }) => !navigationItems.includes(id)),
  ];
  const remoteBaseUrl = remoteStatus?.lanUrls?.[0] ?? remoteStatus?.url ?? "";
  const remotePhoneLink = remoteBaseUrl
    ? remoteStatus?.accessToken
      ? `${remoteBaseUrl}/#token=${encodeURIComponent(remoteStatus.accessToken)}`
      : remoteBaseUrl
    : "";

  const applyRemoteSettings = async (
    patch: Parameters<typeof updateSettings>[0]
  ) => {
    setRemoteBusy(true);
    try {
      await updateSettings(patch);
      setRemoteStatus(await restartRemoteServer());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRemoteStatus((current) => current ? { ...current, running: false, error: message } : current);
    } finally {
      setRemoteBusy(false);
    }
  };

  const copyRemoteLink = async () => {
    if (!remotePhoneLink) return;
    await navigator.clipboard.writeText(remotePhoneLink);
    setRemoteLinkCopied(true);
    window.setTimeout(() => setRemoteLinkCopied(false), 1600);
  };

  const togglePlatformVisible = async (
    platformId: string,
    enabled: boolean
  ) => {
    const item = PLATFORM_ITEMS.find(({ id }) => id === platformId);
    const nextNavigationItems = enabled
      ? [...navigationItems, platformId]
      : navigationItems.filter((itemId) => itemId !== platformId);
    const patch = { navigationItems: nextNavigationItems } as {
      navigationItems: string[];
      visiblePlatforms?: string[];
    };
    if (item?.isPlatform) {
      patch.visiblePlatforms = enabled
        ? visiblePlatforms.includes(platformId)
          ? visiblePlatforms
          : [...visiblePlatforms, platformId]
        : visiblePlatforms.filter((itemId) => itemId !== platformId);
    }
    await updateSettings(patch);
  };

  const reorderPlatform = async (sourceId: string, targetId: string) => {
    const sourceIndex = navigationItems.indexOf(sourceId);
    const targetIndex = navigationItems.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

    const next = [...navigationItems];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDraggingPlatformId(null);
    setDragOverPlatformId(null);
    await updateSettings({ navigationItems: next });
  };

  const movePlatform = async (platformId: string, direction: -1 | 1) => {
    const sourceIndex = navigationItems.indexOf(platformId);
    const targetIndex = sourceIndex + direction;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= navigationItems.length) return;
    await reorderPlatform(platformId, navigationItems[targetIndex]);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2 pb-8">
      {/* Centered, Unified Column Layout Container */}
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Header section with stable solid colors for light & dark themes */}
        <section className="relative overflow-hidden rounded-[28px] border border-border/80 bg-gradient-to-br from-card/85 via-card/75 to-card/45 px-6 py-6 shadow-black/5 shadow-lg backdrop-blur-md md:px-8">
          {/* Glow Spheres */}
          <div className="pointer-events-none absolute -top-12 -left-12 size-48 rounded-full bg-primary/8 blur-[90px]" />
          <div className="pointer-events-none absolute -right-16 -bottom-16 size-56 rounded-full bg-violet-500/6 blur-[110px]" />
          <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.04),transparent_72%)] lg:block" />

          <div className="relative flex select-none items-center justify-between gap-4">
            <div>
              <p className="font-bold text-fine text-primary uppercase tracking-[0.28em]">
                {t("settings")}
              </p>
              <h2 className="mt-1.5 font-extrabold text-2xl text-foreground">
                Memory Forge
              </h2>
            </div>
            <div className="shrink-0 rounded-xl border border-border/80 bg-white/10 px-4 py-2 font-semibold text-foreground/80 text-xs backdrop-blur-md">
              {saving
                ? "Saving..."
                : `${t("themeSection")}: ${snapshot.settings.theme}`}
            </div>
          </div>
        </section>

        {/* 1. Theme Configuration */}
        <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("themeSectionDesc")}
            icon={Sparkles}
            title={t("themeSection")}
          />
          <div className="mt-5 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {themeCatalog.map((theme) => (
              <ThemeCard
                active={snapshot.settings.theme === theme.id}
                description={theme.description[snapshot.settings.locale]}
                key={theme.id}
                onSelect={setTheme}
                preview={theme.preview}
                themeId={theme.id}
                title={theme.label[snapshot.settings.locale]}
              />
            ))}
          </div>
        </section>

        {/* 2. Language Selection */}
        <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("languageSectionDesc")}
            icon={Languages}
            title={t("languageSection")}
          />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {localeCatalog.map((locale) => (
              <button
                className={cn(
                  "cursor-pointer rounded-[22px] border px-4 py-4 text-left transition-all duration-300 hover:scale-[1.01]",
                  snapshot.settings.locale === locale.id
                    ? "border-primary/25 bg-primary/4"
                    : "border-border/60 bg-white/4 hover:border-border/80 hover:bg-white/6"
                )}
                key={locale.id}
                onClick={() => void setLocale(locale.id)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-base">
                      {locale.label[snapshot.settings.locale]}
                    </p>
                    <p className="mt-1 text-quiet text-sm leading-6">
                      {locale.description[snapshot.settings.locale]}
                    </p>
                  </div>
                  {snapshot.settings.locale === locale.id && (
                    <Check className="fade-in zoom-in size-4 animate-in text-primary duration-200" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        {snapshot.runtime === "tauri" && (
          <section className="setting-card rounded-[24px] p-5">
            <SectionHeader
              description={t("remoteSectionDesc")}
              icon={Wifi}
              title={t("remoteSection")}
            />

            <div className="mt-5 border-t border-border/40 pt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-sm text-foreground">{t("remoteMode")}</p>
                  <p className="mt-1 text-xs text-quiet">{snapshot.settings.remoteBindMode === "lan" ? t("remoteLan") : t("remoteLoopback")}</p>
                </div>
                <div className="grid grid-cols-2 rounded-xl border border-border/60 bg-muted/30 p-1" role="group" aria-label={t("remoteMode")}>
                  {(["loopback", "lan"] as const).map((mode) => (
                    <button
                      type="button"
                      key={mode}
                      disabled={remoteBusy}
                      aria-pressed={snapshot.settings.remoteBindMode === mode}
                      onClick={() => void applyRemoteSettings({ remoteBindMode: mode })}
                      className={cn(
                        "min-h-10 rounded-lg px-4 text-xs font-semibold transition-colors",
                        snapshot.settings.remoteBindMode === mode
                          ? "bg-background text-primary shadow-sm"
                          : "text-quiet hover:text-foreground",
                      )}
                    >
                      {t(mode === "lan" ? "remoteLan" : "remoteLoopback")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid gap-4 border-t border-border/40 pt-5 md:grid-cols-[minmax(0,1fr)_180px]">
                <ToggleRow
                  checked={snapshot.settings.remoteMutationsEnabled}
                  description={t("remoteAllowEditsDesc")}
                  disabled={remoteBusy}
                  label={t("remoteAllowEdits")}
                  onToggle={(enabled) => applyRemoteSettings({ remoteMutationsEnabled: enabled })}
                />
                <div className="flex flex-col justify-center">
                  <label className="font-semibold text-sm text-foreground" htmlFor="remote-port">{t("remotePort")}</label>
                  <input
                    id="remote-port"
                    type="number"
                    min={1024}
                    max={65535}
                    inputMode="numeric"
                    disabled={remoteBusy}
                    value={remotePortDraft}
                    onChange={(event) => setRemotePortDraft(event.target.value)}
                    onBlur={() => {
                      const port = Number(remotePortDraft);
                      if (Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== snapshot.settings.remotePort) {
                        void applyRemoteSettings({ remotePort: port });
                      } else {
                        setRemotePortDraft(String(snapshot.settings.remotePort));
                      }
                    }}
                    className="mt-2 h-11 rounded-xl border border-border/60 bg-background/50 px-3 text-base font-mono tabular-nums text-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-3 border-t border-border/40 pt-5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className={cn("size-2.5 shrink-0 rounded-full", remoteStatus?.running ? "bg-emerald-500" : "bg-red-400")} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{t(remoteStatus?.running ? "remoteRunning" : "remoteStopped")}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-quiet" title={remoteBaseUrl || remoteStatus?.error || undefined}>
                      {remoteBaseUrl || remoteStatus?.error || "-"}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {snapshot.settings.remoteBindMode === "lan" && remotePhoneLink && (
                    <>
                      <button
                        className="flex min-h-11 items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3 font-semibold text-primary text-xs hover:bg-primary/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        onClick={() => setRemoteQrOpen(true)}
                        type="button"
                      >
                        <QrCode className="size-4" />
                        {t("remoteShowQr")}
                      </button>
                      <button
                        className="flex min-h-11 items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-3 font-semibold text-primary text-xs hover:bg-primary/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        onClick={() => void copyRemoteLink()}
                        type="button"
                      >
                        {remoteLinkCopied ? <CheckCircle className="size-4" /> : <Copy className="size-4" />}
                        {t(remoteLinkCopied ? "remoteLinkCopied" : "remoteCopyLink")}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={remoteBusy}
                    onClick={() => {
                      setRemoteBusy(true);
                      void restartRemoteServer()
                        .then(setRemoteStatus)
                        .catch((error) => {
                          const message = error instanceof Error ? error.message : String(error);
                          setRemoteStatus((current) => current ? { ...current, running: false, error: message } : current);
                        })
                        .finally(() => setRemoteBusy(false));
                    }}
                    className="flex min-h-11 items-center gap-2 rounded-xl border border-border/60 px-3 text-xs font-semibold text-foreground hover:bg-muted/60 disabled:opacity-50"
                  >
                    <RefreshCw className={cn("size-4", remoteBusy && "animate-spin")} />
                    {t("remoteRestart")}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 3. Desktop Behavior Toggles */}
        {!isRemote && <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("desktopBehaviorDesc")}
            icon={Rocket}
            title={t("desktopBehavior")}
          />
          <div className="mt-5 space-y-3">
            <ToggleRow
              checked={snapshot.settings.closeToTrayOnClose}
              description={t("closeBehaviorDesc")}
              label={t("closeBehavior")}
              onToggle={setCloseToTrayOnClose}
            />
            <ToggleRow
              checked={snapshot.settings.launchOnStartup}
              description={
                snapshot.autostartSupported
                  ? t("launchOnStartupDesc")
                  : t("autostartUnavailable")
              }
              disabled={!snapshot.autostartSupported}
              label={t("launchOnStartup")}
              onToggle={setLaunchOnStartup}
            />
            <ToggleRow
              checked={snapshot.settings.reduceMotion}
              description={t("reduceMotionDesc")}
              label={t("reduceMotion")}
              onToggle={setReduceMotion}
            />
          </div>
        </section>}

        {/* 4. Preferred terminal */}
        {!isRemote && <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("terminalSectionDesc")}
            icon={Terminal}
            title={t("terminalSection")}
          />
          <div className="mt-5">
            <label className="block font-semibold text-sm" htmlFor="preferred-terminal">
              {t("preferredTerminal")}
            </label>
            <select
              className="mt-2 h-10 w-full max-w-xs cursor-pointer rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2 text-sm text-foreground transition-all duration-200 focus:border-primary/50 focus:bg-background/40 focus:outline-none"
              id="preferred-terminal"
              onChange={(event) =>
                void updateSettings({ preferredTerminal: event.target.value })
              }
              value={snapshot.settings.preferredTerminal ?? getDefaultTerminal()}
            >
              {getTerminalOptions().map((terminal) => (
                <option key={terminal.value} value={terminal.value}>
                  {t(terminal.labelKey)}
                </option>
              ))}
            </select>
          </div>
        </section>}

        {/* 5. Platform Visibility Filters */}
        {!isRemote && <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("sidebarSectionDesc")}
            icon={SlidersHorizontal}
            title={t("sidebarSection")}
          />
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
            {orderedPlatformItems.map(({ id, labelKey }) => {
              const enabled = navigationItems.includes(id);
              const priority = navigationItems.indexOf(id);
              return (
                <div
                  className={cn(
                    "flex min-h-14 items-center justify-between gap-2 rounded-[18px] border pr-3 pl-1.5 transition-[border-color,background-color,opacity,box-shadow] duration-200",
                    enabled
                      ? "border-primary/20 bg-primary/5"
                      : "border-border/50 bg-white/3",
                    draggingPlatformId === id && "opacity-50",
                    dragOverPlatformId === id && "border-primary/50 bg-primary/10 ring-2 ring-primary/15"
                  )}
                  key={id}
                  onDragOver={(event) => {
                    if (!enabled || !draggingPlatformId || draggingPlatformId === id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverPlatformId(id);
                  }}
                  onDragLeave={() => {
                    if (dragOverPlatformId === id) setDragOverPlatformId(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingPlatformId) void reorderPlatform(draggingPlatformId, id);
                  }}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <span
                      aria-disabled={!enabled || saving}
                      aria-label={t("sidebar.dragLabel", {
                        platform: t(labelKey),
                        priority: priority + 1,
                      })}
                      className={cn(
                        "flex size-11 shrink-0 items-center justify-center rounded-xl text-quiet transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                        enabled && !saving
                          ? "cursor-grab hover:bg-primary/10 hover:text-primary active:cursor-grabbing"
                          : "cursor-default opacity-30"
                      )}
                      draggable={enabled && !saving}
                      onDragEnd={() => {
                        setDraggingPlatformId(null);
                        setDragOverPlatformId(null);
                      }}
                      onDragStart={(event) => {
                        if (!enabled || saving) return;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", id);
                        setDraggingPlatformId(id);
                      }}
                      onKeyDown={(event) => {
                        if (!enabled || saving) return;
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          void movePlatform(id, -1);
                        }
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          void movePlatform(id, 1);
                        }
                      }}
                      role="button"
                      tabIndex={enabled && !saving ? 0 : -1}
                      title={enabled ? t("sidebar.dragHint") : t("sidebar.enableToReorder")}
                    >
                      <GripVertical className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block truncate font-semibold text-sm",
                          enabled ? "text-foreground" : "text-quiet"
                        )}
                      >
                        {t(labelKey)}
                      </span>
                      {enabled && (
                        <span className="block font-medium text-[10px] text-primary/75 tabular-nums">
                          #{priority + 1}
                        </span>
                      )}
                    </span>
                  </div>
                  <button
                    aria-checked={enabled}
                    aria-label={t(
                      enabled ? "sidebar.hidePlatform" : "sidebar.showPlatform",
                      { platform: t(labelKey) }
                    )}
                    className="toggle-track shrink-0 scale-[0.82]"
                    data-state={enabled ? "on" : "off"}
                    disabled={saving}
                    onClick={() => void togglePlatformVisible(id, !enabled)}
                    role="switch"
                    type="button"
                  >
                    <span className="toggle-thumb animate-in duration-200" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>}

        {/* 6. Directory Paths configuration */}
        {!isRemote && <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("platformPathsDesc")}
            icon={FolderOpen}
            title={t("platformPaths")}
          />
          <div className="mt-5 space-y-3.5">
            <PathRow
              defaultHint="~/.claude"
              label={t("claudeHomePath")}
              onSave={(v) => updateSettings({ claudeHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.claudeHome ?? ""}
            />
            <PathRow
              defaultHint="~/.codex"
              label={t("codexHomePath")}
              onSave={(v) => updateSettings({ codexHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.codexHome ?? ""}
            />
            <PathRow
              defaultHint="例如 F:\workspacevk；留空显示全部 Codex 会话"
              label={t("codexProjectRootPath")}
              onSave={(v) => updateSettings({ codexProjectRoot: v || null })}
              pickMode="directory"
              value={snapshot.settings.codexProjectRoot ?? ""}
            />
            <PathRow
              defaultHint="%APPDATA%\\Cursor\\User"
              label={t("cursorHomePath")}
              onSave={(v) => updateSettings({ cursorHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.cursorHome ?? ""}
            />
            <PathRow
              defaultHint="~/.local/share/opencode/opencode.db"
              label={t("opencodePath")}
              onSave={(v) => updateSettings({ opencodePath: v || null })}
              pickMode="file"
              value={snapshot.settings.opencodePath ?? ""}
            />
            <PathRow
              defaultHint="~/.kiro"
              label={t("kiroHome")}
              onSave={(v) => updateSettings({ kiroHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.kiroHome ?? ""}
            />
            <PathRow
              defaultHint="%APPDATA%\\Kiro\\User\\globalStorage\\kiro.kiroagent"
              label={t("kiroIdeHome")}
              onSave={(v) => updateSettings({ kiroIdeHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.kiroIdeHome ?? ""}
            />
            <PathRow
              defaultHint="~/.gemini"
              label={t("geminiHome")}
              onSave={(v) => updateSettings({ geminiHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.geminiHome ?? ""}
            />
            <PathRow
              defaultHint="~/.grok"
              label={t("grokHome")}
              onSave={(v) => updateSettings({ grokHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.grokHome ?? ""}
            />
            <PathRow
              defaultHint="~/.pi/agent"
              label={t("piHome")}
              onSave={(v) => updateSettings({ piHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.piHome ?? ""}
            />
          </div>
        </section>}
      </div>

      <Dialog onOpenChange={setRemoteQrOpen} open={remoteQrOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[390px] border-border/70 bg-card/98">
          <DialogHeader className="p-5 pr-14">
            <DialogTitle className="flex items-center gap-2.5 text-lg">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <QrCode className="size-4.5" />
              </span>
              {t("remoteQrTitle")}
            </DialogTitle>
            <DialogDescription className="mt-2 leading-6">
              {t("remoteQrDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 p-5">
            <div className="mx-auto aspect-square w-full max-w-[280px] rounded-2xl border border-black/8 bg-white p-3 shadow-[0_16px_44px_rgba(30,38,58,0.12)]">
              {remotePhoneLink && (
                <QRCodeSVG
                  bgColor="#ffffff"
                  className="h-auto w-full"
                  fgColor="#17191f"
                  imageSettings={{
                    src: "/memory-forge.svg",
                    height: 36,
                    width: 36,
                    excavate: true,
                  }}
                  level="H"
                  marginSize={2}
                  size={256}
                  title={t("remoteQrTitle")}
                  value={remotePhoneLink}
                />
              )}
            </div>
            <p className="break-all rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5 text-center font-mono text-[11px] text-quiet leading-5">
              {remoteBaseUrl}
            </p>
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/8 px-3.5 py-3 text-amber-700 text-xs leading-5 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <p>{t("remoteQrSecret")}</p>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex select-none items-start gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary transition-transform duration-300 hover:scale-105">
        <Icon className="size-4.5" />
      </div>
      <div>
        <h3 className="font-bold text-base text-foreground">{title}</h3>
        <p className="mt-1 text-quiet text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

function ThemeCard({
  active,
  themeId,
  title,
  description,
  preview,
  onSelect,
}: {
  active: boolean;
  themeId: ThemeId;
  title: string;
  description: string;
  preview: [string, string, string];
  onSelect: (theme: ThemeId) => Promise<void>;
}) {
  return (
    <button
      className={cn(
        "flex min-h-[128px] cursor-pointer flex-col justify-between rounded-[22px] border px-4 py-4 text-left transition-all duration-300 hover:scale-[1.01] relative overflow-hidden",
        active
          ? "border-primary bg-gradient-to-br from-primary/14 via-primary/4 to-transparent shadow-md shadow-primary/4"
          : "border-border/60 bg-white/4 hover:border-border/80 hover:bg-white/7"
      )}
      onClick={() => void onSelect(themeId)}
      type="button"
    >
      {active && (
        <div className="absolute top-0 right-0 w-10 h-10 bg-primary/15 rounded-bl-2xl pointer-events-none flex items-center justify-center">
          <Check className="size-3.5 text-primary stroke-[3]" />
        </div>
      )}
      <div className="flex w-full items-start justify-between gap-3">
        <div className="space-y-3.5">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/30 bg-white/5 px-2 py-1 shadow-inner">
            {preview.map((color) => (
              <span
                className="size-3 rounded-full shadow-sm transition-transform hover:scale-115"
                key={color}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div>
            <p className="font-bold text-base">{title}</p>
            <p className="mt-1 text-quiet text-xs leading-relaxed">
              {description}
            </p>
          </div>
        </div>
      </div>
    </button>
  );
}

function ToggleRow({
  checked,
  label,
  description,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  description: string;
  disabled?: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  return (
    <div
      className={cn(
        "rounded-[22px] border px-4 py-4 transition-all duration-300",
        disabled
          ? "border-border/40 bg-white/2 opacity-50"
          : checked
            ? "border-primary/25 bg-primary/4 hover:border-primary/35"
            : "border-border/60 bg-white/4 hover:bg-white/6"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-semibold text-base">{label}</p>
          <p className="mt-1 text-quiet text-xs leading-relaxed">
            {description}
          </p>
        </div>
        <button
          aria-checked={checked}
          className="toggle-track shrink-0"
          data-state={checked ? "on" : "off"}
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              void onToggle(!checked);
            }
          }}
          role="switch"
          type="button"
        >
          <span className="toggle-thumb" />
        </button>
      </div>
    </div>
  );
}

function PathRow({
  label,
  defaultHint,
  pickMode,
  value,
  onSave,
}: {
  label: string;
  defaultHint: string;
  pickMode: "directory" | "file";
  value: string;
  onSave: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);

  const commit = async (v?: string) => {
    const trimmed = (v ?? draft).trim();
    if (trimmed === (value ?? "")) {
      return;
    }
    await onSave(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: pickMode === "directory",
        multiple: false,
        filters:
          pickMode === "file"
            ? [{ name: "Database", extensions: ["db"] }]
            : undefined,
      });
      if (selected) {
        setDraft(selected);
        await commit(selected);
      }
    } catch {
      /* user cancelled */
    }
  };

  return (
    <div className="rounded-[22px] border border-border/60 bg-white/4 px-4 py-3.5 transition-all hover:border-border/80 hover:bg-white/6">
      <div className="flex select-none items-center justify-between gap-3">
        <label className="shrink-0 font-semibold text-sm">{label}</label>
        {saved && (
          <Check className="fade-in size-3.5 animate-in text-green-400 duration-200" />
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-1.8 font-mono text-foreground text-xs transition-all duration-200 placeholder:text-muted-foreground/30 focus:border-primary/50 focus:bg-background/40 focus:outline-none"
          onBlur={() => void commit()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void commit();
            }
          }}
          placeholder={defaultHint}
          type="text"
          value={draft}
        />
        <button
          className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/20 text-muted-foreground transition-all duration-200 hover:border-primary/30 hover:bg-primary/15 hover:text-primary"
          onClick={() => void handleBrowse()}
          type="button"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
