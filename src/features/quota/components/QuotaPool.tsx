/**
 * Quota pool view: each provider's credentials as one pool of weekly capacity,
 * with the recorded level (from the backend's quota history) and a projection
 * that burns at the measured rate, drains credentials in the active routing
 * order and refills each one at its weekly reset.
 *
 * All maths lives in quotaPoolModel.ts; this file is data plumbing and layout.
 *
 * Each loaded weekly quota is also saved (see services/storage/quotaPoolSnapshot),
 * so after a page reload the chart shows the last loaded picture, dimmed and
 * marked as cached, until the quotas are refreshed.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { quotaHistoryApi } from '@/services/api/quotaHistory';
import type { QuotaHistory } from '@/services/api/quotaHistory';
import { readPoolSnapshot, writePoolSnapshot } from '@/services/storage/quotaPoolSnapshot';
import type { PoolSnapshot } from '@/services/storage/quotaPoolSnapshot';
import { Select } from '@/components/ui/Select';
import type { ResolvedTheme } from '@/types';
import {
  HOUR_MS,
  drainOrderForStrategy,
  historyBurnPerHour,
  projectPool,
  recordedBurnSeries,
  recordedSeries,
  restoreCachedAccount,
  weeklyAverageBurnPerHour,
} from '../quotaPoolModel';
import type {
  PoolAccount,
  PoolHistory,
  PoolPoint,
  PoolResetEvent,
  PoolSample,
} from '../quotaPoolModel';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { useElementWidth } from '../useElementWidth';
import styles from './QuotaPool.module.scss';

const DAY_MS = 24 * HOUR_MS;
const PAST_DAYS = 3;
const SPAN_DAYS = 14;
const STEP_MS = 15 * 60 * 1000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const POOL_PROVIDERS = ['claude', 'codex'] as const;
type PoolProvider = (typeof POOL_PROVIDERS)[number];

const LINE_COLORS: Record<PoolProvider, Record<ResolvedTheme, string>> = {
  claude: { dark: '#ef8354', light: '#c2552b' },
  codex: { dark: '#7aa2ff', light: '#3d5fd9' },
};

/** Weekly window id per provider, matching the quota adapters. */
const WEEKLY_WINDOW_ID: Record<PoolProvider, string> = { claude: 'seven-day', codex: 'weekly' };

type ChartMode = 'remaining' | 'drain';
type FutureUsage = 'same' | 'half' | 'double' | 'idle';
const FUTURE_FACTOR: Record<FutureUsage, number> = { same: 1, half: 0.5, double: 2, idle: 0 };
const BURN_WINDOWS = [1, 3, 6] as const;

interface WindowLike {
  id?: string;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

export interface QuotaPoolProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  routingStrategy: string | undefined;
  /** Changes when the user refreshes everything, to refetch history too. */
  refreshToken: number;
  /** Server the quotas come from; scopes the saved snapshot. Empty disables it. */
  apiBase: string;
  /** Refreshes every quota; offered on a chart that shows cached data. */
  onRefresh?: () => void;
  /** A refresh is running. */
  refreshing?: boolean;
  /** Refreshing is unavailable, e.g. while disconnected. */
  refreshDisabled?: boolean;
}

interface ProviderPool {
  provider: PoolProvider;
  accounts: PoolAccount[];
  emails: Record<string, string>;
  /** Oldest observation behind a cached account; null when every account is live. */
  cachedAsOf: number | null;
}

const isPoolProvider = (type: string): type is PoolProvider =>
  (POOL_PROVIDERS as readonly string[]).includes(type);

/** Not loaded in this page session yet, or loading now: the saved snapshot may stand in. */
const awaitingQuota = (quota: QuotaCardState | undefined) =>
  !quota || quota.status === 'idle' || quota.status === 'loading';

/**
 * Quota states already saved to the snapshot. A refresh replaces the state
 * object, so an unseen object is a newly loaded value; remounting the page
 * with the same objects doesn't re-save them under a new time.
 */
const savedQuotaStates = new WeakSet<object>();

