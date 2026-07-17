import { useEffect, useRef, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useDesktop } from "@/features/desktop/provider";
import { getThemeSpec } from "@/features/desktop/catalog";
import { useTerminal } from "./terminal-context";
import { xtermTheme } from "./terminal-theme";

interface TerminalViewportProps {
  terminalId: string;
  isActive: boolean;
}

function encodeBinaryString(value: string) {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value.charCodeAt(index) & 0xff);
  }
  return globalThis.btoa(binary);
}

export function TerminalViewport({ terminalId, isActive }: TerminalViewportProps) {
  const { snapshot, t } = useDesktop();
  const { writeTerminal, resizeTerminal, subscribeToOutput } = useTerminal();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const themeId = snapshot?.settings.theme || "graphite";
  const themeSpec = getThemeSpec(themeId);
  const isLight = themeSpec.mode === "light";

  const theme = useMemo(() => {
    return isLight ? {
      background: themeId === "linen" ? "#f6efe4" : "#fcfcfd",
      foreground: themeId === "linen" ? "#261d16" : "#20263a",
      cursor: themeId === "linen" ? "#8a5a2f" : "#7a8cff",
      cursorAccent: themeId === "linen" ? "#f6efe4" : "#fcfcfd",
      selectionBackground: themeId === "linen" ? "#eadaaa" : "#e0e4ff",
      selectionForeground: themeId === "linen" ? "#261d16" : "#20263a",
      black: themeId === "linen" ? "#261d16" : "#20263a",
      red: "#d32f2f",
      green: "#2e7d32",
      yellow: "#f57c00",
      blue: "#1976d2",
      magenta: "#7b1fa2",
      cyan: "#0097a7",
      white: "#f5f5f5",
      brightBlack: "#757575",
      brightRed: "#d32f2f",
      brightGreen: "#2e7d32",
      brightYellow: "#f57c00",
      brightBlue: "#1976d2",
      brightMagenta: "#7b1fa2",
      brightCyan: "#0097a7",
      brightWhite: "#ffffff",
    } : xtermTheme;
  }, [themeId, isLight]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
      smoothScrollDuration: 0,
      theme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let fitFrame: number | null = null;
    const fitAndResize = () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fitAddon.fit();
        } catch {
          return;
        }
        const nextSize = { cols: terminal.cols, rows: terminal.rows };
        const previousSize = lastSizeRef.current;
        if (previousSize?.cols === nextSize.cols && previousSize.rows === nextSize.rows) return;
        lastSizeRef.current = nextSize;
        void resizeTerminal(terminalId, nextSize.cols, nextSize.rows).catch(() => {
          // Resize may race with a process that has just exited.
        });
      });
    };

    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(host);

    const outputSubscription = subscribeToOutput(terminalId, (data) => {
      terminal.write(data);
    });
    const inputSubscription = terminal.onData((data) => {
      void writeTerminal(terminalId, data).catch((error) => {
        console.error("Failed to write embedded terminal input:", error);
      });
    });
    const binarySubscription = terminal.onBinary((data) => {
      void writeTerminal(terminalId, encodeBinaryString(data), true).catch((error) => {
        console.error("Failed to write embedded terminal binary input:", error);
      });
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();

      if (event.ctrlKey && event.shiftKey && key === "c") {
        const selection = terminal.getSelection();
        if (selection) void navigator.clipboard.writeText(selection);
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && key === "c" && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "v") {
        void navigator.clipboard.readText().then((text) => {
          if (text) terminal.paste(text);
        });
        return false;
      }
      return true;
    });

    fitAndResize();

    return () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      outputSubscription();
      inputSubscription.dispose();
      binarySubscription.dispose();
      fitAddon.dispose();
      terminal.dispose();
      fitAddonRef.current = null;
      terminalRef.current = null;
      lastSizeRef.current = null;
    };
  }, [resizeTerminal, subscribeToOutput, terminalId, writeTerminal]);

  useEffect(() => {
    if (!isActive) return;
    const frame = requestAnimationFrame(() => {
      const host = hostRef.current;
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // A tab can become active while its layout is still settling.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [isActive]);

  return (
    <div className="h-full min-h-0 w-full bg-[#0d1117] p-2">
      <div
        ref={hostRef}
        className="h-full min-h-0 w-full overflow-hidden"
        aria-label={t("terminal.viewportLabel")}
      />
    </div>
  );
}
