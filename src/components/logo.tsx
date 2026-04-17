import { cn } from "@/lib/utils"

export function AppLogo({ className }: { className?: string }) {
  const isDark = document.documentElement.style.colorScheme !== "light"
  const bgColor = isDark ? "#1C1917" : "#F5F0EB"
  const gradientFrom = isDark ? "#F97316" : "#EA580C"
  const gradientTo = isDark ? "#DC2626" : "#C2410C"

  return (
    <svg
      viewBox="0 0 512 512"
      className={cn("size-5", className)}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="logo-fg" cx="42%" cy="38%">
          <stop offset="0%" stopColor={gradientFrom} />
          <stop offset="100%" stopColor={gradientTo} />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="96" fill={bgColor} />
      <path
        fillRule="evenodd"
        d="M 72,184 C 72,120 120,72 184,72 L 328,72 C 392,72 440,120 440,184 L 440,328 C 440,392 392,440 328,440 L 184,440 C 120,440 72,392 72,328 Z M 156,380 L 156,164 L 256,316 L 356,164 L 356,380 L 308,380 L 308,224 L 256,344 L 204,224 L 204,380 Z"
        fill="url(#logo-fg)"
      />
    </svg>
  )
}
