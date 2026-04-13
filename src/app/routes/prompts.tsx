import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  incrementPromptUse,
  exportPrompts,
  importPrompts,
} from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import type { PromptItem, PromptCreateInput } from "@/features/desktop/types";
import {
  Search,
  Plus,
  Copy,
  Check,
  Pencil,
  Trash2,
  Download,
  Upload,
  BookOpen,
  RefreshCw,
  X,
  Tag,
  Sparkles,
  KeyRound,
} from "lucide-react";

const PRESET_TAGS = ["代码", "写作", "翻译", "分析", "设计", "优化", "学习", "CTF", "焚诀", "其他"];
const FENJUE_PROMPT_NAMES = ["焚诀·CTF 比赛"];

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
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
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
  const [vaultKey, setVaultKey] = useState("");
  const [fenjueUnlocked, setFenjueUnlocked] = useState(false);

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
      const data = await listPrompts(searchQuery || undefined, activeTag || undefined);
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
        prev.map((p) => (p.id === prompt.id ? { ...p, useCount: p.useCount + 1 } : p))
      );
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleDelete = async (id: number) => {
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
    setModalTags(prompt.tags.split(",").map((t) => t.trim()).filter(Boolean));
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingPrompt(null);
  };

  const togglePresetTag = (tag: string) => {
    setModalTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const addCustomTag = () => {
    const tag = customTagInput.trim();
    if (tag && !modalTags.includes(tag)) setModalTags((prev) => [...prev, tag]);
    setCustomTagInput("");
  };

  const removeTag = (tag: string) => {
    setModalTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleSave = async () => {
    if (!modalName.trim() || !modalContent.trim()) return;
    try {
      const input: PromptCreateInput = { name: modalName, content: modalContent, tags: modalTags };
      if (editingPrompt) {
        const updated = await updatePrompt(editingPrompt.id, input);
        setPrompts((prev) => prev.map((p) => (p.id === editingPrompt.id ? updated : p)));
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
    if (normalized === "焚诀") {
      setFenjueUnlocked(true);
      setShowVault(false);
      setVaultKey("");
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
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const promptsToImport: PromptCreateInput[] = (Array.isArray(data) ? data : data.data ?? []).map(
        (p: { name?: string; content?: string; tags?: string[] | string }) => ({
          name: p.name ?? "",
          content: p.content ?? "",
          tags: Array.isArray(p.tags) ? p.tags : (typeof p.tags === "string" ? p.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : []),
        })
      );
      const result = await importPrompts(promptsToImport);
      await loadPrompts();
      alert(t("importSuccess", { count: result }));
    } catch (err) {
      console.error("Failed to import:", err);
      alert(t("importFailed"));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const allTags = Array.from(new Set(visiblePrompts.flatMap((p) => p.tags.split(",").map((t) => t.trim()).filter(Boolean))));

  return (
    <div className="flex h-full flex-col overflow-y-auto overflow-x-hidden pr-2">
      <div className="max-w-6xl mx-auto w-full p-4 md:p-6 space-y-4 md:space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{t("promptLibrary")}</h1>
            <p className="text-muted-foreground mt-1 text-sm md:text-base">{t("promptSubtitle")}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={loadPrompts} disabled={loading}>
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </Button>
            <div className="relative">
              <Button variant="outline" className="gap-2" onClick={() => setShowImportExport(!showImportExport)}>
                <Download className="w-4 h-4" />
                {t("importExport")}
              </Button>
              {showImportExport && (
                <div className="absolute right-0 top-full mt-2 bg-card border border-border/50 rounded-xl p-2 min-w-[160px] shadow-xl z-50">
                  <button
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm hover:bg-muted/50 transition-colors"
                    onClick={() => { handleExport(); setShowImportExport(false); }}
                  >
                    <Download className="w-4 h-4" />
                    {t("exportJSON")}
                  </button>
                  <button
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm hover:bg-muted/50 transition-colors"
                    onClick={() => { fileInputRef.current?.click(); setShowImportExport(false); }}
                  >
                    <Upload className="w-4 h-4" />
                    {t("importJSON")}
                  </button>
                  <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
                </div>
              )}
            </div>
            <Button className="gap-2" onClick={openCreateModal}>
              <Plus className="w-4 h-4" />
              {t("createNew")}
            </Button>
            <button
              type="button"
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-border/50 bg-background/55 text-muted-foreground/70 transition hover:bg-muted/60 hover:text-foreground"
              onClick={() => setShowVault(true)}
              title="彩蛋入口"
            >
              <KeyRound className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="flex gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
            <input
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-muted/30 border border-border/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs border transition-all",
                !activeTag ? "bg-primary/15 text-primary border-primary/30" : "border-border/50 text-quiet hover:bg-muted/50"
              )}
              onClick={() => setActiveTag("")}
            >
              {t("allTags")}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs border transition-all",
                  activeTag === tag ? getTagColor(tag) : "border-border/50 text-quiet hover:bg-muted/50"
                )}
                onClick={() => setActiveTag(activeTag === tag ? "" : tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 md:gap-4">
          <StatCard icon={<BookOpen className="w-5 h-5 text-blue-400" />} value={visiblePrompts.length} label={t("totalPrompts")} />
          <StatCard icon={<Copy className="w-5 h-5 text-green-400" />} value={visiblePrompts.reduce((sum, p) => sum + p.useCount, 0)} label={t("totalUses")} />
          <StatCard icon={<Tag className="w-5 h-5 text-purple-400" />} value={allTags.length} label={t("totalTags")} />
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : visiblePrompts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-quiet gap-4">
            <BookOpen className="w-16 h-16" />
            <p className="text-lg font-medium">{t("empty")}</p>
            <p className="text-sm">{t("emptyHint")}</p>
            <Button className="gap-2 mt-2" onClick={openCreateModal}>
              <Plus className="w-4 h-4" />
              {t("createFirst")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visiblePrompts.map((prompt) => (
              <article
                key={prompt.id}
                className="group relative overflow-hidden transition-all duration-300 hover:scale-[1.01] border bg-card/50 backdrop-blur-xl hover:shadow-xl hover:shadow-primary/5 rounded-[20px]"
              >
                <div className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-purple-500 flex items-center justify-center flex-shrink-0 shadow-lg">
                        <Sparkles className="w-4 h-4 text-white" />
                      </div>
                      <h3 className="font-semibold text-foreground truncate">{prompt.name}</h3>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="h-7 w-7 rounded-lg hover:bg-muted/50 flex items-center justify-center" onClick={() => openEditModal(prompt)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button className="h-7 w-7 rounded-lg hover:bg-red-500/10 hover:text-red-400 flex items-center justify-center" onClick={() => handleDelete(prompt.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {prompt.tags && (
                    <div className="flex gap-1.5 flex-wrap">
                      {prompt.tags.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => (
                        <span key={tag} className={cn("text-[10px] px-2 py-0.5 rounded-md border", getTagColor(tag))}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="font-mono text-xs leading-relaxed text-quiet bg-muted/30 p-3 rounded-lg max-h-[100px] overflow-hidden relative">
                    {prompt.content}
                    <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted/30 to-transparent" />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-quiet/50">
                      {t("usedCount", { count: prompt.useCount })} · {formatTime(prompt.updatedAt)}
                    </span>
                    <button
                      className={cn(
                        "h-7 gap-1.5 text-xs px-2 rounded-lg transition-all flex items-center",
                        copiedId === prompt.id ? "text-green-400" : "text-quiet hover:text-foreground hover:bg-muted/50"
                      )}
                      onClick={() => handleCopy(prompt)}
                    >
                      {copiedId === prompt.id ? <><Check className="w-3.5 h-3.5" />{t("copied")}</> : <><Copy className="w-3.5 h-3.5" />{t("copy")}</>}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={closeModal}>
          <div className="bg-card border border-border/50 rounded-2xl w-full max-w-[560px] max-h-[90vh] overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-border/50">
              <h2 className="text-lg font-semibold">{editingPrompt ? t("editPrompt") : t("createNew")}</h2>
              <button className="h-8 w-8 rounded-lg hover:bg-muted/50 flex items-center justify-center" onClick={closeModal}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-5 overflow-auto max-h-[calc(90vh-130px)]">
              <div>
                <label className="text-sm font-medium text-quiet mb-2 block">{t("promptName")} *</label>
                <input
                  value={modalName}
                  onChange={(e) => setModalName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  className="w-full px-4 py-2.5 rounded-xl bg-muted/30 border border-border/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-quiet mb-2 block">{t("presetTags")}</label>
                <div className="flex gap-2 flex-wrap">
                  {PRESET_TAGS.map((tag) => (
                    <button
                      key={tag}
                      className={cn(
                        "px-3 py-1.5 rounded-lg text-xs border transition-all",
                        modalTags.includes(tag) ? getTagColor(tag) : "border-border/50 text-quiet hover:bg-muted/50"
                      )}
                      onClick={() => togglePresetTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-quiet mb-2 block">{t("selectedTags")}</label>
                <div className="flex gap-2 flex-wrap p-3 bg-muted/30 border border-border/50 rounded-xl min-h-[44px] items-center">
                  {modalTags.map((tag) => (
                    <span key={tag} className={cn("gap-1 px-2 py-1 rounded-md text-xs border flex items-center", getTagColor(tag))}>
                      {tag}
                      <button onClick={() => removeTag(tag)} className="hover:text-red-400 ml-1">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={customTagInput}
                    onChange={(e) => setCustomTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomTag(); } }}
                    placeholder={t("customTagPlaceholder")}
                    className="flex-1 min-w-[100px] bg-transparent border-none outline-none text-sm text-foreground placeholder:text-quiet/40"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-quiet mb-2 block">{t("promptContent")} *</label>
                <textarea
                  value={modalContent}
                  onChange={(e) => setModalContent(e.target.value)}
                  placeholder={t("contentPlaceholder")}
                  className="w-full px-4 py-3 rounded-xl bg-muted/30 border border-border/50 font-mono text-sm min-h-[160px] resize-y focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t border-border/50">
              <button className="px-4 py-2 rounded-xl border border-border/50 text-sm hover:bg-muted/50 transition" onClick={closeModal}>
                {t("cancel")}
              </button>
              <button
                className={cn(
                  "px-4 py-2 rounded-xl text-sm font-medium transition",
                  modalName.trim() && modalContent.trim()
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-muted text-quiet cursor-not-allowed"
                )}
                onClick={handleSave}
                disabled={!modalName.trim() || !modalContent.trim()}
              >
                {editingPrompt ? t("save") : t("create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showVault && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => setShowVault(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold">彩蛋入口</p>
                <p className="mt-1 text-sm text-muted-foreground">输入口令解锁隐藏提示词</p>
              </div>
              <button className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-muted/50" onClick={() => setShowVault(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <input
                autoFocus
                value={vaultKey}
                onChange={(e) => setVaultKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { handleUnlockVault(); } }}
                placeholder="输入口令"
                className="w-full rounded-xl border border-border/60 bg-background/70 px-4 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-primary/30"
              />
              <div className="flex items-center justify-end gap-3">
                <button className="cursor-pointer rounded-xl border border-border/60 px-4 py-2 text-sm transition hover:bg-muted/50" onClick={() => setShowVault(false)}>
                  取消
                </button>
                <button className="cursor-pointer rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90" onClick={handleUnlockVault}>
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

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="setting-card rounded-[20px] p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">{icon}</div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-quiet">{label}</p>
      </div>
    </div>
  );
}
