/**
 * Server update dialog: shows the running version and the latest release from
 * the configured repository, and installs it through the host helper.
 *
 * Installing restarts the server, so while it runs this polls the update
 * endpoint and treats failed requests as the restart in progress. The helper's
 * status.json reports the outcome, including an automatic rollback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  SERVER_UPDATE_PROGRESS_STATES,
  isTerminalUpdateState,
  serverUpdateApi,
} from '@/services/api/serverUpdate';
import type { ServerUpdateHelperStatus, ServerUpdateInfo } from '@/services/api/serverUpdate';
import { formatDateTimeValue } from '@/utils/format';
import { statusForRequest, summarizeServerUpdate } from './serverUpdateModel';
import styles from './ServerUpdateModal.module.scss';

const POLL_MS = 3000;
const GIVE_UP_MS = 10 * 60 * 1000;

export type ServerUpdatePhase =
  | { kind: 'overview' }
  | { kind: 'confirm' }
  | {
      kind: 'updating';
      version: string;
      /** Latest helper report on this request, if any yet. */
      status: ServerUpdateHelperStatus | null;
      /** The last poll failed: the server is restarting (or unreachable). */
      unreachable: boolean;
    }
  | { kind: 'done'; version: string; status: ServerUpdateHelperStatus }
  | { kind: 'timeout'; version: string };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

/* ------------------------------------------------------------------ body */

export interface ServerUpdateBodyProps {
  info: ServerUpdateInfo;
  phase: ServerUpdatePhase;
  requestError?: string;
}

