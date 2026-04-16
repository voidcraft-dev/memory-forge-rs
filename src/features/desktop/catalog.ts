import type { LocaleId, ThemeId } from "@/features/desktop/types";

type LocalizedText = Record<LocaleId, string>;

export type ThemeSpec = {
  id: ThemeId;
  label: LocalizedText;
  description: LocalizedText;
  preview: [string, string, string];
  mode: "dark" | "light";
};

export const themeCatalog: ThemeSpec[] = [
  {
    id: "graphite",
    label: { "zh-CN": "石墨夜色", en: "Graphite" },
    description: {
      "zh-CN": "偏产品化的深色控制台，适合工具型桌面应用。",
      en: "A product-minded dark control deck for serious desktop tooling.",
    },
    preview: ["#101319", "#6f89ff", "#edf1f7"],
    mode: "dark",
  },
  {
    id: "linen",
    label: { "zh-CN": "亚麻纸感", en: "Linen" },
    description: {
      "zh-CN": "温暖浅色主题，适合办公和长时间阅读。",
      en: "A warm editorial light theme for long-form work and office use.",
    },
    preview: ["#f6efe4", "#8a5a2f", "#261d16"],
    mode: "light",
  },
  {
    id: "porcelain",
    label: { "zh-CN": "素白云雾", en: "Porcelain" },
    description: {
      "zh-CN": "更干净的浅色白系主题，适合长期阅读与内容编辑。",
      en: "A cleaner white light theme for long-form reading and focused editing.",
    },
    preview: ["#fcfcfd", "#7a8cff", "#20263a"],
    mode: "light",
  },
  {
    id: "ocean",
    label: { "zh-CN": "海湾青蓝", en: "Ocean" },
    description: {
      "zh-CN": "偏工程感的冷色主题，适合监控和运维面板。",
      en: "A cool engineering palette for dashboards, logs, and operations.",
    },
    preview: ["#081f2e", "#43c7d7", "#e8f6fb"],
    mode: "dark",
  },
  {
    id: "ember",
    label: { "zh-CN": "余烬铜红", en: "Ember" },
    description: {
      "zh-CN": "更有情绪的暖色深色主题，适合品牌化外壳。",
      en: "A warm cinematic dark theme for branded desktop shells.",
    },
    preview: ["#1c1113", "#f1895d", "#fff1ea"],
    mode: "dark",
  },
  {
    id: "twilight",
    label: { "zh-CN": "暮光星紫", en: "Twilight" },
    description: {
      "zh-CN": "赛博朋克风格的深紫色主题，适合夜间编码。",
      en: "A cyberpunk-inspired deep purple theme for late-night coding.",
    },
    preview: ["#110d1a", "#b48eff", "#ede6f7"],
    mode: "dark",
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

export function getThemeSpec(themeId: ThemeId) {
  return themeCatalog.find((theme) => theme.id === themeId) ?? themeCatalog[0];
}
