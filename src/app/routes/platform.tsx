import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useDesktop } from "@/features/desktop/provider";
import { EditLogPanel } from "@/features/session/edit-log-panel";
import { SessionDetail } from "@/features/session/session-detail";
import { SessionList } from "@/features/session/session-list";
import { cn } from "@/lib/utils";

export default function PlatformPage() {
  const { platform } = useParams<{ platform?: string }>();
  const { state, dispatch } = useDesktop();
  const [railWidth, setRailWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("memory-forge.rail-width"));
      return Number.isFinite(saved) && saved >= 210 && saved <= 480
        ? saved
        : 256;
    } catch {
      return 256;
    }
  });
  const [isResizingRail, setIsResizingRail] = useState(false);

  useEffect(() => {
    dispatch({ type: "setCurrentPlatform", payload: platform || "all" });
  }, [platform, dispatch]);

  const isPeeking = state.railCollapsed && state.railHoverPeek;

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden">
      {/* Left 6px Edge Hover-Peek Trigger when Sidebar is Collapsed (Rin F-96!) */}
      {state.railCollapsed && !state.railHoverPeek && (
        <div
          onMouseEnter={() =>
            dispatch({ type: "setRailHoverPeek", payload: true })
          }
          className="absolute inset-y-0 left-0 z-30 w-1.5"
        />
      )}

      {/* Docked Sidebar / Floating Hover-Peek Sidebar Drawer */}
      <div
        onMouseLeave={
          isPeeking
            ? () => dispatch({ type: "setRailHoverPeek", payload: false })
            : undefined
        }
        style={{ width: `${railWidth}px` }}
        className={cn(
          state.railCollapsed
            ? isPeeking
              ? "absolute inset-y-2 left-2 z-40 overflow-hidden rounded-[10px] border border-[var(--line-strong)] bg-[var(--bg-rack)] shadow-[var(--shadow-elev)]"
              : "hidden"
            : "relative hidden h-full shrink-0 md:block",
          !(state.railCollapsed || isResizingRail) &&
            "transition-[width] duration-150"
        )}
      >
        <SessionList />
        {!state.railCollapsed && (
          /* Right Edge Column Resize Sash */
          <div
            onDoubleClick={() => {
              setRailWidth(256);
              try {
                localStorage.setItem("memory-forge.rail-width", "256");
              } catch {}
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              setIsResizingRail(true);
              const prevCursor = document.body.style.cursor;
              const prevSelect = document.body.style.userSelect;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";

              let latestW = railWidth;
              const onMove = (ev: PointerEvent) => {
                if (ev.clientX < 110) {
                  dispatch({ type: "setRailCollapsed", payload: true });
                  cleanup();
                  return;
                }
                const clamped = Math.max(
                  210,
                  Math.min(Math.min(500, window.innerWidth - 360), ev.clientX)
                );
                latestW = clamped;
                setRailWidth(clamped);
              };
              const cleanup = () => {
                setIsResizingRail(false);
                document.body.style.cursor = prevCursor;
                document.body.style.userSelect = prevSelect;
                try {
                  localStorage.setItem(
                    "memory-forge.rail-width",
                    String(Math.round(latestW))
                  );
                } catch {}
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", cleanup);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", cleanup);
            }}
            className={cn(
              "absolute inset-y-0 -right-[2px] z-20 w-[4px] cursor-col-resize",
              isResizingRail
                ? "bg-[var(--cyan)]"
                : "hover:bg-[var(--cyan)]/75"
            )}
          />
        )}
      </div>

      <SessionDetail />
      <EditLogPanel />
    </div>
  );
}
