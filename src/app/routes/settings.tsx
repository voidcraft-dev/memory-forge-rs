import type { ComponentType } from "react";
import { Check, Languages, Rocket, Sparkles } from "lucide-react";
import {
  localeCatalog,
  themeCatalog,
} from "@/features/desktop/catalog";
import { useDesktop } from "@/features/desktop/provider";
import type { ThemeId } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

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

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2">
      <section className="flex flex-col gap-4 border-b border-border/80 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-fine uppercase tracking-[0.28em] text-quiet">{t("settings")}</p>
          <h2 className="mt-2 text-3xl font-semibold">Memory Forge</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-quiet">
            {t("desktopBehaviorDesc")}
          </p>
        </div>
        <div className="rounded-full border border-border/80 bg-white/5 px-4 py-2 text-sm text-quiet">
          {saving ? "Saving..." : `${t("currentTheme")}: ${snapshot.settings.theme}`}
        </div>
      </section>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.86fr)]">
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
            <p className="text-fine uppercase tracking-[0.24em] text-quiet">Runtime snapshot</p>
            <div className="mt-4 space-y-3 text-sm">
              <MetaRow label={t("runtime")} value={snapshot.runtime === "tauri" ? t("runtimeTauri") : t("runtimeWebPreview")} />
              <MetaRow label={t("trayReady")} value={snapshot.trayAvailable ? t("toggleOn") : t("toggleOff")} />
              <MetaRow label={t("configDir")} value={snapshot.configDir} />
              <MetaRow label={t("dataDir")} value={snapshot.dataDir} />
              <MetaRow label={t("dbPath")} value={snapshot.dbPath} />
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

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-white/4 px-4 py-3">
      <div className="text-fine uppercase tracking-[0.18em] text-quiet">{label}</div>
      <div className="mt-1 break-all text-sm text-foreground">{value}</div>
    </div>
  );
}
