import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FolderOpen,
  GripVertical,
  Info,
  Languages,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import { Link } from "react-router";
import { localeCatalog, themeCatalog } from "@/features/desktop/catalog";
import { useDesktop } from "@/features/desktop/provider";
import { cn } from "@/lib/utils";

const PLATFORM_ITEMS = [
  { id: "claude", labelKey: "platformClaude" as const, isPlatform: true },
  { id: "codex", labelKey: "platformCodex" as const, isPlatform: true },
  { id: "opencode", labelKey: "platformOpencode" as const, isPlatform: true },
  { id: "grok", labelKey: "platformGrok" as const, isPlatform: true },
  { id: "pi", labelKey: "platformPi" as const, isPlatform: true },
  { id: "cursor", labelKey: "platformCursor" as const, isPlatform: true },
  { id: "kiro", labelKey: "platformKiro" as const, isPlatform: true },
  { id: "kiro-ide", labelKey: "platformKiroIde" as const, isPlatform: true },
  { id: "gemini", labelKey: "platformGemini" as const, isPlatform: true },
  { id: "zcode", labelKey: "platformZcode" as const, isPlatform: true },
  { id: "workbuddy", labelKey: "platformWorkbuddy" as const, isPlatform: true },
  { id: "cindy", labelKey: "platformCindy" as const, isPlatform: true },
  { id: "cindy-global", labelKey: "platformCindyGlobal" as const, isPlatform: true },
  { id: "zed", labelKey: "platformZed" as const, isPlatform: true },
  { id: "dsh", labelKey: "platformDsh" as const, isPlatform: true },
  { id: "qoder-cn", labelKey: "platformQoderCn" as const, isPlatform: true },
  { id: "qwen", labelKey: "platformQwen" as const, isPlatform: true },
  { id: "cline", labelKey: "platformCline" as const, isPlatform: true },
  { id: "antigravity", labelKey: "platformAntigravity" as const, isPlatform: true },
  { id: "codebuddy", labelKey: "platformCodebuddy" as const, isPlatform: true },
  { id: "devin", labelKey: "platformDevin" as const, isPlatform: true },
];

const TERMINAL_OPTIONS = {
  windows: [
    { value: "wt", labelKey: "terminalWindowsTerminal" as const },
    { value: "powershell", labelKey: "terminalPowerShell" as const },
    { value: "cmd", labelKey: "terminalCmd" as const },
  ],
  macos: [
    { value: "terminal", labelKey: "terminalMacTerminal" as const },
    { value: "iterm2", labelKey: "terminalITerm2" as const },
    { value: "ghostty", labelKey: "terminalGhostty" as const },
    { value: "wezterm", labelKey: "terminalWezTerm" as const },
    { value: "kitty", labelKey: "terminalKitty" as const },
    { value: "alacritty", labelKey: "terminalAlacritty" as const },
    { value: "kaku", labelKey: "terminalKaku" as const },
  ],
  linux: [
    { value: "gnome-terminal", labelKey: "terminalGnomeTerminal" as const },
    { value: "konsole", labelKey: "terminalKonsole" as const },
    { value: "xfce4-terminal", labelKey: "terminalXfceTerminal" as const },
    { value: "ghostty", labelKey: "terminalGhostty" as const },
    { value: "kitty", labelKey: "terminalKitty" as const },
    { value: "alacritty", labelKey: "terminalAlacritty" as const },
  ],
} as const;

function getDesktopPlatform(): keyof typeof TERMINAL_OPTIONS {
  if (typeof navigator === "undefined") return "windows";
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("linux")) return "linux";
  return "windows";
}

