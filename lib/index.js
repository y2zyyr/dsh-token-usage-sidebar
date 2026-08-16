// src/index.ts
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

// src/usage/ledger.ts
var LEDGER_SCHEMA_VERSION = 4;
function emptyLedger(now = Date.now(), todayDate = localDateOf(now)) {
  return {
    lifetimeTotal: 0,
    todayTotal: 0,
    todayDate,
    byId: {},
    recordCount: 0,
    src: {},
    liveRecordedTotal: 0,
    historicalRecoveredTotal: 0,
    historicalRecoveredRecordCount: 0
    // schemaVersion intentionally NOT pre-set: a fresh (or v0.1) ledger is
    // "not migrated" (treated as 0) so v0.2 historical recovery runs once.
  };
}
function localDateOf(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
function localDate(now) {
  return localDateOf(now);
}
function recordUsage(prev, rec) {
  const dayChanged = prev.todayDate !== rec.localDate;
  const baseToday = dayChanged ? 0 : prev.todayTotal;
  const existing = Object.prototype.hasOwnProperty.call(prev.byId, rec.id) ? prev.byId[rec.id] : void 0;
  const isNew = existing === void 0;
  const delta = rec.totalTokens - (isNew ? 0 : existing);
  const todayDelta = rec.localDate === (dayChanged ? rec.localDate : prev.todayDate) ? delta : 0;
  const src = prev.src ?? {};
  const newSource = rec.sourceType ?? "live_event";
  const priorSrc = src[rec.id];
  const srcNext = { ...src };
  if (priorSrc === void 0) srcNext[rec.id] = newSource;
  let liveRecordedTotal = prev.liveRecordedTotal ?? 0;
  let historicalRecoveredTotal = prev.historicalRecoveredTotal ?? 0;
  let historicalRecoveredRecordCount = prev.historicalRecoveredRecordCount ?? 0;
  if (isNew) {
    const attr = priorSrc ?? newSource;
    if (attr === "live_event" || attr === "other") liveRecordedTotal += rec.totalTokens;
    else {
      historicalRecoveredTotal += rec.totalTokens;
      historicalRecoveredRecordCount += 1;
    }
  }
  const dayBy = { ...prev.dayBy ?? {} };
  if (isNew || dayBy[rec.id] === void 0 || rec.seq >= (prev.seqBy?.[rec.id] ?? -1)) dayBy[rec.id] = rec.localDate;
  const seqBy = { ...prev.seqBy ?? {} };
  if (isNew || rec.seq >= (seqBy[rec.id] ?? -1)) seqBy[rec.id] = rec.seq;
  const shouldReplaceDetail = isNew || rec.seq >= (prev.seqBy?.[rec.id] ?? -1);
  const previousDetail = prev.detailBy?.[rec.id];
  const detailBy = { ...prev.detailBy ?? {} };
  if (shouldReplaceDetail) {
    detailBy[rec.id] = {
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheReadTokens: rec.cacheReadTokens,
      cacheWriteTokens: rec.cacheWriteTokens,
      reasoningTokens: rec.reasoningTokens,
      provider: rec.provider ?? previousDetail?.provider,
      model: rec.model ?? previousDetail?.model
    };
  }
  if (!isNew && delta !== 0) {
    if ((priorSrc ?? newSource) === "live_event" || (priorSrc ?? newSource) === "other") liveRecordedTotal += delta;
    else historicalRecoveredTotal += delta;
  }
  return {
    lifetimeTotal: prev.lifetimeTotal + delta,
    todayTotal: baseToday + todayDelta,
    todayDate: dayChanged ? rec.localDate : prev.todayDate,
    byId: { ...prev.byId, [rec.id]: rec.totalTokens },
    recordCount: prev.recordCount + (isNew ? 1 : 0),
    src: srcNext,
    liveRecordedTotal,
    historicalRecoveredTotal,
    historicalRecoveredRecordCount,
    schemaVersion: prev.schemaVersion ?? LEDGER_SCHEMA_VERSION,
    ...Object.keys(dayBy).length > 0 ? { dayBy } : {},
    ...Object.keys(seqBy).length > 0 ? { seqBy } : {},
    ...Object.keys(detailBy).length > 0 ? { detailBy } : {},
    ...prev.recovery ? { recovery: prev.recovery } : {}
  };
}
function aggregateOf(ledger) {
  return {
    lifetimeTotal: ledger.lifetimeTotal,
    todayTotal: ledger.todayTotal,
    todayDate: ledger.todayDate,
    recordCount: ledger.recordCount
  };
}
function totalForDay(ledger, date) {
  const dayBy = ledger.dayBy ?? {};
  let total = 0;
  for (const id of Object.keys(ledger.byId)) {
    if (dayBy[id] === date) total += ledger.byId[id];
  }
  return total;
}
function totalForOffset(ledger, offsetDays) {
  const d = /* @__PURE__ */ new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const date = y + "-" + m + "-" + dd;
  return { date, total: totalForDay(ledger, date) };
}
function synchronizeToday(ledger, now = Date.now()) {
  const todayDate = localDateOf(now);
  const todayTotal = totalForDay(ledger, todayDate);
  if (ledger.todayDate === todayDate && ledger.todayTotal === todayTotal) return ledger;
  return { ...ledger, todayDate, todayTotal };
}
function foldRecords(base, records) {
  const sorted = [...records].sort((a, b) => a.id === b.id ? a.seq - b.seq : 0);
  let acc = base;
  for (const r of sorted) acc = recordUsage(acc, r);
  return acc;
}
function hasRecord(ledger, id) {
  return Object.prototype.hasOwnProperty.call(ledger.byId, id);
}

// src/usage/historical.ts
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

// src/usage/types.ts
function totalOf(b) {
  return b.inputTokens + (b.cacheReadTokens ?? 0) + (b.cacheWriteTokens ?? 0) + b.outputTokens;
}
function currentLocalDate(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
var EMPTY_AGGREGATE = Object.freeze({
  lifetimeTotal: 0,
  todayTotal: 0,
  todayDate: currentLocalDate(),
  recordCount: 0
});

// src/usage/collector.ts
function bucketsOf(data) {
  if (!data) return void 0;
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return void 0;
  const inputTokens = Number(usage.inputTokens);
  const outputTokens = Number(usage.outputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return void 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: Number.isFinite(Number(usage.cacheReadTokens)) ? Number(usage.cacheReadTokens) : void 0,
    cacheWriteTokens: Number.isFinite(Number(usage.cacheWriteTokens)) ? Number(usage.cacheWriteTokens) : void 0,
    reasoningTokens: Number.isFinite(Number(usage.reasoningTokens)) ? Number(usage.reasoningTokens) : void 0
  };
}
function modelSourceOf(data) {
  const source = data?.message && typeof data.message === "object" ? data.message.source : void 0;
  if (!source || typeof source !== "object") return {};
  const record = source;
  const provider = typeof record.provider === "string" && record.provider.length > 0 ? record.provider : void 0;
  const model = typeof record.model === "string" && record.model.length > 0 ? record.model : void 0;
  return { provider, model };
}
function collectSessionUsage(input) {
  const recs = [];
  const now = input.now ?? Date.now();
  const day = new Date(now);
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, "0");
  const dd = String(day.getDate()).padStart(2, "0");
  const localDate2 = y + "-" + m + "-" + dd;
  const local = (ts) => {
    const d = new Date(ts);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd2 = String(d.getDate()).padStart(2, "0");
    return yy + "-" + mm + "-" + dd2;
  };
  for (const event of input.events) {
    let usage;
    let turn = 0;
    let step = 0;
    let source;
    let provider = input.provider;
    let model = input.model;
    let ts = now;
    const eventTime = Number(event.time) || 0;
    if (event.type === "assistant/message") {
      const data = event.data ?? {};
      usage = bucketsOf(data);
      if (usage === void 0) continue;
      turn = Number(data.turn ?? 0);
      step = Number(data.step ?? 0);
      source = "assistant/message";
      const messageSource = modelSourceOf(data);
      provider = messageSource.provider ?? provider;
      model = messageSource.model ?? model;
      ts = Number(data.timestamp) || Number(data.createdAt) || eventTime || now;
    } else if (event.type === "assistant/chunk") {
      const data = event.data ?? {};
      const chunk = data.chunk;
      if (!chunk || chunk.type !== "usage" || !chunk.usage) continue;
      usage = {
        inputTokens: Number(chunk.usage.inputTokens) || 0,
        outputTokens: Number(chunk.usage.outputTokens) || 0,
        cacheReadTokens: Number(chunk.usage.cacheReadTokens) || void 0,
        cacheWriteTokens: Number(chunk.usage.cacheWriteTokens) || void 0,
        reasoningTokens: Number(chunk.usage.reasoningTokens) || void 0
      };
      if (totalOf(usage) === 0) continue;
      turn = Number(data.turn ?? 0);
      step = Number(data.step ?? 0);
      source = "assistant/chunk";
      ts = Number(data.timestamp) || eventTime || now;
    } else {
      continue;
    }
    const total = totalOf(usage);
    recs.push({
      id: input.sessionId + ":" + turn + ":" + step,
      source,
      sessionId: input.sessionId,
      turn,
      step,
      seq: event.seq,
      timestamp: ts,
      localDate: local(ts),
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      totalTokens: total,
      accounting: "exact",
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      migrationVersion: input.migrationVersion
    });
  }
  const best = /* @__PURE__ */ new Map();
  for (const r of recs) {
    const prev = best.get(r.id);
    if (prev === void 0 || r.seq > prev.seq) best.set(r.id, r);
  }
  return [...best.values()].sort((a, b) => a.seq - b.seq);
}

// src/usage/historical.ts
var HISTORICAL_MIGRATION_VERSION = 4;
function sessionsRoot(overrideDshHome) {
  const home = overrideDshHome ?? process.env.DSH_HOME;
  const base = home && home.length > 0 ? home : join(homedir(), ".dsh");
  return join(base, "sessions");
}
function enumerateSessionLogs(sessionsDir) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) visit(p);
      else if (ent.isFile() && ent.name === "session.jsonl.zstd") out.push(p);
    }
  };
  visit(sessionsDir);
  return out.sort();
}
function fileBackedReader(sessionsDir) {
  return {
    async list() {
      return enumerateSessionLogs(sessionsDir).map((p) => ({ id: basenameOf(p), path: p }));
    },
    async readEvents(id) {
      const found = enumerateSessionLogs(sessionsDir).find((p) => p.endsWith("/" + id + "/session.jsonl.zstd") || p.includes("/" + id + "/"));
      if (!found) return null;
      try {
        const buf = (await import("node:fs")).readFileSync(found);
        const json = zstdDecompressSync(buf).toString("utf8");
        return { ...parseSessionLog(json), path: found };
      } catch {
        return null;
      }
    }
  };
}
function basenameOf(p) {
  return dirname(p).split("/").pop() ?? p;
}
function parseSessionLog(lines) {
  let sessionId = "";
  const events = [];
  for (const raw of lines.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    if (e.type === "session") sessionId = String(e.id ?? "");
    const time = Number(e.time);
    events.push({ type: String(e.type ?? ""), seq: Number(e.seq ?? 0), ...Number.isFinite(time) && time > 0 ? { time } : {}, data: e.data ?? {} });
  }
  return { sessionId, events };
}
async function runHistoricalMigration(ledger, opts) {
  const now = opts?.now ?? Date.now();
  const already = (ledger.schemaVersion ?? 0) >= HISTORICAL_MIGRATION_VERSION && ledger.recovery?.recoveryStatus !== void 0 && !opts?.force;
  if (already) {
    return { migrated: false, ledger, summary: summarize(ledger) };
  }
  let reader;
  if (opts?.reader) {
    reader = opts.reader;
  } else {
    const dir = opts?.sessionsDir ?? sessionsRoot();
    reader = fileBackedReader(dir);
  }
  let next = ledger;
  let sessions;
  try {
    sessions = await reader.list();
  } catch {
    sessions = [];
  }
  if (!Array.isArray(sessions)) sessions = [];
  let earliest;
  let latest;
  let sessionsScanned = 0;
  const diskSeen = /* @__PURE__ */ new Set();
  const newRecords = [];
  for (const s of sessions) {
    let parsed;
    try {
      parsed = await reader.readEvents(s.id);
    } catch {
      continue;
    }
    if (!parsed || !parsed.sessionId || parsed.events.length === 0) continue;
    sessionsScanned += 1;
    const recs = collectSessionUsage({
      sessionId: parsed.sessionId,
      events: parsed.events,
      now,
      sourceType: "session_log",
      sourcePath: parsed.path ?? s.path,
      migrationVersion: HISTORICAL_MIGRATION_VERSION
    });
    for (const r of recs) {
      if (!hasRecord(next, r.id)) newRecords.push({ id: r.id, token: r.totalTokens });
      if (!diskSeen.has(r.id)) diskSeen.add(r.id);
      if (r.timestamp) {
        if (earliest === void 0 || r.timestamp < earliest) earliest = r.timestamp;
        if (latest === void 0 || r.timestamp > latest) latest = r.timestamp;
      }
    }
    next = foldRecords(next, recs);
  }
  {
    const src = { ...next.src ?? {} };
    let live = next.liveRecordedTotal ?? 0;
    let changed = false;
    for (const id of Object.keys(next.byId)) {
      if (src[id] === void 0) {
        src[id] = "live_event";
        live += next.byId[id];
        changed = true;
      }
    }
    if (changed) next = { ...next, src, liveRecordedTotal: live };
  }
  const recovery = {
    trackingStartDate: ledger.recovery?.trackingStartDate,
    earliestRecoveredAt: earliest,
    latestRecoveredAt: latest,
    recoveryVersion: HISTORICAL_MIGRATION_VERSION,
    recoveryCompletedAt: now,
    recoverySources: ["durable_session_logs", "session_persistence"],
    recoveredRecordCount: next.historicalRecoveredRecordCount ?? newRecords.length,
    recoveryStatus: await (async () => {
      try {
        const rd = opts?.reader ? sessions : [];
        return sessions.length > 0 ? "complete" : "partial";
      } catch {
        return "unknown";
      }
    })()
  };
  next = { ...next, schemaVersion: HISTORICAL_MIGRATION_VERSION, recovery };
  return {
    migrated: true,
    ledger: next,
    summary: {
      migrated: true,
      sessionsScanned,
      recordsFound: newRecords.length,
      recoveredTokens: next.historicalRecoveredTotal ?? 0,
      liveTokens: next.liveRecordedTotal ?? 0,
      lifetimeTotal: next.lifetimeTotal,
      earliestRecoveredAt: earliest,
      latestRecoveredAt: latest,
      recoveryStatus: recovery.recoveryStatus
    }
  };
}
function summarize(ledger) {
  return {
    migrated: false,
    sessionsScanned: 0,
    recordsFound: 0,
    recoveredTokens: ledger.historicalRecoveredTotal ?? 0,
    liveTokens: ledger.liveRecordedTotal ?? 0,
    lifetimeTotal: ledger.lifetimeTotal,
    recoveryStatus: ledger.recovery?.recoveryStatus
  };
}

