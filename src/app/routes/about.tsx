import { useState } from "react";
import { Brain, Eye, Flame, Globe, Monitor, Shield, ExternalLink, MessageCircle, Server, RefreshCw, CheckCircle, Download, ArrowUpCircle, AlertCircle } from "lucide-react";
import { AppLogo } from "@/components/logo";
import { useDesktop } from "@/features/desktop/provider";
import { api } from "@/features/desktop/api";
import type { UpdateInfo } from "@/features/desktop/types";
import { open } from "@tauri-apps/plugin-shell";
import { cn } from "@/lib/utils";

function openUrl(url: string) {
  open(url).catch(() => {
    window.open(url, "_blank");
  });
}

function formatReleaseNotes(raw: string): React.ReactNode[] {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("|") && (trimmed.includes("---") || trimmed.includes("平台") || trimmed.includes("Platform"))) return false;
      if (trimmed.match(/^\|.*\|$/)) return false;
      if (trimmed === "") return false;
      return true;
    });

  return lines.map((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      return <h4 key={i} className="text-sm font-semibold text-foreground pt-1">{trimmed.replace(/^##\s+/, "")}</h4>;
    }
    if (trimmed.startsWith("### ")) {
      return <h5 key={i} className="text-xs font-semibold text-foreground/80">{trimmed.replace(/^###\s+/, "")}</h5>;
    }
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      return <p key={i} className="pl-3 before:content-['•'] before:mr-1.5 before:text-amber-400/60">{trimmed.replace(/^[-*]\s+/, "")}</p>;
    }
    return <p key={i}>{trimmed}</p>;
  });
}

export default function AboutPage() {
  const { t, snapshot } = useDesktop();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const info = await api.checkUpdate();
      setUpdateInfo(info);
    } catch (err) {
      setCheckError(String(err));
    }
    setChecking(false);
  };

  const features = [
    { icon: <Brain className="size-5" />, title: t("editMemory"), desc: t("memoryManipulationDesc") },
    { icon: <Shield className="size-5" />, title: t("localFirst"), desc: "100% \u672c\u5730\u8fd0\u884c\uff0c\u96f6\u4e91\u7aef\u4f9d\u8d56\u3002\u4f60\u7684\u6570\u636e\u4e0d\u4f1a\u79bb\u5f00\u4f60\u7684\u7535\u8111\u3002" },
    { icon: <Globe className="size-5" />, title: t("multiPlatform"), desc: "Claude Code / Codex CLI / OpenCode \u7edf\u4e00\u7ba1\u7406\u3002" },
    { icon: <Eye className="size-5" />, title: t("auditLog"), desc: "\u53ea\u8bfb\u5ba1\u8ba1\u65e5\u5fd7\uff0c\u652f\u6301 diff \u5bf9\u6bd4\uff0c\u6bcf\u4e00\u6b65\u4fee\u6539\u53ef\u8ffd\u6eaf\u3002" },
    { icon: <Monitor className="size-5" />, title: t("sessionAlias"), desc: "\u7ed9\u4f1a\u8bdd\u8d77\u4e00\u4e2a\u5bb9\u6613\u8bb0\u7684\u540d\u5b57\uff0c\u5feb\u901f\u5b9a\u4f4d\u3002" },
    { icon: <Flame className="size-5" />, title: t("darkLightTheme"), desc: "\u77f3\u58a8\u591c\u8272\u3001\u4e9a\u9ebb\u7eb8\u611f\u3001\u6d77\u6e7e\u9752\u84dd\u3001\u4f59\u70ec\u94dc\u7ea2 \u2014 \u56db\u5957\u4e3b\u9898\u3002" },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2">
      {/* Author — top */}
      <section className="relative shrink-0 overflow-hidden rounded-[28px] border border-border/80 px-6 py-6 md:px-8 md:py-8">
        <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.16),transparent_64%)] lg:block" />
        <div className="relative flex items-center gap-5">
          <div className="inline-flex size-16 shrink-0 items-center justify-center rounded-2xl overflow-hidden">
            <AppLogo className="size-16" />
          </div>
          <div className="min-w-0">
            <p className="text-fine uppercase tracking-[0.28em] text-quiet">Memory Forge</p>
            <h2 className="mt-1 text-2xl font-semibold md:text-3xl">VoidCraft</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => openUrl("https://github.com/voidcraft-dev")}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-white/5 px-3 py-1.5 text-sm text-foreground/86 transition hover:bg-white/10"
              >
                <ExternalLink className="size-3.5" />
                GitHub
              </button>
              <button
                onClick={() => openUrl("https://qm.qq.com/q/e2y8CNQ8lq")}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-white/5 px-3 py-1.5 text-sm text-foreground/86 transition hover:bg-white/10"
              >
                <MessageCircle className="size-3.5" />
                QQ群: 野生AI观测
              </button>
              <button
                onClick={handleCheckUpdate}
                disabled={checking}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition",
                  updateInfo?.hasUpdate
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                    : "border-border/80 bg-white/5 text-foreground/86 hover:bg-white/10"
                )}
              >
                <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
                {checking ? t("checking") : t("checkUpdate")}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Update status */}
      {updateInfo && !updateInfo.hasUpdate && (
        <section className="mt-4 flex items-center gap-3 rounded-2xl border border-green-500/30 bg-green-500/8 px-5 py-3">
          <CheckCircle className="size-5 text-green-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-green-400">{t("upToDate")}</p>
            <p className="text-xs text-quiet">v{updateInfo.currentVersion}</p>
          </div>
        </section>
      )}

      {updateInfo?.hasUpdate && (
        <section className="mt-4 rounded-[24px] border border-amber-500/30 bg-gradient-to-r from-amber-500/8 to-transparent p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
                <ArrowUpCircle className="size-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-amber-400">{t("updateAvailable")}</h3>
                <p className="mt-1 text-sm text-quiet">
                  v{updateInfo.currentVersion} → <span className="font-semibold text-foreground">v{updateInfo.latestVersion}</span>
                </p>
                {updateInfo.releaseNotes && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-medium text-quiet hover:text-foreground">{t("releaseNotes")}</summary>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-background/50 p-4 text-xs leading-relaxed text-quiet space-y-2">
                      {formatReleaseNotes(updateInfo.releaseNotes)}
                    </div>
                  </details>
                )}
              </div>
            </div>
            <button
              onClick={() => openUrl(updateInfo.releaseUrl)}
              className="inline-flex shrink-0 items-center gap-2 rounded-full bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-400 transition hover:bg-amber-500/30"
            >
              <Download className="size-4" />
              {t("downloadUpdate")}
            </button>
          </div>
        </section>
      )}

      {checkError && (
        <section className="mt-4 flex items-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/8 px-5 py-3">
          <AlertCircle className="size-5 text-red-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-400">{t("checkFailed")}</p>
            <p className="text-xs text-quiet">{checkError}</p>
          </div>
        </section>
      )}

      {/* Features */}
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {features.map((f) => (
          <article key={f.title} className="setting-card rounded-[24px] p-5">
            <div className="space-y-3">
              <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                {f.icon}
              </div>
              <div>
                <h3 className="text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-quiet">{f.desc}</p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* Tech Stack */}
      <section className="mt-5 setting-card rounded-[24px] p-5">
        <p className="text-fine uppercase tracking-[0.24em] text-quiet">Tech Stack</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {["Tauri v2", "Rust", "React 19", "TypeScript", "Tailwind CSS 4", "SQLite", "Vite"].map(
            (tech) => (
              <span key={tech} className="rounded-full border border-border/80 bg-white/5 px-3 py-1.5 text-sm text-foreground/86">
                {tech}
              </span>
            )
          )}
        </div>
      </section>

      {/* Runtime */}
      {snapshot && (
        <section className="mt-5 setting-card rounded-[24px] p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary">
              <Server className="size-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">{t("runtime")}</h3>
              <p className="mt-2 text-sm leading-6 text-quiet">{t("desktopBehaviorDesc")}</p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <MetaRow label={t("runtime")} value={snapshot.runtime === "tauri" ? t("runtimeTauri") : t("runtimeWebPreview")} />
            <MetaRow label={t("trayReady")} value={snapshot.trayAvailable ? t("toggleOn") : t("toggleOff")} />
            <MetaRow label={t("configDir")} value={snapshot.configDir} />
            <MetaRow label={t("dataDir")} value={snapshot.dataDir} />
            <MetaRow label={t("dbPath")} value={snapshot.dbPath} />
          </div>
        </section>
      )}
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
