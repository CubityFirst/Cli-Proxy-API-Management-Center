import { apiClient } from './client';

/**
 * Why a request did or did not find its prompt cache, as attributed by the
 * backend's cache history recorder.
 * - continued: same account while the cache was alive
 * - switched: moved to another account while the cache was alive
 * - expired: longer gap than the cache lifetime
 * - new: first request of a conversation
 * - untracked: no session identity
 */
export const CACHE_REASONS = ['continued', 'switched', 'expired', 'new', 'untracked'] as const;
export type CacheReason = (typeof CACHE_REASONS)[number];

/** Prompt-token totals for one reason. */
export interface CacheTally {
  requests: number;
  misses: number;
  read: number;
  write: number;
  input: number;
  /** Cached prompt the previous request left that this request processed again. */
  lost: number;
}

export interface CacheBucket {
  atMs: number;
  reasons: Partial<Record<CacheReason, CacheTally>>;
}

export interface CacheHistorySeries {
  authId: string;
  provider: string;
  label: string;
  buckets: CacheBucket[];
}

export interface CacheSettings {
  strategy: string;
  sessionAffinity: boolean;
  affinityTtl: string;
  rebindOn: string;
  /** Empty when bound sessions never move to expiring quota. */
  expiringWindow: string;
}

export interface CacheMarker extends CacheSettings {
  atMs: number;
}

export interface CacheHistory {
  nowMs: number;
  bucketMs: number;
  series: CacheHistorySeries[];
  markers: CacheMarker[];
}

const CACHE_HISTORY_TIMEOUT_MS = 15 * 1000;

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const secondsToMs = (value: unknown): number | null => {
  const seconds = num(value);
  return seconds > 0 ? seconds * 1000 : null;
};

function normalizeTally(raw: unknown): CacheTally | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  return {
    requests: num(t.n),
    misses: num(t.m),
    read: num(t.r),
    write: num(t.w),
    input: num(t.i),
    lost: num(t.l),
  };
}

/** Normalize the backend payload; drops malformed entries instead of failing. */
export function normalizeCacheHistory(raw: unknown): CacheHistory {
  const body = (raw ?? {}) as Record<string, unknown>;
  const series = Array.isArray(body.series) ? body.series : [];
  const markers = Array.isArray(body.markers) ? body.markers : [];
  return {
    nowMs: secondsToMs(body.now) ?? Date.now(),
    bucketMs: (num(body.bucket_seconds) || 300) * 1000,
    series: series.flatMap((entry): CacheHistorySeries[] => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const authId = str(item.auth_id);
      if (!authId) return [];
      const buckets = Array.isArray(item.buckets) ? item.buckets : [];
      return [
        {
          authId,
          provider: str(item.provider),
          label: str(item.label),
          buckets: buckets
            .flatMap((value): CacheBucket[] => {
              const b = (value ?? {}) as Record<string, unknown>;
              const atMs = secondsToMs(b.t);
              if (atMs === null) return [];
              const by = (b.by ?? {}) as Record<string, unknown>;
              const reasons: CacheBucket['reasons'] = {};
              for (const reason of CACHE_REASONS) {
                const tally = normalizeTally(by[reason]);
                if (tally) reasons[reason] = tally;
              }
              return [{ atMs, reasons }];
            })
            .sort((a, b) => a.atMs - b.atMs),
        },
      ];
    }),
    markers: markers
      .flatMap((value): CacheMarker[] => {
        const m = (value ?? {}) as Record<string, unknown>;
        const atMs = secondsToMs(m.t);
        if (atMs === null) return [];
        return [
          {
            atMs,
            strategy: str(m.strategy),
            sessionAffinity: m.session_affinity === true,
            affinityTtl: str(m.affinity_ttl),
            rebindOn: str(m.rebind_on),
            expiringWindow: str(m.expiring_window),
          },
        ];
      })
      .sort((a, b) => a.atMs - b.atMs),
  };
}

export const cacheHistoryApi = {
  /**
   * Recorded prompt-cache usage per credential. Resolves to null when the
   * backend does not record it (older or upstream CLIProxyAPI builds).
   */
  async get(days = 7): Promise<CacheHistory | null> {
    try {
      const raw = await apiClient.get<unknown>('/observability/cache-history', {
        params: { days },
        timeout: CACHE_HISTORY_TIMEOUT_MS,
      });
      return normalizeCacheHistory(raw);
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      throw error;
    }
  },
};
