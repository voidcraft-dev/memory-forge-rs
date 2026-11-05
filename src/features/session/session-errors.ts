/** Raised by the backend when the session file changed after it was loaded. */
export const SESSION_FILE_CHANGED = 'SESSION_FILE_CHANGED'

export function isSessionFileChanged(error: unknown): boolean {
  return String(error).includes(SESSION_FILE_CHANGED)
}
