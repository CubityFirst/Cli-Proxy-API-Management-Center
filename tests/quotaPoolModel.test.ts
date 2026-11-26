import { describe, expect, test } from 'bun:test';
import {
  HOUR_MS,
  WEEK_MS,
  drainOrderForStrategy,
  historyBurnPerHour,
  projectPool,
  recordedBurnSeries,
  recordedSeries,
  remainingAt,
  restoreCachedAccount,
  rollForward,
  weeklyAverageBurnPerHour,
} from '../src/features/quota/quotaPoolModel';
import type { PoolAccount, PoolSample } from '../src/features/quota/quotaPoolModel';

const NOW = Date.UTC(2026, 10, 25, 20, 0, 0);

const account = (id: string, remaining: number, resetInHours: number): PoolAccount => ({
  id,
  label: id,
  remaining,
  resetAtMs: NOW + resetInHours * HOUR_MS,
  periodMs: WEEK_MS,
});

const sample = (hoursAgo: number, used: number, resetMs: number | null = null): PoolSample => ({
  atMs: NOW - hoursAgo * HOUR_MS,
  weeklyUsed: used,
  weeklyResetMs: resetMs,
});

describe('drainOrderForStrategy', () => {
  test('maps routing strategies and aliases', () => {
    expect(drainOrderForStrategy('soonest-reset')).toBe('soonest-reset');
    expect(drainOrderForStrategy('SR')).toBe('soonest-reset');
    expect(drainOrderForStrategy('fill-first')).toBe('fill-first');
    expect(drainOrderForStrategy('round-robin')).toBe('even');
    expect(drainOrderForStrategy(undefined)).toBe('even');
  });
});

describe('rollForward', () => {
  test('moves a past reset forward by whole periods', () => {
    expect(rollForward(NOW - HOUR_MS, WEEK_MS, NOW)).toBe(NOW - HOUR_MS + WEEK_MS);
    expect(rollForward(NOW + HOUR_MS, WEEK_MS, NOW)).toBe(NOW + HOUR_MS);
  });
});

describe('restoreCachedAccount', () => {
  const cached = {
    remaining: 60,
    resetAtMs: NOW + 24 * HOUR_MS,
    periodMs: WEEK_MS,
    capturedAt: NOW - 5 * HOUR_MS,
  };

  test('keeps the cached value when no newer observation exists', () => {
    expect(restoreCachedAccount(cached, [sample(8, 10)], NOW)).toEqual({
      remaining: 60,
      resetAtMs: NOW + 24 * HOUR_MS,
      asOf: NOW - 5 * HOUR_MS,
    });
  });

  test('a newer history observation replaces the cached value', () => {
    const resetMs = NOW + 23 * HOUR_MS;
    // The future sample (beyond now) is ignored.
    const samples = [sample(8, 10), sample(2, 55, resetMs), sample(-1, 90)];
    expect(restoreCachedAccount(cached, samples, NOW)).toEqual({
      remaining: 45,
      resetAtMs: resetMs,
      asOf: NOW - 2 * HOUR_MS,
    });
  });

  test('a weekly reset that has passed refills the window', () => {
    const stale = { ...cached, remaining: 5, resetAtMs: NOW - HOUR_MS };
    expect(restoreCachedAccount(stale, [], NOW)).toEqual({
      remaining: 100,
      resetAtMs: NOW - HOUR_MS + WEEK_MS,
      asOf: cached.capturedAt,
    });
  });
});

describe('recorded history', () => {
  test('remainingAt holds the last observation and applies a reported reset', () => {
    const samples = [sample(10, 20, NOW - 2 * HOUR_MS), sample(1, 5)];
    expect(remainingAt(samples, NOW - 20 * HOUR_MS)).toBe(80);
    expect(remainingAt(samples, NOW - 5 * HOUR_MS)).toBe(80);
    expect(remainingAt(samples, NOW - 1.5 * HOUR_MS)).toBe(100);
    expect(remainingAt(samples, NOW)).toBe(95);
    expect(remainingAt([], NOW)).toBeNull();
  });

  test('recordedSeries ends at live values and is empty without history', () => {
    const accounts = [account('a', 60, 24), account('b', 90, 48)];
    expect(recordedSeries(accounts, {}, NOW - 6 * HOUR_MS, NOW, HOUR_MS)).toEqual([]);

    const points = recordedSeries(
      accounts,
      { a: [sample(4, 30), sample(2, 40)] },
      NOW - 6 * HOUR_MS,
      NOW,
      HOUR_MS
    );
    // Starts at the first observation, untracked account held at its live value.
    expect(points[0]).toEqual({ t: NOW - 4 * HOUR_MS, pool: 70 + 90, perAccount: [70, 90] });
    expect(points.at(-1)).toEqual({ t: NOW, pool: 150, perAccount: [60, 90] });
  });
});

