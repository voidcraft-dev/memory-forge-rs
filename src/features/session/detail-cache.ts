import type { EditLogEntry, SessionDetail } from "@/features/desktop/types";

const MAX_ENTRIES = 6;
const MAX_TOTAL_CHARS = 40_000_000;

type CacheEntry = {
  detail: SessionDetail;
  logs: EditLogEntry[];
  size: number;
};

const cache = new Map<string, CacheEntry>();

function detailSize(detail: SessionDetail): number {
  let size = 0;
  for (const block of detail.blocks) {
    size += block.content.length;
    for (const call of block.toolCalls ?? []) {
      size +=
        (call.input?.length ?? 0) +
        (call.output?.length ?? 0) +
        (call.error?.length ?? 0);
    }
  }
  return size;
}

export function readCachedDetail(
  key: string
): { detail: SessionDetail; logs: EditLogEntry[] } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function writeCachedDetail(
  key: string,
  detail: SessionDetail,
  logs: EditLogEntry[]
) {
  cache.delete(key);
  const size = detailSize(detail);
  if (size > MAX_TOTAL_CHARS) return;
  cache.set(key, { detail, logs, size });
  let total = 0;
  for (const entry of cache.values()) total += entry.size;
  while (cache.size > MAX_ENTRIES || total > MAX_TOTAL_CHARS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    total -= cache.get(oldestKey)?.size ?? 0;
    cache.delete(oldestKey);
  }
}
