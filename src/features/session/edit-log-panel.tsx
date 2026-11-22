import {
  CheckCircle,
  Clock,
  Eye,
  EyeOff,
  FileText,
  RefreshCw,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/features/desktop/api";
import type { MessageKey } from "@/features/desktop/i18n";
import { useDesktop } from "@/features/desktop/provider";
import { hasBackupWrite } from "@/features/desktop/write-safety";
import type { EditLogEntry } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

function DiffBlock({
  oldText,
  newText,
  t,
}: {
  oldText: string;
  newText: string;
  t: (key: MessageKey) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const maxLen = 160;
  const oldPreview =
    oldText.length > maxLen && !expanded
      ? `${oldText.slice(0, maxLen)}...`
      : oldText;
  const newPreview =
    newText.length > maxLen && !expanded
      ? `${newText.slice(0, maxLen)}...`
      : newText;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="rounded-[3px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] p-2">
        <div className="hud-mono mb-1 flex items-center justify-between text-[10.5px] font-bold tracking-wider text-[var(--crimson-fg)] uppercase">
          <span>- {t("editLog.before")}</span>
          {!expanded && oldText.length > maxLen && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="underline opacity-80 hover:opacity-100"
            >
              {t("editLog.expand")}
            </button>
          )}
        </div>
        <pre className="hud-mono max-h-44 overflow-y-auto text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--crimson-fg)]">
          {oldPreview || t("hud.previewEmpty")}
        </pre>
      </div>

      <div className="rounded-[3px] border border-[var(--emerald-line)] bg-[var(--emerald-dim)] p-2">
        <div className="hud-mono mb-1 flex items-center justify-between text-[10.5px] font-bold tracking-wider text-[var(--emerald-fg)] uppercase">
          <span>+ {t("editLog.after")}</span>
          {!expanded && newText.length > maxLen && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="underline opacity-80 hover:opacity-100"
            >
              {t("editLog.expand")}
            </button>
          )}
        </div>
        <pre className="hud-mono max-h-44 overflow-y-auto text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--emerald-fg)]">
          {newPreview || t("hud.emptyFrame")}
        </pre>
      </div>
    </div>
  );
}

