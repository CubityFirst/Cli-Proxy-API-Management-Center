/**
 * Prompt-cache card, about the part of cache loss routing decides: follow-up
 * requests that lost their cache because the conversation moved to another
 * account. Idle expiry, model changes, compaction and new conversations are
 * recorded too but left out, except in the all-causes hit rate. Routing setting
 * changes are marked so their effect can be compared.
 *
 * Maths lives in cacheHistoryModel.ts; this file is data plumbing and layout.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { cacheHistoryApi } from '@/services/api/cacheHistory';
import type { CacheHistory, CacheMarker, CacheSettings } from '@/services/api/cacheHistory';
import type { ResolvedTheme } from '@/types';
import {
  cacheSeries,
  comparableRequests,
  formatShare,
  formatTokens,
  hitRate,
  sameSettings,
  settingsSegments,
  switchLossShare,
  switchMissRate,
  totalsBetween,
} from '../cacheHistoryModel';
import type { CachePoint, CacheTotals, SettingsSegment } from '../cacheHistoryModel';
import { useElementWidth } from '../useElementWidth';
import styles from './CacheStats.module.scss';

const HOUR_MS = 60 * 60 * 1000;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
const RANGES = {
  day: { spanMs: 24 * HOUR_MS, stepMs: HOUR_MS / 2, tickMs: 3 * HOUR_MS },
  week: { spanMs: 7 * 24 * HOUR_MS, stepMs: 2 * HOUR_MS, tickMs: 24 * HOUR_MS },
} as const;
type RangeId = keyof typeof RANGES;

/** Categorical slot 1, validated against both card surfaces. */
const SWITCH_COLOR: Record<ResolvedTheme, string> = { light: '#257de0', dark: '#338ced' };

export interface CacheStatsProps {
  resolvedTheme: ResolvedTheme;
  /** Changes when the user refreshes everything, to refetch history too. */
  refreshToken: number;
}

function useCacheHistory(refreshToken: number) {
  const [history, setHistory] = useState<CacheHistory | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      cacheHistoryApi
        .get(7)
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

function useFormatters(locale: string) {
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const dayTime = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });
    return {
      time: (ms: number) => time.format(ms),
      dayTime: (ms: number) => dayTime.format(ms),
      day: (ms: number) => day.format(ms),
    };
  }, [locale]);
}

