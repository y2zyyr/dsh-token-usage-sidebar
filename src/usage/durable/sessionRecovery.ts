// Read-only adapters for official DSH 0.1 and 0.2 persistence APIs.
import { createHash } from 'node:crypto';
import { SessionUsageCollector, collectSessionUsage, type SessionEventLike, type CollectorCheckpoint } from '../collector.ts';
import type { UsageRecord, SourceScanStatus } from '../types.ts';
import { isTokenCount } from '../validation.ts';
import { DurableStore } from './durableStore.ts';
import { inTransaction } from './wrapper.ts';

interface HeaderLike { id: string; isSeeded?: boolean; parentSession?: string; }
export interface LiveSessionLike {
  id: string;
  header?: HeaderLike;
  inheritedEventCount?: number;
  events?: readonly SessionEventLike[];
  snapshotEvents?: () => readonly SessionEventLike[];
}
interface ReadHandle {
  header: HeaderLike;
  inheritedEventCount: number;
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEventLike[] }>;
  close(): Promise<void>;
}
export interface PersistenceLike {
  /** Backend identity used only for explicitly supported revision formats. */
  name?: string;
  list(options?: unknown): Promise<readonly unknown[]>;
  listSnapshots?: (signal?: AbortSignal) => Promise<readonly unknown[]>;
  open?: (id: string, access: 'read', options?: { signal?: AbortSignal }) => Promise<ReadHandle>;
  readFrom?: (id: string, fromSeq: number, signal?: AbortSignal) => Promise<{ meta: HeaderLike; events: readonly SessionEventLike[] }>;
}
export interface SessionRecoveryResult {
  sourceScanStatus: SourceScanStatus;
  sessionsDiscovered: number;
  sessionsReadSuccessfully: number;
  sessionsReadFailed: number;
  sessionsSkippedUnchanged: number;
  /** Sessions whose previous identical-revision read failed; not re-read this pass. */
  sessionsSkippedKnownUnreadable: number;
  invalidUsageEvents: number;
  errors: string[];
  listMs: number;
  durationMs: number;
}

export interface SessionRecoveryOptions {
  /** How long a remembered failure suppresses an unchanged-source re-read. */
  retryTtlMs?: number;
  now?: () => number;
}

/** A failed read is not retried for the same revision until this has elapsed. */
export const SESSION_SCAN_RETRY_TTL_MS = 24 * 60 * 60 * 1000;
interface RecoveryCheckpoint {
  offset: number;
  inheritedEventCount: number;
  lastEventHash?: string;
  collector: CollectorCheckpoint;
  revision?: string;
}
const hashEvent = (event: SessionEventLike) => createHash('sha256').update(JSON.stringify(event)).digest('hex');

/**
 * Identify one source revision well enough to justify skipping a re-read of a
 * previously failed session. JSONL historical revisions include a corpus hash:
 * writing ANY other session changes it. For failed reads only, throttle retries
 * by the unchanged source file identity until TTL expiry. Successful checkpoints
 * still use the full official revision to verify related fork/migration sources.
 * Other backends keep their opaque revision; when a source has none, a byte-size
 * fingerprint still changes when an
 * append-only log grows. No fingerprint means no memory: such a source is
 * always retried, because a changed log cannot be detected.
 */
function scanFingerprint(revision: string | undefined, sizeBytes: unknown, backend?: string): string | undefined {
  if (revision !== undefined) {
    const historical = backend === 'session-persistence-jsonl'
      ? /^(\d+:\d+:(\d+):\d+:\d+):[a-f0-9]{64}$/.exec(revision) : null;
    if (historical && isTokenCount(sizeBytes) && Number(historical[2]) === sizeBytes) {
      return 'historical-file:' + historical[1];
    }
    return 'revision:' + revision;
  }
  return isTokenCount(sizeBytes) ? 'size:' + sizeBytes : undefined;
}

function rememberedFingerprint(value: string, sizeBytes: unknown, backend?: string): string {
  // Accept already-written schema-4 cache entries without changing their age.
  return value.startsWith('revision:') ? scanFingerprint(value.slice('revision:'.length), sizeBytes, backend)! : value;
}
const SAFE_ERRORS = new Set(['invalid-session-descriptor', 'invalid-session-read', 'invalid-session-handle',
  'unsupported-session-persistence', 'session-recovery-checkpoint-conflict', 'non-contiguous-session-log',
  'invalid-session-usage-or-fork-cut', 'fork-ownership-unavailable', 'invalid-fork-inherited-cut',
  'invalid-session-event-order', 'session-snapshot-behind-ledger', 'invalid-session-usage']);

