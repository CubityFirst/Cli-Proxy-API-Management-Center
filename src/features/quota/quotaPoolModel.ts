/**
 * Quota pool model: one provider's credentials treated as a single pool of
 * weekly capacity (100% per credential).
 *
 * Answers the questions the per-card view can't: how much of the pool is left,
 * how fast it's being burned, when it runs dry, and how much quota will reset
 * unused under the active routing strategy.
 *
 * Pure functions with an injected `now` so every case is directly testable.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * HOUR_MS;

/** One credential's current weekly window. */
export interface PoolAccount {
  /** Credential file name; matches the backend auth ID. */
  id: string;
  label: string;
  /** Remaining percent of the weekly window, 0..100. */
  remaining: number;
  /** Next weekly reset instant. */
  resetAtMs: number;
  periodMs: number;
}

/** One recorded observation (see GET /observability/quota-history). */
export interface PoolSample {
  atMs: number;
  /** Percent of the weekly window used, 0..100. */
  weeklyUsed: number;
  /** Weekly reset reported with this observation, if any. */
  weeklyResetMs: number | null;
}

export type PoolHistory = Record<string, PoolSample[]>;

/** How the router spreads load across credentials, as far as the projection cares. */
export type DrainOrder = 'soonest-reset' | 'fill-first' | 'even';

export function drainOrderForStrategy(strategy: string | undefined | null): DrainOrder {
  switch ((strategy ?? '').trim().toLowerCase()) {
    case 'soonest-reset':
    case 'soonestreset':
    case 'sr':
      return 'soonest-reset';
    case 'fill-first':
    case 'fillfirst':
    case 'ff':
      return 'fill-first';
    default:
      return 'even';
  }
}

export interface PoolPoint {
  t: number;
  pool: number;
  /** Remaining percent per account, in `accounts` order. */
  perAccount: number[];
}

export interface PoolResetEvent {
  t: number;
  /** Total percent restored across accounts resetting at this instant. */
  amount: number;
  /** Percent that was still unused when the window reset. */
  unused: number;
  accountIds: string[];
}

export interface PoolProjection {
  points: PoolPoint[];
  resets: PoolResetEvent[];
  firstEmpty: { accountId: string; t: number } | null;
  poolEmptyAt: number | null;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Advance a reset instant by whole periods until it is after `now`. */
export function rollForward(resetAtMs: number, periodMs: number, now: number): number {
  if (!(periodMs > 0) || resetAtMs > now) return resetAtMs;
  const periods = Math.floor((now - resetAtMs) / periodMs) + 1;
  return resetAtMs + periods * periodMs;
}

/* ------------------------------------------------------------ recorded */

/**
 * Remaining percent of one account at `t` from its samples (sorted by time).
 * Between observations usage is assumed unchanged, except that a reset reported
 * by the last observation restores the window to 100%.
 * Before the first sample the first observed value is used.
 */
export function remainingAt(samples: readonly PoolSample[], t: number): number | null {
  if (samples.length === 0) return null;
  let last: PoolSample | null = null;
  for (const sample of samples) {
    if (sample.atMs > t) break;
    last = sample;
  }
  if (!last) return clamp(100 - samples[0].weeklyUsed, 0, 100);
  if (last.weeklyResetMs !== null && t >= last.weeklyResetMs) return 100;
  return clamp(100 - last.weeklyUsed, 0, 100);
}

/**
 * Recorded pool level from `fromMs` to `nowMs`, ending exactly at the live
 * values. Accounts without any history are held at their current level.
 * Returns no points when no account has history.
 */
export function recordedSeries(
  accounts: readonly PoolAccount[],
  history: PoolHistory,
  fromMs: number,
  nowMs: number,
  stepMs: number
): PoolPoint[] {
  const tracked = accounts.map((account) => history[account.id] ?? []);
  const firstSample = Math.min(
    ...tracked.filter((samples) => samples.length > 0).map((samples) => samples[0].atMs)
  );
  if (!Number.isFinite(firstSample) || !(stepMs > 0)) return [];

  const start = Math.max(fromMs, firstSample);
  const points: PoolPoint[] = [];
  for (let t = start; t < nowMs; t += stepMs) {
    const perAccount = accounts.map(
      (account, index) => remainingAt(tracked[index], t) ?? account.remaining
    );
    points.push({ t, pool: sum(perAccount), perAccount });
  }
  const live = accounts.map((account) => account.remaining);
  points.push({ t: nowMs, pool: sum(live), perAccount: live });
  return points;
}

/* ---------------------------------------------------------------- burn */

/** Percent consumed between two consecutive observations of one account. */
function consumedBetween(prev: PoolSample, next: PoolSample): number {
  const windowRolled =
    prev.weeklyResetMs !== null &&
    (next.atMs >= prev.weeklyResetMs ||
      (next.weeklyResetMs !== null && next.weeklyResetMs !== prev.weeklyResetMs));
  if (windowRolled || next.weeklyUsed < prev.weeklyUsed) return Math.max(0, next.weeklyUsed);
  return next.weeklyUsed - prev.weeklyUsed;
}

/**
 * Pool burn in percent per hour over the trailing window, from history.
 * Null when no account has an observation at or before the window end.
 */
export function historyBurnPerHour(
  accounts: readonly PoolAccount[],
  history: PoolHistory,
  nowMs: number,
  windowMs: number
): number | null {
  const from = nowMs - windowMs;
  let consumed = 0;
  let tracked = false;
  for (const account of accounts) {
    const samples = history[account.id] ?? [];
    if (samples.length === 0) continue;
    tracked = true;
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].atMs <= from || samples[i].atMs > nowMs) continue;
      consumed += consumedBetween(samples[i - 1], samples[i]);
    }
  }
  if (!tracked || !(windowMs > 0)) return null;
  return consumed / (windowMs / HOUR_MS);
}

