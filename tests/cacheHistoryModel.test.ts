import { describe, expect, test } from 'bun:test';
import { normalizeCacheHistory } from '@/services/api/cacheHistory';
import {
  cacheSeries,
  comparableRequests,
  formatTokens,
  hitRate,
  settingsSegments,
  totalsBetween,
} from '@/features/quota/cacheHistoryModel';

const HOUR = 3600;
const T0 = 1_795_000_000 - (1_795_000_000 % HOUR);

const raw = {
  now: T0 + 6 * HOUR,
  bucket_seconds: 300,
  series: [
    {
      auth_id: 'a.json',
      provider: 'claude',
      label: 'a@example.com',
      buckets: [
        {
          t: T0,
          by: {
            new: { n: 1, w: 40_000 },
            continued: { n: 4, r: 160_000, w: 8_000, i: 40 },
          },
        },
        {
          t: T0 + 3 * HOUR,
          by: { continued: { n: 2, r: 90_000, w: 2_000, l: 500 } },
        },
      ],
    },
    {
      auth_id: 'b.json',
      provider: 'claude',
      buckets: [
        {
          t: T0 + HOUR + 600,
          by: {
            switched: { n: 2, m: 1, r: 10_000, w: 50_000, l: 44_000 },
            expired: { n: 1, m: 1, w: 30_000, l: 30_000 },
            bogus: { n: 9 },
          },
        },
        { t: 'not a time', by: {} },
      ],
    },
    { provider: 'claude', buckets: [] },
  ],
  markers: [
    {
      t: T0 + 2 * HOUR,
      strategy: 'soonest-reset',
      session_affinity: true,
      affinity_ttl: '1h',
      rebind_on: 'quota',
    },
    { t: T0 - HOUR, strategy: 'round-robin', session_affinity: false },
  ],
};

describe('cache history', () => {
  const history = normalizeCacheHistory(raw);

  test('normalizes series, drops malformed entries and sorts markers', () => {
    expect(history.series.map((s) => s.authId)).toEqual(['a.json', 'b.json']);
    expect(history.series[1].buckets).toHaveLength(1);
    expect(Object.keys(history.series[1].buckets[0].reasons).sort()).toEqual([
      'expired',
      'switched',
    ]);
    expect(history.markers.map((m) => m.strategy)).toEqual(['round-robin', 'soonest-reset']);
    expect(history.markers[1]).toMatchObject({ sessionAffinity: true, rebindOn: 'quota' });
    expect(history.bucketMs).toBe(300_000);
  });

  test('totals and hit rate over a range', () => {
    const totals = totalsBetween(history, T0 * 1000, (T0 + 6 * HOUR) * 1000);
    expect(totals.requests).toBe(10);
    expect(totals.byReason.switched.misses).toBe(1);
    expect(totals.lost).toBe(74_500);
    expect(comparableRequests(totals)).toBe(9);
    const prompt = totals.read + totals.write + totals.input;
    expect(hitRate(totals)).toBeCloseTo(260_000 / prompt, 6);
    expect(hitRate(totalsBetween(history, 0, 1))).toBeNull();
  });

  test('fixed-step series includes empty steps', () => {
    const points = cacheSeries(history, T0 * 1000, (T0 + 4 * HOUR) * 1000, HOUR * 1000);
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.totals.requests)).toEqual([5, 3, 0, 2]);
    expect(points[1].totals.byReason.switched.lost).toBe(44_000);
  });

  test('segments split at settings changes, newest first', () => {
    const segments = settingsSegments(history, T0 * 1000, (T0 + 6 * HOUR) * 1000);
    expect(segments).toHaveLength(2);
    expect(segments[0].settings?.strategy).toBe('soonest-reset');
    expect(segments[0].totals.requests).toBe(2);
    expect(segments[1].settings?.strategy).toBe('round-robin');
    expect(segments[1].totals.requests).toBe(8);
    expect(segments[1].toMs).toBe((T0 + 2 * HOUR) * 1000);
  });

  test('segments before the first marker have no settings', () => {
    const early = normalizeCacheHistory({ ...raw, markers: [raw.markers[0]] });
    const segments = settingsSegments(early, T0 * 1000, (T0 + 6 * HOUR) * 1000);
    expect(segments.map((s) => s.settings?.strategy ?? null)).toEqual(['soonest-reset', null]);
  });

  test('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(1_240)).toBe('1.2k');
    expect(formatTokens(3_100_000)).toBe('3.1M');
  });
});
