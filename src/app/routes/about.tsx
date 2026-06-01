import { useState } from "react";
import { Brain, Eye, Flame, Globe, Monitor, Shield, ExternalLink, MessageCircle, Server, RefreshCw, CheckCircle, Download, ArrowUpCircle, AlertCircle, Copy, Check } from "lucide-react";
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
    { icon: <Brain className="size-5" />, title: t("editMemory"), desc: t("memoryManipulationDesc"), color: "from-violet-500/20 to-violet-600/10 text-violet-400 bg-violet-500/10" },
    { icon: <Shield className="size-5" />, title: t("localFirst"), desc: "100% 本地运行，零云端依赖。你的数据不会离开你的电脑。", color: "from-emerald-500/20 to-emerald-600/10 text-emerald-400 bg-emerald-500/10" },
    { icon: <Globe className="size-5" />, title: t("multiPlatform"), desc: "Claude Code / Codex CLI / OpenCode 统一管理。", color: "from-sky-500/20 to-sky-600/10 text-sky-400 bg-sky-500/10" },
    { icon: <Eye className="size-5" />, title: t("auditLog"), desc: "只读审计日志，支持 diff 对比，每一步修改可追溯。", color: "from-amber-500/20 to-amber-600/10 text-amber-400 bg-amber-500/10" },
    { icon: <Monitor className="size-5" />, title: t("sessionAlias"), desc: "给会话起一个容易记的名字，快速定位。", color: "from-blue-500/20 to-blue-600/10 text-blue-400 bg-blue-500/10" },
    { icon: <Flame className="size-5" />, title: t("darkLightTheme"), desc: "石墨夜色、亚麻纸感、素白云雾、海湾青蓝、余烬铜红、暮光星紫 — 六套主题。", color: "from-rose-500/20 to-rose-600/10 text-rose-400 bg-rose-500/10" },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2 pb-6">
      {/* Author — top with ambient glows */}
      <section className="relative shrink-0 overflow-hidden rounded-[28px] border border-border/80 px-6 py-6 md:px-8 md:py-8 bg-gradient-to-br from-card/85 via-card/75 to-card/40 backdrop-blur-md shadow-xl shadow-black/10">
        {/* Glow Spheres */}
        <div className="absolute -top-12 -left-12 size-48 bg-primary/8 blur-[90px] rounded-full pointer-events-none" />
        <div className="absolute -bottom-16 -right-16 size-56 bg-violet-500/6 blur-[110px] rounded-full pointer-events-none" />
        <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.04),transparent_72%)] lg:block pointer-events-none" />

        <div className="relative flex items-center gap-5">
          <div className="inline-flex size-16 shrink-0 items-center justify-center rounded-2xl overflow-hidden shadow-lg shadow-black/20 ring-soft">
            <AppLogo className="size-16" />
          </div>
          <div className="min-w-0">
            <p className="text-fine uppercase tracking-[0.28em] text-primary font-bold">Memory Forge</p>
            <h2 className="mt-1 text-2xl font-extrabold md:text-3xl bg-gradient-to-r from-foreground via-foreground to-foreground/80 bg-clip-text text-transparent">记忆锻造</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => openUrl("https://github.com/voidcraft-dev")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-border/80 bg-white/4 px-4 py-2 text-xs font-semibold text-foreground/86 transition hover:bg-primary/15 hover:text-primary hover:border-primary/25 cursor-pointer shadow-sm"
              >
                <ExternalLink className="size-3.5" />
                GitHub
              </button>
              <button
                onClick={() => openUrl("https://qm.qq.com/q/e2y8CNQ8lq")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-border/80 bg-white/4 px-4 py-2 text-xs font-semibold text-foreground/86 transition hover:bg-primary/15 hover:text-primary hover:border-primary/25 cursor-pointer shadow-sm"
              >
                <MessageCircle className="size-3.5" />
                QQ群: 野生AI观测
              </button>
              <button
                onClick={handleCheckUpdate}
                disabled={checking}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold transition cursor-pointer shadow-sm",
                  updateInfo?.hasUpdate
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                    : "border-border/80 bg-white/4 text-foreground/86 hover:bg-primary/15 hover:text-primary hover:border-primary/25"
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
        <section className="mt-4 flex items-center gap-3 rounded-2xl border border-green-500/35 bg-green-500/5 px-5 py-3.5 animate-in slide-in-from-top duration-300">
          <CheckCircle className="size-5 text-green-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-green-400">{t("upToDate")}</p>
            <p className="text-xs text-quiet font-medium">v{updateInfo.currentVersion}</p>
          </div>
        </section>
      )}

      {updateInfo?.hasUpdate && (
        <section className="mt-4 rounded-[24px] border border-amber-500/35 bg-gradient-to-r from-amber-500/8 to-transparent p-5 animate-in slide-in-from-top duration-300">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400 shadow-sm">
                <ArrowUpCircle className="size-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-amber-400">{t("updateAvailable")}</h3>
                <p className="mt-1 text-sm text-quiet">
                  v{updateInfo.currentVersion} → <span className="font-semibold text-foreground">v{updateInfo.latestVersion}</span>
                </p>
                {updateInfo.releaseNotes && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-quiet hover:text-foreground">{t("releaseNotes")}</summary>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-background/50 p-4 text-xs leading-relaxed text-quiet space-y-2 font-mono">
                      {formatReleaseNotes(updateInfo.releaseNotes)}
                    </div>
                  </details>
                )}
              </div>
            </div>
            <button
              onClick={() => openUrl(updateInfo.releaseUrl)}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-500/20 px-4 py-2 text-sm font-bold text-amber-400 transition hover:bg-amber-500/30 cursor-pointer shadow-sm"
            >
              <Download className="size-4" />
              {t("downloadUpdate")}
            </button>
          </div>
        </section>
      )}

      {checkError && (
        <section className="mt-4 flex items-center gap-3 rounded-2xl border border-red-500/35 bg-red-500/5 px-5 py-3.5 animate-in slide-in-from-top duration-300">
          <AlertCircle className="size-5 text-red-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-400">{t("checkFailed")}</p>
            <p className="text-xs text-quiet font-medium">{checkError}</p>
          </div>
        </section>
      )}

      {/* Features Grid */}
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {features.map((f) => (
          <article key={f.title} className="setting-card rounded-[24px] p-5 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300">
            <div className="space-y-3">
              <div className={cn("inline-flex size-11 items-center justify-center rounded-2xl shadow-sm transition-transform duration-300 hover:rotate-6", f.color)}>
                {f.icon}
              </div>
              <div>
                <h3 className="text-lg font-bold">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-quiet">{f.desc}</p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* Tech Stack */}
      <section className="mt-5 setting-card rounded-[24px] p-5 bg-gradient-to-r from-card/50 via-card/25 to-transparent border border-border/40">
        <p className="text-fine uppercase tracking-[0.24em] text-primary font-bold">Tech Stack</p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          {[
            { name: "Tauri v2", color: "text-sky-400 border-sky-400/20 bg-sky-500/5 hover:bg-sky-500/10" },
            { name: "Rust", color: "text-amber-500 border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10" },
            { name: "React 19", color: "text-blue-400 border-blue-400/20 bg-blue-500/5 hover:bg-blue-500/10" },
            { name: "TypeScript", color: "text-blue-500 border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10" },
            { name: "Tailwind CSS 4", color: "text-cyan-400 border-cyan-400/20 bg-cyan-500/5 hover:bg-cyan-500/10" },
            { name: "SQLite", color: "text-indigo-400 border-indigo-400/20 bg-indigo-500/5 hover:bg-indigo-500/10" },
            { name: "Vite", color: "text-purple-400 border-purple-400/20 bg-purple-500/5 hover:bg-purple-500/10" },
          ].map((tech) => (
            <span
              key={tech.name}
              className={cn(
                "rounded-xl border px-3.5 py-2 text-xs font-mono font-semibold transition duration-300 hover:-translate-y-0.5 shadow-sm backdrop-blur-md select-none",
                tech.color
              )}
            >
              {tech.name}
            </span>
          ))}
        </div>
      </section>

      {/* Runtime Environment with copy path buttons */}
      {snapshot && (
        <section className="mt-5 setting-card rounded-[24px] p-5 bg-gradient-to-r from-card/50 via-card/20 to-transparent border border-border/40">
          <div className="flex items-start gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-sm">
              <Server className="size-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold">{t("runtime")}</h3>
              <p className="mt-1 text-sm text-quiet">{t("desktopBehaviorDesc")}</p>
            </div>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
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
  const [copied, setCopied] = useState(false);
  const isPath = value.includes("\\") || value.includes("/") || value.includes(":");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="group relative rounded-2xl border border-border/60 bg-white/4 px-4 py-3.5 hover:bg-white/6 hover:border-border/80 transition-all duration-300 flex flex-col justify-between min-h-[96px]">
      <div className="flex items-center justify-between gap-3 select-none">
        <span className="text-fine uppercase tracking-[0.18em] text-primary/80 font-bold">{label}</span>
        {isPath && (
          <button
            onClick={handleCopy}
            className={cn(
              "opacity-0 group-hover:opacity-100 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded transition-all duration-200 cursor-pointer bg-white/5 border border-border/20",
              copied ? "text-green-400 bg-green-500/10 border-green-500/20 opacity-100!" : "text-quiet hover:text-foreground"
            )}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? '已复制' : '复制路径'}
          </button>
        )}
      </div>
      <div className={cn(
        "mt-2 break-all text-sm font-medium text-foreground/90 selection:bg-primary/20",
        isPath && "font-mono text-xs text-foreground/80 bg-muted/20 border border-border/30 p-2.5 rounded-lg leading-relaxed select-all"
      )}>
        {value}
      </div>
    </div>
  );
}
