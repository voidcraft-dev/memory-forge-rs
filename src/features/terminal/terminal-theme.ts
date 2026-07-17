export const terminalTheme = {
  ansiColors: {
    black: "#21252b",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#d19a66",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#be5046",
    brightGreen: "#98c379",
    brightYellow: "#d19a66",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  
  statusConfig: {
    idle: {
      color: "text-slate-400 dark:text-slate-500",
      bg: "bg-slate-100 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/60",
      dot: "bg-slate-400 dark:bg-slate-500",
    },
    starting: {
      color: "text-blue-500 dark:text-blue-400",
      bg: "bg-blue-50/50 dark:bg-blue-950/20 border-blue-100 dark:border-blue-900/30",
      dot: "bg-blue-500 dark:bg-blue-400 animate-pulse",
    },
    running: {
      color: "text-emerald-500 dark:text-emerald-400",
      bg: "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-100 dark:border-emerald-900/30",
      dot: "bg-emerald-500 dark:bg-emerald-400",
    },
    stopping: {
      color: "text-amber-500 dark:text-amber-400",
      bg: "bg-amber-50/50 dark:bg-amber-950/20 border-amber-100 dark:border-amber-900/30",
      dot: "bg-amber-500 dark:bg-amber-400 animate-pulse",
    },
    exited: {
      color: "text-zinc-500 dark:text-zinc-400",
      bg: "bg-zinc-50/50 dark:bg-zinc-950/20 border-zinc-100 dark:border-zinc-900/30",
      dot: "bg-zinc-500 dark:bg-zinc-400",
    },
    failed: {
      color: "text-red-500 dark:text-red-400",
      bg: "bg-red-50/50 dark:bg-red-950/20 border-red-100 dark:border-red-900/30",
      dot: "bg-red-500 dark:bg-red-400",
    },
  },
};
