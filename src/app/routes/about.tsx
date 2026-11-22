import { open } from "@tauri-apps/plugin-shell";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpCircle,
  Check,
  CheckCircle,
  Copy,
  Download,
  ExternalLink,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { AppLogo } from "@/components/logo";
import { api } from "@/features/desktop/api";
import { useDesktop } from "@/features/desktop/provider";
import type { UpdateInfo } from "@/features/desktop/types";
import { cn } from "@/lib/utils";

function openUrl(url: string) {
  open(url).catch(() => {
    window.open(url, "_blank");
  });
}

export default function AboutPage() {
  const { t, snapshot } = useDesktop();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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

  return (
    <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3.5 pb-8">
        <div className="flex items-center justify-between">
          <Link to="/settings" className="hud-btn">
            <ArrowLeft className="size-3.5" />
            <span>{t("hud.backToSettings")}</span>
          </Link>
        </div>

        {/* Identity Card */}
        <section className="reticle hud-panel flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="flex items-center gap-4">
            <div className="grid size-14 place-items-center overflow-hidden rounded-[6px] border border-[var(--forge-line)] bg-[var(--forge-dim)]">
              <AppLogo className="size-12" />
            </div>
            <div>
              <span className="hud-mono text-[10px] font-bold tracking-[0.14em] text-[var(--forge-fg)] uppercase">
                {t("appNameEn")}
              </span>
              <h1 className="mt-0.5 text-xl font-bold text-[var(--text-hi)]">
                {t("appName")} · v{snapshot?.version ?? ""}
              </h1>
              <p className="mt-1 text-xs text-[var(--text-mid)]">
                {t("aboutDesc")}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openUrl("https://github.com/voidcraft-dev")}
              className="hud-btn"
            >
              <ExternalLink className="size-3" />
              <span>GitHub</span>
            </button>
            <button
              type="button"
              onClick={() => openUrl("https://qm.qq.com/q/e2y8CNQ8lq")}
              className="hud-btn"
            >
              <MessageCircle className="size-3" />
              <span>{t("hud.qqGroupLabel")}: 野生AI观测</span>
            </button>
            <button
              type="button"
              disabled={checking}
              onClick={() => void handleCheckUpdate()}
              className="hud-btn hud-btn-forge"
            >
              <RefreshCw className={cn("size-3", checking && "animate-spin")} />
              <span>{checking ? t("checking") : t("checkUpdate")}</span>
            </button>
          </div>
        </section>

        {updateInfo && !updateInfo.hasUpdate && (
          <section className="hud-mono flex items-center gap-2.5 rounded-[5px] border border-[var(--emerald-line)] bg-[var(--emerald-dim)] px-4 py-3 text-xs text-[var(--emerald-fg)]">
            <CheckCircle className="size-4 shrink-0" />
            <span>
              {t("upToDate")} (v{updateInfo.currentVersion})
            </span>
          </section>
        )}

        {updateInfo?.hasUpdate && (
          <section className="hud-panel border-[var(--forge-line)] bg-[var(--forge-dim)] p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <ArrowUpCircle className="size-5 text-[var(--forge-fg)]" />
                <div>
                  <h3 className="text-sm font-bold text-[var(--forge-fg)]">
                    {t("updateAvailable")}: v{updateInfo.latestVersion}
                  </h3>
                  <p className="hud-mono text-xs text-[var(--text-mid)]">
                    {t("hud.updateVersionLine", {
                      current: updateInfo.currentVersion,
                      latest: updateInfo.latestVersion,
                    })}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => openUrl(updateInfo.releaseUrl)}
                className="hud-btn hud-btn-forge"
              >
                <Download className="size-3.5" />
                <span>{t("downloadUpdate")}</span>
              </button>
            </div>
          </section>
        )}

        {checkError && (
          <section className="hud-mono flex items-center gap-2 rounded-[5px] border border-[var(--crimson-line)] bg-[var(--crimson-dim)] px-4 py-3 text-xs text-[var(--crimson-fg)]">
            <AlertCircle className="size-4 shrink-0" />
            <span>
              {t("checkFailed")}: {checkError}
            </span>
          </section>
        )}

        {/* Runtime Paths Telemetry */}
        {snapshot && (
          <section className="hud-panel p-4">
            <div className="hud-mono mb-3 border-b border-[var(--line-subtle)] pb-2 text-[11px] font-bold text-[var(--text-mid)]">
              {t("hud.diagnosticsTitle")}
            </div>
            <div className="space-y-2">
              {(
                [
                  [
                    t("runtime"),
                    snapshot.runtime === "tauri"
                      ? t("runtimeTauri")
                      : t("runtimeWebPreview"),
                  ],
                  [t("configDir"), snapshot.configDir],
                  [t("dataDir"), snapshot.dataDir],
                  [t("dbPath"), snapshot.dbPath],
                ] as const
              ).map(([label, val]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 rounded-[4px] border border-[var(--line-hair)] bg-[var(--bg-elevated)] px-3 py-2 text-xs"
                >
                  <span className="shrink-0 font-semibold text-[var(--text-mid)]">
                    {label}
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="hud-mono truncate text-[11px] text-[var(--text-hi)] select-all">
                      {val}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(val);
                        setCopiedKey(label);
                        setTimeout(() => setCopiedKey(null), 1400);
                      }}
                      className="shrink-0 text-[var(--text-low)] hover:text-[var(--cyan-fg)]"
                    >
                      {copiedKey === label ? (
                        <Check className="size-3.5 text-[var(--emerald-fg)]" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