export default function SettingsPage() {
  const {
    snapshot,
    resolvedTheme,
    loading,
    saving,
    t,
    setTheme,
    setLocale,
    setCloseToTrayOnClose,
    setLaunchOnStartup,
    setReduceMotion,
    updateSettings,
  } = useDesktop();
  const [draggingPlatformId, setDraggingPlatformId] = useState<string | null>(
    null
  );

  if (loading || !snapshot) {
    return (
      <div className="hud-mono flex h-full items-center justify-center text-xs text-[var(--text-low)]">
        {t("loading")}
      </div>
    );
  }

  const visiblePlatforms = snapshot.settings.visiblePlatforms ?? [
    "claude",
    "codex",
    "opencode",
  ];
  const navigationItems = snapshot.settings.navigationItems ?? visiblePlatforms;
  const orderedPlatformItems = [
    ...navigationItems.flatMap((id) => {
      const item = PLATFORM_ITEMS.find((x) => x.id === id);
      return item ? [item] : [];
    }),
    ...PLATFORM_ITEMS.filter(({ id }) => !navigationItems.includes(id)),
  ];

  const togglePlatformVisible = async (platformId: string, enabled: boolean) => {
    const nextNavigationItems = enabled
      ? [...navigationItems, platformId]
      : navigationItems.filter((id) => id !== platformId);
    const nextVisiblePlatforms = enabled
      ? visiblePlatforms.includes(platformId)
        ? visiblePlatforms
        : [...visiblePlatforms, platformId]
      : visiblePlatforms.filter((id) => id !== platformId);
    await updateSettings({
      navigationItems: nextNavigationItems,
      visiblePlatforms: nextVisiblePlatforms,
    });
  };

  const reorderPlatform = async (sourceId: string, targetId: string) => {
    const srcIdx = navigationItems.indexOf(sourceId);
    const tgtIdx = navigationItems.indexOf(targetId);
    if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
    const next = [...navigationItems];
    const [moved] = next.splice(srcIdx, 1);
    next.splice(tgtIdx, 0, moved);
    setDraggingPlatformId(null);
    await updateSettings({ navigationItems: next });
  };

  const platform = getDesktopPlatform();
  const defaultTerm =
    platform === "macos"
      ? "terminal"
      : platform === "linux"
        ? "gnome-terminal"
        : "cmd";

  return (
    <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3.5 pb-8">
        {/* Top Config Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="hud-mono text-[10px] font-bold tracking-[0.08em] text-[var(--cyan-fg)]">
              {t("hud.settingsSubtitle")}
            </span>
            <h1 className="text-base font-bold text-[var(--text-hi)]">
              {t("settings")} · v{snapshot.version}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {saving && (
              <span className="hud-mono text-xs text-[var(--forge-fg)]">
                {t("loading")}
              </span>
            )}
            <Link to="/about" className="hud-btn">
              <Info className="size-3.5 text-[var(--cyan-fg)]" />
              <span>{t("hud.aboutAndUpdate")}</span>
            </Link>
          </div>
        </div>

        {/* 1. Dual Precision HUD Theme + Language */}
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <section className="hud-panel p-4">
            <HudSectionHead
              desc={t("hud.themeDualDesc")}
              icon={Sparkles}
              title={t("themeSection")}
            />
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {themeCatalog.map((th) => {
                const active = resolvedTheme === th.id;
                return (
                  <button
                    key={th.id}
                    type="button"
                    onClick={() => void setTheme(th.id)}
                    className={cn(
                      "flex flex-col justify-between gap-2 rounded-[5px] border p-3 text-left transition-all",
                      active
                        ? "reticle border-[var(--forge)] bg-[var(--forge-dim)]"
                        : "border-[var(--line-hair)] bg-[var(--bg-elevated)] hover:border-[var(--line-strong)]"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex gap-1.5">
                        {th.preview.map((c) => (
                          <span
                            key={c}
                            className="size-3.5 rounded-[2px] border border-black/20"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      {active && (
                        <Check className="size-3.5 text-[var(--forge-fg)]" />
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-bold text-[var(--text-hi)]">
                        {th.label[snapshot.settings.locale]}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-mid)]">
                        {th.description[snapshot.settings.locale]}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="hud-panel p-4">
            <HudSectionHead
              desc={t("languageSectionDesc")}
              icon={Languages}
              title={`${t("languageSection")} & ${t("preferredTerminal")}`}
            />
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {localeCatalog.map((loc) => {
                const active = snapshot.settings.locale === loc.id;
                return (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => void setLocale(loc.id)}
                    className={cn(
                      "flex items-center justify-between rounded-[5px] border px-3 py-2.5 text-left transition-colors",
                      active
                        ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                        : "border-[var(--line-hair)] bg-[var(--bg-elevated)] hover:border-[var(--line-strong)]"
                    )}
                  >
                    <span className="text-xs font-bold">
                      {loc.label[snapshot.settings.locale]}
                    </span>
                    {active && <Check className="size-3.5" />}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-[5px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <Terminal className="size-3.5 text-[var(--emerald-fg)]" />
                <span>{t("preferredTerminal")}</span>
              </span>
              <select
                className="hud-mono rounded-[4px] border border-[var(--line-strong)] bg-[var(--bg-void)] px-2.5 py-1 text-xs text-[var(--text-hi)] outline-none"
                onChange={(e) =>
                  void updateSettings({ preferredTerminal: e.target.value })
                }
                value={snapshot.settings.preferredTerminal ?? defaultTerm}
              >
                {TERMINAL_OPTIONS[platform].map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </div>

        {/* 2. Desktop Behavior */}
        <section className="hud-panel p-4">
          <HudSectionHead
            desc={t("desktopBehaviorDesc")}
            icon={Rocket}
            title={t("desktopBehavior")}
          />
          <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-3">
            <HudToggleRow
              checked={snapshot.settings.closeToTrayOnClose}
              desc={t("closeBehaviorDesc")}
              label={t("closeBehavior")}
              onToggle={setCloseToTrayOnClose}
            />
            <HudToggleRow
              checked={snapshot.settings.launchOnStartup}
              desc={
                snapshot.autostartSupported
                  ? t("launchOnStartupDesc")
                  : t("autostartUnavailable")
              }
              disabled={!snapshot.autostartSupported}
              label={t("launchOnStartup")}
              onToggle={setLaunchOnStartup}
            />
            <HudToggleRow
              checked={snapshot.settings.reduceMotion}
              desc={t("reduceMotionDesc")}
              label={t("reduceMotion")}
              onToggle={setReduceMotion}
            />
          </div>
        </section>

        {/* 3. Platform Visibility & Priority */}
        <section className="hud-panel p-4">
          <HudSectionHead
            desc={t("hud.adapterEnableDesc")}
            icon={SlidersHorizontal}
            title={t("sidebarSection")}
          />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {orderedPlatformItems.map(({ id, labelKey }) => {
              const enabled = visiblePlatforms.includes(id);
              return (
                <div
                  key={id}
                  draggable={enabled && !saving}
                  onDragOver={(e) => {
                    if (!enabled || !draggingPlatformId) return;
                    e.preventDefault();
                  }}
                  onDragStart={() => setDraggingPlatformId(id)}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggingPlatformId) {
                      void reorderPlatform(draggingPlatformId, id);
                    }
                  }}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-[4px] border px-2.5 py-2 transition-colors",
                    enabled
                      ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)]"
                      : "border-[var(--line-hair)] bg-[var(--bg-elevated)] opacity-60"
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <GripVertical className="size-3.5 shrink-0 cursor-grab text-[var(--text-low)]" />
                    <span className="truncate text-xs font-semibold">
                      {t(labelKey)}
                    </span>
                  </div>
                  <button
                    aria-checked={enabled}
                    className="toggle-track shrink-0 scale-85"
                    data-state={enabled ? "on" : "off"}
                    disabled={saving}
                    onClick={() => void togglePlatformVisible(id, !enabled)}
                    role="switch"
                    type="button"
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* 4. Custom Adapter Data Paths (All 21 Platforms) */}
        <section className="hud-panel p-4">
          <HudSectionHead
            desc={t("platformPathsDesc")}
            icon={FolderOpen}
            title={t("platformPaths")}
          />
          <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <HudPathRow
              defaultHint="~/.claude"
              label={t("claudeHomePath")}
              onSave={(v) => updateSettings({ claudeHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.claudeHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.codex"
              label={t("codexHomePath")}
              onSave={(v) => updateSettings({ codexHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.codexHome ?? ""}
            />
            <HudPathRow
              defaultHint={t("hud.codexProjectRootHint")}
              label={t("codexProjectRootPath")}
              onSave={(v) => updateSettings({ codexProjectRoot: v || null })}
              pickMode="directory"
              value={snapshot.settings.codexProjectRoot ?? ""}
            />
            <HudPathRow
              defaultHint="%APPDATA%\Cursor\User"
              label={t("cursorHomePath")}
              onSave={(v) => updateSettings({ cursorHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.cursorHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.local/share/opencode/opencode.db"
              label={t("opencodePath")}
              onSave={(v) => updateSettings({ opencodePath: v || null })}
              pickMode="file"
              value={snapshot.settings.opencodePath ?? ""}
            />
            <HudPathRow
              defaultHint="%APPDATA%/devin/cli"
              label={t("devinHome")}
              onSave={(v) => updateSettings({ devinHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.devinHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.gemini"
              label={t("geminiHome")}
              onSave={(v) => updateSettings({ geminiHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.geminiHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.kiro"
              label={t("kiroHome")}
              onSave={(v) => updateSettings({ kiroHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.kiroHome ?? ""}
            />
            <HudPathRow
              defaultHint="%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent"
              label={t("kiroIdeHome")}
              onSave={(v) => updateSettings({ kiroIdeHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.kiroIdeHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.grok"
              label={t("grokHome")}
              onSave={(v) => updateSettings({ grokHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.grokHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.pi/agent"
              label={t("piHome")}
              onSave={(v) => updateSettings({ piHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.piHome ?? ""}
            />
            <HudPathRow
              defaultHint="%LOCALAPPDATA%\Zed"
              label={t("zedHome")}
              onSave={(v) => updateSettings({ zedHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.zedHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.cline"
              label={t("clineHome")}
              onSave={(v) => updateSettings({ clineHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.clineHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.qwen"
              label={t("qwenHome")}
              onSave={(v) => updateSettings({ qwenHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.qwenHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.zcode"
              label={t("zcodeHome")}
              onSave={(v) => updateSettings({ zcodeHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.zcodeHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.workbuddy"
              label={t("workbuddyHome")}
              onSave={(v) => updateSettings({ workbuddyHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.workbuddyHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.codebuddy"
              label={t("codebuddyHome")}
              onSave={(v) => updateSettings({ codebuddyHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.codebuddyHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.dsh"
              label={t("dshHome")}
              onSave={(v) => updateSettings({ dshHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.dshHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.qoder-cn"
              label={t("qoderCnHome")}
              onSave={(v) => updateSettings({ qoderCnHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.qoderCnHome ?? ""}
            />
            <HudPathRow
              defaultHint="%APPDATA%\Cindy"
              label={t("cindyHome")}
              onSave={(v) => updateSettings({ cindyHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.cindyHome ?? ""}
            />
            <HudPathRow
              defaultHint="%APPDATA%\CindyGlobal"
              label={t("cindyGlobalHome")}
              onSave={(v) => updateSettings({ cindyGlobalHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.cindyGlobalHome ?? ""}
            />
            <HudPathRow
              defaultHint="~/.gemini/antigravity"
              label={t("antigravityHome")}
              onSave={(v) => updateSettings({ antigravityHome: v || null })}
              pickMode="directory"
              value={snapshot.settings.antigravityHome ?? ""}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function HudSectionHead({
  icon: Icon,
  title,
  desc,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-2.5 border-b border-[var(--line-subtle)] pb-2.5">
      <div className="grid size-7 shrink-0 place-items-center rounded-[4px] border border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]">
        <Icon className="size-3.5" />
      </div>
      <div>
        <h2 className="text-xs font-bold text-[var(--text-hi)]">{title}</h2>
        <p className="text-[11px] text-[var(--text-low)]">{desc}</p>
      </div>
    </div>
  );
}

function HudToggleRow({
  checked,
  label,
  desc,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  desc: string;
  disabled?: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-[4px] border p-2.5",
        disabled
          ? "border-[var(--line-hair)] opacity-50"
          : checked
            ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)]"
            : "border-[var(--line-hair)] bg-[var(--bg-elevated)]"
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold">{label}</p>
        <p className="mt-0.5 line-clamp-1 text-[10.5px] text-[var(--text-low)]">
          {desc}
        </p>
      </div>
      <button
        aria-checked={checked}
        className="toggle-track shrink-0"
        data-state={checked ? "on" : "off"}
        disabled={disabled}
        onClick={() => {
          if (!disabled) void onToggle(!checked);
        }}
        role="switch"
        type="button"
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

function HudPathRow({
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
    if (trimmed === (value ?? "")) return;
    await onSave(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
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
      if (typeof selected === "string") {
        setDraft(selected);
        await commit(selected);
      }
    } catch {
      // user cancelled
    }
  };

  return (
    <div className="rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] p-2.5">
      <div className="mb-1.5 flex items-center justify-between text-xs font-medium">
        <span className="truncate">{label}</span>
        {saved && <Check className="size-3.5 text-[var(--emerald-fg)]" />}
      </div>
      <div className="flex gap-1.5">
        <input
          className="hud-mono min-w-0 flex-1 rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-void)] px-2.5 py-1 text-[11px] text-[var(--text-hi)] placeholder:text-[var(--text-low)] outline-none focus:border-[var(--cyan)]"
          onBlur={() => void commit()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
          }}
          placeholder={defaultHint}
          value={draft}
        />
        <button
          type="button"
          onClick={() => void handleBrowse()}
          className="grid size-7 shrink-0 place-items-center rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:border-[var(--cyan-line)] hover:text-[var(--cyan-fg)]"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
