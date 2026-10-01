import type { UsageRecord } from './types.ts';

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00');
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(value.slice(0, 4))
    && date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
}

/** Reject a whole batch before any write. Legacy unknown totals remain valid. */
export function assertUsageRecord(record: UsageRecord): void {
  if (!record.id || !record.sessionId) throw new Error('invalid-usage-record: identity');
  for (const field of ['turn', 'step', 'seq', 'timestamp', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) {
    if (!isTokenCount(record[field])) throw new Error('invalid-usage-record: ' + field);
  }
  if (!isTokenCount(record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens)) {
    throw new Error('invalid-usage-record: bucket sum');
  }
  if (!isLocalDate(record.localDate) && record.localDate !== '' && record.localDate !== 'unclassified') {
    throw new Error('invalid-usage-record: localDate');
  }
  if (record.accountingVersion !== undefined && (!isTokenCount(record.accountingVersion) || record.accountingVersion < 1)) {
    throw new Error('invalid-usage-record: accountingVersion');
  }
}
