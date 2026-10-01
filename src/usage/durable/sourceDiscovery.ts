// src/usage/durable/sourceDiscovery.ts
// Discover recoverable token records from plugin-owned DSH storage units.
//
// The discovery boundary is deliberately narrow: only JSON files whose names
// begin with dsh_token_usage and whose contents match one of the known ledger
// schemas are considered. We never walk the user's general home directory and
// we never turn aggregate totals into synthetic invocation records.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageRecord, UsageSourceType } from '../types.ts';
import { buildRecordsFromV1, type V1LedgerState } from './migration.ts';
import { assertUsageRecord, isTokenCount } from '../validation.ts';
import type { DurableStore } from './durableStore.ts';
import { inTransaction } from './wrapper.ts';

export const SOURCE_DISCOVERY_VERSION = 3;

type JsonObject = Record<string, unknown>;
type DiscoveryFormat = 'record-table' | 'legacy-root' | 'aggregate-summary';

export interface DiscoveredSource {
  path: string;
  format: DiscoveryFormat;
  sha256: string;
  recordCount: number;
  totalTokens: number;
  imported: boolean;
}

export interface SourceDiscoveryResult {
  cached?: boolean;
  storageDir: string;
  status: 'complete' | 'partial' | 'failed' | 'none';
  records: UsageRecord[];
  sources: DiscoveredSource[];
  errors: string[];
  aggregateChecks: {
    expectedTotal: number | null;
    expectedRecordCount: number | null;
    discoveredTotal: number;
    discoveredRecordCount: number;
  };
}