const pct = (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)}%`);

export function CacheStats({ resolvedTheme, refreshToken }: CacheStatsProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const fmt = useFormatters(i18n.language);
  const [rangeId, setRangeId] = useState<RangeId>('day');
  const { history, available } = useCacheHistory(refreshToken);

  const range = RANGES[rangeId];
  const endMs = Math.ceil(now / range.stepMs) * range.stepMs;
  const startMs = endMs - range.spanMs;

  const totals = useMemo(() => totalsBetween(history, startMs, endMs), [history, startMs, endMs]);
  const points = useMemo(
    () => cacheSeries(history, startMs, endMs, range.stepMs),
    [history, startMs, endMs, range.stepMs]
  );
  const segments = useMemo(
    () => settingsSegments(history, startMs, endMs),
    [history, startMs, endMs]
  );

  if (available === null) return null;

  const color = SWITCH_COLOR[resolvedTheme];
  const markers = (history?.markers ?? []).filter(
    (marker) => marker.atMs > startMs && marker.atMs < endMs
  );
  const allMarkers = history?.markers ?? [];
  const currentSettings = allMarkers[allMarkers.length - 1] ?? null;

  return (
    <article className={styles.card} aria-label={t('cache_stats.title')}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.title}>{t('cache_stats.title')}</span>
          <span className={styles.scope}>{t('cache_stats.scope')}</span>
        </div>
        <div
          className={styles.segmented}
          role="radiogroup"
          aria-label={t('cache_stats.range_label')}
        >
          {(Object.keys(RANGES) as RangeId[]).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rangeId === value}
              className={`${styles.segment} ${rangeId === value ? styles.segmentActive : ''}`}
              onClick={() => setRangeId(value)}
            >
              {t(`cache_stats.range_${value}`)}
            </button>
          ))}
        </div>
      </header>

      {!available ? (
        <p className={styles.notice}>{t('cache_stats.no_history')}</p>
      ) : totals.requests === 0 ? (
        <p className={styles.notice}>{t('cache_stats.empty')}</p>
      ) : (
        <>
          <CacheSummary totals={totals} color={color} />

          <CacheChart
            points={points}
            stepMs={range.stepMs}
            tickMs={range.tickMs}
            startMs={startMs}
            endMs={endMs}
            markers={markers}
            color={color}
            fmt={fmt}
            dayTicks={rangeId === 'week'}
          />

          {markers.length > 0 && (
            <footer className={styles.legend}>
              <span className={styles.legendItem}>
                <svg width="10" height="12" aria-hidden="true">
                  <line x1="5" y1="0" x2="5" y2="12" className={styles.markerLine} />
                </svg>
                {t('cache_stats.legend_marker')}
              </span>
            </footer>
          )}

          <SettingsTable segments={segments} current={currentSettings} fmt={fmt} />

          <p className={styles.explain}>{t('cache_stats.explain')}</p>
        </>
      )}
    </article>
  );
}

/* -------------------------------------------------------------- summary */

export interface CacheSummaryProps {
  totals: CacheTotals;
  /** Colour of the switch series in the chart, for the matching swatch. */
  color: string;
}

/** Headline switch-miss rate and the figures behind it; pure, so tests can render it. */
export function CacheSummary({ totals, color }: CacheSummaryProps) {
  const { t, i18n } = useTranslation();
  const switched = totals.byReason.switched;
  const share = switchLossShare(totals);
  return (
    <div className={styles.summary}>
      <div className={styles.headline}>
        <span className={styles.total}>{formatShare(switchMissRate(totals))}</span>
        <span className={styles.totalHint}>{t('cache_stats.headline_hint')}</span>
      </div>
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>
            <span className={styles.swatch} style={{ background: color }} aria-hidden="true" />
            {t('cache_stats.stat_lost_switched')}
          </dt>
          <dd>
            {formatTokens(switched.lost)}
            {share !== null && (
              <span className={styles.statNote}>
                {t('cache_stats.stat_switch_share', { share: formatShare(share) })}
              </span>
            )}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>{t('cache_stats.stat_switch_misses')}</dt>
          <dd>{switched.misses.toLocaleString(i18n.language)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>{t('cache_stats.stat_followups')}</dt>
          <dd>{comparableRequests(totals).toLocaleString(i18n.language)}</dd>
        </div>
        <div className={`${styles.stat} ${styles.statMuted}`}>
          <dt>{t('cache_stats.stat_hit_rate_all')}</dt>
          <dd>{pct(hitRate(totals))}</dd>
        </div>
      </dl>
    </div>
  );
}

/* ---------------------------------------------------------------- table */

function useSettingsLabel() {
  const { t } = useTranslation();
  return (settings: CacheSettings | null) => {
    if (!settings) return t('cache_stats.settings_unknown');
    const affinity = settings.sessionAffinity
      ? t('cache_stats.settings_affinity', {
          ttl: settings.affinityTtl || '–',
          rebind: settings.rebindOn || 'any',
        })
      : t('cache_stats.settings_no_affinity');
    const expiring =
      settings.sessionAffinity && settings.expiringWindow
        ? ` · ${t('cache_stats.settings_expiring', { window: settings.expiringWindow })}`
        : '';
    return `${settings.strategy || 'round-robin'} · ${affinity}${expiring}`;
  };
}

function SettingsTable({
  segments,
  current,
  fmt,
}: {
  segments: SettingsSegment[];
  /** Settings in effect now: the latest recorded marker. */
  current: CacheSettings | null;
  fmt: ReturnType<typeof useFormatters>;
}) {
  const { t, i18n } = useTranslation();
  const label = useSettingsLabel();
  if (segments.length === 0) return null;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{t('cache_stats.settings_title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('cache_stats.col_setting')}</th>
            <th scope="col">{t('cache_stats.col_period')}</th>
            <th scope="col" className={styles.num}>
              {t('cache_stats.col_followups')}
            </th>
            <th scope="col" className={styles.num}>
              {t('cache_stats.col_switch_misses')}
            </th>
            <th scope="col" className={styles.num}>
              {t('cache_stats.col_switch_rate')}
            </th>
            <th scope="col" className={styles.num}>
              {t('cache_stats.col_lost_switched')}
            </th>
          </tr>
        </thead>
        <tbody>
          {segments.map((segment, index) => (
            <tr key={segment.fromMs}>
              <th scope="row">
                {label(segment.settings)}
                {index === 0 && current && sameSettings(segment.settings, current) && (
                  <span className={styles.current}>{t('cache_stats.current')}</span>
                )}
              </th>
              <td>
                {t('cache_stats.period', {
                  from: fmt.dayTime(segment.fromMs),
                  to: fmt.dayTime(segment.toMs),
                })}
              </td>
              <td className={styles.num}>
                {comparableRequests(segment.totals).toLocaleString(i18n.language)}
              </td>
              <td className={styles.num}>
                {segment.totals.byReason.switched.misses.toLocaleString(i18n.language)}
              </td>
              <td className={styles.num}>{formatShare(switchMissRate(segment.totals))}</td>
              <td className={styles.num}>{formatTokens(segment.totals.byReason.switched.lost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- chart */

interface CacheChartProps {
  points: CachePoint[];
  stepMs: number;
  tickMs: number;
  startMs: number;
  endMs: number;
  markers: CacheMarker[];
  color: string;
  fmt: ReturnType<typeof useFormatters>;
  dayTicks: boolean;
}

const PAD = { top: 22, right: 16, bottom: 28, left: 56 };
const PLOT_H = 180;
const HEIGHT = PAD.top + PLOT_H + PAD.bottom;
const BAR_GAP = 2;

function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** A bar with rounded top corners. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(3, w / 2, h);
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Tokens re-processed after an account switch, one bar per step. */
function CacheChart({
  points,
  stepMs,
  tickMs,
  startMs,
  endMs,
  markers,
  color,
  fmt,
  dayTicks,
}: CacheChartProps) {
  const { t } = useTranslation();
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const label = useSettingsLabel();

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const x = (ms: number) => PAD.left + ((ms - startMs) / (endMs - startMs)) * innerW;
  const stepW = points.length > 0 ? innerW / points.length : 0;
  const plotTop = PAD.top;
  const plotBottom = PAD.top + PLOT_H;
  const lostOf = (point: CachePoint) => point.totals.byReason.switched.lost;
  // At least 1k so a range without switch losses still gets a readable axis.
  const lostMax = niceCeil(Math.max(1000, ...points.map(lostOf)));
  const y = (value: number) => plotBottom - (value / lostMax) * PLOT_H;

  // Gridlines at each tick; day labels sit centred on the visible part of each day.
  const ticks: { lineAt: number | null; labelAt: number | null; text: string }[] = [];
  if (dayTicks) {
    const cursor = new Date(startMs);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < endMs) {
      const dayStart = cursor.getTime();
      cursor.setDate(cursor.getDate() + 1);
      const from = Math.max(dayStart, startMs);
      const to = Math.min(cursor.getTime(), endMs);
      const wide = x(to) - x(from) >= 44;
      ticks.push({
        lineAt: dayStart > startMs ? dayStart : null,
        labelAt: wide ? (from + to) / 2 : null,
        text: fmt.day(dayStart),
      });
    }
  } else {
    for (let tick = Math.ceil(startMs / tickMs) * tickMs; tick < endMs; tick += tickMs) {
      ticks.push({ lineAt: tick, labelAt: tick, text: fmt.time(tick) });
    }
  }

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    if (px < PAD.left || px > PAD.left + innerW || stepW <= 0) return setHoverIndex(null);
    setHoverIndex(Math.min(points.length - 1, Math.floor((px - PAD.left) / stepW)));
  };

  const hover = hoverIndex !== null ? points[hoverIndex] : undefined;
  const hoverLeft = hover ? x(hover.t) + stepW / 2 : 0;

  return (
    <div ref={wrapRef} className={styles.chart} style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={t('cache_stats.chart_label')}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <text className={styles.panelTitle} x={PAD.left} y={plotTop - 8}>
            {t('cache_stats.panel_lost_switched')}
          </text>
          {[0, lostMax / 2, lostMax].map((tick) => (
            <g key={`lost-${tick}`}>
              <line
                className={styles.gridLine}
                x1={PAD.left}
                x2={PAD.left + innerW}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className={styles.axisText} x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
                {formatTokens(tick)}
              </text>
            </g>
          ))}

          {ticks.map((tick) => (
            <g key={`${tick.lineAt}-${tick.labelAt}`}>
              {tick.lineAt !== null && (
                <line
                  className={styles.gridLineFaint}
                  x1={x(tick.lineAt)}
                  x2={x(tick.lineAt)}
                  y1={plotTop}
                  y2={plotBottom}
                />
              )}
              {tick.labelAt !== null && (
                <text
                  className={styles.axisText}
                  x={x(tick.labelAt)}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                >
                  {tick.text}
                </text>
              )}
            </g>
          ))}

          {points.map((point, index) => {
            const value = lostOf(point);
            if (value <= 0) return null;
            const top = y(value);
            const h = plotBottom - top;
            if (h <= 0) return null;
            return (
              <path
                key={point.t}
                d={barPath(x(point.t) + BAR_GAP / 2, top, Math.max(1, stepW - BAR_GAP), h)}
                fill={color}
                opacity={hoverIndex === null || hoverIndex === index ? 1 : 0.55}
              />
            );
          })}

          {markers.map((marker) => (
            <g key={marker.atMs}>
              <line
                className={styles.markerLine}
                x1={x(marker.atMs)}
                x2={x(marker.atMs)}
                y1={plotTop}
                y2={plotBottom}
              />
              <title>{`${fmt.dayTime(marker.atMs)} · ${label(marker)}`}</title>
            </g>
          ))}

          {hover && (
            <line
              className={styles.hoverLine}
              x1={hoverLeft}
              x2={hoverLeft}
              y1={plotTop}
              y2={plotBottom}
              pointerEvents="none"
            />
          )}
        </svg>
      )}

      {hover && (
        <div
          className={styles.tooltip}
          style={{
            left: Math.min(Math.max(hoverLeft, PAD.left + 100), PAD.left + innerW - 100),
          }}
          role="status"
        >
          <div className={styles.tooltipTitle}>
            {t('cache_stats.period', {
              from: fmt.dayTime(hover.t),
              to: fmt.time(hover.t + stepMs),
            })}
          </div>
          <div className={styles.tooltipRow}>
            <span>{t('cache_stats.stat_switch_misses')}</span>
            <strong>{hover.totals.byReason.switched.misses}</strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>
              <span className={styles.swatch} style={{ background: color }} aria-hidden="true" />
              {t('cache_stats.stat_lost_switched')}
            </span>
            <strong>{formatTokens(lostOf(hover))}</strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>{t('cache_stats.stat_followups')}</span>
            <strong>{comparableRequests(hover.totals)}</strong>
          </div>
          <div className={styles.tooltipRow}>
            <span>{t('cache_stats.col_switch_rate')}</span>
            <strong>{formatShare(switchMissRate(hover.totals))}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
