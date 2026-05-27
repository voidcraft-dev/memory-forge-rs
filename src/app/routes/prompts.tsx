import {
  BookOpen,
  Copy,
  Download,
  Eye,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createPrompt,
  deletePrompt,
  exportPrompts,
  importPrompts,
  incrementPromptUse,
  listPrompts,
  updatePrompt,
} from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import type { PromptCreateInput, PromptItem } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

const PRESET_TAGS = [
  "代码",
  "写作",
  "翻译",
  "分析",
  "设计",
  "优化",
  "学习",
  "CTF",
  "焚诀",
  "其他",
];
const FENJUE_PROMPT_NAMES = ["焚诀·CTF 比赛"];
const FENJUE_VAULT_KEY = "焚诀";

const tagColors: Record<string, string> = {
  代码: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Code: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  写作: "bg-green-500/10 text-green-400 border-green-500/20",
  Writing: "bg-green-500/10 text-green-400 border-green-500/20",
  翻译: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  Translation: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  分析: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Analysis: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  设计: "bg-pink-500/10 text-pink-400 border-pink-500/20",
  Design: "bg-pink-500/10 text-pink-400 border-pink-500/20",
  优化: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  Optimization: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  学习: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Learning: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  CTF: "bg-red-500/10 text-red-400 border-red-500/20",
  焚诀: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  OpenCode: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
};

function getTagColor(tag: string): string {
  return tagColors[tag] || "bg-muted/30 text-muted-foreground border-border/30";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  return d.toLocaleDateString();
}