export interface SourceDiscoveryOptions {
  /** Import the legacy root only after the verified v1 migration completed. */
  includeLegacyRoot?: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nonNegativeNumber(value: unknown, field: string, fallback = 0): number {
  if (value === undefined) return fallback;
  if (!isTokenCount(value)) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sourceType(value: unknown, fallback: UsageSourceType): UsageSourceType {
  return value === 'live_event' || value === 'session_log' || value === 'provider_record'
    || value === 'legacy_store' || value === 'other' ? value : fallback;
}

function localDateFromName(name: string): string | undefined {
  const match = /^dsh_token_usage_day_(\d{4})(\d{2})(\d{2})\.json$/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function splitCanonicalId(id: string): { sessionId: string; turn: number; step: number } {
  const parts = id.split(':');
  if (parts.length < 3) return { sessionId: id, turn: 0, step: 0 };
  const step = Number(parts.at(-1));
  const turn = Number(parts.at(-2));
  return {
    sessionId: parts.slice(0, -2).join(':') || id,
    turn: Number.isFinite(turn) ? Math.trunc(turn) : 0,
    step: Number.isFinite(step) ? Math.trunc(step) : 0,
  };
}

function totalOf(record: UsageRecord): number {
  return record.totalTokens;
}

function normalizeRecord(raw: JsonObject, fallbackId: string, sourcePath: string, defaultDate?: string): UsageRecord {
  const id = text(raw.id) ?? fallbackId;
  if (id.length === 0) throw new Error('record id is empty');
  const identity = splitCanonicalId(id);
  const localDate = text(raw.localDate) ?? defaultDate ?? 'unclassified';
  const timestamp = raw.timestamp === undefined ? undefined : nonNegativeNumber(raw.timestamp, 'timestamp');
  const effectiveTimestamp = timestamp
    ?? (localDate !== 'unclassified' ? Date.parse(`${localDate}T12:00:00`) : 0);
  const totalTokens = nonNegativeNumber(raw.totalTokens, 'totalTokens');
  if (!isTokenCount(raw.totalTokens)) throw new Error('totalTokens is missing or invalid');
  const source = raw.source === 'assistant/chunk' || raw.source === 'assistant/attempt' ? raw.source : 'assistant/message';
  return {
    id,
    source,
    sessionId: text(raw.sessionId) ?? identity.sessionId,
    turn: nonNegativeNumber(raw.turn, 'turn', identity.turn),
    step: nonNegativeNumber(raw.step, 'step', identity.step),
    seq: nonNegativeNumber(raw.seq, 'seq'),
    timestamp: Number.isFinite(effectiveTimestamp) ? effectiveTimestamp! : 0,
    localDate,
    provider: text(raw.provider),
    model: text(raw.model),
    inputTokens: nonNegativeNumber(raw.inputTokens, 'inputTokens'),
    outputTokens: nonNegativeNumber(raw.outputTokens, 'outputTokens'),
    cacheReadTokens: nonNegativeNumber(raw.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: nonNegativeNumber(raw.cacheWriteTokens, 'cacheWriteTokens'),
    reasoningTokens: nonNegativeNumber(raw.reasoningTokens, 'reasoningTokens'),
    totalTokens,
    accounting: 'exact',
    accountingVersion: raw.accountingVersion === undefined ? 1 : nonNegativeNumber(raw.accountingVersion, 'accountingVersion'),
    sourceType: sourceType(raw.sourceType, 'legacy_store'),
    sourcePath,
    migrationVersion: SOURCE_DISCOVERY_VERSION,
  };
}

function sumRecords(records: readonly UsageRecord[]): number {
  return records.reduce((sum, record) => sum + totalOf(record), 0);
}

function aggregateTotal(value: unknown): number | null {
  if (!isObject(value)) return null;
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  const values = fields.map((field) => finiteNumber(value[field]));
  return values.every((field) => field !== undefined) ? values.reduce((sum, field) => sum + field!, 0) : null;
}

function readJson(path: string): { bytes: Buffer; value?: JsonObject; error?: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { bytes: Buffer.alloc(0), error: `read failed: ${String(error)}` };
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return isObject(value) ? { bytes, value } : { bytes, error: 'root is not an object' };
  } catch (error) {
    return { bytes, error: 'JSON parse failed' };
  }
}

function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseRecordTable(table: JsonObject, sourcePath: string, defaultDate?: string): { records: UsageRecord[]; errors: string[] } {
  const records: UsageRecord[] = [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (!isObject(value)) {
      errors.push(`${sourcePath}: record ${key} is not an object`);
      continue;
    }
    try {
      const record = normalizeRecord(value, key, sourcePath, defaultDate);
      assertUsageRecord(record);
      records.push(record);
    } catch (error) {
      errors.push(`${sourcePath}: record ${key} invalid: ${String(error)}`);
    }
  }
  return { records, errors };
}

function parseLegacyRoot(root: JsonObject, sourcePath: string): { records: UsageRecord[]; errors: string[] } {
  try {
    const records = buildRecordsFromV1(root as V1LedgerState).map((record) => ({
      ...record,
      sourcePath,
    }));
    for (const record of records) assertUsageRecord(record);
    if (!isTokenCount(root.lifetimeTotal ?? 0) || sumRecords(records) !== (root.lifetimeTotal ?? 0)
      || !isTokenCount(root.recordCount ?? records.length) || (root.recordCount ?? records.length) !== records.length) throw new Error('legacy root totals mismatch');
    return { records, errors: [] };
  } catch (error) {
    return { records: [], errors: [`${sourcePath}: legacy root invalid: ${String(error)}`] };
  }
}

interface DiscoveryCache {
  signature: string;
  appliedGeneration: number;
  result: SourceDiscoveryResult;
}

function sourceSignature(storageDir: string, options: SourceDiscoveryOptions): string | undefined {
  try {
    const files = readdirSync(storageDir).filter((name) => name.startsWith('dsh_token_usage') && name.endsWith('.json')).sort();
    const fingerprint = files.map((name) => {
      const stat = statSync(join(storageDir, name), { bigint: true });
      return [name, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    });
    return hashOf(Buffer.from(JSON.stringify([SOURCE_DISCOVERY_VERSION, !!options.includeLegacyRoot, fingerprint])));
  } catch { return undefined; }
}

/** Cache only successful, committed imports. File changes and failed scans are rechecked. */
export function importTokenSources(store: DurableStore, storageDir: string, options: SourceDiscoveryOptions = {}): { discovery: SourceDiscoveryResult; applied: number } {
  const signature = sourceSignature(storageDir, options);
  const cached = store.readSourceDiscoveryCache<DiscoveryCache>();
  if (signature && !store.repairedOnOpen && cached?.signature === signature
    && isTokenCount(cached.appliedGeneration) && cached.appliedGeneration <= (store.readMeta()?.recordGeneration ?? 0)
    && (cached.result?.status === 'complete' || cached.result?.status === 'none')
    && Array.isArray(cached.result.sources) && Array.isArray(cached.result.errors) && cached.result.aggregateChecks) {
    return { discovery: { ...cached.result, records: [], cached: true }, applied: 0 };
  }
  const discovery = discoverTokenSources(storageDir, options);
  const applied = inTransaction(store.database, () => {
    const result = store.apply(discovery.records);
    if (signature && signature === sourceSignature(storageDir, options) && (discovery.status === 'complete' || discovery.status === 'none')) {
      store.writeSourceDiscoveryCache({ signature, appliedGeneration: store.readMeta()?.recordGeneration ?? 0,
        result: { ...discovery, records: [] } } satisfies DiscoveryCache);
    }
    return result.added + result.replaced;
  });
  return { discovery, applied };
}

function bestRecords(records: readonly UsageRecord[], errors: string[]): UsageRecord[] {
  const best = new Map<string, UsageRecord>();
  for (const record of records) {
    const existing = best.get(record.id);
    if (existing === undefined || record.seq > existing.seq) {
      best.set(record.id, record);
    } else if (record.seq === existing.seq && record.totalTokens !== existing.totalTokens) {
      errors.push(`duplicate canonical id ${record.id} has conflicting equal-seq totals; kept ${existing.sourcePath ?? 'first source'}`);
    }
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Discover plugin-owned JSON storage units in one DSH storages directory.
 * Aggregate-only units are recorded for verification but never converted into
 * UsageRecords. Record-table units are normalized and deduplicated by ID.
 */
export function discoverTokenSources(storageDir: string, options: SourceDiscoveryOptions = {}): SourceDiscoveryResult {
  const includeLegacyRoot = options.includeLegacyRoot ?? false;
  const sources: DiscoveredSource[] = [];
  const errors: string[] = [];
  const candidates: string[] = [];
  try {
    candidates.push(...readdirSync(storageDir).filter((name) =>
      name.startsWith('dsh_token_usage') && name.endsWith('.json')).sort());
  } catch (error) {
    return {
      storageDir,
      status: 'failed',
      records: [],
      sources: [],
      errors: [`${storageDir}: directory scan failed: ${String(error)}`],
      aggregateChecks: { expectedTotal: null, expectedRecordCount: null, discoveredTotal: 0, discoveredRecordCount: 0 },
    };
  }

  const rawRecords: UsageRecord[] = [];
  let expectedTotal: number | null = null;
  let expectedRecordCount: number | null = null;

  for (const name of candidates) {
    const path = join(storageDir, name);
    const loaded = readJson(path);
    const sha256 = hashOf(loaded.bytes);
    if (loaded.error || loaded.value === undefined) {
      errors.push(`${path}: ${loaded.error ?? 'unreadable'}`);
      continue;
    }
    const tables = loaded.value.tables;
    const recordsTable = isObject(tables) && isObject(tables.records) ? tables.records : undefined;
    const ledgerRoot = isObject(tables) && isObject(tables.ledger) && isObject(tables.ledger.root)
      ? tables.ledger.root : undefined;
    const metaRoot = isObject(tables) && isObject(tables.meta) && isObject(tables.meta.root)
      ? tables.meta.root : undefined;
    const date = localDateFromName(name);

    if (recordsTable !== undefined) {
      const parsed = parseRecordTable(recordsTable, path, date);
      rawRecords.push(...parsed.records);
      errors.push(...parsed.errors);
      sources.push({ path, format: 'record-table', sha256, recordCount: parsed.records.length, totalTokens: sumRecords(parsed.records), imported: true });
      continue;
    }
    if (ledgerRoot !== undefined) {
      const parsed = parseLegacyRoot(ledgerRoot, path);
      if (includeLegacyRoot) rawRecords.push(...parsed.records);
      errors.push(...parsed.errors);
      sources.push({ path, format: 'legacy-root', sha256, recordCount: parsed.records.length, totalTokens: sumRecords(parsed.records), imported: includeLegacyRoot });
      continue;
    }
    const aggregate = metaRoot && isObject(metaRoot.aggregate) ? metaRoot.aggregate : undefined;
    const global = aggregate && isObject(aggregate.global) ? aggregate.global : undefined;
    if (aggregate !== undefined && global !== undefined) {
      const total = aggregateTotal(global);
      const count = finiteNumber(global.recordCount) ?? finiteNumber(global.calls) ?? null;
      if (total !== null) expectedTotal = total;
      if (count !== null) expectedRecordCount = count;
      sources.push({ path, format: 'aggregate-summary', sha256, recordCount: count ?? 0, totalTokens: total ?? 0, imported: false });
      continue;
    }
    // A plugin-owned JSON file with no recognized table is not silently treated
    // as a ledger. It is reported so a future schema can be added explicitly.
    errors.push(`${path}: no recognized token-record table`);
  }

  const records = bestRecords(rawRecords, errors);
  const discoveredTotal = sumRecords(records);
  if (expectedTotal !== null && expectedTotal !== discoveredTotal) {
    errors.push(`aggregate total mismatch: expected=${expectedTotal} discovered=${discoveredTotal}`);
  }
  if (expectedRecordCount !== null && expectedRecordCount !== records.length) {
    errors.push(`aggregate record-count mismatch: expected=${expectedRecordCount} discovered=${records.length}`);
  }

  let status: SourceDiscoveryResult['status'];
  if (candidates.length === 0) status = 'none';
  else if (sources.length === 0) status = 'failed';
  else if (errors.length > 0) status = 'partial';
  else status = 'complete';
  return {
    storageDir,
    status,
    records,
    sources,
    errors,
    aggregateChecks: { expectedTotal, expectedRecordCount, discoveredTotal, discoveredRecordCount: records.length },
  };
}