describe('burn rate', () => {
  test('history burn sums usage inside the window and ignores reset drops', () => {
    const accounts = [account('a', 50, 24), account('b', 90, 48)];
    const history = {
      a: [sample(5, 40), sample(2, 44), sample(1, 50)],
      // Window rolled between samples: usage since the reset counts.
      b: [sample(4, 70, NOW - 3 * HOUR_MS), sample(1, 10)],
    };
    // 3h window: a +4 +6, b +10 -> 20%/3h.
    expect(historyBurnPerHour(accounts, history, NOW, 3 * HOUR_MS)).toBeCloseTo(20 / 3, 6);
    expect(historyBurnPerHour(accounts, {}, NOW, 3 * HOUR_MS)).toBeNull();
  });

  test('weekly average spreads usage over the elapsed window', () => {
    // 24h left of 168h -> 144h elapsed, 72% used.
    expect(weeklyAverageBurnPerHour([account('a', 28, 24)], NOW)).toBeCloseTo(0.5, 6);
  });

  test('recordedBurnSeries buckets consumption per hour', () => {
    const series = recordedBurnSeries(
      [account('a', 50, 24)],
      { a: [sample(3, 10), sample(1.5, 16)] },
      NOW - 3 * HOUR_MS,
      NOW,
      HOUR_MS
    );
    expect(series.map((point) => point.perHour)).toEqual([0, 6, 0]);
  });
});

describe('projectPool', () => {
  test('soonest-reset drains the earliest reset first and wastes less', () => {
    const accounts = [account('late', 100, 100), account('soon', 30, 10)];
    const soonest = projectPool({
      accounts,
      nowMs: NOW,
      endMs: NOW + 12 * HOUR_MS,
      burnPerHour: 2,
      order: 'soonest-reset',
      stepMs: HOUR_MS,
    });
    const even = projectPool({
      accounts,
      nowMs: NOW,
      endMs: NOW + 12 * HOUR_MS,
      burnPerHour: 2,
      order: 'even',
      stepMs: HOUR_MS,
    });
    // 10h at 2%/h = 20% all from "soon" -> 10% left unused at its reset.
    expect(soonest.resets).toHaveLength(1);
    expect(soonest.resets[0].unused).toBeCloseTo(10, 6);
    expect(soonest.resets[0].amount).toBeCloseTo(90, 6);
    // Even split takes only 10% from "soon" -> 20% unused.
    expect(even.resets[0].unused).toBeCloseTo(20, 6);
  });

  test('reports first empty account and pool exhaustion', () => {
    const projection = projectPool({
      accounts: [account('a', 5, 200), account('b', 10, 200)],
      nowMs: NOW,
      endMs: NOW + 24 * HOUR_MS,
      burnPerHour: 5,
      order: 'fill-first',
      stepMs: HOUR_MS,
    });
    expect(projection.firstEmpty).toEqual({ accountId: 'a', t: NOW + HOUR_MS });
    expect(projection.poolEmptyAt).toBe(NOW + 3 * HOUR_MS);
    expect(projection.points.at(-1)?.pool).toBe(0);
  });

  test('accounts already empty are not reported as first empty', () => {
    const projection = projectPool({
      accounts: [account('dry', 0, 200), account('b', 50, 200)],
      nowMs: NOW,
      endMs: NOW + 48 * HOUR_MS,
      burnPerHour: 2,
      order: 'even',
      stepMs: HOUR_MS,
    });
    expect(projection.firstEmpty?.accountId).toBe('b');
  });

  test('resets at the same instant merge into one event and refill weekly', () => {
    const projection = projectPool({
      accounts: [account('a', 40, 5), account('b', 70, 5)],
      nowMs: NOW,
      endMs: NOW + 8 * 24 * HOUR_MS,
      burnPerHour: 0,
      order: 'even',
      stepMs: HOUR_MS,
    });
    expect(projection.resets[0]).toMatchObject({ t: NOW + 5 * HOUR_MS, amount: 90 });
    expect(projection.resets[0].accountIds.sort()).toEqual(['a', 'b']);
    // Next week's reset restores nothing at zero burn.
    expect(projection.resets[1]).toMatchObject({ t: NOW + 5 * HOUR_MS + WEEK_MS, amount: 0 });
    expect(projection.poolEmptyAt).toBeNull();
  });
});