// src/usage/insights.ts
function emptyMetrics() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 };
}
function addDetail(metrics, detail) {
  metrics.inputTokens += detail.inputTokens;
  metrics.outputTokens += detail.outputTokens;
  metrics.cacheReadTokens += detail.cacheReadTokens;
  metrics.cacheWriteTokens += detail.cacheWriteTokens;
  metrics.reasoningTokens += detail.reasoningTokens;
  metrics.totalTokens += detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheWriteTokens;
  metrics.callCount += 1;
}
function datesEnding(now, days) {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const cursor = new Date(d);
    cursor.setDate(cursor.getDate() - i);
    dates.push(localDate(cursor.getTime()));
  }
  return dates;
}
function lastSevenLocalDates(now = Date.now()) {
  return datesEnding(now, 7);
}
function datesForRange(range, now) {
  if (range === "all") return void 0;
  if (range === "today") return datesEnding(now, 1);
  if (range === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setHours(12, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    return [localDate(yesterday.getTime())];
  }
  return datesEnding(now, 7);
}
function buildUsageInsights(ledger, range, now = Date.now()) {
  const selectedDates = datesForRange(range, now);
  const selected = selectedDates ? new Set(selectedDates) : void 0;
  const daily = /* @__PURE__ */ new Map();
  for (const date of lastSevenLocalDates(now)) daily.set(date, { date, ...emptyMetrics(), unknownTokens: 0 });
  const categories = emptyMetrics();
  const modelMap = /* @__PURE__ */ new Map();
  let totalTokens = 0;
  let unknownTokens = 0;
  let unknownCallCount = 0;
  const dayBy = ledger.dayBy ?? {};
  const detailBy = ledger.detailBy ?? {};
  for (const [id, authoritativeTotal] of Object.entries(ledger.byId)) {
    const date = dayBy[id];
    if (selected && (date === void 0 || !selected.has(date))) continue;
    totalTokens += authoritativeTotal;
    const detail = detailBy[id];
    const recoveredTotal = detail ? detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheWriteTokens : -1;
    const isExact = detail !== void 0 && recoveredTotal === authoritativeTotal;
    const day = date ? daily.get(date) : void 0;
    if (!isExact) {
      unknownTokens += authoritativeTotal;
      unknownCallCount += 1;
      if (day) day.unknownTokens += authoritativeTotal;
      continue;
    }
    addDetail(categories, detail);
    if (day) addDetail(day, detail);
    const provider = detail.provider ?? "Unknown provider";
    const model = detail.model ?? "Unknown model";
    const key = provider + "\0" + model;
    let modelUsage = modelMap.get(key);
    if (!modelUsage) {
      modelUsage = { provider, model, ...emptyMetrics() };
      modelMap.set(key, modelUsage);
    }
    addDetail(modelUsage, detail);
  }
  return {
    range,
    ...selectedDates ? { rangeStartDate: selectedDates[0], rangeEndDate: selectedDates[selectedDates.length - 1] } : {},
    totalTokens,
    categories,
    unknownTokens,
    unknownCallCount,
    daily: [...daily.values()],
    models: [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  };
}

// src/usage/aggregator.ts
var UsageAggregator = class {
  store;
  ledger;
  now;
  persistDebounceMs;
  sessionsDir;
  historicalReader;
  listeners = /* @__PURE__ */ new Set();
  persistTimer;
  dirty = false;
  closed = false;
  loading = true;
  constructor(opts) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.persistDebounceMs = opts.persistDebounceMs ?? 250;
    this.sessionsDir = opts.sessionsDir;
    this.historicalReader = opts.historicalReader;
    this.ledger = emptyLedger(this.now());
  }
  /** Load persisted state. Call once before first read. */
  async start() {
    const persisted = await this.store.load();
    if (persisted) this.ledger = this.normalizeDay(persisted);
    else this.ledger = emptyLedger(this.now());
    this.loading = false;
    this.notify();
  }
  /** Roll today's bucket forward when the local day changed while unloaded. */
  normalizeDay(l) {
    return synchronizeToday(l, this.now());
  }
  /**
   * Ingest authoritative usage records exactly once. Records whose id is
   * already known are ignored (returns false). Returns count of new records.
   */
  apply(records) {
    if (records.length === 0) return 0;
    let added = 0;
    let next = this.ledger;
    for (const rec of records) {
      const knownSeq = next.seqBy?.[rec.id];
      if (knownSeq !== void 0 && rec.seq <= knownSeq) continue;
      const r = rec.sourceType === void 0 ? { ...rec, sourceType: "live_event" } : rec;
      next = foldRecords(next, [r]);
      added += 1;
    }
    if (added === 0) return 0;
    this.ledger = this.normalizeDay(next);
    this.schedulePersist();
    this.notify();
    return added;
  }
  /**
   * v0.2 historical recovery migration (idempotent). Scans durable session logs
   * on disk and merges every authoritative historical record without resetting
   * or dropping existing live records; attribute sources and update metadata.
   */
  async migrateHistorical() {
    if (this.closed) return { migrated: false, summary: null };
    const res = await runHistoricalMigration(this.ledger, {
      sessionsDir: this.sessionsDir,
      reader: this.historicalReader,
      now: this.now()
    });
    if (res.migrated) {
      this.ledger = this.normalizeDay(res.ledger);
      this.schedulePersist();
      this.notify();
    }
    return { migrated: res.migrated, summary: res.summary };
  }
  /** v0.2 diagnostic view (no conversation content / credentials). */
  diagnostics() {
    const todayYmd = this.ledger.todayDate;
    const yesterday = totalForOffset(this.ledger, 1);
    return {
      todayTotal: this.ledger.todayTotal,
      todayDate: todayYmd,
      yesterdayTotal: yesterday.total,
      yesterdayDate: yesterday.date,
      lifetimeTotal: this.ledger.lifetimeTotal,
      recordCount: this.ledger.recordCount,
      detailRecordCount: Object.keys(this.ledger.detailBy ?? {}).length,
      liveRecordedTotal: this.ledger.liveRecordedTotal ?? 0,
      historicalRecoveredTotal: this.ledger.historicalRecoveredTotal ?? 0,
      historicalRecoveredRecordCount: this.ledger.historicalRecoveredRecordCount ?? 0,
      schemaVersion: this.ledger.schemaVersion ?? 0,
      earliestRecoveredAt: this.ledger.recovery?.earliestRecoveredAt ?? void 0,
      latestRecoveredAt: this.ledger.recovery?.latestRecoveredAt ?? void 0,
      recoveryVersion: this.ledger.recovery?.recoveryVersion ?? void 0,
      recoveryCompletedAt: this.ledger.recovery?.recoveryCompletedAt ?? void 0,
      recoverySources: this.ledger.recovery?.recoverySources ?? void 0,
      recoveryStatus: this.ledger.recovery?.recoveryStatus ?? void 0,
      trackingStartDate: this.ledger.recovery?.trackingStartDate
    };
  }
  /** Rebuild the ledger from a full record list (startup reconciliation). */
  replaceFrom(records) {
    const rebuilt = foldRecords(emptyLedger(this.now()), records);
    this.ledger = rebuilt;
    this.schedulePersist();
    this.notify();
  }
  get aggregate() {
    return aggregateOf(this.ledger);
  }
  /** Aggregate-only detail view for the settings page. */
  insights(range) {
    return buildUsageInsights(this.ledger, range, this.now());
  }
  /** Read-only snapshot of the underlying ledger (for per-day aggregation). */
  ledgerSnapshot() {
    return this.ledger;
  }
  get ready() {
    return !this.loading;
  }
  subscribe(l) {
    this.listeners.add(l);
    l(this.aggregate);
    return () => {
      this.listeners.delete(l);
    };
  }
  notify() {
    const agg = this.aggregate;
    for (const l of [...this.listeners]) {
      try {
        l(agg);
      } catch (e) {
        console.error("[dsh-token-usage-sidebar] listener error", e);
      }
    }
  }
  schedulePersist() {
    this.dirty = true;
    if (this.persistTimer !== void 0) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = void 0;
      void this.flush();
    }, this.persistDebounceMs);
  }
  /** Flush the debounced persistence (also callable on dispose). */
  async flush() {
    if (this.persistTimer !== void 0) {
      clearTimeout(this.persistTimer);
      this.persistTimer = void 0;
    }
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    try {
      await this.store.save(this.ledger);
    } catch (e) {
      console.error("[dsh-token-usage-sidebar] persist failed", e);
      this.dirty = true;
    }
  }
  async close() {
    this.closed = true;
    await this.flush();
    this.listeners.clear();
    if (this.store.close) await this.store.close();
  }
};

