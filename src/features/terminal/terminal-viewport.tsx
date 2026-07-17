import React, { useEffect, useRef } from "react";
import { Info } from "lucide-react";

interface TerminalViewportProps {
  mockLogs: string[];
}

// ────────────────────────────────────────────────────────────────
// [Phase 0 Annotation]
// This component displays a visual preview of terminal logs with 
// ANSI color sequence parsing. It is a pure UI mockup for Phase 0 
// to avoid importing xterm.js or executing real backend commands.
// All of this mock parser and render code can be safely deleted or 
// replaced when hooking up real xterm.js container in Phase 1.
// ────────────────────────────────────────────────────────────────

function parseAnsi(text: string): React.ReactNode {
  // Matches \x1b[...m or \u001b[...m
  const ansiRegex = /\x1b\[([0-9;]+)m/g;
  const parts = text.split(ansiRegex);

  if (parts.length === 1) return text;

  const nodes: React.ReactNode[] = [];
  let currentClasses = "";
  let bold = false;
  let colorClass = "";
  let blink = false;

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // ANSI code sequence (e.g. "1;36" or "0")
      const codes = parts[i].split(";");
      for (const code of codes) {
        if (code === "0") {
          bold = false;
          colorClass = "";
          blink = false;
        } else if (code === "1") {
          bold = true;
        } else if (code === "5") {
          blink = true;
        } else {
          switch (code) {
            case "30": colorClass = "text-black dark:text-zinc-900"; break;
            case "31": colorClass = "text-red-500 dark:text-red-400"; break;
            case "32": colorClass = "text-emerald-500 dark:text-emerald-400"; break;
            case "33": colorClass = "text-amber-500 dark:text-amber-400"; break;
            case "34": colorClass = "text-blue-500 dark:text-blue-400"; break;
            case "35": colorClass = "text-purple-500 dark:text-purple-400"; break;
            case "36": colorClass = "text-cyan-500 dark:text-cyan-400"; break;
            case "37": colorClass = "text-zinc-300 dark:text-zinc-200"; break;
            case "90": colorClass = "text-zinc-500 dark:text-zinc-500"; break; // Gray
            default: break;
          }
        }
      }
      
      const classList: string[] = [];
      if (bold) classList.push("font-bold");
      if (colorClass) classList.push(colorClass);
      if (blink) classList.push("animate-pulse");
      currentClasses = classList.join(" ");
    } else {
      const content = parts[i];
      if (content) {
        if (currentClasses) {
          nodes.push(
            <span key={i} className={currentClasses}>
              {content}
            </span>
          );
        } else {
          nodes.push(<span key={i}>{content}</span>);
        }
      }
    }
  }

  return <>{nodes}</>;
}

export function TerminalViewport({ mockLogs }: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of terminal output
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [mockLogs]);

  return (
    <div className="relative flex flex-1 flex-col bg-[#0d1117] text-[#c9d1d9] font-mono text-sm leading-relaxed overflow-hidden">
      {/* Floating Info Banner explaining Phase 0 status */}
      <div className="flex items-center gap-2 bg-blue-500/10 border-b border-blue-500/20 px-5 py-2.5 text-xs text-blue-400 select-none shrink-0">
        <Info className="size-4 shrink-0" />
        <span>
          <strong>Phase 0 Mock Preview:</strong> xterm.js & terminal subprocess are not yet hooked up. Commands entered here will not execute.
        </span>
      </div>

      {/* Terminal logs viewport container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-5 scrollbar-thin scrollbar-thumb-zinc-800"
      >
        <div className="space-y-1 font-mono min-w-0 break-all select-text">
          {mockLogs.map((line, index) => (
            <div key={index} className="min-h-[1.5rem]">
              {parseAnsi(line)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
