import { ArrowUp, CornerDownLeft, Send } from "lucide-react";
import { useCallback, useState } from "react";
import { useDesktop } from "@/features/desktop/provider";
import type { RemoteTerminalController } from "./remote-terminal-context";

interface RemoteTerminalComposerProps {
  disabled?: boolean;
  terminalId: string;
  transport: RemoteTerminalController;
}

const SPECIAL_KEYS = [
  { label: "Esc", value: "\u001b", title: "Escape" },
  { label: "Tab", value: "\t", title: "Tab" },
  { label: "Ctrl C", value: "\u0003", title: "Interrupt" },
  { label: "↑", value: "\u001b[A", title: "Arrow up" },
  { label: "↓", value: "\u001b[B", title: "Arrow down" },
];

function pastePayload(value: string) {
  const normalized = value.replace(/\r?\n/g, "\r");
  if (!normalized.includes("\r")) {
    return `${normalized}\r`;
  }
  return `\u001b[200~${normalized}\u001b[201~\r`;
}

export function RemoteTerminalComposer({
  terminalId,
  transport,
  disabled = false,
}: RemoteTerminalComposerProps) {
  const { t } = useDesktop();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);

  const sendDraft = useCallback(async () => {
    const value = draft.trimEnd();
    if (!value || disabled || sending) {
      return;
    }
    setSending(true);
    setError(false);
    try {
      await transport.writeTerminal(terminalId, pastePayload(value));
      setDraft("");
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  }, [disabled, draft, sending, terminalId, transport]);

  const sendSpecialKey = useCallback(
    async (value: string) => {
      if (disabled || sending) {
        return;
      }
      setError(false);
      try {
        await transport.writeTerminal(terminalId, value);
      } catch {
        setError(true);
      }
    },
    [disabled, sending, terminalId, transport]
  );

  return (
    <div className="remote-terminal-composer">
      <fieldset
        aria-label={t("remoteTerminalKeys")}
        className="remote-terminal-key-row"
      >
        {SPECIAL_KEYS.map((key) => (
          <button
            aria-label={key.title}
            className="remote-terminal-key"
            disabled={disabled || sending}
            key={key.label}
            onClick={() => {
              sendSpecialKey(key.value).catch(() => undefined);
            }}
            title={key.title}
            type="button"
          >
            {key.label}
          </button>
        ))}
        <button
          aria-label={t("remoteTerminalSend")}
          className="remote-terminal-key remote-terminal-key-enter"
          disabled={disabled || sending || !draft.trim()}
          onClick={() => {
            sendDraft().catch(() => undefined);
          }}
          title={t("remoteTerminalSend")}
          type="button"
        >
          <CornerDownLeft className="size-3.5" />
        </button>
      </fieldset>

      <form
        className="remote-terminal-composer-row"
        onSubmit={(event) => {
          event.preventDefault();
          sendDraft().catch(() => undefined);
        }}
      >
        <textarea
          aria-label={t("remoteTerminalPromptPlaceholder")}
          disabled={disabled || sending}
          enterKeyHint="send"
          maxLength={60_000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              sendDraft().catch(() => undefined);
            }
          }}
          placeholder={t("remoteTerminalPromptPlaceholder")}
          rows={1}
          value={draft}
        />
        <button
          aria-label={t("remoteTerminalSend")}
          className="remote-terminal-send"
          disabled={disabled || sending || !draft.trim()}
          title={t("remoteTerminalSend")}
          type="submit"
        >
          {sending ? (
            <ArrowUp className="size-4 animate-pulse" />
          ) : (
            <Send className="size-4" />
          )}
        </button>
      </form>

      {error && (
        <span className="remote-terminal-input-error" role="alert">
          {t("remoteTerminalInputFailed")}
        </span>
      )}
    </div>
  );
}
