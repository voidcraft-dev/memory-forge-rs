import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FolderOpen,
  Languages,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import { localeCatalog, themeCatalog } from "@/features/desktop/catalog";
import { useDesktop } from "@/features/desktop/provider";
import type { ThemeId } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

const PLATFORM_ITEMS = [
  { id: "claude", labelKey: "platformClaude" as const },
  { id: "codex", labelKey: "platformCodex" as const },
  { id: "cursor", labelKey: "platformCursor" as const },
  { id: "opencode", labelKey: "platformOpencode" as const },
  { id: "kiro", labelKey: "platformKiro" as const },
  { id: "kiro-ide", labelKey: "platformKiroIde" as const },
  { id: "gemini", labelKey: "platformGemini" as const },
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
  } = useDesktop();

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
    "cursor",
    "opencode",
  ];

  const togglePlatformVisible = async (
    platformId: string,
    enabled: boolean
  ) => {
    const next = enabled
      ? [...visiblePlatforms, platformId]
      : visiblePlatforms.filter((p) => p !== platformId);
    await updateSettings({ visiblePlatforms: next });
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

        {/* 3. Desktop Behavior Toggles */}
        <section className="setting-card rounded-[24px] p-5">
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
        </section>

        {/* 4. Preferred terminal */}
        <section className="setting-card rounded-[24px] p-5">
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
        </section>

        {/* 5. Platform Visibility Filters */}
        <section className="setting-card rounded-[24px] p-5">
          <SectionHeader
            description={t("sidebarSectionDesc")}
            icon={SlidersHorizontal}
            title={t("sidebarSection")}
          />
          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
            {PLATFORM_ITEMS.map(({ id, labelKey }) => {
              const enabled = visiblePlatforms.includes(id);
              return (
                <div
                  className={cn(
                    "flex items-center justify-between gap-2.5 rounded-[18px] border px-4 py-3 transition-all duration-300",
                    enabled
                      ? "border-primary/20 bg-primary/5"
                      : "border-border/50 bg-white/3"
                  )}
                  key={id}
                >
                  <span
                    className={cn(
                      "truncate font-semibold text-sm",
                      enabled ? "text-foreground" : "text-quiet"
                    )}
                  >
                    {t(labelKey)}
                  </span>
                  <button
                    aria-checked={enabled}
                    className="toggle-track shrink-0 scale-[0.82]"
                    data-state={enabled ? "on" : "off"}
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
        </section>

        {/* 6. Directory Paths configuration */}
        <section className="setting-card rounded-[24px] p-5">
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
          </div>
        </section>
      </div>
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
        "flex min-h-[128px] cursor-pointer flex-col justify-between rounded-[22px] border px-4 py-4 text-left transition-all duration-300 hover:scale-[1.01]",
        active
          ? "border-primary bg-gradient-to-br from-primary/14 via-primary/4 to-transparent shadow-md shadow-primary/4"
          : "border-border/60 bg-white/4 hover:border-border/80 hover:bg-white/7"
      )}
      onClick={() => void onSelect(themeId)}
      type="button"
    >
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
        {active && (
          <Check className="fade-in zoom-in mt-1 size-4 shrink-0 animate-in text-primary duration-200" />
        )}
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