/**
 * Fallback burn without history: each account's usage so far this week spread
 * over the elapsed part of its window. Accounts less than an hour into their
 * window are skipped since a single burst would dominate.
 */
export function weeklyAverageBurnPerHour(accounts: readonly PoolAccount[], nowMs: number): number {
  let burn = 0;
  for (const account of accounts) {
    const resetAt = rollForward(account.resetAtMs, account.periodMs, nowMs);
    const elapsedMs = account.periodMs - (resetAt - nowMs);
    if (elapsedMs < HOUR_MS) continue;
    burn += (100 - account.remaining) / (elapsedMs / HOUR_MS);
  }
  return burn;
}

/**
 * Burn per hour bucketed by `bucketMs` over [fromMs, nowMs], for the drain-rate
 * view. Consumption is attributed to the bucket of the later observation.
 */
export function recordedBurnSeries(
  accounts: readonly PoolAccount[],
  history: PoolHistory,
  fromMs: number,
  nowMs: number,
  bucketMs: number
): { t: number; perHour: number }[] {
  if (!(bucketMs > 0) || nowMs <= fromMs) return [];
  const count = Math.ceil((nowMs - fromMs) / bucketMs);
  const buckets = new Array<number>(count).fill(0);
  let tracked = false;
  for (const account of accounts) {
    const samples = history[account.id] ?? [];
    if (samples.length > 0) tracked = true;
    for (let i = 1; i < samples.length; i += 1) {
      const at = samples[i].atMs;
      if (at < fromMs || at > nowMs) continue;
      const index = Math.min(count - 1, Math.floor((at - fromMs) / bucketMs));
      buckets[index] += consumedBetween(samples[i - 1], samples[i]);
    }
  }
  if (!tracked) return [];
  const perHourFactor = HOUR_MS / bucketMs;
  return buckets.map((value, index) => ({
    t: fromMs + index * bucketMs,
    perHour: value * perHourFactor,
  }));
}

/* ---------------------------------------------------------- projection */

/**
 * Take `amount` from the accounts per the drain order. Returns what could not
 * be served because every account is empty.
 */
