import type { LocaleId, ThemeId } from "@/features/desktop/types";

type LocalizedText = Record<LocaleId, string>;

export type ThemeSpec = {
  id: "chrono" | "braun";
  label: LocalizedText;
  description: LocalizedText;
  preview: [string, string, string];
  mode: "dark" | "light";
};

export const themeCatalog: ThemeSpec[] = [
  {
    id: "chrono",
    label: { "zh-CN": "曜石熔金 (暗色 HUD)", en: "Chrono Obsidian (Dark)" },
    description: {
      "zh-CN": "高反差冷曜石机架与熔金手术烙印，专为长时代码阅读与上下文操控调校。",
      en: "High-contrast cold obsidian rack with molten amber surgical accents.",
    },
    preview: ["#06080c", "#f59e0b", "#22d3ee"],
    mode: "dark",
  },
  {
    id: "braun",
    label: { "zh-CN": "钛白工程 (浅色 HUD)", en: "Braun Titanium (Light)" },
    description: {
      "zh-CN": "精密仪器说明书风格的冷钛白浅色模式，1px 墨水发丝线与高对比信号色。",
      en: "Precision engineering manual light mode with crisp hairline borders.",
    },
    preview: ["#f3f5f8", "#0284c7", "#d97706"],
    mode: "light",
  },
];

export const localeCatalog: Array<{
  id: LocaleId;
  label: LocalizedText;
  description: LocalizedText;
}> = [
  {
    id: "zh-CN",
    label: { "zh-CN": "简体中文", en: "Simplified Chinese" },
    description: {
      "zh-CN": "适合中文工作流，默认推荐。",
      en: "Recommended when your primary workflow is Chinese.",
    },
  },
  {
    id: "en",
    label: { "zh-CN": "English", en: "English" },
    description: {
      "zh-CN": "适合国际化团队和英文技术术语。",
      en: "Best for international teams and English-first technical terms.",
    },
  },
];

export function resolveHudTheme(themeId?: string | null): "chrono" | "braun" {
  if (themeId === "braun" || themeId === "porcelain" || themeId === "linen") {
    return "braun";
  }
  return "chrono";
}

export function getThemeSpec(themeId?: ThemeId | string | null): ThemeSpec {
  const resolved = resolveHudTheme(themeId);
  return themeCatalog.find((theme) => theme.id === resolved) ?? themeCatalog[0];
}