export function EditLogPanel() {
  const { t, state, dispatch, snapshot } = useDesktop();
  const { confirm, dialogProps } = useConfirmDialog();
  const editLog = state.editLog;
  const selectedSessionKey =
    state.sessionDetail?.sessionKey ?? state.selectedSessionKey;
  const showEditLog = state.showEditLog;
  const activePlatform =
    state.sessionDetail?.platform ||
    state.selectedSessionPlatform ||
    (state.currentPlatform !== "all" ? state.currentPlatform : "claude");

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  if (!selectedSessionKey || !showEditLog) return null;

  const handleRefreshLog = async () => {
    setRefreshing(true);
    setRefreshDone(false);
    try {
      const logs = await api.getEditLog(activePlatform, selectedSessionKey);
      dispatch({ type: "setEditLog", payload: logs });
      setRefreshDone(true);
      setTimeout(() => setRefreshDone(false), 1400);
    } catch (err) {
      console.error("Failed to refresh edit log:", err);
    }
    setRefreshing(false);
  };

  const handleRestore = async (entry: EditLogEntry) => {
    if (
      !(await confirm({
        title: t("session.restore"),
        description: t("session.restoreConfirm"),
      }))
    ) {
      return;
    }
    try {
      await api.restoreMessage(activePlatform, entry.id, selectedSessionKey);
      const [logs, detail] = await Promise.all([
        api.getEditLog(activePlatform, selectedSessionKey),
        api.getSessionDetail(activePlatform, selectedSessionKey),
      ]);
      dispatch({ type: "setEditLog", payload: logs });
      dispatch({ type: "setSessionDetail", payload: detail });
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "success", message: t("session.messageSaved") },
      });
    } catch (err) {
      console.error("Failed to restore message:", err);
      dispatch({
        type: "setSessionStatus",
        payload: { tone: "error", message: t("session.saveFailed") },
      });
    }
  };

  const handleDelete = async (entry: EditLogEntry) => {
    if (
      !(await confirm({
        title: t("editLog.delete"),
        description: t("editLog.deleteConfirm"),
        variant: "danger",
      }))
    ) {
      return;
    }
    setDeletingId(entry.id);
    try {
      const deleted = await api.deleteEditLog(
        activePlatform,
        entry.id,
        selectedSessionKey
      );
      if (deleted) {
        dispatch({
          type: "setEditLog",
          payload: editLog.filter((item) => item.id !== entry.id),
        });
      }
    } catch (err) {
      console.error("Failed to delete edit log:", err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleClear = async () => {
    if (
      editLog.length === 0 ||
      !(await confirm({
        title: t("editLog.clear"),
        description: t("editLog.clearConfirm"),
        variant: "danger",
      }))
    ) {
      return;
    }
    setDeletingId(-1);
    try {
      await api.clearEditLogs(activePlatform, selectedSessionKey);
      dispatch({ type: "setEditLog", payload: [] });
    } catch (err) {
      console.error("Failed to clear edit logs:", err);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 top-[38px] z-30 bg-black/35 xl:hidden"
        onClick={() => dispatch({ type: "setShowEditLog", payload: false })}
      />
      <aside className="fixed top-[38px] right-0 bottom-0 z-40 flex w-[350px] max-w-[92vw] flex-col border-l border-[var(--line-strong)] bg-[var(--bg-rack)] shadow-2xl">
        {/* Drawer Header */}
        <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-[var(--line-hair)] px-3.5">
          <div className="hud-mono flex items-center gap-1.5 text-xs font-bold tracking-wider text-[var(--forge-fg)]">
            <Zap className="size-3.5" />
            <span>{t("editLog.title")}</span>
          </div>
          <div className="flex items-center gap-1">
            {editLog.length > 0 && (
              <button
                type="button"
                disabled={deletingId !== null}
                onClick={() => void handleClear()}
                className="hud-btn hud-btn-danger h-6 px-2 text-[10.5px]"
              >
                <Trash2 className="size-3" />
                <span>{t("editLog.clear")}</span>
              </button>
            )}
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void handleRefreshLog()}
              className={cn(
                "grid size-6 place-items-center rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:text-[var(--text-hi)]",
                refreshDone && "text-[var(--emerald-fg)]"
              )}
              title={t("session.refresh")}
            >
              {refreshDone ? (
                <CheckCircle className="size-3" />
              ) : (
                <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
              )}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "setShowEditLog", payload: false })}
              className="grid size-6 place-items-center rounded-[3px] border border-[var(--line-hair)] bg-[var(--bg-panel)] text-[var(--text-mid)] hover:text-[var(--text-hi)]"
              title={t("editLog.collapse")}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Scrollable Diff Entries */}
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
          {editLog.length === 0 ? (
            <div className="py-16 text-center">
              <FileText className="mx-auto mb-3 size-7 text-[var(--text-low)]" />
              <p className="text-xs font-semibold text-[var(--text-mid)]">
                {t("editLog.noRecords")}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-low)]">
                {t("editLog.afterEditHint")}
              </p>
            </div>
          ) : (
            editLog.map((entry) => {
              const isExpanded = expandedId === entry.id;
              return (
                <div
                  key={entry.id}
                  className="rounded-[5px] border border-[var(--line-hair)] border-l-[2.5px] border-l-[var(--forge)] bg-[var(--bg-panel)] p-2.5"
                >
                  <div className="hud-mono flex items-center justify-between text-[10px] text-[var(--text-low)]">
                    <span className="flex items-center gap-1 text-[var(--forge-fg)] font-semibold">
                      <Clock className="size-2.5" />
                      {new Date(entry.createdAt).toLocaleString(snapshot?.settings.locale ?? "zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span className="max-w-[140px] truncate">
                      {entry.editTarget}
                    </span>
                  </div>

                  {isExpanded ? (
                    <DiffBlock
                      newText={entry.newContent}
                      oldText={entry.oldContent}
                      t={t}
                    />
                  ) : (
                    <div className="mt-2 space-y-1">
                      <p className="hud-mono line-clamp-1 rounded-[2px] bg-[var(--crimson-dim)] px-1.5 py-0.5 text-[10.5px] text-[var(--crimson-fg)]">
                        - {entry.oldContent.slice(0, 90) || t("hud.previewEmpty")}
                      </p>
                      <p className="hud-mono line-clamp-1 rounded-[2px] bg-[var(--emerald-dim)] px-1.5 py-0.5 text-[10.5px] text-[var(--emerald-fg)]">
                        + {entry.newContent.slice(0, 90) || t("hud.previewEmpty")}
                      </p>
                    </div>
                  )}

                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                      className="hud-btn h-6 flex-1 justify-center text-[10.5px]"
                    >
                      {isExpanded ? (
                        <>
                          <EyeOff className="size-3" />
                          <span>{t("editLog.collapse")}</span>
                        </>
                      ) : (
                        <>
                          <Eye className="size-3" />
                          <span>{t("editLog.viewDetail")}</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRestore(entry)}
                      className="hud-btn h-6 flex-1 justify-center border-[var(--cyan-line)] bg-[var(--cyan-dim)] text-[10.5px] text-[var(--cyan-fg)]"
                    >
                      <Undo2 className="size-3" />
                      <span>{t("session.restore")}</span>
                    </button>
                    <button
                      type="button"
                      disabled={deletingId === entry.id}
                      onClick={() => void handleDelete(entry)}
                      className="hud-btn hud-btn-danger h-6 px-2 text-[10.5px]"
                      title={t("editLog.delete")}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Safety Guarantee */}
        <div className="hud-mono shrink-0 border-t border-[var(--line-hair)] bg-[var(--bg-panel)] px-3.5 py-2 text-[10px] text-[var(--text-low)]">
          {hasBackupWrite(snapshot, activePlatform)
            ? t("hud.safeWriteGuarantee")
            : t("hud.editLogOnlyGuarantee")}
        </div>
      </aside>
      <ConfirmDialog {...dialogProps} />
    </>
  );
}
