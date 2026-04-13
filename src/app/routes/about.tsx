import { Brain, Eye, Flame, Globe, Monitor, Shield } from "lucide-react";
import { useDesktop } from "@/features/desktop/provider";

export default function AboutPage() {
  const { snapshot, t } = useDesktop();

  const features = [
    { icon: <Brain className="size-5" />, title: t("editMemory"), desc: t("memoryManipulationDesc") },
    { icon: <Shield className="size-5" />, title: t("localFirst"), desc: "100% 本地运行，零云端依赖。你的数据不会离开你的电脑。" },
    { icon: <Globe className="size-5" />, title: t("multiPlatform"), desc: "Claude Code / Codex CLI / OpenCode 统一管理。" },
    { icon: <Eye className="size-5" />, title: t("auditLog"), desc: "只读审计日志，支持 diff 对比，每一步修改可追溯。" },
    { icon: <Monitor className="size-5" />, title: t("sessionAlias"), desc: "给会话起一个容易记的名字，快速定位。" },
    { icon: <Flame className="size-5" />, title: t("darkLightTheme"), desc: "石墨夜色、亚麻纸感、海湾青蓝、余烬铜红 — 四套主题。" },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2">
      <section className="relative overflow-hidden rounded-[28px] border border-border/80 px-6 py-6 md:px-8 md:py-8">
        <div className="absolute inset-y-0 right-0 hidden w-[34%] bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.16),transparent_64%)] lg:block" />
        <div className="relative">
          <p className="text-fine uppercase tracking-[0.28em] text-quiet">Memory Forge</p>
          <h2 className="mt-3 text-3xl font-semibold md:text-4xl">{t("aboutTitle")}</h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-quiet">{t("aboutDesc")}</p>
        </div>
      </section>

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

      {snapshot && (
        <section className="mt-5 setting-card rounded-[24px] p-5">
          <p className="text-fine uppercase tracking-[0.24em] text-quiet">Runtime Info</p>
          <div className="mt-4 space-y-3 text-sm">
            <MetaRow label={t("runtime")} value={snapshot.runtime === "tauri" ? t("runtimeTauri") : t("runtimeWebPreview")} />
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
