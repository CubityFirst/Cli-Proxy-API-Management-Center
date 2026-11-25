import { apiClient } from './client';

/** One observation as served by GET /observability/quota-history. */
export interface QuotaHistorySample {
  /** Observation time, ms. */
  atMs: number;
  /** Percent of the weekly window used, 0..100. */
  weeklyUsed: number;
  /** Percent of the short (5h / primary) window used, 0..100. */
  shortUsed: number;
  weeklyResetMs: number | null;
  shortResetMs: number | null;
}

export interface QuotaHistorySeries {
  authId: string;
  provider: string;
  label: string;
  samples: QuotaHistorySample[];
}

export interface QuotaHistory {
  nowMs: number;
  series: QuotaHistorySeries[];
}

const QUOTA_HISTORY_TIMEOUT_MS = 15 * 1000;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const secondsToMs = (value: unknown): number | null => {
  const seconds = num(value);
  return seconds !== null && seconds > 0 ? seconds * 1000 : null;
};

/** Normalize the backend payload; drops malformed entries instead of failing. */
export function normalizeQuotaHistory(raw: unknown): QuotaHistory {
  const body = (raw ?? {}) as { now?: unknown; series?: unknown };
  const series = Array.isArray(body.series) ? body.series : [];
  return {
    nowMs: secondsToMs(body.now) ?? Date.now(),
    series: series.flatMap((entry): QuotaHistorySeries[] => {
      const item = (entry ?? {}) as Record<string, unknown>;
      if (typeof item.auth_id !== 'string' || !item.auth_id) return [];
      const samples = Array.isArray(item.samples) ? item.samples : [];
      return [
        {
          authId: item.auth_id,
          provider: typeof item.provider === 'string' ? item.provider : '',
          label: typeof item.label === 'string' ? item.label : '',
          samples: samples
            .flatMap((value): QuotaHistorySample[] => {
              const s = (value ?? {}) as Record<string, unknown>;
              const atMs = secondsToMs(s.t);
              if (atMs === null) return [];
              return [
                {
                  atMs,
                  weeklyUsed: num(s.w) ?? 0,
                  shortUsed: num(s.s) ?? 0,
                  weeklyResetMs: secondsToMs(s.wr),
                  shortResetMs: secondsToMs(s.sr),
                },
              ];
            })
            .sort((a, b) => a.atMs - b.atMs),
        },
      ];
    }),
  };
}

export const quotaHistoryApi = {
  /**
   * Recorded quota usage per credential. Resolves to null when the backend does
   * not provide quota history (older or upstream CLIProxyAPI builds).
   */
  async get(days = 14): Promise<QuotaHistory | null> {
    try {
      const raw = await apiClient.get<unknown>('/observability/quota-history', {
        params: { days },
        timeout: QUOTA_HISTORY_TIMEOUT_MS,
      });
      return normalizeQuotaHistory(raw);
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      throw error;
    }
  },
};
