import { useEffect } from "react";
import { ArrowRight, Bot, Brain, Code, Flame, Terminal, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useDesktop } from "@/features/desktop/provider";
import { api } from "@/features/desktop/api";

const platformMeta = [
  { key: "claude", label: "Claude Code", icon: Bot, to: "/claude", gradient: "from-violet-500/15 to-violet-600/5", border: "border-violet-500/30", iconBg: "bg-violet-500/20 text-violet-400" },
  { key: "codex", label: "Codex CLI", icon: Terminal, to: "/codex", gradient: "from-emerald-500/15 to-emerald-600/5", border: "border-emerald-500/30", iconBg: "bg-emerald-500/20 text-emerald-400" },
  { key: "opencode", label: "OpenCode", icon: Code, to: "/opencode", gradient: "from-sky-500/15 to-sky-600/5", border: "border-sky-500/30", iconBg: "bg-sky-500/20 text-sky-400" },
  { key: "kiro", label: "Kiro CLI", icon: Sparkles, to: "/kiro", gradient: "from-purple-500/15 to-purple-600/5", border: "border-purple-500/30", iconBg: "bg-purple-500/20 text-purple-400" },
  { key: "kiro-ide", label: "Kiro IDE", icon: Sparkles, to: "/kiro-ide", gradient: "from-fuchsia-500/15 to-fuchsia-600/5", border: "border-fuchsia-500/30", iconBg: "bg-fuchsia-500/20 text-fuchsia-400" },
] as const;

export default function DashboardPage() {
  const { snapshot, loading, t, state, dispatch } = useDesktop();

  useEffect(() => {
    api.getDashboard()
      .then((data) => dispatch({ type: "setDashboard", payload: data }))
      .catch(console.error);
  }, [dispatch]);

  const platforms = state.dashboard?.platforms ?? [];

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[28px] border border-border/80 px-6 py-6 md:px-8 md:py-8">
        <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.16),transparent_64%)] lg:block" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-fine uppercase tracking-[0.28em] text-quiet">Memory Forge</p>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold leading-tight md:text-4xl">
              {t("welcomeTitle")}
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-quiet">{t("welcomeDesc")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link to="/prompts">
                {t("prompts")}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <div className="rounded-full border border-border/80 bg-white/5 px-4 py-2 text-sm text-quiet">
              {loading
                ? t("loading")
                : `${snapshot?.appName ?? "Memory Forge"} · v${snapshot?.version ?? "3.0.0"}`}
            </div>
          </div>
        </div>
      </section>

      {/* Platform Session Cards */}
      <section className="mt-5 grid gap-4 grid-cols-2 xl:grid-cols-5">
        {platformMeta.map((pm) => {
          const Icon = pm.icon;
          const summary = platforms.find((p) => p.platform === pm.key);
          const count = summary?.count ?? 0;
          const latest = summary?.latest || "—";
          return (
            <Link
              key={pm.key}
              to={pm.to}
              className={`setting-card rounded-[24px] border ${pm.border} bg-gradient-to-b ${pm.gradient} p-5 transition hover:scale-[1.02] hover:shadow-lg h-[120px] flex flex-col justify-between`}
            >
              <div className="flex items-center gap-3">
                <div className={`inline-flex size-11 items-center justify-center rounded-2xl ${pm.iconBg}`}>
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-quiet">{pm.label}</p>
                  <p className="text-2xl font-bold">{count}</p>
                </div>
              </div>
              <p className="truncate text-xs text-quiet">最近活跃: {latest}</p>
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
      <section className="mt-5 setting-card rounded-[24px] p-5">
        <p className="text-fine uppercase tracking-[0.24em] text-quiet">Quick Links</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link to="/prompts" className="rounded-full border border-border/80 bg-white/5 px-4 py-2 text-sm text-foreground/86 hover:bg-white/8 transition">
            {t("promptLibrary")}
          </Link>
          <Link to="/settings" className="rounded-full border border-border/80 bg-white/5 px-4 py-2 text-sm text-foreground/86 hover:bg-white/8 transition">
            {t("settings")}
          </Link>
          <Link to="/about" className="rounded-full border border-border/80 bg-white/5 px-4 py-2 text-sm text-foreground/86 hover:bg-white/8 transition">
            {t("about")}
          </Link>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <article className="setting-card rounded-[24px] p-5">
      <div className="space-y-3">
        <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-primary/12 text-primary">
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