// src/index.ts
var name = "dsh-token-usage-sidebar";
var inject = ["webServer", "sessions", "storageDomain", "webRuntime", "sessionPersistence"];
var LedgerSchema = z.object({
  lifetimeTotal: z.number().int().nonnegative(),
  todayTotal: z.number().int().nonnegative(),
  todayDate: z.string(),
  byId: z.record(z.string(), z.number().int().nonnegative()),
  recordCount: z.number().int().nonnegative(),
  src: z.record(z.string(), z.enum(["live_event", "session_log", "provider_record", "legacy_store", "other"])).optional(),
  liveRecordedTotal: z.number().int().nonnegative().optional(),
  historicalRecoveredTotal: z.number().int().nonnegative().optional(),
  historicalRecoveredRecordCount: z.number().int().nonnegative().optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  // Per-record fields are optional for backwards-compatible v0.1/v0.2 reads.
  // They must be part of the domain schema, though: Zod strips unknown keys
  // before storage and an omitted declaration would lose daily accounting on
  // every restart.
  dayBy: z.record(z.string(), z.string()).optional(),
  seqBy: z.record(z.string(), z.number().int().nonnegative()).optional(),
  detailBy: z.record(z.string(), z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    provider: z.string().optional(),
    model: z.string().optional()
  })).optional(),
  recovery: z.object({
    trackingStartDate: z.string().optional(),
    earliestRecoveredAt: z.number().optional(),
    latestRecoveredAt: z.number().optional(),
    recoveryVersion: z.number().optional(),
    recoveryCompletedAt: z.number().optional(),
    recoverySources: z.array(z.string()).optional(),
    recoveredRecordCount: z.number().optional(),
    recoveryStatus: z.enum(["complete", "partial", "unknown"]).optional()
  }).optional()
});
var ledgerSpec = defineDomain({
  name: "dsh_token_usage_sidebar",
  version: 1,
  tables: {
    ledger: domainTable(LedgerSchema)
  }
});
var DomainLedgerStore = class {
  table;
  domain;
  key = "root";
  async open(facility) {
    this.domain = await facility.open(ledgerSpec);
    this.table = this.domain.table("ledger");
  }
  async load() {
    const row = this.table?.get(this.key);
    if (!row) return void 0;
    const parsed = LedgerSchema.safeParse(row);
    if (!parsed.success) return void 0;
    return parsed.data;
  }
  async save(ledger) {
    if (!this.table) throw new Error("ledger domain not open");
    await this.table.put(this.key, ledger);
  }
  async close() {
    if (this.domain) await this.domain.close?.();
  }
};
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function parseAuthority(authority) {
  try {
    return new URL("http://" + authority);
  } catch {
    return void 0;
  }
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL("https://" + entry).port;
  return port === "" ? entryUrl.hostname : entryUrl.hostname + ":" + port;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
function isTrustedApiRequest(request, trustedHosts) {
  const raw = request.headers["host"];
  const host = typeof raw === "string" ? raw : void 0;
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers["origin"];
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
function writeJson(res, status, body) {
  if (typeof res.statusCode === "number") res.statusCode = status;
  if (typeof res.setHeader === "function") res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
function insightRangeOf(body) {
  const range = body && typeof body === "object" ? body.range : void 0;
  return range === "today" || range === "yesterday" || range === "7d" || range === "all" ? range : void 0;
}
function apply(ctx) {
  const store = new DomainLedgerStore();
  const historicalReader = {
    async list() {
      try {
        const headers = await ctx.sessionPersistence.list();
        return Array.isArray(headers) ? headers.map((h) => ({ id: String(h?.id ?? "") })).filter((x) => x.id) : [];
      } catch {
        return [];
      }
    },
    async readEvents(id) {
      try {
        const out = await ctx.sessionPersistence.readFrom(id, 0);
        const meta = out?.meta ?? {};
        return { sessionId: String(meta?.id ?? id), events: out?.events ?? [], path: void 0 };
      } catch {
        return null;
      }
    }
  };
  const agg = new UsageAggregator({ store, historicalReader });
  ctx.effect(async () => {
    try {
      await store.open(ctx.storageDomain);
      await agg.start();
      const mig = await agg.migrateHistorical();
      if (mig.migrated) {
        console.log("[dsh-token-usage-sidebar] v0.2 historical recovery ran:", JSON.stringify(mig.summary));
      } else {
        console.log("[dsh-token-usage-sidebar] historical recovery already complete (schemaVersion=" + agg.diagnostics().schemaVersion + "), skipping re-scan");
      }
      let sessions = [];
      try {
        sessions = ctx.sessions.list ? [...ctx.sessions.list()] : [];
      } catch {
        sessions = [];
      }
      for (const s of sessions) {
        const events = s.events ?? [];
        if (events.length === 0) continue;
        agg.apply(collectSessionUsage({ sessionId: String(s.id), events }));
      }
      ctx.on("session/event", (session, event) => {
        const recs = collectSessionUsage({ sessionId: String(session?.id ?? ""), events: [event] });
        if (recs.length > 0) agg.apply(recs);
      });
      const trustedHosts = () => {
        const rt = ctx.webRuntime?.trustedHosts;
        return Array.isArray(rt) ? rt : [];
      };
      const fence = (req) => {
        try {
          return isTrustedApiRequest(req, trustedHosts());
        } catch {
          return false;
        }
      };
      const dispose = ctx.webServer.register({
        kind: "prefix",
        path: "/token-usage/api",
        handler: async (req, res) => {
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
            return;
          }
          if (req.method !== "POST") {
            writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
            return;
          }
          const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
          const method = pathname.startsWith("/token-usage/api/") ? pathname.slice("/token-usage/api/".length) : void 0;
          if (!method || method.includes("/")) {
            writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method" } });
            return;
          }
          try {
            const body = await readJsonBody(req);
            if (method === "summary") {
              const a = agg.aggregate;
              const yesterday = totalForOffset(agg.ledgerSnapshot(), 1);
              writeJson(res, 200, {
                ok: true,
                value: {
                  todayTotal: a.todayTotal,
                  todayDate: a.todayDate,
                  yesterdayTotal: yesterday.total,
                  yesterdayDate: yesterday.date,
                  lifetimeTotal: a.lifetimeTotal,
                  recordCount: a.recordCount,
                  serverNow: currentLocalDate()
                }
              });
            } else if (method === "details") {
              const range = insightRangeOf(body);
              if (!range) {
                writeJson(res, 400, { ok: false, error: { code: "validation-error", message: "range must be today, yesterday, 7d, or all" } });
                return;
              }
              writeJson(res, 200, { ok: true, value: agg.insights(range) });
            } else if (method === "debug") {
              writeJson(res, 200, { ok: true, value: agg.diagnostics() });
            } else {
              writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method " + method } });
            }
          } catch (e) {
            writeJson(res, 500, { ok: false, error: { code: "internal", message: String(e?.message ?? e) } });
          }
        }
      });
      return () => {
        try {
          dispose?.();
        } catch {
        }
        void agg.close();
      };
    } catch (e) {
      try {
        ctx.logger?.warn?.("[dsh-token-usage-sidebar] init failed", e);
      } catch {
      }
      console.error("[dsh-token-usage-sidebar] init failed", e);
      return () => {
        void agg.close();
      };
    }
  }, "dsh-token-usage-sidebar: host");
}
export {
  apply,
  inject,
  name
};