function validCheckpoint(value: RecoveryCheckpoint | undefined): value is RecoveryCheckpoint {
  if (!value || !isTokenCount(value.offset) || !isTokenCount(value.inheritedEventCount)
    || value.inheritedEventCount > value.offset || !value.collector || value.collector.lastSeq !== value.offset - 1) return false;
  if (value.offset > 0 && !/^[a-f0-9]{64}$/.test(value.lastEventHash ?? '')) return false;
  if (value.revision !== undefined && (typeof value.revision !== 'string' || value.revision.length === 0)) return false;
  const step = value.collector.activeStep;
  return !step || (isTokenCount(step.turn) && isTokenCount(step.step)
    && (step.retrySeq === undefined || (isTokenCount(step.retrySeq) && step.retrySeq < value.offset)));
}

function inheritedCut(header: HeaderLike | undefined, provided: number | undefined, events: readonly SessionEventLike[]): number {
  if (provided !== undefined) {
    if (!isTokenCount(provided)) throw new Error('invalid-fork-inherited-cut');
    return provided;
  }
  if (!header?.isSeeded && !header?.parentSession) return 0;
  const marker = [...events].reverse().find((event) => event.type === 'session/end-seed' && event.data?.inherited === true);
  if (!marker) throw new Error('fork-ownership-unavailable');
  return marker.seq;
}

function inheritedUsageIds(sessionId: string, events: readonly SessionEventLike[], cut: number): string[] {
  const records = collectSessionUsage({ sessionId, events: events.filter((event) => event.seq < cut), sourceType: 'session_log' });
  return [...new Set(records.flatMap((record) => [record.id, sessionId + ':' + record.turn + ':' + record.step]))];
}

export function snapshotLiveSession(session: LiveSessionLike, onInvalidUsage?: () => void): {
  collector: SessionUsageCollector; records: UsageRecord[]; inheritedIds: string[]; lastSeq: number;
} {
  if (!session.id) throw new Error('invalid-live-session');
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
  if (!Array.isArray(events)) throw new Error('session-events-unavailable');
  let previous = -1;
  for (const event of events) {
    if (!isTokenCount(event.seq) || event.seq !== previous + 1) throw new Error('non-contiguous-session-log');
    previous = event.seq;
  }
  const cut = inheritedCut(session.header, session.inheritedEventCount, events);
  if (cut > previous + 1) throw new Error('fork-cut-outside-session');
  let invalid = 0;
  const collector = new SessionUsageCollector({ sessionId: session.id, inheritedEventCount: cut, sourceType: 'session_log',
    onInvalidUsage: () => { invalid += 1; onInvalidUsage?.(); } });
  const records = collector.collect(events);
  if (invalid > 0) throw new Error('invalid-session-usage');
  return { collector, records, inheritedIds: inheritedUsageIds(session.id, events, cut), lastSeq: previous };
}