function poolAccountFor(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined
): PoolAccount | null {
  if (!quota || (quota as { status?: string }).status !== 'success') return null;
  const provider = entry.type as PoolProvider;
  const windows = ((quota as { windows?: WindowLike[] }).windows ?? []).filter(
    (window) => window.id === WEEKLY_WINDOW_ID[provider]
  );
  const weekly = windows[0];
  if (
    !weekly ||
    typeof weekly.usedPercent !== 'number' ||
    typeof weekly.resetAtMs !== 'number' ||
    !Number.isFinite(weekly.resetAtMs)
  ) {
    return null;
  }
  const periodHours =
    typeof weekly.periodHours === 'number' && weekly.periodHours > 0 ? weekly.periodHours : 168;
  return {
    id: entry.file.name,
    label: entry.file.name,
    remaining: Math.min(100, Math.max(0, 100 - weekly.usedPercent)),
    resetAtMs: weekly.resetAtMs,
    periodMs: periodHours * HOUR_MS,
  };
}

function shortLabel(email: string, fileName: string): string {
  const local = email.split('@')[0]?.trim();
  if (local) return local;
  return fileName.replace(/\.json$/i, '');
}

/** One credential's recorded samples, matched by auth ID, then by email label. */
function samplesFor(
  history: QuotaHistory | null,
  id: string,
  email: string | undefined
): PoolSample[] {
  if (!history) return [];
  const lower = email?.toLowerCase();
  const series =
    history.series.find((item) => item.authId === id) ??
    (lower ? history.series.find((item) => item.label.toLowerCase() === lower) : undefined);
  return (series?.samples ?? []).map((sample) => ({
    atMs: sample.atMs,
    weeklyUsed: sample.weeklyUsed,
    weeklyResetMs: sample.weeklyResetMs,
  }));
}

function historyFor(
  accounts: PoolAccount[],
  emails: Record<string, string>,
  history: QuotaHistory | null
): PoolHistory {
  const out: PoolHistory = {};
  for (const account of accounts) {
    const samples = samplesFor(history, account.id, emails[account.id]);
    if (samples.length > 0) out[account.id] = samples;
  }
  return out;
}

/* ------------------------------------------------------------ formatting */

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const pct = (value: number) => `${Math.round(value)}%`;

function useFormatters(locale: string) {
  return useMemo(() => {
    const weekdayTime = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    const monthDay = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    const weekdayDay = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });
    return {
      at: (ms: number) => weekdayTime.format(ms),
      day: (ms: number) => monthDay.format(ms),
      tick: (ms: number) => weekdayDay.format(ms),
    };
  }, [locale]);
}

/* ---------------------------------------------------------------- hooks */

function useQuotaHistory(refreshToken: number) {
  const [history, setHistory] = useState<QuotaHistory | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      quotaHistoryApi
        .get(SPAN_DAYS)
        .then((result) => {
          if (cancelled) return;
          setHistory(result);
          setAvailable(result !== null);
        })
        .catch(() => {
          if (!cancelled) setAvailable((prev) => prev ?? false);
        });
    };
    load();
    const timer = window.setInterval(load, HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshToken]);
  return { history, available };
}

/* ------------------------------------------------------------ component */