/** The dialog's content for one phase; pure, so it can be rendered in tests. */
export function ServerUpdateBody({ info, phase, requestError }: ServerUpdateBodyProps) {
  const { t, i18n } = useTranslation();
  const formatTime = (ms: number | null) => (ms ? formatDateTimeValue(ms, i18n.language) : '');
  const latest = info.latest;
  const summary = summarizeServerUpdate(info);

  if (phase.kind === 'confirm') {
    return (
      <div className={styles.body}>
        <p>
          {t('system_info.update_confirm_message', {
            version: latest?.version ?? '',
            repo: info.repository,
          })}
        </p>
      </div>
    );
  }

  if (phase.kind === 'updating') {
    const current = phase.status?.state ?? '';
    const currentIndex = (SERVER_UPDATE_PROGRESS_STATES as readonly string[]).indexOf(current);
    return (
      <div className={styles.body}>
        <ol className={styles.steps}>
          {SERVER_UPDATE_PROGRESS_STATES.map((state, index) => (
            <li
              key={state}
              className={
                index < currentIndex
                  ? styles.stepDone
                  : index === currentIndex
                    ? styles.stepActive
                    : undefined
              }
              aria-current={index === currentIndex ? 'step' : undefined}
            >
              {t(`system_info.update_step_${state}`, { version: phase.version })}
            </li>
          ))}
        </ol>
        <p className={styles.note} role="status">
          {phase.unreachable
            ? t('system_info.update_progress_unreachable')
            : phase.status
              ? phase.status.message
              : t('system_info.update_progress_requested')}
        </p>
      </div>
    );
  }

  if (phase.kind === 'done' || phase.kind === 'timeout') {
    const state = phase.kind === 'done' ? phase.status.state : 'timeout';
    const tone = state === 'succeeded' || state === 'verified' ? styles.good : styles.bad;
    return (
      <div className={styles.body}>
        <p className={`${styles.summary} ${tone}`} role="status">
          {t(`system_info.update_done_${state}`, {
            version: phase.version,
            message: phase.kind === 'done' ? phase.status.message : '',
          })}
        </p>
      </div>
    );
  }

  const summaryText = (() => {
    switch (summary.kind) {
      case 'check_failed':
        return t('system_info.update_check_failed', { message: summary.message });
      case 'no_release':
        return t('system_info.update_no_release', { repo: info.repository });
      case 'pending':
        return t('system_info.update_pending');
      case 'latest':
        return t('system_info.update_is_latest');
      case 'building':
        return t('system_info.update_building', { version: summary.version, asset: summary.asset });
      case 'available':
        return summary.canInstall
          ? t('system_info.update_available', { version: summary.version })
          : t('system_info.update_not_configured', { version: summary.version });
    }
  })();
  const summaryTone =
    summary.kind === 'available' ? styles.accent : summary.kind === 'latest' ? styles.good : '';

  return (
    <div className={styles.body}>
      <dl className={styles.facts}>
        <div>
          <dt>{t('system_info.update_running')}</dt>
          <dd>{info.currentVersion || t('system_info.version_unknown')}</dd>
        </div>
        <div>
          <dt>{t('system_info.update_latest')}</dt>
          <dd>
            {latest ? latest.version : '—'}
            {latest?.publishedAtMs ? (
              <span className={styles.muted}> · {formatTime(latest.publishedAtMs)}</span>
            ) : null}
            {latest?.url ? (
              <>
                {' · '}
                <a href={latest.url} target="_blank" rel="noopener noreferrer">
                  {t('system_info.update_release_notes')}
                </a>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t('system_info.update_source')}</dt>
          <dd>
            <code>{info.repository}</code>
          </dd>
        </div>
      </dl>
      <p className={`${styles.summary} ${summaryTone}`}>{summaryText}</p>
      {requestError && (
        <p className={`${styles.summary} ${styles.bad}`} role="alert">
          {t('system_info.update_request_failed', { message: requestError })}
        </p>
      )}
      {info.status && (
        <p className={styles.note}>
          {t('system_info.update_last_run', {
            time: formatTime(info.status.updatedAtMs) || '—',
            message: info.status.message || info.status.state,
          })}
        </p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- modal */

export interface ServerUpdateModalProps {
  open: boolean;
  info: ServerUpdateInfo | null;
  onClose: () => void;
}

export function ServerUpdateModal({ open, info: initialInfo, onClose }: ServerUpdateModalProps) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<ServerUpdateInfo | null>(initialInfo);
  const [phase, setPhase] = useState<ServerUpdatePhase>({ kind: 'overview' });
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const request = useRef<{
    tag: string;
    baseline: ServerUpdateHelperStatus | null;
    startedAt: number;
  } | null>(null);

  // A new check result resets the dialog unless an update is being followed.
  useEffect(() => {
    if (!open) return;
    setInfo(initialInfo);
    if (!request.current) {
      setPhase({ kind: 'overview' });
      setRequestError('');
    }
  }, [open, initialInfo]);

  const startUpdate = useCallback(async () => {
    const latest = info?.latest;
    if (!info || !latest) return;
    setRequesting(true);
    setRequestError('');
    try {
      await serverUpdateApi.request(latest.tag);
      request.current = { tag: latest.tag, baseline: info.status, startedAt: Date.now() };
      setPhase({ kind: 'updating', version: latest.version, status: null, unreachable: false });
    } catch (error: unknown) {
      setRequestError(errorMessage(error));
      setPhase({ kind: 'overview' });
    } finally {
      setRequesting(false);
    }
  }, [info]);

  // Follow the helper until it reports a result for our request.
  const following = phase.kind === 'updating';
  useEffect(() => {
    if (!following) return;
    let cancelled = false;
    const poll = async () => {
      const current = request.current;
      if (!current) return;
      if (Date.now() - current.startedAt > GIVE_UP_MS) {
        request.current = null;
        setPhase((prev) =>
          prev.kind === 'updating' ? { kind: 'timeout', version: prev.version } : prev
        );
        return;
      }
      try {
        const next = await serverUpdateApi.get();
        if (cancelled) return;
        setInfo(next);
        const status = statusForRequest(next.status, current.tag, current.baseline);
        if (status && isTerminalUpdateState(status.state)) {
          request.current = null;
          setPhase((prev) =>
            prev.kind === 'updating' ? { kind: 'done', version: prev.version, status } : prev
          );
          return;
        }
        setPhase((prev) =>
          prev.kind === 'updating'
            ? { ...prev, status: status ?? prev.status, unreachable: false }
            : prev
        );
      } catch {
        if (!cancelled) {
          setPhase((prev) => (prev.kind === 'updating' ? { ...prev, unreachable: true } : prev));
        }
      }
    };
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [following]);

  if (!info) return null;
  const summary = summarizeServerUpdate(info);
  const canInstall = summary.kind === 'available' && summary.canInstall;

  const footer = (() => {
    switch (phase.kind) {
      case 'overview':
        return (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            {canInstall && (
              <Button onClick={() => setPhase({ kind: 'confirm' })}>
                {t('system_info.update_install', { version: info.latest?.version ?? '' })}
              </Button>
            )}
          </>
        );
      case 'confirm':
        return (
          <>
            <Button
              variant="secondary"
              onClick={() => setPhase({ kind: 'overview' })}
              disabled={requesting}
            >
              {t('common.back')}
            </Button>
            <Button onClick={() => void startUpdate()} loading={requesting}>
              {t('system_info.update_install_now')}
            </Button>
          </>
        );
      case 'updating':
        return (
          <Button variant="secondary" onClick={onClose}>
            {t('system_info.update_close_continues')}
          </Button>
        );
      default:
        return (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            {phase.kind === 'done' && phase.status.state === 'succeeded' && (
              <Button onClick={() => window.location.reload()}>
                {t('system_info.update_reload')}
              </Button>
            )}
          </>
        );
    }
  })();

  return (
    <Modal open={open} onClose={onClose} title={t('system_info.update_title')} footer={footer}>
      <ServerUpdateBody info={info} phase={phase} requestError={requestError} />
    </Modal>
  );
}
