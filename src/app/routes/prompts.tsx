import {
  BookOpen,
  Check,
  Copy,
  Download,
  Eye,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  createPrompt,
  deletePrompt,
  exportPrompts,
  importPrompts,
  incrementPromptUse,
  listPrompts,
  updatePrompt,
} from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
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

function formatTime(
  iso: string,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  locale: string
): string {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return t("hud.timeJustNow");
  if (diffMin < 60) return t("hud.timeMinutesAgo", { count: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t("hud.timeHoursAgo", { count: diffH });
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return t("hud.timeDaysAgo", { count: diffD });
  return d.toLocaleDateString(locale);
}

export default function PromptsPage() {
  const { t, snapshot } = useDesktop();
  const locale = snapshot?.settings.locale ?? "zh-CN";
  const { confirm, dialogProps } = useConfirmDialog();
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [showVault, setShowVault] = useState(false);
  const [vaultKey, setVaultKey] = useState(FENJUE_VAULT_KEY);
  const [fenjueUnlocked, setFenjueUnlocked] = useState(false);
  const [vaultError, setVaultError] = useState(false);
  const [pageNotice, setPageNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const loadRequestRef = useRef(0);

  const [viewingPrompt, setViewingPrompt] = useState<PromptItem | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalContent, setModalContent] = useState("");
  const [modalTags, setModalTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadPrompts = async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const data = await listPrompts(
        searchQuery || undefined,
        activeTag || undefined
      );
      if (requestId === loadRequestRef.current) setPrompts(data);
    } catch (err) {
      console.error("Failed to load prompts:", err);
    }
    if (requestId === loadRequestRef.current) setLoading(false);
  };

  useEffect(() => {
    const timer = window.setTimeout(
      () => void loadPrompts(),
      searchQuery ? 200 : 0
    );
    return () => window.clearTimeout(timer);
  }, [searchQuery, activeTag]);

  useEffect(() => {
    if (!pageNotice) return;
    const timer = window.setTimeout(() => setPageNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pageNotice]);

  const handleUnlockVault = () => {
    const normalized = vaultKey.trim();
    if (normalized && normalized !== FENJUE_VAULT_KEY) {
      setVaultError(true);
      return;
    }
    setFenjueUnlocked(normalized === FENJUE_VAULT_KEY);
    setVaultError(false);
    setShowVault(false);
  };

  const visiblePrompts = prompts.filter((prompt) => {
    if (!FENJUE_PROMPT_NAMES.includes(prompt.name)) return true;
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
      setTimeout(() => setCopiedId(null), 1800);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleDelete = async (id: number) => {
    if (
      !(await confirm({
        title: t("hud.deletePromptTitle"),
        description: t("hud.deletePromptDesc"),
        variant: "danger",
      }))
    ) {
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
        .map((tag) => tag.trim())
        .filter(Boolean)
    );
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!(modalName.trim() && modalContent.trim())) return;
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
      setShowModal(false);
    } catch (err) {
      console.error("Failed to save prompt:", err);
    }
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
    if (!file) return;
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
                  .map((x) => x.trim())
                  .filter(Boolean)
              : [],
        })
      );
      const imported = await importPrompts(promptsToImport);
      await loadPrompts();
      setPageNotice({
        tone: "success",
        message: t("importSuccess", { count: imported }),
      });
    } catch (err) {
      console.error("Failed to import:", err);
      setPageNotice({ tone: "error", message: t("importFailed") });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const allTags = Array.from(
    new Set(
      visiblePrompts.flatMap((p) =>
        p.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
    )
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-3.5">
        {/* Top Arsenal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="hud-mono text-[10px] font-bold tracking-[0.08em] text-[var(--cyan-fg)]">
              {t("promptSubtitle")}
            </span>
            <h1 className="text-base font-bold text-[var(--text-hi)]">
              {t("promptLibrary")} ·{" "}
              <span className="hud-mono text-xs font-normal text-[var(--text-low)]">
                {t("hud.promptsSummary", {
                  count: visiblePrompts.length,
                  uses: visiblePrompts.reduce((s, p) => s + p.useCount, 0),
                })}
              </span>
            </h1>
            {pageNotice && (
              <p
                className={cn(
                  "hud-mono mt-0.5 text-[11px]",
                  pageNotice.tone === "success"
                    ? "text-[var(--emerald-fg)]"
                    : "text-[var(--crimson-fg)]"
                )}
                role="status"
              >
                {pageNotice.message}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPrompts()}
              className="hud-btn px-2"
              title={t("session.refresh")}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              className="hud-btn"
            >
              <Download className="size-3" />
              <span>{t("exportJSON")}</span>
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="hud-btn"
            >
              <Upload className="size-3" />
              <span>{t("importJSON")}</span>
            </button>
            <input
              accept=".json"
              className="hidden"
              onChange={handleImport}
              ref={fileInputRef}
              type="file"
            />
            <button
              type="button"
              onClick={() => {
                setVaultKey(FENJUE_VAULT_KEY);
                setVaultError(false);
                setShowVault(true);
              }}
              className="hud-btn px-2"
              title={t("hud.vaultKeyTitle")}
            >
              <KeyRound className="size-3.5 text-[var(--forge-fg)]" />
            </button>
            <button
              type="button"
              onClick={openCreateModal}
              className="hud-btn hud-btn-forge"
            >
              <Plus className="size-3.5" />
              <span>{t("createNew")}</span>
            </button>
          </div>
        </div>

        {/* Search & Tag Filter Strip */}
        <div className="hud-panel flex flex-wrap items-center gap-2.5 p-2.5">
          <div className="flex h-7 min-w-[200px] flex-1 items-center gap-2 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-void)] px-2.5 focus-within:border-[var(--cyan-line)]">
            <Search className="size-3.5 text-[var(--text-low)]" />
            <input
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--text-low)]"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTag("")}
              className={cn(
                "hud-mono rounded-[3px] border px-2 py-0.5 text-[10.5px] font-semibold",
                !activeTag
                  ? "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                  : "border-[var(--line-hair)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
              )}
            >
              {t("allTags")}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(activeTag === tag ? "" : tag)}
                className={cn(
                  "hud-mono rounded-[3px] border px-2 py-0.5 text-[10.5px] font-semibold",
                  activeTag === tag
                    ? "border-[var(--forge-line)] bg-[var(--forge-dim)] text-[var(--forge-fg)]"
                    : "border-[var(--line-hair)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Prompt Grid */}
        {loading ? (
          <div className="py-20 text-center">
            <RefreshCw className="mx-auto size-6 animate-spin text-[var(--cyan-fg)]" />
          </div>
        ) : visiblePrompts.length === 0 ? (
          <div className="hud-panel flex flex-col items-center justify-center gap-3 py-16 text-center">
            <BookOpen className="size-8 text-[var(--text-low)]" />
            <p className="text-sm font-semibold text-[var(--text-mid)]">
              {t("empty")}
            </p>
            <button
              type="button"
              onClick={openCreateModal}
              className="hud-btn hud-btn-forge"
            >
              <Plus className="size-3.5" />
              <span>{t("createFirst")}</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {visiblePrompts.map((prompt) => (
              <article
                key={prompt.id}
                className="hud-panel group flex flex-col justify-between gap-2.5 p-3.5 transition-colors hover:border-[var(--cyan-line)]"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-[13.5px] font-bold text-[var(--text-hi)]">
                      {prompt.name}
                    </h3>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => openEditModal(prompt)}
                        className="rounded p-1 text-[var(--text-low)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-hi)]"
                        title={t("editPrompt")}
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(prompt.id)}
                        className="rounded p-1 text-[var(--text-low)] hover:bg-[var(--crimson-dim)] hover:text-[var(--crimson-fg)]"
                        title={t("hud.deletePromptTitle")}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  </div>

                  {prompt.tags && (
                    <div className="flex flex-wrap gap-1">
                      {prompt.tags
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean)
                        .map((tag) => (
                          <span
                            key={tag}
                            className="hud-mono rounded-[2px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-1.5 py-[0.5px] text-[10.5px] text-[var(--cyan-fg)]"
                          >
                            {tag}
                          </span>
                        ))}
                    </div>
                  )}

                  <pre className="hud-mono max-h-28 overflow-hidden rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-code)] p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--text-mid)]">
                    {prompt.content}
                  </pre>
                </div>

                <div className="hud-mono flex items-center justify-between border-t border-[var(--line-subtle)] pt-2 text-[10px] text-[var(--text-low)]">
                  <span>
                    {t("usedCount", { count: prompt.useCount })} ·{" "}
                    {formatTime(prompt.updatedAt, t, locale)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setViewingPrompt(prompt)}
                      className="hud-btn h-6 px-2 text-[10.5px]"
                    >
                      <Eye className="size-3" />
                      <span>{t("hud.viewPrompt")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopy(prompt)}
                      className={cn(
                        "hud-btn h-6 px-2.5 text-[10.5px]",
                        copiedId === prompt.id
                          ? "border-[var(--emerald-line)] bg-[var(--emerald-dim)] text-[var(--emerald-fg)]"
                          : "border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[var(--cyan-fg)]"
                      )}
                    >
                      {copiedId === prompt.id ? (
                        <>
                          <Check className="size-3" />
                          <span>{t("copied")}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="size-3" />
                          <span>{t("copy")}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* View Modal */}
      {viewingPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
          onClick={() => setViewingPrompt(null)}
        >
          <div
            className="reticle reticle-cyan w-full max-w-[600px] rounded-[6px] border border-[var(--cyan-line)] bg-[var(--bg-panel)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--line-hair)] pb-3">
              <h2 className="text-base font-bold">{viewingPrompt.name}</h2>
              <button
                type="button"
                onClick={() => setViewingPrompt(null)}
                className="text-[var(--text-low)] hover:text-[var(--text-hi)]"
              >
                <X className="size-4" />
              </button>
            </div>
            <pre className="hud-mono my-3 max-h-[55vh] overflow-y-auto rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-code)] p-3 text-xs leading-relaxed whitespace-pre-wrap">
              {viewingPrompt.content}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleCopy(viewingPrompt)}
                className="hud-btn hud-btn-forge"
              >
                <Copy className="size-3" />
                <span>
                  {copiedId === viewingPrompt.id ? t("copied") : t("copy")}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
          onClick={() => setShowModal(false)}
        >
          <div
            className="reticle w-full max-w-[560px] rounded-[6px] border border-[var(--forge-line)] bg-[var(--bg-panel)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--line-hair)] pb-3">
              <h2 className="text-base font-bold">
                {editingPrompt ? t("editPrompt") : t("createNew")}
              </h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="text-[var(--text-low)] hover:text-[var(--text-hi)]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="my-3 space-y-3 text-xs">
              <div>
                <label className="hud-mono mb-1 block text-[10px] font-bold tracking-wider text-[var(--text-mid)] uppercase">
                  {t("promptName")}
                </label>
                <input
                  className="w-full rounded-[4px] border border-[var(--line-strong)] bg-[var(--bg-void)] px-3 py-2 text-xs outline-none focus:border-[var(--cyan)]"
                  onChange={(e) => setModalName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  value={modalName}
                />
              </div>

              <div>
                <label className="hud-mono mb-1 block text-[10px] font-bold tracking-wider text-[var(--text-mid)] uppercase">
                  {t("presetTags")}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_TAGS.map((tag) => {
                    const active = modalTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() =>
                          setModalTags((prev) =>
                            prev.includes(tag)
                              ? prev.filter((x) => x !== tag)
                              : [...prev, tag]
                          )
                        }
                        className={cn(
                          "hud-mono rounded-[3px] border px-2 py-0.5 text-[10.5px]",
                          active
                            ? "border-[var(--forge-line)] bg-[var(--forge-dim)] font-bold text-[var(--forge-fg)]"
                            : "border-[var(--line-hair)] text-[var(--text-mid)]"
                        )}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
                <input
                  className="mt-2 w-full rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-void)] px-3 py-1.5 text-xs outline-none focus:border-[var(--cyan)]"
                  onChange={(e) => setCustomTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = customTagInput.trim();
                      if (val && !modalTags.includes(val)) {
                        setModalTags((prev) => [...prev, val]);
                      }
                      setCustomTagInput("");
                    }
                  }}
                  placeholder={t("customTagPlaceholder")}
                  value={customTagInput}
                />
              </div>

              <div>
                <label className="hud-mono mb-1 block text-[10px] font-bold tracking-wider text-[var(--text-mid)] uppercase">
                  {t("promptContent")}
                </label>
                <textarea
                  className="hud-mono min-h-[160px] w-full rounded-[4px] border border-[var(--line-strong)] bg-[var(--bg-code)] p-3 text-xs leading-relaxed outline-none focus:border-[var(--forge)]"
                  onChange={(e) => setModalContent(e.target.value)}
                  placeholder={t("contentPlaceholder")}
                  value={modalContent}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="hud-btn"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                className="hud-btn hud-btn-forge"
              >
                <span>{editingPrompt ? t("save") : t("create")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vault Unlock Dialog */}
      {showVault && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
          onClick={() => setShowVault(false)}
        >
          <div
            className="reticle w-full max-w-[360px] rounded-[6px] border border-[var(--forge-line)] bg-[var(--bg-panel)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="hud-mono text-xs font-bold text-[var(--forge-fg)]">
              {t("hud.vaultKeyTitle")}
            </p>
            <input
              autoFocus
              className="hud-mono mt-2.5 w-full rounded-[4px] border border-[var(--line-strong)] bg-[var(--bg-void)] px-3 py-1.5 text-xs outline-none"
              onChange={(e) => {
                setVaultKey(e.target.value);
                setVaultError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  handleUnlockVault();
                }
              }}
              value={vaultKey}
            />
            {vaultError && (
              <p className="hud-mono mt-1.5 text-[11px] text-[var(--crimson-fg)]">
                {t("hud.vaultWrongKey")}
              </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowVault(false)}
                className="hud-btn"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={handleUnlockVault}
                className="hud-btn hud-btn-forge"
              >
                {t("hud.unlock")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