export function QuotaPool({
  entries,
  quotaFor,
  resolvedTheme,
  routingStrategy,
  refreshToken,
  apiBase,
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
}: QuotaPoolProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const fmt = useFormatters(i18n.language);
  const [mode, setMode] = useState<ChartMode>('remaining');
  const [burnWindow, setBurnWindow] = useState<(typeof BURN_WINDOWS)[number]>(3);
  const [future, setFuture] = useState<FutureUsage>('same');
  const [showAccounts, setShowAccounts] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const [offset, setOffset] = useState(0);
  const { history, available } = useQuotaHistory(refreshToken);

  // Save each newly loaded weekly quota so a reload can show the last picture.
  useEffect(() => {
    if (!apiBase) return;
    const capturedAt = Date.now();
    const updates: PoolSnapshot = {};
    let changed = false;
    for (const entry of entries) {
      if (!isPoolProvider(entry.type)) continue;
      const quota = quotaFor(entry);
      if (!quota || savedQuotaStates.has(quota)) continue;
      const account = poolAccountFor(entry, quota);
      if (!account) continue;
      savedQuotaStates.add(quota);
      (updates[entry.type] ??= {})[account.id] = {
        remaining: account.remaining,
        resetAtMs: account.resetAtMs,
        periodMs: account.periodMs,
        capturedAt,
      };
      changed = true;
    }
    if (changed) writePoolSnapshot(apiBase, updates, capturedAt);
  }, [apiBase, entries, quotaFor]);

  const pools = useMemo<ProviderPool[]>(() => {
    // Read on every rebuild: the effect above may have saved newer values since.
    const snapshot = readPoolSnapshot(apiBase);
    return POOL_PROVIDERS.map((provider) => {
      const accounts: PoolAccount[] = [];
      const emails: Record<string, string> = {};
      let cachedAsOf: number | null = null;
      for (const entry of entries) {
        if (entry.type !== provider) continue;
        const quota = quotaFor(entry);
        const email = entry.file.email?.trim() ?? '';
        let account = poolAccountFor(entry, quota);
        const cached =
          account || !awaitingQuota(quota) ? undefined : snapshot[provider]?.[entry.file.name];
        if (cached) {
          const restored = restoreCachedAccount(
            cached,
            samplesFor(history, entry.file.name, email),
            now
          );
          account = {
            id: entry.file.name,
            label: entry.file.name,
            remaining: restored.remaining,
            resetAtMs: restored.resetAtMs,
            periodMs: cached.periodMs,
          };
          cachedAsOf = cachedAsOf === null ? restored.asOf : Math.min(cachedAsOf, restored.asOf);
        }
        if (!account) continue;
        emails[account.id] = email;
        account.label = showEmails ? email || entry.file.name : shortLabel(email, entry.file.name);
        accounts.push(account);
      }
      return { provider, accounts, emails, cachedAsOf };
    }).filter((pool) => pool.accounts.length > 0);
  }, [apiBase, entries, quotaFor, showEmails, history, now]);

  const span = useMemo(() => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - PAST_DAYS + offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + SPAN_DAYS);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }, [now, offset]);

  if (pools.length === 0) return null;

  const futureOptions = (['same', 'half', 'double', 'idle'] as const).map((value) => ({
    value,
    label: t(`quota_pool.future_${value}`),
  }));

  return (
    <section className={styles.pool} aria-label={t('quota_pool.title')}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="radiogroup" aria-label={t('quota_pool.view_label')}>
          {(['remaining', 'drain'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={`${styles.segment} ${mode === value ? styles.segmentActive : ''}`}
              onClick={() => setMode(value)}
            >
              {t(`quota_pool.view_${value}`)}
            </button>
          ))}
        </div>

        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('quota_pool.burn_rate')}</span>
          <div
            className={styles.segmented}
            role="radiogroup"
            aria-label={t('quota_pool.burn_rate')}
          >
            {BURN_WINDOWS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={burnWindow === value}
                className={`${styles.segment} ${burnWindow === value ? styles.segmentActive : ''}`}
                onClick={() => setBurnWindow(value)}
              >
                {value}h
              </button>
            ))}
          </div>
        </div>

        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('quota_pool.future_usage')}</span>
          <div className={styles.select}>
            <Select
              value={future}
              options={futureOptions}
              onChange={(value) => setFuture(value as FutureUsage)}
              ariaLabel={t('quota_pool.future_usage')}
              size="sm"
            />
          </div>
        </div>

        <button
          type="button"
          className={`${styles.toggle} ${showAccounts ? styles.toggleActive : ''}`}
          aria-pressed={showAccounts}
          onClick={() => setShowAccounts((value) => !value)}
        >
          {t('quota_pool.accounts')}
        </button>
        <button
          type="button"
          className={`${styles.toggle} ${showEmails ? styles.toggleActive : ''}`}
          aria-pressed={showEmails}
          onClick={() => setShowEmails((value) => !value)}
        >
          {t('quota_pool.show_emails')}
        </button>

        <div className={styles.range}>
          <span className={styles.rangeLabel}>
            {t('quota_pool.range', { from: fmt.day(span.startMs), to: fmt.day(span.endMs - 1) })}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('quota_pool.previous')}
            onClick={() => setOffset((value) => value - 1)}
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.toggle} ${offset === 0 ? styles.toggleActive : ''}`}
            onClick={() => setOffset(0)}
          >
            {t('quota_pool.today')}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('quota_pool.next')}
            onClick={() => setOffset((value) => value + 1)}
          >
            ›
          </button>
        </div>
      </div>

      {available === false && <p className={styles.notice}>{t('quota_pool.no_history')}</p>}

      {pools.map((pool) => (
        <PoolCard
          key={pool.provider}
          pool={pool}
          history={history}
          now={now}
          span={span}
          mode={mode}
          burnWindowMs={burnWindow * HOUR_MS}
          futureFactor={FUTURE_FACTOR[future]}
          showAccounts={showAccounts}
          routingStrategy={routingStrategy}
          color={LINE_COLORS[pool.provider][resolvedTheme]}
          fmt={fmt}
          onRefresh={onRefresh}
          refreshing={refreshing}
          refreshDisabled={refreshDisabled}
        />
      ))}
    </section>
  );
}

/* ------------------------------------------------------------- one pool */

interface PoolCardProps {
  pool: ProviderPool;
  history: QuotaHistory | null;
  now: number;
  span: { startMs: number; endMs: number };
  mode: ChartMode;
  burnWindowMs: number;
  futureFactor: number;
  showAccounts: boolean;
  routingStrategy: string | undefined;
  color: string;
  fmt: ReturnType<typeof useFormatters>;
  onRefresh?: () => void;
  refreshing: boolean;
  refreshDisabled: boolean;
}

function PoolCard({
  pool,
  history,
  now,
  span,
  mode,
  burnWindowMs,
  futureFactor,
  showAccounts,
  routingStrategy,
  color,
  fmt,
  onRefresh,
  refreshing,
  refreshDisabled,
}: PoolCardProps) {
  const { t } = useTranslation();
  const { accounts, cachedAsOf } = pool;
  const cached = cachedAsOf !== null;
  const dim = cached ? ` ${styles.dimmed}` : '';
  const capacity = accounts.length * 100;
  const order = drainOrderForStrategy(routingStrategy);

  const model = useMemo(() => {
    const poolHistory = historyFor(accounts, pool.emails, history);
    const measured = historyBurnPerHour(accounts, poolHistory, now, burnWindowMs);
    const burn = measured ?? weeklyAverageBurnPerHour(accounts, now);
    const horizonEnd = Math.max(span.endMs, now + SPAN_DAYS * DAY_MS);
    const projection = projectPool({
      accounts,
      nowMs: now,
      endMs: horizonEnd,
      burnPerHour: burn * futureFactor,
      order,
      stepMs: STEP_MS,
    });
    const recorded = recordedSeries(accounts, poolHistory, span.startMs, now, STEP_MS);
    const burnSeries = recordedBurnSeries(accounts, poolHistory, span.startMs, now, HOUR_MS);
    const weekAhead = now + 7 * DAY_MS;
    const unusedWeek = projection.resets
      .filter((event) => event.t <= weekAhead)
      .reduce((total, event) => total + event.unused, 0);
    const nextReset = projection.resets.find((event) => event.t > now) ?? null;
    return {
      burn,
      burnSource: measured === null ? 'week' : 'history',
      projection,
      recorded,
      burnSeries,
      unusedWeek,
      nextReset,
    } as const;
  }, [
    accounts,
    pool.emails,
    history,
    now,
    burnWindowMs,
    futureFactor,
    order,
    span.startMs,
    span.endMs,
  ]);

  const current = accounts.reduce((total, account) => total + account.remaining, 0);
  const labelFor = (id: string) => accounts.find((account) => account.id === id)?.label ?? id;
  const { projection } = model;

  const stats = [
    {
      key: 'pool_empty',
      value: projection.poolEmptyAt
        ? fmt.at(projection.poolEmptyAt)
        : t('quota_pool.not_by', { date: fmt.day(now + SPAN_DAYS * DAY_MS) }),
    },
    {
      key: 'first_empty',
      value: projection.firstEmpty
        ? t('quota_pool.first_empty_value', {
            account: labelFor(projection.firstEmpty.accountId),
            in: formatDuration(projection.firstEmpty.t - now),
          })
        : t('quota_pool.none'),
    },
    {
      key: 'next_reset',
      value: model.nextReset
        ? `+${pct(model.nextReset.amount)} ${fmt.at(model.nextReset.t)}`
        : t('quota_pool.none'),
    },
    {
      key: 'unused_week',
      value: pct(model.unusedWeek),
      tone: model.unusedWeek >= 1 ? 'warn' : undefined,
    },
    {
      key: model.burnSource === 'history' ? 'burn_history' : 'burn_week',
      value: `${(model.burn * futureFactor).toFixed(1)}%/h`,
      hours: burnWindowMs / HOUR_MS,
    },
  ];

  return (
    <article className={styles.card}>
      <header className={styles.cardHeader}>
        <div className={styles.identity}>
          <span className={styles.dot} style={{ background: color }} aria-hidden="true" />
          <span className={styles.provider}>{t(`quota_pool.provider_${pool.provider}`)}</span>
          <span className={styles.accountCount}>
            {t('quota_pool.accounts_count', { count: accounts.length })}
          </span>
          <span className={styles.strategy}>
            {t(`quota_pool.order_${order.replace('-', '_')}`)}
          </span>
        </div>
        <div className={`${styles.headline}${dim}`}>
          <span className={styles.total}>{pct(current)}</span>
          <span className={styles.capacity}>
            {t('quota_pool.of_capacity', { capacity: pct(capacity) })}
          </span>
        </div>
        <dl className={`${styles.stats}${dim}`}>
          {stats.map((stat) => (
            <div key={stat.key} className={styles.stat}>
              <dt>{t(`quota_pool.stat_${stat.key}`, { hours: stat.hours })}</dt>
              <dd className={stat.tone === 'warn' ? styles.warn : undefined}>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className={styles.chartArea}>
        <div className={cached ? styles.dimmed : undefined}>
          <PoolChart
            mode={mode}
            capacity={capacity}
            accounts={accounts}
            recorded={model.recorded}
            projected={projection.points}
            resets={projection.resets}
            poolEmptyAt={projection.poolEmptyAt}
            burnSeries={model.burnSeries}
            projectedBurn={model.burn * futureFactor}
            now={now}
            span={span}
            color={color}
            showAccounts={showAccounts}
            fmt={fmt}
          />
        </div>
        {cachedAsOf !== null && (
          <div className={styles.cachedOverlay}>
            <div className={styles.cachedNotice} role="status">
              <span>
                {refreshing
                  ? t('quota_pool.cached_refreshing')
                  : t('quota_pool.cached_notice', { time: fmt.at(cachedAsOf) })}
              </span>
              {onRefresh && !refreshing && (
                <button
                  type="button"
                  className={styles.toggle}
                  disabled={refreshDisabled}
                  onClick={onRefresh}
                >
                  {t('quota_pool.cached_refresh')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <footer className={`${styles.legend}${dim}`}>
        <span className={styles.legendTitle}>{t('quota_pool.legend_pool')}</span>
        <span className={styles.legendItem}>
          <svg width="22" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="2" />
          </svg>
          {t('quota_pool.legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <svg width="22" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke={color}
              strokeWidth="2"
              strokeDasharray="5 4"
            />
          </svg>
          {t('quota_pool.legend_projected')}
        </span>
        {showAccounts &&
          accounts.map((account, index) => (
            <span key={account.id} className={styles.legendItem}>
              <svg width="14" height="6" aria-hidden="true">
                <line
                  x1="0"
                  y1="3"
                  x2="14"
                  y2="3"
                  stroke={color}
                  strokeOpacity={accountOpacity(index, accounts.length)}
                  strokeWidth="1.5"
                />
              </svg>
              {account.label} · {pct(account.remaining)}
            </span>
          ))}
      </footer>
    </article>
  );
}

const accountOpacity = (index: number, count: number) =>
  count <= 1 ? 0.7 : 0.85 - (0.55 * index) / (count - 1);

/* ---------------------------------------------------------------- chart */

interface PoolChartProps {
  mode: ChartMode;
  capacity: number;
  accounts: PoolAccount[];
  recorded: PoolPoint[];
  projected: PoolPoint[];
  resets: PoolResetEvent[];
  poolEmptyAt: number | null;
  burnSeries: { t: number; perHour: number }[];
  projectedBurn: number;
  now: number;
  span: { startMs: number; endMs: number };
  color: string;
  showAccounts: boolean;
  fmt: ReturnType<typeof useFormatters>;
}

const HEIGHT = 300;
const PAD = { top: 30, right: 16, bottom: 30, left: 52 };

function PoolChart({
  mode,
  capacity,
  accounts,
  recorded,
  projected,
  resets,
  poolEmptyAt,
  burnSeries,
  projectedBurn,
  now,
  span,
  color,
  showAccounts,
  fmt,
}: PoolChartProps) {
  const { t } = useTranslation();
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const gradientId = `pool-fill-${useId().replace(/:/g, '')}`;

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = useCallback(
    (ms: number) => PAD.left + ((ms - span.startMs) / (span.endMs - span.startMs)) * innerW,
    [span.startMs, span.endMs, innerW]
  );

  const inSpan = (points: PoolPoint[]) =>
    points.filter((point) => point.t >= span.startMs && point.t <= span.endMs);

  // Series in the active unit.
  const remainingRecorded = inSpan(recorded);
  const remainingProjected = inSpan(projected);
  const drainRecorded = burnSeries.filter(
    (point) => point.t >= span.startMs && point.t <= span.endMs
  );
  const yMax =
    mode === 'remaining'
      ? Math.max(capacity, 1)
      : niceCeil(Math.max(projectedBurn, ...drainRecorded.map((point) => point.perHour), 1) * 1.2);
  const y = (value: number) => PAD.top + innerH - (Math.max(0, value) / yMax) * innerH;

  const linePath = (points: { t: number; v: number }[], step = false) =>
    points
      .map((point, index) => {
        const px = x(point.t).toFixed(1);
        const py = y(point.v).toFixed(1);
        if (index === 0) return `M${px},${py}`;
        return step ? `H${px}V${py}` : `L${px},${py}`;
      })
      .join('');

  const recordedLine =
    mode === 'remaining'
      ? remainingRecorded.map((point) => ({ t: point.t, v: point.pool }))
      : drainRecorded.map((point) => ({ t: point.t, v: point.perHour }));
  const projectedLine =
    mode === 'remaining'
      ? remainingProjected.map((point) => ({ t: point.t, v: point.pool }))
      : now < span.endMs
        ? [
            { t: Math.max(now, span.startMs), v: projectedBurn },
            { t: span.endMs, v: projectedBurn },
          ]
        : [];

  const areaPath = (points: { t: number; v: number }[]) =>
    points.length < 2
      ? ''
      : `${linePath(points)}L${x(points[points.length - 1].t).toFixed(1)},${y(0).toFixed(1)}L${x(points[0].t).toFixed(1)},${y(0).toFixed(1)}Z`;

  const days = useMemo(() => {
    const out: number[] = [];
    const cursor = new Date(span.startMs);
    while (cursor.getTime() < span.endMs) {
      out.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [span.startMs, span.endMs]);

  // Reset labels, skipping ones that would collide with the previous label.
  const resetLabels: { x: number; y: number; text: string }[] = [];
  for (const event of mode === 'remaining' ? resets : []) {
    if (event.t < span.startMs || event.t > span.endMs || event.amount < 0.5) continue;
    const px = x(event.t);
    const last = resetLabels[resetLabels.length - 1];
    if (last && px - last.x < 34) continue;
    // Label sits above the post-reset level: the last point at the reset instant.
    const atReset = projected.filter((point) => point.t === event.t);
    const level = atReset[atReset.length - 1]?.pool ?? 0;
    resetLabels.push({
      x: px,
      y: Math.max(PAD.top - 6, y(level) - 8),
      text: `+${Math.round(event.amount)}%`,
    });
  }

  const nowVisible = now >= span.startMs && now <= span.endMs;
  const emptyVisible =
    mode === 'remaining' &&
    poolEmptyAt !== null &&
    poolEmptyAt >= span.startMs &&
    poolEmptyAt <= span.endMs;

  // Hover readout: the latest point of the combined series at or before the cursor.
  let hoverValue: { t: number; v: number } | null = null;
  if (hover) {
    for (const point of [...recordedLine, ...projectedLine]) {
      if (point.t <= hover.t && (!hoverValue || point.t >= hoverValue.t)) hoverValue = point;
    }
  }

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    if (px < PAD.left || px > PAD.left + innerW) return setHover(null);
    const ms = span.startMs + ((px - PAD.left) / innerW) * (span.endMs - span.startMs);
    setHover({ x: px, t: ms });
  };

  const yTicks = [0, yMax / 2, yMax];
  const fmtY = (value: number) => (mode === 'remaining' ? pct(value) : `${value.toFixed(1)}%/h`);

  return (
    <div ref={wrapRef} className={styles.chart}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={t(
            mode === 'remaining' ? 'quota_pool.chart_label' : 'quota_pool.chart_label_drain'
          )}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className={styles.gridLine}
                x1={PAD.left}
                x2={PAD.left + innerW}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className={styles.axisText} x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
                {fmtY(tick)}
              </text>
            </g>
          ))}
          {days.map((day) => (
            <g key={day}>
              <line
                className={styles.gridLineFaint}
                x1={x(day)}
                x2={x(day)}
                y1={PAD.top}
                y2={PAD.top + innerH}
              />
              <text
                className={styles.axisText}
                x={x(day + DAY_MS / 2)}
                y={HEIGHT - 8}
                textAnchor="middle"
              >
                {innerW / days.length > 46 ? fmt.tick(day) : new Date(day).getDate()}
              </text>
            </g>
          ))}

          <path d={areaPath([...recordedLine, ...projectedLine])} fill={`url(#${gradientId})`} />

          {showAccounts &&
            mode === 'remaining' &&
            accounts.map((account, index) => {
              const series = [...remainingRecorded, ...remainingProjected].map((point) => ({
                t: point.t,
                v: point.perAccount[index] ?? 0,
              }));
              return (
                <path
                  key={account.id}
                  d={linePath(series)}
                  fill="none"
                  stroke={color}
                  strokeOpacity={accountOpacity(index, accounts.length)}
                  strokeWidth={1.2}
                />
              );
            })}

          <path
            d={linePath(recordedLine, mode === 'drain')}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <path
            d={linePath(projectedLine)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="6 5"
            strokeLinejoin="round"
          />

          {resetLabels.map((label) => (
            <text
              key={`${label.x}-${label.text}`}
              className={styles.resetText}
              x={label.x}
              y={label.y}
              textAnchor="middle"
            >
              {label.text}
            </text>
          ))}

          {nowVisible && (
            <g>
              <line
                className={styles.nowLine}
                x1={x(now)}
                x2={x(now)}
                y1={PAD.top - 8}
                y2={PAD.top + innerH}
              />
              <text className={styles.axisText} x={x(now)} y={PAD.top - 14} textAnchor="middle">
                {t('quota_pool.now')}
              </text>
              {projectedLine.length > 0 && (
                <circle cx={x(now)} cy={y(projectedLine[0].v)} r={3.5} fill={color} />
              )}
            </g>
          )}

          {emptyVisible && poolEmptyAt !== null && (
            <g>
              <circle className={styles.emptyMarker} cx={x(poolEmptyAt)} cy={y(0)} r={5} />
              <text
                className={styles.emptyText}
                x={x(poolEmptyAt)}
                y={y(0) - 12}
                textAnchor="middle"
              >
                {t('quota_pool.empty_at', { time: fmt.at(poolEmptyAt) })}
              </text>
            </g>
          )}

          {hover && hoverValue && (
            <g pointerEvents="none">
              <line
                className={styles.hoverLine}
                x1={hover.x}
                x2={hover.x}
                y1={PAD.top}
                y2={PAD.top + innerH}
              />
              <circle cx={hover.x} cy={y(hoverValue.v)} r={3} fill={color} />
              <text
                className={styles.hoverText}
                x={Math.min(Math.max(hover.x, PAD.left + 60), PAD.left + innerW - 60)}
                y={PAD.top + 12}
                textAnchor="middle"
              >
                {`${fmt.at(hover.t)} · ${fmtY(hoverValue.v)}`}
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
