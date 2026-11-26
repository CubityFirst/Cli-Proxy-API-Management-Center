/**
 * Server updates from GitHub releases: payload normalization, what the dialog
 * says for each check result, and matching the host helper's report to our
 * request.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { ServerUpdateBody } from '../src/features/serverUpdate/ServerUpdateModal';
import type { ServerUpdatePhase } from '../src/features/serverUpdate/ServerUpdateModal';
import {
  statusForRequest,
  summarizeServerUpdate,
} from '../src/features/serverUpdate/serverUpdateModel';
import { normalizeServerUpdate } from '../src/services/api/serverUpdate';
import type { ServerUpdateInfo } from '../src/services/api/serverUpdate';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const payload = {
  repository: 'CubityFirst/CLIProxyAPI',
  current_version: '8.1.4-sr.2',
  apply_enabled: true,
  latest: {
    tag: 'v8.1.5-sr',
    version: '8.1.5-sr',
    published_at: '2026-11-26T12:00:00Z',
    url: 'https://github.com/CubityFirst/CLIProxyAPI/releases/tag/v8.1.5-sr',
    asset: 'CLIProxyAPI_8.1.5-sr_linux_amd64_no-plugin.tar.gz',
    asset_ready: true,
  },
  update_available: true,
  pending: false,
  status: {
    state: 'succeeded',
    tag: 'v8.1.4-sr.2',
    from: '8.1.4-sr',
    message: 'Running 8.1.4-sr.2',
    updated_at: '2026-11-26T09:15:30Z',
  },
};

const info = (overrides: Partial<ServerUpdateInfo> = {}): ServerUpdateInfo => ({
  ...normalizeServerUpdate(payload),
  ...overrides,
});

describe('normalizeServerUpdate', () => {
  test('maps the backend payload', () => {
    const normalized = normalizeServerUpdate(payload);
    expect(normalized).toMatchObject({
      repository: 'CubityFirst/CLIProxyAPI',
      currentVersion: '8.1.4-sr.2',
      applyEnabled: true,
      updateAvailable: true,
      pending: false,
      error: '',
    });
    expect(normalized.latest).toMatchObject({
      tag: 'v8.1.5-sr',
      version: '8.1.5-sr',
      assetReady: true,
      publishedAtMs: Date.parse('2026-11-26T12:00:00Z'),
    });
    expect(normalized.status).toMatchObject({
      state: 'succeeded',
      tag: 'v8.1.4-sr.2',
      updatedAtMs: Date.parse('2026-11-26T09:15:30Z'),
    });
  });

  test('tolerates missing or malformed fields', () => {
    expect(normalizeServerUpdate(null)).toMatchObject({
      repository: '',
      latest: null,
      status: null,
      applyEnabled: false,
    });
    const odd = normalizeServerUpdate({
      latest: { tag: '' },
      status: { state: 1 },
      pending: 'yes',
    });
    expect(odd.latest).toBeNull();
    expect(odd.status).toBeNull();
    expect(odd.pending).toBe(false);
  });
});

describe('summarizeServerUpdate', () => {
  test('covers each check result', () => {
    expect(summarizeServerUpdate(info())).toEqual({
      kind: 'available',
      version: '8.1.5-sr',
      canInstall: true,
    });
    expect(summarizeServerUpdate(info({ applyEnabled: false }))).toMatchObject({
      kind: 'available',
      canInstall: false,
    });
    expect(summarizeServerUpdate(info({ updateAvailable: false }))).toEqual({ kind: 'latest' });
    expect(summarizeServerUpdate(info({ pending: true }))).toEqual({ kind: 'pending' });
    expect(summarizeServerUpdate(info({ latest: null }))).toEqual({ kind: 'no_release' });
    expect(summarizeServerUpdate(info({ latest: null, error: 'status 403' }))).toEqual({
      kind: 'check_failed',
      message: 'status 403',
    });
    const building = info();
    building.latest = { ...building.latest!, assetReady: false };
    expect(summarizeServerUpdate(building)).toMatchObject({ kind: 'building' });
  });
});

describe('statusForRequest', () => {
  const baseline = normalizeServerUpdate(payload).status;
  const report = (state: string, tag = 'v8.1.5-sr', at = '2026-11-26T12:05:00Z') =>
    normalizeServerUpdate({ status: { state, tag, updated_at: at } }).status;

  test('accepts a new report for the requested tag', () => {
    expect(statusForRequest(report('restarting'), 'v8.1.5-sr', baseline)?.state).toBe('restarting');
  });

  test('ignores reports for another tag or unchanged from before the request', () => {
    expect(statusForRequest(baseline, 'v8.1.5-sr', baseline)).toBeNull();
    expect(statusForRequest(report('failed', 'v8.1.4'), 'v8.1.5-sr', baseline)).toBeNull();
    // An earlier failed attempt at the same tag, still on file when we asked again.
    const earlier = report('failed');
    expect(statusForRequest(earlier, 'v8.1.5-sr', earlier)).toBeNull();
    expect(
      statusForRequest(
        report('downloading', 'v8.1.5-sr', '2026-11-26T12:09:00Z'),
        'v8.1.5-sr',
        earlier
      )?.state
    ).toBe('downloading');
    expect(statusForRequest(null, 'v8.1.5-sr', baseline)).toBeNull();
  });
});

describe('ServerUpdateBody', () => {
  const render = (phase: ServerUpdatePhase, data = info(), requestError?: string) =>
    renderToStaticMarkup(createElement(ServerUpdateBody, { info: data, phase, requestError }));

  test('overview shows versions, the source and the last helper run', () => {
    const markup = render({ kind: 'overview' });
    expect(markup).toContain('8.1.4-sr.2');
    expect(markup).toContain('CubityFirst/CLIProxyAPI');
    expect(markup).toContain('8.1.5-sr is available.');
    expect(markup).toContain(
      'href="https://github.com/CubityFirst/CLIProxyAPI/releases/tag/v8.1.5-sr"'
    );
    expect(markup).toContain('Running 8.1.4-sr.2');
  });

  test('explains a missing install setup and a failed request', () => {
    const markup = render({ kind: 'overview' }, info({ applyEnabled: false }), 'update_disabled');
    expect(markup).toContain('installing from the panel isn&#x27;t set up');
    expect(markup).toContain('Couldn&#x27;t request the update: update_disabled');
  });

  test('progress marks finished and current steps', () => {
    const markup = render({
      kind: 'updating',
      version: '8.1.5-sr',
      unreachable: false,
      status: normalizeServerUpdate({
        status: { state: 'installing', tag: 'v8.1.5-sr', message: 'Installing 8.1.5-sr' },
      }).status,
    });
    expect(markup).toContain('aria-current="step"');
    expect(markup).toMatch(/aria-current="step"[^>]*>Install</);
    expect(markup).toContain('Installing 8.1.5-sr');

    const restarting = render({
      kind: 'updating',
      version: '8.1.5-sr',
      unreachable: true,
      status: null,
    });
    expect(restarting).toContain('The server is restarting');
  });

  test('outcomes', () => {
    const done = (state: string, message = '') =>
      render({
        kind: 'done',
        version: '8.1.5-sr',
        status: normalizeServerUpdate({ status: { state, tag: 'v8.1.5-sr', message } }).status!,
      });
    expect(done('succeeded')).toContain('Updated to 8.1.5-sr.');
    expect(done('rolled_back', 'restored 8.1.4-sr.2')).toContain(
      'the previous version was restored. restored 8.1.4-sr.2'
    );
    expect(render({ kind: 'timeout', version: '8.1.5-sr' })).toContain(
      'No result after 10 minutes'
    );
  });
});
