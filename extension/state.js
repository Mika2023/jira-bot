/**
 * Pure helpers for the deduplication state.
 * seen: { [issueKey]: firstSeenTimestampMs }
 */

export const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function scopeKey(boardUrl, status) {
  return `${String(boardUrl ?? '').trim()}|${String(status ?? '').trim()}`;
}

export function collectNewIssues(seen, issues) {
  const map = seen ?? {};
  return (issues ?? []).filter((issue) => issue?.key && !Object.prototype.hasOwnProperty.call(map, issue.key));
}

export function rememberIssues(seen, issues, now = Date.now()) {
  const next = { ...(seen ?? {}) };
  for (const issue of issues ?? []) {
    if (issue?.key) {
      next[issue.key] = now;
    }
  }
  return next;
}

export function pruneSeen(seen, now = Date.now(), ttlMs = SEEN_TTL_MS) {
  const next = {};
  for (const [key, timestamp] of Object.entries(seen ?? {})) {
    if (typeof timestamp === 'number' && now - timestamp <= ttlMs) {
      next[key] = timestamp;
    }
  }
  return next;
}