function drain(
  remaining: number[],
  nextReset: number[],
  amount: number,
  order: DrainOrder
): number {
  if (amount <= 0) return 0;
  if (order === 'even') {
    let left = amount;
    for (let guard = 0; left > 1e-9 && guard < remaining.length + 1; guard += 1) {
      const active = remaining
        .map((value, index) => (value > 1e-9 ? index : -1))
        .filter((i) => i >= 0);
      if (active.length === 0) break;
      const share = left / active.length;
      for (const index of active) {
        const taken = Math.min(remaining[index], share);
        remaining[index] -= taken;
        left -= taken;
      }
    }
    return Math.max(0, left);
  }
  const indexes = remaining.map((_, index) => index);
  if (order === 'soonest-reset') indexes.sort((a, b) => nextReset[a] - nextReset[b] || a - b);
  let left = amount;
  for (const index of indexes) {
    if (left <= 1e-9) break;
    const taken = Math.min(remaining[index], left);
    remaining[index] -= taken;
    left -= taken;
  }
  return Math.max(0, left);
}

/**
 * Simulate the pool from `nowMs` to `endMs`: burn at `burnPerHour`, drained per
 * the routing order, with each account refilling to 100% at its weekly reset.
 */
export function projectPool(input: {
  accounts: readonly PoolAccount[];
  nowMs: number;
  endMs: number;
  burnPerHour: number;
  order: DrainOrder;
  stepMs: number;
}): PoolProjection {
  const { accounts, nowMs, endMs, order, stepMs } = input;
  const burnPerHour = Math.max(0, input.burnPerHour);
  const remaining = accounts.map((account) => clamp(account.remaining, 0, 100));
  const nextReset = accounts.map((account) =>
    rollForward(account.resetAtMs, account.periodMs, nowMs)
  );
  const wasEmpty = remaining.map((value) => value <= 1e-9);

  const points: PoolPoint[] = [{ t: nowMs, pool: sum(remaining), perAccount: [...remaining] }];
  const resets: PoolResetEvent[] = [];
  let firstEmpty: PoolProjection['firstEmpty'] = null;
  let poolEmptyAt: number | null = sum(remaining) <= 1e-9 ? nowMs : null;
  if (!(stepMs > 0) || endMs <= nowMs) return { points, resets, firstEmpty, poolEmptyAt };

  // Burn from `from` to `to`, then record any account that just ran dry.
  const burnUntil = (from: number, to: number) => {
    if (to <= from) return;
    drain(remaining, nextReset, burnPerHour * ((to - from) / HOUR_MS), order);
    for (let index = 0; index < remaining.length; index += 1) {
      if (!firstEmpty && !wasEmpty[index] && remaining[index] <= 1e-9) {
        firstEmpty = { accountId: accounts[index].id, t: to };
      }
      if (remaining[index] <= 1e-9) wasEmpty[index] = true;
    }
    if (poolEmptyAt === null && sum(remaining) <= 1e-9 && accounts.length > 0) poolEmptyAt = to;
  };

  let t = nowMs;
  while (t < endMs) {
    const stepEnd = Math.min(endMs, t + stepMs);
    let cursor = t;

    // Resets inside this step happen at their exact instant: burn up to the
    // reset first, so the jump is drawn where it occurs and usage before it is
    // charged to the old window.
    for (;;) {
      let index = -1;
      for (let i = 0; i < nextReset.length; i += 1) {
        if (nextReset[i] <= stepEnd && (index < 0 || nextReset[i] < nextReset[index])) index = i;
      }
      if (index < 0) break;
      const at = nextReset[index];
      burnUntil(cursor, at);
      cursor = Math.max(cursor, at);
      const restored = 100 - remaining[index];
      const unused = remaining[index];
      points.push({ t: at, pool: sum(remaining), perAccount: [...remaining] });
      remaining[index] = 100;
      wasEmpty[index] = false;
      nextReset[index] += accounts[index].periodMs;
      points.push({ t: at, pool: sum(remaining), perAccount: [...remaining] });
      const existing = resets.find((event) => Math.abs(event.t - at) < stepMs / 2);
      if (existing) {
        existing.amount += restored;
        existing.unused += unused;
        existing.accountIds.push(accounts[index].id);
      } else {
        resets.push({ t: at, amount: restored, unused, accountIds: [accounts[index].id] });
      }
    }

    burnUntil(cursor, stepEnd);
    points.push({ t: stepEnd, pool: sum(remaining), perAccount: [...remaining] });
    t = stepEnd;
  }
  resets.sort((a, b) => a.t - b.t);
  return { points, resets, firstEmpty, poolEmptyAt };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
