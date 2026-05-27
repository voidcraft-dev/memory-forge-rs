import { type ComponentType, useState } from "react";
import { Check, FolderOpen, Languages, Rocket, Sparkles, SlidersHorizontal } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  localeCatalog,
  themeCatalog,
} from "@/features/desktop/catalog";
import { useDesktop } from "@/features/desktop/provider";
import type { ThemeId } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

const PLATFORM_ITEMS = [
  { id: "claude", labelKey: "platformClaude" as const },
  { id: "codex", labelKey: "platformCodex" as const },
  { id: "opencode", labelKey: "platformOpencode" as const },
  { id: "kiro", labelKey: "platformKiro" as const },
  { id: "kiro-ide", labelKey: "platformKiroIde" as const },
  { id: "gemini", labelKey: "platformGemini" as const },
];

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
        <div className="panel-surface rounded-[24px] px-5 py-4 text-sm text-quiet">
          {t("loading")}
        </div>
      </div>
    );
  }

  const visiblePlatforms = snapshot.settings.visiblePlatforms ?? ["claude", "codex", "opencode"];

  const togglePlatformVisible = async (platformId: string, enabled: boolean) => {
    const next = enabled
      ? [...visiblePlatforms, platformId]
      : visiblePlatforms.filter((p) => p !== platformId);
    await updateSettings({ visiblePlatforms: next });
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2">
      <section className="relative overflow-hidden rounded-[28px] border border-border/80 px-6 py-5 md:px-8">
        <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.14),transparent_64%)] lg:block" />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <p className="text-fine uppercase tracking-[0.28em] text-quiet">{t("settings")}</p>
            <h2 className="mt-1.5 text-2xl font-semibold">Memory Forge</h2>
          </div>
          <div className="rounded-full border border-border/80 bg-white/5 px-4 py-1.5 text-sm text-quiet shrink-0">
            {saving ? "Saving..." : snapshot.settings.theme}
          </div>
        </div>
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.86fr)]">
        <div className="space-y-4">
          <section className="setting-card rounded-[24px] p-5">
            <SectionHeader icon={Sparkles} title={t("themeSection")} description={t("themeSectionDesc")} />
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {themeCatalog.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  active={snapshot.settings.theme === theme.id}
                  themeId={theme.id}
                  title={theme.label[snapshot.settings.locale]}
                  description={theme.description[snapshot.settings.locale]}
                  preview={theme.preview}
                  onSelect={setTheme}
                />
              ))}
            </div>
          </section>

          <section className="setting-card rounded-[24px] p-5">
            <SectionHeader icon={Languages} title={t("languageSection")} description={t("languageSectionDesc")} />
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {localeCatalog.map((locale) => (
                <button
                  key={locale.id}
                  className={cn(
                    "rounded-[22px] border px-4 py-4 text-left transition",
                    snapshot.settings.locale === locale.id
                      ? "border-primary/40 bg-primary/12"
                      : "border-border/70 bg-white/4 hover:bg-white/7"
                  )}
                  onClick={() => void setLocale(locale.id)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-base font-medium">{locale.label[snapshot.settings.locale]}</p>
                      <p className="mt-1 text-sm leading-6 text-quiet">{locale.description[snapshot.settings.locale]}</p>
                    </div>
                    {snapshot.settings.locale === locale.id && <Check className="size-4 text-primary" />}
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section className="setting-card rounded-[24px] p-5">
            <SectionHeader icon={Rocket} title={t("desktopBehavior")} description={t("desktopBehaviorDesc")} />
            <div className="mt-5 space-y-3">
              <ToggleRow checked={snapshot.settings.closeToTrayOnClose} description={t("closeBehaviorDesc")} label={t("closeBehavior")} onToggle={setCloseToTrayOnClose} />
              <ToggleRow
                checked={snapshot.settings.launchOnStartup}
                description={snapshot.autostartSupported ? t("launchOnStartupDesc") : t("autostartUnavailable")}
                disabled={!snapshot.autostartSupported}
                label={t("launchOnStartup")}
                onToggle={setLaunchOnStartup}
              />
              <ToggleRow checked={snapshot.settings.reduceMotion} description={t("reduceMotionDesc")} label={t("reduceMotion")} onToggle={setReduceMotion} />
            </div>
          </section>

          <section className="setting-card rounded-[24px] p-5">
            <SectionHeader icon={SlidersHorizontal} title={t("sidebarSection")} description={t("sidebarSectionDesc")} />
            <div className="mt-5 grid grid-cols-2 gap-2">
              {PLATFORM_ITEMS.map(({ id, labelKey }) => {
                const enabled = visiblePlatforms.includes(id);
                return (
                  <div
                    key={id}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-[18px] border px-3 py-2.5 transition",
                      enabled ? "border-primary/30 bg-primary/8" : "border-border/50 bg-white/3"
                    )}
                  >
                    <span className={cn("text-sm font-medium truncate", enabled ? "text-foreground" : "text-quiet")}>
                      {t(labelKey)}
                    </span>
                    <button
                      aria-checked={enabled}
                      className="toggle-track shrink-0 scale-[0.85]"
                      data-state={enabled ? "on" : "off"}
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

          <section className="setting-card rounded-[24px] p-5">
            <SectionHeader icon={FolderOpen} title={t("platformPaths")} description={t("platformPathsDesc")} />
            <div className="mt-5 space-y-3">
              <PathRow
                label={t("claudeHomePath")}
                defaultHint="~/.claude"
                pickMode="directory"
                value={snapshot.settings.claudeHome ?? ""}
                onSave={(v) => updateSettings({ claudeHome: v || null })}
              />
              <PathRow
                label={t("codexHomePath")}
                defaultHint="~/.codex"
                pickMode="directory"
                value={snapshot.settings.codexHome ?? ""}
                onSave={(v) => updateSettings({ codexHome: v || null })}
              />
              <PathRow
                label={t("codexProjectRootPath")}
                defaultHint="例如 F:\\workspacevk；留空显示全部 Codex 会话"
                pickMode="directory"
                value={snapshot.settings.codexProjectRoot ?? ""}
                onSave={(v) => updateSettings({ codexProjectRoot: v || null })}
              />
              <PathRow
                label={t("opencodePath")}
                defaultHint="~/.local/share/opencode/opencode.db"
                pickMode="file"
                value={snapshot.settings.opencodePath ?? ""}
                onSave={(v) => updateSettings({ opencodePath: v || null })}
              />
              <PathRow
                label={t("kiroHome")}
                defaultHint="~/.kiro"
                pickMode="directory"
                value={snapshot.settings.kiroHome ?? ""}
                onSave={(v) => updateSettings({ kiroHome: v || null })}
              />
              <PathRow
                label={t("kiroIdeHome")}
                defaultHint="%APPDATA%\\Kiro\\User\\globalStorage\\kiro.kiroagent"
                pickMode="directory"
                value={snapshot.settings.kiroIdeHome ?? ""}
                onSave={(v) => updateSettings({ kiroIdeHome: v || null })}
              />
              <PathRow
                label={t("geminiHome")}
                defaultHint="~/.gemini"
                pickMode="directory"
                value={snapshot.settings.geminiHome ?? ""}
                onSave={(v) => updateSettings({ geminiHome: v || null })}
              />
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, description }: { icon: ComponentType<{ className?: string }>; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary">
        <Icon className="size-5" />
      </div>
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-quiet">{description}</p>
      </div>
    </div>
  );
}

function ThemeCard({ active, themeId, title, description, preview, onSelect }: { active: boolean; themeId: ThemeId; title: string; description: string; preview: [string, string, string]; onSelect: (theme: ThemeId) => Promise<void> }) {
  return (
    <button
      className={cn("rounded-[22px] border px-4 py-4 text-left transition", active ? "border-primary/42 bg-primary/10" : "border-border/70 bg-white/4 hover:bg-white/7")}
      onClick={() => void onSelect(themeId)}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex gap-2">
            {preview.map((color) => (
              <span key={color} className="size-3 rounded-full ring-1 ring-black/10" style={{ backgroundColor: color }} />
            ))}
          </div>
          <p className="mt-3 text-base font-medium">{title}</p>
          <p className="mt-1 text-sm leading-6 text-quiet">{description}</p>
        </div>
        {active && <Check className="size-4 text-primary" />}
      </div>
    </button>
  );
}

function ToggleRow({ checked, label, description, disabled, onToggle }: { checked: boolean; label: string; description: string; disabled?: boolean; onToggle: (enabled: boolean) => Promise<void> }) {
  return (
    <div className={cn("rounded-[22px] border px-4 py-4", disabled ? "border-border/50 bg-white/3 opacity-60" : "border-border/70 bg-white/4")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-base font-medium">{label}</p>
          <p className="mt-1 text-sm leading-6 text-quiet">{description}</p>
        </div>
        <button
          aria-checked={checked}
          className="toggle-track shrink-0"
          data-state={checked ? "on" : "off"}
          disabled={disabled}
          onClick={() => { if (!disabled) void onToggle(!checked); }}
          role="switch"
          type="button"
        >
          <span className="toggle-thumb" />
        </button>
      </div>
    </div>
  );
}

function PathRow({ label, defaultHint, pickMode, value, onSave }: { label: string; defaultHint: string; pickMode: "directory" | "file"; value: string; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);

  const commit = async (v?: string) => {
    const trimmed = (v ?? draft).trim();
    if (trimmed === (value ?? "")) return;
    await onSave(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: pickMode === "directory",
        multiple: false,
        filters: pickMode === "file" ? [{ name: "Database", extensions: ["db"] }] : undefined,
      });
      if (selected) {
        setDraft(selected);
        await commit(selected);
      }
    } catch { /* user cancelled */ }
  };

  return (
    <div className="rounded-[22px] border border-border/70 bg-white/4 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium shrink-0">{label}</label>
        {saved && <Check className="size-3.5 text-green-400 animate-in fade-in" />}
      </div>
      <div className="mt-1.5 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === "Enter") void commit(); }}
          placeholder={defaultHint}
          className="min-w-0 flex-1 rounded-xl border border-border/50 bg-muted/30 px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none transition-colors"
        />
        <button
          type="button"
          onClick={() => void handleBrowse()}
          className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/30 text-muted-foreground transition-colors hover:bg-primary/12 hover:text-primary"
        >
          <FolderOpen className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
