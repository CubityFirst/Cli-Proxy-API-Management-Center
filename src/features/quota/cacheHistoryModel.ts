/**
 * Pure maths for the prompt-cache card: totals over a range, fixed-step series
 * for the charts, and per-routing-setting segments for before/after comparison.
 */

import { CACHE_REASONS } from '@/services/api/cacheHistory';
import type {
  CacheHistory,
  CacheReason,
  CacheSettings,
  CacheTally,
} from '@/services/api/cacheHistory';

/** Reasons that can lose cache, in stacking order from the baseline up. */
export const LOST_REASONS = ['switched', 'expired', 'continued'] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export interface CacheTotals extends CacheTally {
  byReason: Record<CacheReason, CacheTally>;
}

export const emptyTally = (): CacheTally => ({
  requests: 0,
  misses: 0,
  read: 0,
  write: 0,
  input: 0,
  lost: 0,
});

export function emptyTotals(): CacheTotals {
  const byReason = {} as Record<CacheReason, CacheTally>;
  for (const reason of CACHE_REASONS) byReason[reason] = emptyTally();
  return { ...emptyTally(), byReason };
}

function addTally(into: CacheTally, from: CacheTally) {
  into.requests += from.requests;
  into.misses += from.misses;
  into.read += from.read;
  into.write += from.write;
  into.input += from.input;
  into.lost += from.lost;
}

/** Share of prompt tokens served from cache, or null without any prompt tokens. */
export function hitRate(tally: CacheTally): number | null {
  const prompt = tally.read + tally.write + tally.input;
  return prompt > 0 ? tally.read / prompt : null;
}

/** Requests that had a previous request to compare with (not new or untracked). */
export function comparableRequests(totals: CacheTotals): number {
  return LOST_REASONS.reduce((sum, reason) => sum + totals.byReason[reason].requests, 0);
}

/** Sums every bucket starting in [startMs, endMs). */
export function totalsBetween(history: CacheHistory | null, startMs: number, endMs: number) {
  const totals = emptyTotals();
  if (!history) return totals;
  for (const series of history.series) {
    for (const bucket of series.buckets) {
      if (bucket.atMs < startMs || bucket.atMs >= endMs) continue;
      for (const reason of CACHE_REASONS) {
        const tally = bucket.reasons[reason];
        if (!tally) continue;
        addTally(totals.byReason[reason], tally);
        addTally(totals, tally);
      }
    }
  }
  return totals;
}

export interface CachePoint {
  /** Step start, ms. */
  t: number;
  totals: CacheTotals;
}

/** Fixed steps covering [startMs, endMs), including empty ones. */
export function cacheSeries(
  history: CacheHistory | null,
  startMs: number,
  endMs: number,
  stepMs: number
): CachePoint[] {
  const points: CachePoint[] = [];
  if (!(stepMs > 0) || endMs <= startMs) return points;
  for (let t = startMs; t < endMs; t += stepMs) points.push({ t, totals: emptyTotals() });
  if (!history) return points;
  for (const series of history.series) {
    for (const bucket of series.buckets) {
      if (bucket.atMs < startMs || bucket.atMs >= endMs) continue;
      const point = points[Math.floor((bucket.atMs - startMs) / stepMs)];
      if (!point) continue;
      for (const reason of CACHE_REASONS) {
        const tally = bucket.reasons[reason];
        if (!tally) continue;
        addTally(point.totals.byReason[reason], tally);
        addTally(point.totals, tally);
      }
    }
  }
  return points;
}

export interface SettingsSegment {
  fromMs: number;
  toMs: number;
  /** Null for the part of the range before any settings were recorded. */
  settings: CacheSettings | null;
  totals: CacheTotals;
}

/**
 * Splits [startMs, endMs) wherever the routing settings changed, newest first,
 * keeping only segments that saw requests.
 */
export function settingsSegments(
  history: CacheHistory | null,
  startMs: number,
  endMs: number
): SettingsSegment[] {
  if (!history || endMs <= startMs) return [];
  const markers = history.markers;
  let current: CacheSettings | null = null;
  const boundaries: { atMs: number; settings: CacheSettings }[] = [];
  for (const marker of markers) {
    if (marker.atMs <= startMs) current = marker;
    else if (marker.atMs < endMs) boundaries.push({ atMs: marker.atMs, settings: marker });
  }
  const segments: SettingsSegment[] = [];
  let fromMs = startMs;
  for (const boundary of [...boundaries, { atMs: endMs, settings: null }]) {
    if (boundary.atMs > fromMs) {
      segments.push({
        fromMs,
        toMs: boundary.atMs,
        settings: current,
        totals: totalsBetween(history, fromMs, boundary.atMs),
      });
    }
    fromMs = Math.max(fromMs, boundary.atMs);
    current = boundary.settings ?? current;
  }
  return segments.filter((segment) => segment.totals.requests > 0).reverse();
}

/** Same settings, ignoring when they were recorded. */
export function sameSettings(a: CacheSettings | null, b: CacheSettings | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.strategy === b.strategy &&
    a.sessionAffinity === b.sessionAffinity &&
    a.affinityTtl === b.affinityTtl &&
    a.rebindOn === b.rebindOn &&
    a.expiringWindow === b.expiringWindow
  );
}

/** Compact token count, e.g. 950, 12.4k, 3.1M. */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}
