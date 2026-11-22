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
      return Number.isFinite(saved) && saved >= 220 && saved <= 480
        ? saved
        : 278;
    } catch {
      return 278;
    }
  });
  const [isResizingRail, setIsResizingRail] = useState(false);

  useEffect(() => {
    dispatch({ type: "setCurrentPlatform", payload: platform || "all" });
  }, [platform, dispatch]);

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden">
      {!state.railCollapsed && (
        <div
          style={{ width: `${railWidth}px` }}
          className={cn(
            "relative hidden h-full shrink-0 md:block",
            !isResizingRail && "transition-[width] duration-150"
          )}
        >
          <SessionList />
          {/* Right Edge Column Resize Sash */}
          <div
            onDoubleClick={() => {
              setRailWidth(278);
              try {
                localStorage.setItem("memory-forge.rail-width", "278");
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
                if (ev.clientX < 120) {
                  dispatch({ type: "setRailCollapsed", payload: true });
                  cleanup();
                  return;
                }
                const clamped = Math.max(
                  220,
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
            title="左右拖拽调整会话栏宽度 · 双击恢复默认"
          />
        </div>
      )}

      <SessionDetail />
      <EditLogPanel />
    </div>
  );
}