/** Always closes read handles; records and their checkpoint commit together. */
export async function recoverPersistedSessions(store: DurableStore, persistence: PersistenceLike | undefined,
  signal: AbortSignal, options: SessionRecoveryOptions = {}): Promise<SessionRecoveryResult> {
  const now = options.now ?? (() => Date.now());
  const retryTtlMs = options.retryTtlMs ?? SESSION_SCAN_RETRY_TTL_MS;
  const startedAt = now();
  const result: SessionRecoveryResult = { sourceScanStatus: 'unknown', sessionsDiscovered: 0, sessionsReadSuccessfully: 0,
    sessionsReadFailed: 0, sessionsSkippedUnchanged: 0, sessionsSkippedKnownUnreadable: 0, invalidUsageEvents: 0,
    errors: [], listMs: 0, durationMs: 0 };
  if (!persistence) { result.durationMs = now() - startedAt; return result; }
  let snapshots: readonly unknown[];
  try {
    const listStartedAt = now();
    snapshots = persistence.open ? await persistence.list({ signal })
      : persistence.listSnapshots ? await persistence.listSnapshots(signal) : await persistence.list(signal);
    result.listMs = now() - listStartedAt;
    if (!Array.isArray(snapshots)) throw new Error('invalid-session-list');
  } catch {
    if (signal.aborted) { result.durationMs = now() - startedAt; return result; }
    result.sourceScanStatus = 'failed'; result.errors.push('session-list-failed');
    result.durationMs = now() - startedAt; return result;
  }
  result.sessionsDiscovered = snapshots.length;
  for (const snapshot of snapshots) {
    if (signal.aborted) break;
    let id: string | undefined;
    let fingerprint: string | undefined;
    try {
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid-session-descriptor');
      const value = snapshot as { header?: HeaderLike; id?: string; eventCount?: number; revision?: unknown; sizeBytes?: unknown };
      const sourceId = value.header?.id ?? value.id;
      if (typeof sourceId !== 'string' || sourceId.length === 0) throw new Error('invalid-session-descriptor');
      id = sourceId;
      const revision = typeof value.revision === 'string' && value.revision.length > 0 ? value.revision : undefined;
      fingerprint = scanFingerprint(revision, value.sizeBytes, persistence.name);
      const remembered = store.readSessionScanFailure(id);
      const saved = store.readSessionCheckpoint<RecoveryCheckpoint>(id);
      // Official revisions identify both the backing source and its log state.
      // No source read is needed while a validated committed checkpoint matches.
      if (!store.repairedOnOpen && validCheckpoint(saved) && revision !== undefined && saved.revision === revision) {
        if (remembered) store.clearSessionScanFailure(id);
        result.sessionsSkippedUnchanged += 1; result.sessionsReadSuccessfully += 1;
        await new Promise<void>((resolve) => setImmediate(resolve)); continue;
      }
      // A repair invalidates every checkpoint, so it also invalidates remembered
      // failures: retry once against the repaired ledger.
      const age = remembered ? now() - remembered.attemptedAt : -1;
      if (!store.repairedOnOpen && remembered && fingerprint !== undefined
        && rememberedFingerprint(remembered.revision, value.sizeBytes, persistence.name) === fingerprint
        && age >= 0 && age < retryTtlMs) {
        // Same source revision, already known unreadable: keep reporting it as
        // failed without paying the read again on every start.
        result.sessionsSkippedKnownUnreadable += 1; result.sessionsReadFailed += 1;
        result.errors.push(SAFE_ERRORS.has(remembered.failureCode) ? remembered.failureCode : 'session-read-failed');
        await new Promise<void>((resolve) => setImmediate(resolve)); continue;
      }
      if (persistence.open) {
        if (await recoverV2(store, persistence, id, signal, () => { result.invalidUsageEvents += 1; }, revision)) result.sessionsSkippedUnchanged += 1;
      } else if (persistence.readFrom) {
        if (await recoverV1(store, persistence, id, signal, () => { result.invalidUsageEvents += 1; }, revision)) result.sessionsSkippedUnchanged += 1;
      } else throw new Error('unsupported-session-persistence');
      result.sessionsReadSuccessfully += 1;
      if (remembered) store.clearSessionScanFailure(id);
    } catch (error) {
      if (signal.aborted) break;
      result.sessionsReadFailed += 1;
      const message = error instanceof Error ? error.message : '';
      const code = SAFE_ERRORS.has(message) ? message : 'session-read-failed';
      result.errors.push(code);
      if (id !== undefined && fingerprint !== undefined) {
        try { store.writeSessionScanFailure(id, fingerprint, code, now()); } catch {}
      }
    }
    // Yield between sessions so recovery does not monopolize the host.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  result.sourceScanStatus = result.sessionsReadFailed > 0
    ? result.sessionsReadSuccessfully > 0 ? 'partial' : 'failed'
    : signal.aborted ? 'partial' : 'complete';
  result.durationMs = now() - startedAt;
  return result;
}

async function recoverV1(store: DurableStore, persistence: PersistenceLike, id: string, signal: AbortSignal, onInvalidUsage: () => void, revision?: string): Promise<boolean> {
  const saved = store.readSessionCheckpoint<RecoveryCheckpoint>(id);
  const checkpoint = !store.repairedOnOpen && validCheckpoint(saved) ? saved : undefined;
  const from = checkpoint ? Math.max(0, checkpoint.offset - 1) : 0;
  const read = await persistence.readFrom!(id, from, signal);
  if (signal.aborted) throw new Error('session-recovery-aborted');
  if (read.meta.id !== id || !Array.isArray(read.events)) throw new Error('invalid-session-read');
  for (let i = 0; i < read.events.length; i += 1) if (read.events[i].seq !== from + i) throw new Error('non-contiguous-session-log');
  if (checkpoint && checkpoint.offset > 0 && (read.events.length === 0 || hashEvent(read.events[0]) !== checkpoint.lastEventHash)) throw new Error('session-recovery-checkpoint-conflict');
  const events = checkpoint && checkpoint.offset > 0 ? read.events.slice(1) : read.events;
  const cut = checkpoint?.inheritedEventCount ?? inheritedCut(read.meta, undefined, events);
  let invalid = 0;
  const collector = new SessionUsageCollector({ sessionId: id, sourceType: 'session_log', inheritedEventCount: cut,
    onInvalidUsage: () => { invalid += 1; onInvalidUsage(); } }, checkpoint?.collector);
  const records = collector.collect(events);
  const offset = (checkpoint?.offset ?? 0) + events.length;
  if (invalid > 0 || cut > offset) throw new Error('invalid-session-usage-or-fork-cut');
  const next: RecoveryCheckpoint = { offset, inheritedEventCount: cut, collector: collector.checkpoint(), revision,
    lastEventHash: events.length > 0 ? hashEvent(events[events.length - 1]) : checkpoint?.lastEventHash };
  if (checkpoint) commitIncremental(store, id, checkpoint, records, next);
  else store.reconcileSession(id, records, inheritedUsageIds(id, events, cut), offset - 1, next);
  return checkpoint !== undefined && events.length === 0;
}

async function recoverV2(store: DurableStore, persistence: PersistenceLike, id: string, signal: AbortSignal, onInvalidUsage: () => void, revision?: string): Promise<boolean> {
  const handle = await persistence.open!(id, 'read', { signal });
  try {
    if (handle.header.id !== id || typeof handle.read !== 'function' || typeof handle.close !== 'function') throw new Error('invalid-session-handle');
    const cut = inheritedCut(handle.header, handle.inheritedEventCount, []);
    const saved = store.readSessionCheckpoint<RecoveryCheckpoint>(id);
    const checkpoint = !store.repairedOnOpen && validCheckpoint(saved) ? saved : undefined;
    if (checkpoint && checkpoint.inheritedEventCount !== cut) throw new Error('session-recovery-checkpoint-conflict');
    if (checkpoint && checkpoint.offset > 0) {
      const marker = (await handle.read(checkpoint.offset - 1, 1, { signal })).events;
      if (marker.length !== 1 || hashEvent(marker[0]) !== checkpoint.lastEventHash) throw new Error('session-recovery-checkpoint-conflict');
    }
    let invalid = 0;
    const collector = new SessionUsageCollector({ sessionId: id, sourceType: 'session_log', inheritedEventCount: cut,
      onInvalidUsage: () => { invalid += 1; onInvalidUsage(); } }, checkpoint?.collector);
    const records = new Map<string, UsageRecord>();
    const inherited = new Set<string>();
    const inheritedCollector = new SessionUsageCollector({ sessionId: id, sourceType: 'session_log' });
    let offset = checkpoint?.offset ?? 0;
    const initialOffset = offset;
    let lastEventHash = checkpoint?.lastEventHash;
    while (!signal.aborted) {
      const events = (await handle.read(offset, 512, { signal })).events;
      if (!Array.isArray(events)) throw new Error('invalid-session-read');
      if (events.length === 0) break;
      for (let i = 0; i < events.length; i += 1) if (events[i].seq !== offset + i) throw new Error('non-contiguous-session-log');
      for (const record of collector.collect(events)) records.set(record.id, record);
      if (!checkpoint) for (const record of inheritedCollector.collect(events.filter((event) => event.seq < cut))) {
        inherited.add(record.id); inherited.add(id + ':' + record.turn + ':' + record.step);
      }
      offset += events.length;
      lastEventHash = hashEvent(events[events.length - 1]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (signal.aborted) throw new Error('session-recovery-aborted');
    if (invalid > 0 || cut > offset) throw new Error('invalid-session-usage-or-fork-cut');
    const next: RecoveryCheckpoint = { offset, inheritedEventCount: cut, lastEventHash, collector: collector.checkpoint(), revision };
    if (checkpoint) commitIncremental(store, id, checkpoint, [...records.values()], next);
    else store.reconcileSession(id, [...records.values()], [...inherited], offset - 1, next);
    return checkpoint !== undefined && initialOffset === offset;
  } finally { await handle.close(); }
}

function commitIncremental(store: DurableStore, id: string, previous: RecoveryCheckpoint, records: readonly UsageRecord[], next: RecoveryCheckpoint): void {
  inTransaction(store.database, () => {
    // A live/legacy write may have invalidated this checkpoint during an await.
    // Never recreate an invalidated watermark from only the old suffix.
    if (JSON.stringify(store.readSessionCheckpoint(id)) !== JSON.stringify(previous)) throw new Error('session-recovery-checkpoint-conflict');
    store.apply(records); store.writeSessionCheckpoint(id, next);
  });
}
