/**
 * The quota pool chart keeps the last loaded picture across a page reload,
 * dimmed and marked as cached until the quotas are refreshed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { QuotaPool } from '../src/features/quota/components/QuotaPool';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import type { QuotaCardState } from '../src/features/quota/providers';
import {
  POOL_SNAPSHOT_KEY,
  POOL_SNAPSHOT_MAX_AGE_MS,
  clearPoolSnapshot,
  readPoolSnapshot,
  writePoolSnapshot,
} from '../src/services/storage/quotaPoolSnapshot';
import { useAuthStore } from '../src/stores/useAuthStore';

const API = 'https://proxy.invalid';
const HOUR = 60 * 60 * 1000;
const now = Date.now();

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, location: { host: 'proxy.invalid' } },
  });
  await i18n.changeLanguage('en');
});

afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

beforeEach(() => {
  memory.clear();
});

const cachedAccount = (remaining: number, capturedAt = now - HOUR) => ({
  remaining,
  resetAtMs: now + 48 * HOUR,
  periodMs: 168 * HOUR,
  capturedAt,
});

describe('pool snapshot storage', () => {
  test('merges writes and is scoped to the server it came from', () => {
    writePoolSnapshot(API, { claude: { 'a.json': cachedAccount(60) } }, now);
    writePoolSnapshot(API, { claude: { 'b.json': cachedAccount(30) } }, now);
    expect(Object.keys(readPoolSnapshot(API).claude ?? {})).toEqual(['a.json', 'b.json']);
    expect(readPoolSnapshot('https://other.invalid')).toEqual({});
    expect(readPoolSnapshot('')).toEqual({});

    // A write for another server replaces the snapshot rather than mixing them.
    writePoolSnapshot('https://other.invalid', { claude: { 'c.json': cachedAccount(10) } }, now);
    expect(readPoolSnapshot(API)).toEqual({});
    expect(Object.keys(readPoolSnapshot('https://other.invalid').claude ?? {})).toEqual(['c.json']);
  });

  test('drops malformed values, and expired ones on the next write', () => {
    const expired = cachedAccount(10, now - POOL_SNAPSHOT_MAX_AGE_MS - HOUR);
    memory.set(
      POOL_SNAPSHOT_KEY,
      JSON.stringify({
        version: 1,
        apiBase: API,
        pools: { claude: { good: cachedAccount(50), bad: { remaining: 'x' }, expired } },
      })
    );
    expect(Object.keys(readPoolSnapshot(API).claude ?? {})).toEqual(['good', 'expired']);
    writePoolSnapshot(API, {}, now);
    expect(Object.keys(readPoolSnapshot(API).claude ?? {})).toEqual(['good']);

    memory.set(POOL_SNAPSHOT_KEY, 'not json');
    expect(readPoolSnapshot(API)).toEqual({});
  });

  test('clearPoolSnapshot removes it, and logout clears it', () => {
    writePoolSnapshot(API, { claude: { 'a.json': cachedAccount(60) } }, now);
    clearPoolSnapshot();
    expect(memory.has(POOL_SNAPSHOT_KEY)).toBe(false);

    writePoolSnapshot(API, { claude: { 'a.json': cachedAccount(60) } }, now);
    useAuthStore.getState().logout();
    expect(memory.has(POOL_SNAPSHOT_KEY)).toBe(false);
  });
});

describe('QuotaPool with a cached snapshot', () => {
  const entries: QuotaFileEntry[] = [
    { file: { name: 'claude-a.json', type: 'claude', email: 'a@example.invalid' }, type: 'claude' },
  ];
  const live: QuotaCardState = {
    status: 'success',
    windows: [{ id: 'seven-day', usedPercent: 25, resetAtMs: now + 40 * HOUR, periodHours: 168 }],
  } as QuotaCardState;

  const render = (quota: QuotaCardState | undefined, refreshing = false) =>
    renderToStaticMarkup(
      createElement(QuotaPool, {
        entries,
        quotaFor: () => quota,
        resolvedTheme: 'dark',
        routingStrategy: 'soonest-reset',
        refreshToken: 0,
        apiBase: API,
        onRefresh: () => {},
        refreshing,
      })
    );

  test('renders nothing with neither live nor cached data', () => {
    expect(render(undefined)).toBe('');
  });

  test('shows the cached picture with a notice and a refresh button before quotas load', () => {
    writePoolSnapshot(API, { claude: { 'claude-a.json': cachedAccount(60) } }, now);
    const markup = render(undefined);
    expect(markup).toContain('>60%<');
    expect(markup).toContain('Cached data from');
    expect(markup).toContain(`>${i18n.t('quota_pool.cached_refresh')}</button>`);
  });

  test('while refreshing, the notice says so and the button is hidden', () => {
    writePoolSnapshot(API, { claude: { 'claude-a.json': cachedAccount(60) } }, now);
    const markup = render({ status: 'loading' }, true);
    expect(markup).toContain(i18n.t('quota_pool.cached_refreshing'));
    expect(markup).not.toContain(`>${i18n.t('quota_pool.cached_refresh')}</button>`);
  });

  test('live quota replaces the cached picture', () => {
    writePoolSnapshot(API, { claude: { 'claude-a.json': cachedAccount(60) } }, now);
    const markup = render(live);
    expect(markup).toContain('>75%<');
    expect(markup).not.toContain('Cached data from');
  });

  test('a failed load does not fall back to cached data', () => {
    writePoolSnapshot(API, { claude: { 'claude-a.json': cachedAccount(60) } }, now);
    expect(render({ status: 'error', error: 'expired' })).toBe('');
  });

  test('a snapshot from another server is not shown', () => {
    writePoolSnapshot('https://other.invalid', {
      claude: { 'claude-a.json': cachedAccount(60) },
    });
    expect(render(undefined)).toBe('');
  });
});
