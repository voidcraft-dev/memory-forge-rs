import { type ReactNode, Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { LoaderCircle } from "lucide-react";
import { AppLogo } from "@/components/logo";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopProvider } from "@/features/desktop/provider";
import { TerminalProvider } from "@/features/terminal/terminal-context";
import { RemoteTerminalProvider } from "@/features/terminal/remote-terminal-context";
import AppErrorPage from "@/features/errors/app-error";

export default function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
          <div className="relative grid size-14 place-items-center" role="status" aria-label="Loading Memory Forge">
            <AppLogo className="size-9 motion-safe:animate-pulse" />
            <LoaderCircle className="absolute size-14 animate-spin text-primary/35 motion-reduce:animate-none" />
          </div>
        </div>
      }
    >
      <ErrorBoundary FallbackComponent={AppErrorPage}>
        <DesktopProvider>
          <RemoteTerminalProvider>
            <TerminalProvider>
              <TooltipProvider>{children}</TooltipProvider>
            </TerminalProvider>
          </RemoteTerminalProvider>
        </DesktopProvider>
      </ErrorBoundary>
    </Suspense>
  );
}
