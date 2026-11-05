/**
 * CLIs inject context into user messages with XML-ish blocks
 * (`<system-reminder>`, `<environment_context>`, ...). They are part of the
 * stored transcript but should not be rendered as the user's own words.
 */
export const INJECTED_CONTEXT_TAGS = [
  'system-reminder',
  'environment_context',
  'user_instructions',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'user-prompt-submit-hook',
] as const

export type InjectedSegment = {
  kind: 'injected'
  tag: string
  body: string
  raw: string
}

export type TextSegment = {
  kind: 'text'
  content: string
}

export type ContentSegment = InjectedSegment | TextSegment

function findNextOpenTag(
  text: string,
  from: number
): { tag: string; start: number } | null {
  let best: { tag: string; start: number } | null = null
  for (const tag of INJECTED_CONTEXT_TAGS) {
    const start = text.indexOf(`<${tag}>`, from)
    if (start === -1) continue
    if (!best || start < best.start) {
      best = { tag, start }
    }
  }
  return best
}

/**
 * Split a message into plain text and injected-context segments, preserving
 * the original order. Unterminated tags are treated as plain text.
 */
export function splitInjectedContext(text: string): ContentSegment[] {
  if (!text) return []

  const segments: ContentSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    const next = findNextOpenTag(text, cursor)
    if (!next) {
      segments.push({ kind: 'text', content: text.slice(cursor) })
      break
    }

    if (next.start > cursor) {
      segments.push({ kind: 'text', content: text.slice(cursor, next.start) })
    }

    const openTag = `<${next.tag}>`
    const closeTag = `</${next.tag}>`
    const bodyStart = next.start + openTag.length
    const closeIndex = text.indexOf(closeTag, bodyStart)

    if (closeIndex === -1) {
      segments.push({ kind: 'text', content: text.slice(next.start) })
      break
    }

    segments.push({
      kind: 'injected',
      tag: next.tag,
      body: text.slice(bodyStart, closeIndex),
      raw: text.slice(next.start, closeIndex + closeTag.length),
    })
    cursor = closeIndex + closeTag.length
  }

  return segments
}

export function hasInjectedContext(text: string): boolean {
  return splitInjectedContext(text).some((segment) => segment.kind === 'injected')
}

/** Remove injected-context blocks, leaving the human-authored text. */
export function stripInjectedContext(text: string): string {
  return splitInjectedContext(text)
    .filter((segment): segment is TextSegment => segment.kind === 'text')
    .map((segment) => segment.content)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isInjectedOnly(text: string): boolean {
  const segments = splitInjectedContext(text)
  const hasInjected = segments.some((segment) => segment.kind === 'injected')
  const hasText = segments.some(
    (segment) => segment.kind === 'text' && segment.content.trim().length > 0
  )
  return hasInjected && !hasText
}
