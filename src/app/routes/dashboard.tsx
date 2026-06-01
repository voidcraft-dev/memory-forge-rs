import { useEffect } from "react";
import { ArrowRight, Bot, Brain, Code, Flame, Terminal, Sparkles, MousePointer2, Gem, Pi } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { AppLogo } from "@/components/logo";
import { useDesktop } from "@/features/desktop/provider";
import { api } from "@/features/desktop/api";
import { cn } from "@/lib/utils";

const platformMeta = [
  {
    key: "claude",
    label: "Claude Code",
    icon: Bot,
    to: "/claude",
    gradient: "from-violet-500/10 to-violet-600/5",
    border: "border-violet-500/20 hover:border-violet-500/40",
    iconBg: "bg-violet-500/15 text-violet-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(139,92,246,0.12)] hover:-translate-y-1"
  },
  {
    key: "codex",
    label: "Codex CLI",
    icon: Terminal,
    to: "/codex",
    gradient: "from-emerald-500/10 to-emerald-600/5",
    border: "border-emerald-500/20 hover:border-emerald-500/40",
    iconBg: "bg-emerald-500/15 text-emerald-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(16,185,129,0.12)] hover:-translate-y-1"
  },
  {
    key: "cursor",
    label: "Cursor",
    icon: MousePointer2,
    to: "/cursor",
    gradient: "from-sky-500/10 to-sky-600/5",
    border: "border-sky-500/20 hover:border-sky-500/40",
    iconBg: "bg-sky-500/15 text-sky-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(14,165,233,0.12)] hover:-translate-y-1"
  },
  {
    key: "opencode",
    label: "OpenCode",
    icon: Code,
    to: "/opencode",
    gradient: "from-sky-500/10 to-sky-600/5",
    border: "border-sky-500/20 hover:border-sky-500/40",
    iconBg: "bg-sky-500/15 text-sky-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(14,165,233,0.12)] hover:-translate-y-1"
  },
  {
    key: "kiro",
    label: "Kiro CLI",
    icon: Sparkles,
    to: "/kiro",
    gradient: "from-purple-500/10 to-purple-600/5",
    border: "border-purple-500/20 hover:border-purple-500/40",
    iconBg: "bg-purple-500/15 text-purple-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(168,85,247,0.12)] hover:-translate-y-1"
  },
  {
    key: "kiro-ide",
    label: "Kiro IDE",
    icon: Sparkles,
    to: "/kiro-ide",
    gradient: "from-fuchsia-500/10 to-fuchsia-600/5",
    border: "border-fuchsia-500/20 hover:border-fuchsia-500/40",
    iconBg: "bg-fuchsia-500/15 text-fuchsia-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(217,70,239,0.12)] hover:-translate-y-1"
  },
  {
    key: "gemini",
    label: "Gemini CLI",
    icon: Gem,
    to: "/gemini",
    gradient: "from-blue-500/10 to-indigo-600/5",
    border: "border-blue-500/20 hover:border-indigo-500/40",
    iconBg: "bg-blue-500/15 text-blue-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(59,130,246,0.12)] hover:-translate-y-1"
  },
  {
    key: "pi",
    label: "Pi",
    icon: Pi,
    to: "/pi",
    gradient: "from-rose-500/10 to-cyan-600/5",
    border: "border-rose-500/20 hover:border-cyan-500/40",
    iconBg: "bg-rose-500/15 text-rose-400 group-hover:scale-110",
    hoverGlow: "hover:shadow-[0_8px_30px_rgba(244,63,94,0.12)] hover:-translate-y-1"
  },
] as const;

