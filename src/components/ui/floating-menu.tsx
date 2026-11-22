import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const EDGE_MARGIN = 8;

export function FloatingMenu({
  x,
  y,
  className,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(
      EDGE_MARGIN,
      Math.min(x, window.innerWidth - width - EDGE_MARGIN)
    );
    const top =
      y + height + EDGE_MARGIN > window.innerHeight
        ? Math.max(EDGE_MARGIN, y - height)
        : y;
    setPosition({ left, top });
  }, [x, y]);

  return (
    <div
      ref={ref}
      data-context-menu
      className={cn(
        "fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto",
        className
      )}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: position.left, top: position.top }}
    >
      {children}
    </div>
  );
}
