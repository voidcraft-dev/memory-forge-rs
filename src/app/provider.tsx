import { type ReactNode, Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopProvider } from "@/features/desktop/provider";
import { TerminalProvider } from "@/features/terminal/terminal-context";
import AppErrorPage from "@/features/errors/app-error";

export default function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
          <div className="panel-surface px-6 py-4 text-sm text-muted-foreground">
            Loading VK Desktop Starter...
          </div>
        </div>
      }
    >
      <ErrorBoundary FallbackComponent={AppErrorPage}>
        <DesktopProvider>
          <TerminalProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </TerminalProvider>
        </DesktopProvider>
      </ErrorBoundary>
    </Suspense>
  );
}
