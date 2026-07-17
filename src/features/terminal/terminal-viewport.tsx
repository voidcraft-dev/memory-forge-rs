import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useDesktop } from "@/features/desktop/provider";
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
  const { t } = useDesktop();
  const { writeTerminal, resizeTerminal, subscribeToOutput } = useTerminal();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

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
      theme: xtermTheme,
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
        if (nextSize.cols < 20 || nextSize.rows < 3) return;
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