export default function DashboardPage() {
  const { snapshot, loading, t, state, dispatch } = useDesktop();

  useEffect(() => {
    api.getDashboard()
      .then((data) => dispatch({ type: "setDashboard", payload: data }))
      .catch(console.error);
  }, [dispatch]);

  const platforms = state.dashboard?.platforms ?? [];
  const visiblePlatforms = snapshot?.settings?.visiblePlatforms ?? ["claude", "codex", "opencode", "pi"];
  const displayPlatforms = platformMeta.filter((pm) => visiblePlatforms.includes(pm.key));

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2 pb-6">
      {/* Hero with dynamic glowing abstract background */}
      <section className="relative shrink-0 overflow-hidden rounded-[28px] border border-border/80 bg-gradient-to-br from-card/85 via-card/75 to-card/40 px-6 py-7 md:px-8 md:py-8 backdrop-blur-md shadow-xl shadow-black/10">
        {/* Glow Spheres */}
        <div className="absolute -top-12 -left-12 size-48 bg-primary/8 blur-[90px] rounded-full pointer-events-none" />
        <div className="absolute -bottom-16 -right-16 size-56 bg-violet-500/6 blur-[110px] rounded-full pointer-events-none" />
        <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.04),transparent_72%)] lg:block pointer-events-none" />

        <div className="relative flex flex-col gap-6">
          <div className="flex flex-col md:flex-row md:items-center gap-5">
            <div className="inline-flex size-16 shrink-0 items-center justify-center rounded-2xl overflow-hidden shadow-lg shadow-black/25 ring-soft bg-stone-900 border border-white/5 transition-transform duration-300 hover:scale-105 select-none">
              <AppLogo className="size-16" />
            </div>
            <div className="min-w-0">
              <p className="text-fine uppercase tracking-[0.28em] text-primary font-bold">Memory Forge</p>
              <h2 className="mt-1 max-w-3xl text-3xl font-extrabold leading-tight md:text-4xl bg-gradient-to-r from-foreground via-foreground to-foreground/80 bg-clip-text text-transparent">
                {t("welcomeTitle")}
              </h2>
            </div>
          </div>
          <p className="max-w-3xl text-sm md:text-base leading-7 text-quiet">{t("welcomeDesc")}</p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button asChild size="lg" className="rounded-xl shadow-md shadow-primary/14 hover:shadow-lg hover:shadow-primary/22 cursor-pointer transition-all duration-200">
              <Link to="/prompts">
                {t("prompts")}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <div className="rounded-xl border border-border/80 bg-white/5 px-4 py-2.5 text-xs md:text-sm text-quiet backdrop-blur-md select-none font-medium">
              {loading
                ? t("loading")
                : `${snapshot?.appName ?? "Memory Forge"} · v${snapshot?.version ?? "3.3.1"}`}
            </div>
          </div>
        </div>
      </section>

      {/* Platform Session Cards */}
      <section className={cn(
        "mt-5 grid gap-4 grid-cols-2",
        displayPlatforms.length === 1 && "xl:grid-cols-1 max-w-sm",
        displayPlatforms.length === 2 && "xl:grid-cols-2 max-w-2xl",
        displayPlatforms.length === 3 && "xl:grid-cols-3 max-w-4xl",
        displayPlatforms.length === 4 && "xl:grid-cols-4",
        displayPlatforms.length >= 5 && "xl:grid-cols-5"
      )}>
        {displayPlatforms.map((pm) => {
          const Icon = pm.icon;
          const summary = platforms.find((p) => p.platform === pm.key);
          const count = summary?.count ?? 0;
          const latest = summary?.latest || "—";
          return (
            <Link
              key={pm.key}
              to={pm.to}
              className={cn(
                "group setting-card rounded-[24px] border bg-gradient-to-b p-5 h-[120px] flex flex-col justify-between transition-all duration-300",
                pm.gradient,
                pm.border,
                pm.hoverGlow
              )}
            >
              <div className="flex items-center gap-3">
                <div className={cn("inline-flex size-11 items-center justify-center rounded-2xl transition-all duration-300", pm.iconBg)}>
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-quiet group-hover:text-foreground transition-colors">{pm.label}</p>
                  <p className="text-2xl font-bold tracking-tight">{count}</p>
                </div>
              </div>
              <p className="truncate text-xs text-quiet border-t border-border/30 pt-2 mt-1">最近活跃: {latest}</p>
            </Link>
          );
        })}
      </section>

      {/* Feature Cards */}
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <FeatureCard icon={<Brain className="size-5" />} title={t("memoryManipulation")} description={t("memoryManipulationDesc")} />
        <FeatureCard icon={<Flame className="size-5" />} title={t("localFirst")} description="100% 本地运行，零云端依赖。你的数据不会离开你的电脑。" />
        <FeatureCard icon={<ArrowRight className="size-5" />} title={t("multiPlatform")} description="Claude Code / Codex CLI / OpenCode 统一管理，一个界面搞定。" />
      </section>

      {/* Quick Links */}
      <section className="mt-5 setting-card rounded-[24px] p-6 bg-gradient-to-r from-card/50 via-card/30 to-transparent border border-border/40">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="select-none">
            <p className="text-fine uppercase tracking-[0.24em] text-primary font-bold">快捷导航</p>
            <p className="text-xs text-quiet mt-1.5">快速跳转提示词库、全局参数配置或了解本项目</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Link to="/prompts" className="rounded-xl border border-border/80 bg-white/4 px-4 py-2.5 text-xs font-semibold text-foreground/86 hover:bg-primary/12 hover:text-primary hover:border-primary/30 transition-all duration-300">
              {t("promptLibrary")}
            </Link>
            <Link to="/settings" className="rounded-xl border border-border/80 bg-white/4 px-4 py-2.5 text-xs font-semibold text-foreground/86 hover:bg-primary/12 hover:text-primary hover:border-primary/30 transition-all duration-300">
              {t("settings")}
            </Link>
            <Link to="/about" className="rounded-xl border border-border/80 bg-white/4 px-4 py-2.5 text-xs font-semibold text-foreground/86 hover:bg-primary/12 hover:text-primary hover:border-primary/30 transition-all duration-300">
              {t("about")}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <article className="setting-card rounded-[24px] p-5 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300">
      <div className="space-y-3">
        <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-sm shadow-primary/5 transition-transform duration-300 hover:rotate-6">
          {icon}
        </div>
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-quiet">{description}</p>
        </div>
      </div>
    </article>
  );
}
