/**
 * Session adapters expose `updated_at` in whatever form the underlying tool
 * stores: nanoseconds since epoch (Claude, Codex), milliseconds (Pi, OpenCode,
 * ZCode, Cursor) or an ISO-8601 string (Kiro, Gemini, Grok). Normalize them in
 * one place so every view formats timestamps the same way.
 */
const NUMERIC_TIMESTAMP = /^\d+$/

export function parseTimestamp(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null

  const raw = String(value).trim()
  if (!raw) return null

  if (NUMERIC_TIMESTAMP.test(raw)) {
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) return null

    let date: Date
    if (num > 10 ** 17) date = new Date(num / 1_000_000)
    else if (num > 10 ** 15) date = new Date(num / 1_000)
    else if (num > 10 ** 12) date = new Date(num)
    else date = new Date(num * 1000)

    return Number.isNaN(date.getTime()) ? null : date
  }

  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
