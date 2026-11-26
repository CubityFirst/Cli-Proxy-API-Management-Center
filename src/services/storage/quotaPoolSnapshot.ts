/**
 * The last loaded weekly quota of each quota-pool credential, so the pool chart
 * on the Quota page can show the previous picture (dimmed and marked as cached)
 * after a page reload, until quotas are refreshed.
 *
 * Kept in localStorage, scoped to the server it was loaded from and cleared on
 * logout. Only numbers and credential file names are stored.
 */

export interface PoolSnapshotAccount {
  /** Remaining percent of the weekly window when loaded, 0..100. */
  remaining: number;
  resetAtMs: number;
  periodMs: number;
  /** When the value was loaded. */
  capturedAt: number;
}

/** Provider -> credential file name -> last loaded value. */
export type PoolSnapshot = Record<string, Record<string, PoolSnapshotAccount>>;

interface StoredSnapshot {
  version: 1;
  apiBase: string;
  pools: PoolSnapshot;
}

export const POOL_SNAPSHOT_KEY = 'quotaPage.poolSnapshot';

/** Values older than this are dropped on the next write. */
export const POOL_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function parseAccount(value: unknown): PoolSnapshotAccount | null {
  if (!value || typeof value !== 'object') return null;
  const { remaining, resetAtMs, periodMs, capturedAt } = value as Record<string, unknown>;
  if (
    !isFiniteNumber(remaining) ||
    !isFiniteNumber(resetAtMs) ||
    !isFiniteNumber(periodMs) ||
    !isFiniteNumber(capturedAt) ||
    periodMs <= 0
  ) {
    return null;
  }
  return { remaining: Math.min(100, Math.max(0, remaining)), resetAtMs, periodMs, capturedAt };
}

function parsePools(value: unknown): PoolSnapshot {
  const pools: PoolSnapshot = {};
  if (!value || typeof value !== 'object') return pools;
  for (const [provider, accounts] of Object.entries(value as Record<string, unknown>)) {
    if (!accounts || typeof accounts !== 'object') continue;
    for (const [id, raw] of Object.entries(accounts as Record<string, unknown>)) {
      const account = parseAccount(raw);
      if (account) (pools[provider] ??= {})[id] = account;
    }
  }
  return pools;
}

function readStored(): StoredSnapshot | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(POOL_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSnapshot> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.apiBase !== 'string') return null;
    return { version: 1, apiBase: parsed.apiBase, pools: parsePools(parsed.pools) };
  } catch {
    return null;
  }
}

/** The snapshot saved for `apiBase`; empty when none was saved or it belongs to another server. */
export function readPoolSnapshot(apiBase: string): PoolSnapshot {
  if (!apiBase) return {};
  const stored = readStored();
  return stored && stored.apiBase === apiBase ? stored.pools : {};
}

/**
 * Merges `updates` into the snapshot for `apiBase`, replacing a snapshot saved
 * for another server, and drops values older than the maximum age.
 */
export function writePoolSnapshot(apiBase: string, updates: PoolSnapshot, now = Date.now()): void {
  const store = storage();
  if (!store || !apiBase) return;
  const pools = readPoolSnapshot(apiBase);
  for (const [provider, accounts] of Object.entries(updates)) {
    pools[provider] = { ...pools[provider], ...accounts };
  }
  for (const [provider, accounts] of Object.entries(pools)) {
    for (const [id, account] of Object.entries(accounts)) {
      if (now - account.capturedAt > POOL_SNAPSHOT_MAX_AGE_MS) delete accounts[id];
    }
    if (Object.keys(accounts).length === 0) delete pools[provider];
  }
  const next: StoredSnapshot = { version: 1, apiBase, pools };
  try {
    store.setItem(POOL_SNAPSHOT_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked; the chart just won't have a cached picture.
  }
}

export function clearPoolSnapshot(): void {
  try {
    storage()?.removeItem(POOL_SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}
