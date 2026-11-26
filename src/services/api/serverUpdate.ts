/**
 * Server updates from GitHub releases (GET/POST /server/update).
 *
 * The backend checks remote-management.server-update-repository for a newer
 * release and, on request, hands the tag to a privileged helper on the host,
 * which installs it and restarts the server. Older or upstream backends don't
 * have the endpoint (404); callers fall back to /server/latest-version.
 */

import { apiClient } from './client';

/** Helper progress states, in order, then the terminal ones. */
export const SERVER_UPDATE_PROGRESS_STATES = [
  'downloading',
  'verifying',
  'installing',
  'restarting',
] as const;
export const SERVER_UPDATE_TERMINAL_STATES = [
  'succeeded',
  'failed',
  'rolled_back',
  'rollback_failed',
  'verified',
] as const;

export interface ServerUpdateHelperStatus {
  state: string;
  tag: string;
  from: string;
  message: string;
  updatedAtMs: number | null;
}

export interface ServerUpdateRelease {
  tag: string;
  version: string;
  publishedAtMs: number | null;
  url: string;
  /** Archive the host helper installs on the server's platform. */
  asset: string;
  /** False while the release workflow is still uploading the archive. */
  assetReady: boolean;
}

export interface ServerUpdateInfo {
  /** owner/repo; empty when the server has no update repository configured. */
  repository: string;
  currentVersion: string;
  /** The server can hand requests to the host helper. */
  applyEnabled: boolean;
  latest: ServerUpdateRelease | null;
  updateAvailable: boolean;
  /** A request is waiting for the helper. */
  pending: boolean;
  status: ServerUpdateHelperStatus | null;
  /** Why GitHub couldn't be checked, if it couldn't. */
  error: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const timeMs = (value: unknown): number | null => {
  const ms = Date.parse(str(value));
  return Number.isFinite(ms) ? ms : null;
};

function normalizeRelease(raw: unknown): ServerUpdateRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tag = str(r.tag);
  if (!tag) return null;
  return {
    tag,
    version: str(r.version) || tag.replace(/^v/i, ''),
    publishedAtMs: timeMs(r.published_at),
    url: str(r.url),
    asset: str(r.asset),
    assetReady: r.asset_ready === true,
  };
}

function normalizeStatus(raw: unknown): ServerUpdateHelperStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const state = str(s.state);
  if (!state) return null;
  return {
    state,
    tag: str(s.tag),
    from: str(s.from),
    message: str(s.message),
    updatedAtMs: timeMs(s.updated_at),
  };
}

export function normalizeServerUpdate(raw: unknown): ServerUpdateInfo {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    repository: str(body.repository),
    currentVersion: str(body.current_version),
    applyEnabled: body.apply_enabled === true,
    latest: normalizeRelease(body.latest),
    updateAvailable: body.update_available === true,
    pending: body.pending === true,
    status: normalizeStatus(body.status),
    error: str(body.error),
  };
}

export const isTerminalUpdateState = (state: string): boolean =>
  (SERVER_UPDATE_TERMINAL_STATES as readonly string[]).includes(state);

export const serverUpdateApi = {
  get: async (): Promise<ServerUpdateInfo> =>
    normalizeServerUpdate(await apiClient.get<unknown>('/server/update')),
  request: (tag: string) => apiClient.post<{ requested?: string }>('/server/update', { tag }),
};
