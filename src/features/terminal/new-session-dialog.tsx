import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  Code,
  Cpu,
  FolderOpen,
  Gem,
  Orbit,
  Pi as PiIcon,
  Sparkles,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDesktop } from "@/features/desktop/provider";
import { useTerminal } from "@/features/terminal/terminal-context";
import { cn } from "@/lib/utils";

const CWD_STORAGE_KEY = "memory-forge:new-session-cwd";
const LAUNCHER_STORAGE_KEY = "memory-forge:new-session-launcher";

type SessionLauncher = {
  id: string;
  label: string;
  command: string;
  platform: string;
  icon: LucideIcon;
  accent: string;
};

const AI_LAUNCHERS: SessionLauncher[] = [
  { id: "claude", label: "Claude Code", command: "claude", platform: "claude", icon: Bot, accent: "text-amber-400" },
  { id: "codex", label: "Codex CLI", command: "codex", platform: "codex", icon: Terminal, accent: "text-blue-400" },
  { id: "opencode", label: "OpenCode", command: "opencode", platform: "opencode", icon: Code, accent: "text-emerald-400" },
  { id: "gemini", label: "Gemini CLI", command: "gemini", platform: "gemini", icon: Gem, accent: "text-rose-400" },
  { id: "qwen", label: "Qwen Code", command: "qwen", platform: "qwen", icon: Cpu, accent: "text-cyan-400" },
  { id: "grok", label: "Grok Build", command: "grok", platform: "grok", icon: Orbit, accent: "text-cyan-300" },
  { id: "pi", label: "Pi", command: "pi", platform: "pi", icon: PiIcon, accent: "text-pink-400" },
  { id: "kiro", label: "Kiro CLI", command: "kiro-cli chat", platform: "kiro", icon: Sparkles, accent: "text-purple-400" },
];

function shellLaunchers(): SessionLauncher[] {
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  if (!isWindows) {
    return [
      { id: "shell", label: "Shell", command: "$SHELL", platform: "shell", icon: Terminal, accent: "text-emerald-400" },
    ];
  }
  return [
    { id: "pwsh", label: "PowerShell 7", command: "pwsh", platform: "shell", icon: Terminal, accent: "text-emerald-400" },
    { id: "powershell", label: "Windows PowerShell", command: "powershell.exe", platform: "shell", icon: Terminal, accent: "text-sky-400" },
    { id: "cmd", label: "Command Prompt", command: "cmd.exe", platform: "shell", icon: SquareTerminal, accent: "text-zinc-300" },
  ];
}

function readStored(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in restricted webviews.
  }
}

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCwd?: string | null;
}

export function NewSessionDialog({ open, onOpenChange, defaultCwd }: NewSessionDialogProps) {
  const { t } = useDesktop();
  const { startTerminal } = useTerminal();
  const shells = shellLaunchers();
  const launchers = [...shells, ...AI_LAUNCHERS];

  const [selectedId, setSelectedId] = useState(() => readStored(LAUNCHER_STORAGE_KEY) || "");
  const [cwd, setCwd] = useState(() => readStored(CWD_STORAGE_KEY));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!selectedId || !launchers.some((launcher) => launcher.id === selectedId)) {
      setSelectedId(launchers[0]?.id ?? "");
    }
    setCwd((current) => current || defaultCwd || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultCwd]);

  const selected = launchers.find((launcher) => launcher.id === selectedId) ?? launchers[0];

  const handleBrowse = async () => {
    try {
      const selectedDirectory = await openDialog({
        directory: true,
        multiple: false,
      });
      if (typeof selectedDirectory === "string") {
        setCwd(selectedDirectory);
      }
    } catch {
      // user cancelled
    }
  };

  const handleStart = async () => {
    if (!selected || starting) return;
    setStarting(true);
    setError(null);
    try {
      const terminalId = await startTerminal(
        `new:${selected.id}:${Date.now()}`,
        "shell",
        selected.command,
        cwd.trim() || null,
        { platform: selected.platform, sessionTitle: selected.label }
      );
      if (!terminalId) {
        setError(t("terminal.new.limit"));
        return;
      }
      writeStored(LAUNCHER_STORAGE_KEY, selected.id);
      writeStored(CWD_STORAGE_KEY, cwd.trim());
      onOpenChange(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-emerald-500/20 bg-card/98">
        <DialogHeader className="border-emerald-500/15 bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent">
          <DialogTitle className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <SquareTerminal className="size-4.5" />
            </span>
            {t("terminal.new.title")}
          </DialogTitle>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t("terminal.new.desc")}
          </p>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <div className="space-y-2">
            <div className="text-xs font-semibold text-foreground">{t("terminal.new.launcher")}</div>
            <div className="grid max-h-[280px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {launchers.map((launcher) => {
                const Icon = launcher.icon;
                const active = launcher.id === selected?.id;
                return (
                  <button
                    key={launcher.id}
                    type="button"
                    onClick={() => setSelectedId(launcher.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
                      active
                        ? "border-emerald-500/50 bg-emerald-500/10"
                        : "border-border/50 bg-muted/15 hover:border-border/80 hover:bg-muted/30"
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/60">
                      <Icon className={cn("size-4", launcher.accent)} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-foreground">
                        {launcher.label}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {launcher.command}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full border",
                        active ? "border-emerald-400 bg-emerald-400" : "border-border"
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-foreground">{t("terminal.new.cwd")}</div>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                onChange={(event) => setCwd(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleStart();
                }}
                placeholder={t("terminal.new.cwdPlaceholder")}
                value={cwd}
              />
              <Button
                className="shrink-0"
                onClick={() => void handleBrowse()}
                size="icon"
                title={t("terminal.new.browse")}
                type="button"
                variant="outline"
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </DialogBody>

        <DialogFooter className="flex items-center justify-end gap-2">
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t("terminal.new.cancel")}
          </Button>
          <Button disabled={!selected || starting} onClick={() => void handleStart()} type="button">
            {starting ? t("terminal.new.starting") : t("terminal.new.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
