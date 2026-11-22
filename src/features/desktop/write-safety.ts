import type { DesktopSnapshot } from "@/features/desktop/types";

export function hasBackupWrite(
  snapshot: DesktopSnapshot | null,
  platform: string | null | undefined
): boolean {
  return Boolean(platform && snapshot?.backupWritePlatforms?.includes(platform));
}