export default function PromptsPage() {
  const { t } = useDesktop();
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showVault, setShowVault] = useState(false);
  const [vaultKey, setVaultKey] = useState(FENJUE_VAULT_KEY);
  const [fenjueUnlocked, setFenjueUnlocked] = useState(false);

  // Viewing Details state
  const [viewingPrompt, setViewingPrompt] = useState<PromptItem | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalContent, setModalContent] = useState("");
  const [modalTags, setModalTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState("");

  // Import/Export
  const [showImportExport, setShowImportExport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadPrompts = async () => {
    setLoading(true);
    try {
      const data = await listPrompts(
        searchQuery || undefined,
        activeTag || undefined
      );
      setPrompts(data);
    } catch (err) {
      console.error("Failed to load prompts:", err);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadPrompts();
  }, [searchQuery, activeTag]);

  const visiblePrompts = prompts.filter((prompt) => {
    if (!FENJUE_PROMPT_NAMES.includes(prompt.name)) {
      return true;
    }
    return fenjueUnlocked && prompt.name === "焚诀·CTF 比赛";
  });

  const handleCopy = async (prompt: PromptItem) => {
    try {
      await navigator.clipboard.writeText(prompt.content);
      setCopiedId(prompt.id);
      await incrementPromptUse(prompt.id);
      setPrompts((prev) =>
        prev.map((p) =>
          p.id === prompt.id ? { ...p, useCount: p.useCount + 1 } : p
        )
      );
      if (viewingPrompt?.id === prompt.id) {
        setViewingPrompt((prev) =>
          prev ? { ...prev, useCount: prev.useCount + 1 } : null
        );
      }
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("确定要删除此提示词吗？")) {
      return;
    }
    try {
      await deletePrompt(id);
      setPrompts((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error("Failed to delete prompt:", err);
    }
  };

  const openCreateModal = () => {
    setEditingPrompt(null);
    setModalName("");
    setModalContent("");
    setModalTags([]);
    setShowModal(true);
  };

  const openEditModal = (prompt: PromptItem) => {
    setEditingPrompt(prompt);
    setModalName(prompt.name);
    setModalContent(prompt.content);
    setModalTags(
      prompt.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    );
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingPrompt(null);
  };

  const togglePresetTag = (tag: string) => {
    setModalTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const addCustomTag = () => {
    const tag = customTagInput.trim();
    if (tag && !modalTags.includes(tag)) {
      setModalTags((prev) => [...prev, tag]);
    }
    setCustomTagInput("");
  };

  const removeTag = (tag: string) => {
    setModalTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleSave = async () => {
    if (!(modalName.trim() && modalContent.trim())) {
      return;
    }
    try {
      const input: PromptCreateInput = {
        name: modalName,
        content: modalContent,
        tags: modalTags,
      };
      if (editingPrompt) {
        const updated = await updatePrompt(editingPrompt.id, input);
        setPrompts((prev) =>
          prev.map((p) => (p.id === editingPrompt.id ? updated : p))
        );
      } else {
        const created = await createPrompt(input);
        setPrompts((prev) => [created, ...prev]);
      }
      closeModal();
    } catch (err) {
      console.error("Failed to save prompt:", err);
    }
  };

  const handleUnlockVault = () => {
    const normalized = vaultKey.trim();
    if (normalized === FENJUE_VAULT_KEY) {
      setFenjueUnlocked(true);
      setShowVault(false);
      setVaultKey(FENJUE_VAULT_KEY);
      return;
    }
    if (!normalized) {
      setFenjueUnlocked(false);
      setShowVault(false);
      return;
    }
    window.alert("口令不对");
  };

  const handleExport = async () => {
    try {
      const data = await exportPrompts();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `memory-forge-prompts-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export:", err);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const promptsToImport: PromptCreateInput[] = (
        Array.isArray(data) ? data : (data.data ?? [])
      ).map(
        (p: { name?: string; content?: string; tags?: string[] | string }) => ({
          name: p.name ?? "",
          content: p.content ?? "",
          tags: Array.isArray(p.tags)
            ? p.tags
            : typeof p.tags === "string"
              ? p.tags
                  .split(",")
                  .map((t: string) => t.trim())
                  .filter(Boolean)
              : [],
        })
      );
      const result = await importPrompts(promptsToImport);
      await loadPrompts();
      alert(t("importSuccess", { count: result }));
    } catch (err) {
      console.error("Failed to import:", err);
      alert(t("importFailed"));
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const allTags = Array.from(
    new Set(
      visiblePrompts.flatMap((p) =>
        p.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      )
    )
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto pr-2 pb-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        {/* Header Section */}
        <section className="relative overflow-hidden rounded-[28px] border border-border/80 bg-gradient-to-br from-card/85 via-card/75 to-card/45 px-6 py-6 shadow-black/5 shadow-lg backdrop-blur-md md:px-8">
          {/* Glow Spheres */}
          <div className="pointer-events-none absolute -top-12 -left-12 size-48 rounded-full bg-primary/8 blur-[90px]" />
          <div className="pointer-events-none absolute -right-16 -bottom-16 size-56 rounded-full bg-violet-500/6 blur-[110px]" />

          <div className="relative flex select-none flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <p className="font-bold text-fine text-primary uppercase tracking-[0.28em]">
                {t("promptLibrary")}
              </p>
              <h2 className="mt-1 font-extrabold text-2xl text-foreground">
                Memory Forge
              </h2>
              <p className="mt-1 text-quiet text-xs">{t("promptSubtitle")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                className="h-9 w-9 cursor-pointer rounded-xl border border-border/40 backdrop-blur-sm transition-all hover:border-border/60 hover:bg-white/10"
                disabled={loading}
                onClick={() => void loadPrompts()}
                size="icon"
                variant="ghost"
              >
                <RefreshCw
                  className={cn(
                    "h-4 w-4 text-foreground/80",
                    loading && "animate-spin"
                  )}
                />
              </Button>
              <div className="relative">
                <Button
                  className="cursor-pointer gap-2 rounded-xl border-border/40 text-foreground/80 backdrop-blur-sm transition-all hover:border-border/60 hover:bg-white/10"
                  onClick={() => setShowImportExport(!showImportExport)}
                  variant="outline"
                >
                  <Download className="h-4 w-4" />
                  {t("importExport")}
                </Button>
                {showImportExport && (
                  <div className="fade-in slide-in-from-top-2 absolute top-full right-0 z-50 mt-2 min-w-[170px] animate-in rounded-2xl border border-border/85 bg-popover p-2 shadow-2xl backdrop-blur-xl duration-200">
                    <button
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-foreground/80 text-sm transition-all hover:bg-primary/10 hover:text-primary"
                      onClick={() => {
                        void handleExport();
                        setShowImportExport(false);
                      }}
                    >
                      <Download className="h-4 w-4" />
                      {t("exportJSON")}
                    </button>
                    <button
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-foreground/80 text-sm transition-all hover:bg-primary/10 hover:text-primary"
                      onClick={() => {
                        fileInputRef.current?.click();
                        setShowImportExport(false);
                      }}
                    >
                      <Upload className="h-4 w-4" />
                      {t("importJSON")}
                    </button>
                    <input
                      accept=".json"
                      className="hidden"
                      onChange={handleImport}
                      ref={fileInputRef}
                      type="file"
                    />
                  </div>
                )}
              </div>
              <Button
                className="cursor-pointer gap-2 rounded-xl bg-primary font-semibold text-primary-foreground shadow-lg shadow-primary/15 transition-all hover:scale-[1.02] hover:bg-primary/90"
                onClick={openCreateModal}
              >
                <Plus className="h-4 w-4" />
                {t("createNew")}
              </Button>
              <button
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-border/40 bg-white/5 text-foreground/75 transition hover:border-primary/30 hover:bg-primary/15 hover:text-primary"
                onClick={() => {
                  setVaultKey(FENJUE_VAULT_KEY);
                  setShowVault(true);
                }}
                title="彩蛋入口"
                type="button"
              >
                <KeyRound className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>

        {/* Search & Filter Bar */}
        <div className="flex flex-wrap gap-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground/40" />
            <input
              className="w-full rounded-2xl border border-border/50 bg-white/4 py-2.5 pr-4 pl-10 font-medium text-sm transition-all duration-300 placeholder:text-muted-foreground/30 focus:border-primary/50 focus:bg-background/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={cn(
                "cursor-pointer rounded-full border px-4 py-1.8 font-semibold text-xs transition-all duration-300 hover:scale-[1.03]",
                activeTag
                  ? "border-border/60 text-quiet hover:border-border/80 hover:bg-white/10"
                  : "border-primary/30 bg-primary/15 text-primary shadow-primary/5 shadow-sm"
              )}
              onClick={() => setActiveTag("")}
            >
              {t("allTags")}
            </button>
            {allTags.map((tag) => (
              <button
                className={cn(
                  "cursor-pointer rounded-full border px-4 py-1.8 font-semibold text-xs transition-all duration-300 hover:scale-[1.03]",
                  activeTag === tag
                    ? getTagColor(tag) + "shadow-primary/5 shadow-sm"
                    : "border-border/60 text-quiet hover:border-border/80 hover:bg-white/10"
                )}
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? "" : tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-3 md:gap-4">
          <StatCard
            icon={<BookOpen className="h-5 w-5 text-blue-400" />}
            label={t("totalPrompts")}
            value={visiblePrompts.length}
          />
          <StatCard
            icon={<Copy className="h-5 w-5 text-green-400" />}
            label={t("totalUses")}
            value={visiblePrompts.reduce((sum, p) => sum + p.useCount, 0)}
          />
          <StatCard
            icon={<Tag className="h-5 w-5 text-purple-400" />}
            label={t("totalTags")}
            value={allTags.length}
          />
        </div>

        {/* Grid / Content Feed */}
        {loading ? (
          <div className="flex select-none items-center justify-center py-24">
            <RefreshCw className="h-8 w-8 animate-spin text-primary/50" />
          </div>
        ) : visiblePrompts.length === 0 ? (
          <div className="flex select-none flex-col items-center justify-center gap-4 rounded-[28px] border border-border/60 border-dashed bg-white/2 py-20 text-quiet">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted/20 text-muted-foreground/60">
              <BookOpen className="h-8 w-8" />
            </div>
            <div className="space-y-1 text-center">
              <p className="font-bold text-base text-foreground/80">
                {t("empty")}
              </p>
              <p className="text-quiet/70 text-xs">{t("emptyHint")}</p>
            </div>
            <Button
              className="mt-2 cursor-pointer gap-2 rounded-xl bg-primary font-semibold shadow-md shadow-primary/5 hover:bg-primary/90"
              onClick={openCreateModal}
            >
              <Plus className="h-4 w-4" />
              {t("createFirst")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2 xl:grid-cols-3">
            {visiblePrompts.map((prompt) => (
              <article
                className="group relative flex flex-col justify-between overflow-hidden rounded-[24px] border border-border/55 bg-gradient-to-br from-card/85 via-card/75 to-card/45 transition-all duration-300 hover:scale-[1.015] hover:border-primary/25 hover:shadow-primary/4 hover:shadow-xl"
                key={prompt.id}
              >
                <div className="flex h-full flex-col justify-between gap-3.5 p-5">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 select-none items-center gap-2.5">
                        <div className="flex h-8.5 w-8.5 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-primary/85 to-purple-500 shadow-lg shadow-primary/10 transition-transform duration-300 group-hover:rotate-12">
                          <Sparkles className="h-4.5 w-4.5 text-white" />
                        </div>
                        <h3 className="truncate font-bold text-base text-foreground leading-snug">
                          {prompt.name}
                        </h3>
                      </div>
                      <div className="flex shrink-0 translate-y-1 transform gap-1.5 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
                        <button
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent transition-all hover:border-border/30 hover:bg-white/10 hover:text-primary"
                          onClick={() => openEditModal(prompt)}
                          title="编辑"
                        >
                          <Pencil className="h-3.5 w-3.5 text-quiet group-hover/btn:text-foreground" />
                        </button>
                        <button
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent transition-all hover:border-border/30 hover:bg-red-500/10 hover:text-red-400"
                          onClick={() => void handleDelete(prompt.id)}
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-quiet" />
                        </button>
                      </div>
                    </div>

                    {prompt.tags && (
                      <div className="flex select-none flex-wrap gap-1.5">
                        {prompt.tags
                          .split(",")
                          .map((tag) => tag.trim())
                          .filter(Boolean)
                          .map((tag) => (
                            <span
                              className={cn(
                                "rounded-md border px-2 py-0.5 font-bold text-[10px] tracking-wider",
                                getTagColor(tag)
                              )}
                              key={tag}
                            >
                              {tag}
                            </span>
                          ))}
                      </div>
                    )}

                    <div className="relative max-h-[110px] cursor-text select-all overflow-hidden rounded-xl border border-border/30 bg-muted/20 p-3.5 font-mono text-quiet text-xs leading-relaxed transition-colors group-hover:bg-muted/35 dark:bg-black/15">
                      {prompt.content}
                      <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-9 bg-gradient-to-t from-card to-transparent" />
                    </div>
                  </div>

                  <div className="mt-auto flex w-full select-none items-center justify-between gap-3 pt-1">
                    <span className="text-[11px] text-quiet/60">
                      {t("usedCount", { count: prompt.useCount })} ·{" "}
                      {formatTime(prompt.updatedAt)}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        className="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-border/40 px-2.5 font-medium text-quiet text-xs transition-all duration-200 hover:bg-white/10 hover:text-foreground"
                        onClick={() => setViewingPrompt(prompt)}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        查看
                      </button>
                      <button
                        className={cn(
                          "relative flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border px-3 font-semibold text-xs transition-all duration-300",
                          copiedId === prompt.id
                            ? "border-green-500/25 bg-green-500/10 text-green-400 shadow-green-500/5 shadow-sm"
                            : "border-border/40 text-quiet hover:border-primary/20 hover:bg-primary/12 hover:text-foreground"
                        )}
                        onClick={() => void handleCopy(prompt)}
                      >
                        {copiedId === prompt.id ? (
                          <>
                            <span className="relative flex size-2 shrink-0">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                              <span className="relative inline-flex size-2 rounded-full bg-green-500" />
                            </span>
                            {t("copied")}
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            {t("copy")}
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* View Prompt Details Modal */}
      {viewingPrompt && (
        <div
          className="fade-in fixed inset-0 z-50 flex animate-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm duration-200"
          onClick={() => setViewingPrompt(null)}
        >
          <div
            className="fade-in zoom-in-95 max-h-[90vh] w-full max-w-[620px] animate-in overflow-hidden rounded-[28px] border border-border/80 bg-card/95 shadow-2xl backdrop-blur-xl duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="relative flex items-center justify-between border-border/40 border-b p-6">
              <div className="pointer-events-none absolute top-0 left-0 h-24 w-24 rounded-full bg-primary/6 blur-3d" />
              <div className="z-10 flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-purple-500 shadow-lg shadow-primary/10">
                  <Sparkles className="h-4.5 w-4.5 animate-pulse text-white" />
                </div>
                <div>
                  <h2 className="truncate font-extrabold text-foreground text-lg">
                    {viewingPrompt.name}
                  </h2>
                  <p className="mt-0.5 text-[11px] text-quiet">
                    {t("usedCount", { count: viewingPrompt.useCount })} ·{" "}
                    {formatTime(viewingPrompt.updatedAt)}
                  </p>
                </div>
              </div>
              <button
                className="relative z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-transparent text-quiet transition-all hover:border-border/30 hover:bg-white/10 hover:text-foreground"
                onClick={() => setViewingPrompt(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Content */}
            <div className="max-h-[calc(90vh-140px)] space-y-5 overflow-y-auto p-6">
              {/* Tags */}
              {viewingPrompt.tags && (
                <div className="select-none space-y-1.5">
                  <label className="font-bold text-primary text-xs uppercase tracking-wide">
                    {t("selectedTags")}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {viewingPrompt.tags
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean)
                      .map((tag) => (
                        <span
                          className={cn(
                            "rounded-full border px-3 py-1 font-bold text-xs",
                            getTagColor(tag)
                          )}
                          key={tag}
                        >
                          {tag}
                        </span>
                      ))}
                  </div>
                </div>
              )}

              {/* Prompt Text Block */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-primary text-xs uppercase tracking-wide">
                    {t("promptContent")}
                  </label>
                  <button
                    className={cn(
                      "relative flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border px-3 font-semibold text-xs transition-all duration-300",
                      copiedId === viewingPrompt.id
                        ? "border-green-500/25 bg-green-500/10 text-green-400 shadow-green-500/5 shadow-sm"
                        : "border-border/40 text-quiet hover:border-primary/20 hover:bg-primary/12 hover:text-foreground"
                    )}
                    onClick={() => void handleCopy(viewingPrompt)}
                  >
                    {copiedId === viewingPrompt.id ? (
                      <>
                        <span className="relative flex size-2 shrink-0">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex size-2 rounded-full bg-green-500" />
                        </span>
                        {t("copied")}
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        {t("copy")}
                      </>
                    )}
                  </button>
                </div>

                {/* Scrollable text container */}
                <div className="relative max-h-[360px] cursor-text select-all overflow-y-auto rounded-2xl border border-border/40 bg-muted/20 p-4.5 font-mono text-foreground text-sm leading-relaxed transition-colors dark:bg-black/20">
                  <pre className="whitespace-pre-wrap break-all font-mono leading-relaxed">
                    {viewingPrompt.content}
                  </pre>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end border-border/40 border-t bg-white/2 p-5">
              <button
                className="cursor-pointer rounded-xl border border-border/40 px-5 py-2.5 font-semibold text-foreground/80 text-sm transition-all hover:border-border/60 hover:bg-white/10"
                onClick={() => setViewingPrompt(null)}
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Prompt Modal */}
      {showModal && (
        <div
          className="fade-in fixed inset-0 z-50 flex animate-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm duration-200"
          onClick={closeModal}
        >
          <div
            className="fade-in zoom-in-95 max-h-[90vh] w-full max-w-[580px] animate-in overflow-hidden rounded-[28px] border border-border/80 bg-card shadow-2xl backdrop-blur-xl duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex items-center justify-between border-border/40 border-b p-5">
              <div className="pointer-events-none absolute top-0 left-0 h-24 w-24 rounded-full bg-primary/6 blur-3d" />
              <h2 className="relative z-10 font-extrabold text-foreground text-lg">
                {editingPrompt ? t("editPrompt") : t("createNew")}
              </h2>
              <button
                className="relative z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-transparent text-quiet transition-all hover:border-border/30 hover:bg-white/10 hover:text-foreground"
                onClick={closeModal}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[calc(90vh-140px)] space-y-5 overflow-y-auto p-6">
              <div>
                <label className="mb-2 block font-bold text-primary text-xs uppercase tracking-wide">
                  {t("promptName")} *
                </label>
                <input
                  className="w-full rounded-xl border border-border/50 bg-muted/20 px-4 py-2.5 text-sm transition-all duration-300 placeholder:text-muted-foreground/30 focus:border-primary/50 focus:bg-background/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                  onChange={(e) => setModalName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  value={modalName}
                />
              </div>

              <div>
                <label className="mb-2 block font-bold text-primary text-xs uppercase tracking-wide">
                  {t("presetTags")}
                </label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_TAGS.map((tag) => (
                    <button
                      className={cn(
                        "cursor-pointer rounded-full border px-3.5 py-1.5 font-semibold text-xs transition-all duration-300 hover:scale-[1.03]",
                        modalTags.includes(tag)
                          ? getTagColor(tag)
                          : "border-border/40 text-quiet hover:border-border/60 hover:bg-white/10"
                      )}
                      key={tag}
                      onClick={() => togglePresetTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-2 block font-bold text-primary text-xs uppercase tracking-wide">
                  {t("selectedTags")}
                </label>
                <div className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-2xl border border-border/50 bg-muted/20 p-3.5">
                  {modalTags.map((tag) => (
                    <span
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-3 py-1 font-bold text-xs transition-all duration-300",
                        getTagColor(tag)
                      )}
                      key={tag}
                    >
                      {tag}
                      <button
                        className="ml-1 cursor-pointer transition-colors hover:text-red-400"
                        onClick={() => removeTag(tag)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    className="min-w-[120px] flex-1 border-none bg-transparent text-foreground text-sm outline-none placeholder:text-quiet/40 focus:outline-none focus:ring-0"
                    onChange={(e) => setCustomTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomTag();
                      }
                    }}
                    placeholder={t("customTagPlaceholder")}
                    type="text"
                    value={customTagInput}
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block font-bold text-primary text-xs uppercase tracking-wide">
                  {t("promptContent")} *
                </label>
                <textarea
                  className="min-h-[180px] w-full resize-y rounded-2xl border border-border/50 bg-muted/20 px-4 py-3.5 font-mono text-sm transition-all duration-300 placeholder:text-muted-foreground/30 focus:border-primary/50 focus:bg-background/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
                  onChange={(e) => setModalContent(e.target.value)}
                  placeholder={t("contentPlaceholder")}
                  value={modalContent}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 border-border/40 border-t bg-white/2 p-5">
              <button
                className="cursor-pointer rounded-xl border border-border/40 px-5 py-2.5 font-semibold text-foreground/80 text-sm transition-all hover:border-border/60 hover:bg-white/10"
                onClick={closeModal}
              >
                {t("cancel")}
              </button>
              <button
                className={cn(
                  "cursor-pointer rounded-xl px-5 py-2.5 font-bold text-sm shadow-lg transition-all duration-300",
                  modalName.trim() && modalContent.trim()
                    ? "animate-in bg-primary text-primary-foreground shadow-primary/15 hover:scale-[1.02] hover:bg-primary/90"
                    : "cursor-not-allowed border border-transparent bg-muted text-quiet shadow-none"
                )}
                disabled={!(modalName.trim() && modalContent.trim())}
                onClick={handleSave}
              >
                {editingPrompt ? t("save") : t("create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Easter Egg Vault Modal */}
      {showVault && (
        <div
          className="fade-in fixed inset-0 z-50 flex animate-in items-center justify-center bg-black/60 p-4 backdrop-blur-sm duration-200"
          onClick={() => setShowVault(false)}
        >
          <div
            className="fade-in zoom-in-95 w-full max-w-sm animate-in rounded-2xl border border-border/80 bg-card/95 p-6 shadow-2xl backdrop-blur-xl duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex items-start justify-between gap-3">
              <div className="pointer-events-none absolute top-0 left-0 h-16 w-16 rounded-full bg-primary/6 blur-3d" />
              <div className="z-10">
                <p className="font-extrabold text-base text-foreground">
                  彩蛋入口
                </p>
                <p className="mt-1 text-quiet text-xs">
                  输入口令解锁隐藏提示词
                </p>
              </div>
              <button
                className="relative z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-quiet transition-all hover:bg-white/10 hover:text-foreground"
                onClick={() => setShowVault(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <input
                autoFocus
                className="w-full rounded-xl border border-border/60 bg-muted/20 px-4 py-2.5 font-medium text-foreground text-sm outline-none transition-all duration-300 placeholder:text-quiet/40 focus:border-primary/50 focus:bg-background/40 focus:ring-4 focus:ring-primary/10"
                onChange={(e) => setVaultKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleUnlockVault();
                  }
                }}
                placeholder="输入口令"
                value={vaultKey}
              />
              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  className="cursor-pointer rounded-xl border border-border/65 px-4.5 py-2 font-bold text-foreground/80 text-xs transition hover:border-border/60 hover:bg-white/10"
                  onClick={() => setShowVault(false)}
                >
                  取消
                </button>
                <button
                  className="cursor-pointer rounded-xl bg-primary px-4.5 py-2 font-bold text-primary-foreground text-xs shadow-lg shadow-primary/15 transition hover:scale-[1.02] hover:bg-primary/90"
                  onClick={handleUnlockVault}
                >
                  解锁
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  return (
    <div className="group setting-card flex cursor-default items-center gap-4.5 rounded-[24px] p-4 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/3 md:p-5">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 transition-transform duration-300 group-hover:scale-105">
        {icon}
      </div>
      <div>
        <p className="select-none font-black text-2xl text-foreground tracking-tight md:text-3xl">
          {value}
        </p>
        <p className="select-none font-semibold text-quiet text-xs">{label}</p>
      </div>
    </div>
  );
}
