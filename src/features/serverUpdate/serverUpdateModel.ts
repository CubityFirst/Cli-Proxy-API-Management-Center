/**
 * What the server update dialog says about a check result, and how it tells
 * the host helper's report on our request apart from an earlier run's.
 */

import type { ServerUpdateHelperStatus, ServerUpdateInfo } from '@/services/api/serverUpdate';

export type ServerUpdateSummary =
  | { kind: 'check_failed'; message: string }
  | { kind: 'no_release' }
  | { kind: 'pending' }
  | { kind: 'latest' }
  /** Published, but the archive for this platform isn't uploaded yet. */
  | { kind: 'building'; version: string; asset: string }
  | { kind: 'available'; version: string; canInstall: boolean };

export function summarizeServerUpdate(info: ServerUpdateInfo): ServerUpdateSummary {
  if (info.pending) return { kind: 'pending' };
  if (!info.latest) {
    return info.error ? { kind: 'check_failed', message: info.error } : { kind: 'no_release' };
  }
  if (!info.updateAvailable) return { kind: 'latest' };
  if (!info.latest.assetReady) {
    return { kind: 'building', version: info.latest.version, asset: info.latest.asset };
  }
  return { kind: 'available', version: info.latest.version, canInstall: info.applyEnabled };
}

/**
 * The helper's status when it reports on the update requested for `tag`.
 * `baseline` is the status seen just before the request: a report that is
 * unchanged from it belongs to an earlier run (possibly of the same tag).
 * Compared by content rather than time, since browser and server clocks differ.
 */
export function statusForRequest(
  status: ServerUpdateHelperStatus | null,
  tag: string,
  baseline: ServerUpdateHelperStatus | null
): ServerUpdateHelperStatus | null {
  if (!status || status.tag !== tag) return null;
  if (
    baseline &&
    baseline.tag === status.tag &&
    baseline.state === status.state &&
    baseline.updatedAtMs === status.updatedAtMs
  ) {
    return null;
  }
  return status;
}
