import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Summary } from './index.tsx';
import { fetchSummary, formatTokens } from './index.tsx';
import type { ProviderAliasGroup, ProviderOption, ProviderScope, UsageFacets, UsageFilters } from '../usage/providerAliases.ts';

export type DetailRange = 'today' | 'yesterday' | '7d' | 'all';

interface Metrics {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  callCount: number;
}
interface Daily extends Metrics { date: string; unknownTokens: number; }
interface ProviderBreakdown extends Metrics { provider: string; }
interface Model extends Metrics {
  provider: string;
  model: string;
  providerScope?: ProviderScope;
  rawProviders?: ProviderBreakdown[];
}
export interface Details {
  range: DetailRange;
  rangeStartDate?: string;
  rangeEndDate?: string;
  totalTokens: number;
  categories: Metrics;
  unknownTokens: number;
  unknownCallCount: number;
  daily: Daily[];
  models: Model[];
  filters?: UsageFilters;
  facets?: UsageFacets;
  excludedUnclassified?: { tokens: number; calls: number };
}

type Translate = (key: string) => string;

const EMPTY_FILTERS: UsageFilters = { provider: null, model: null };
const EMPTY_FACETS: UsageFacets = { providers: [], models: [], pairs: [], groups: [] };
const EMPTY_METRICS: Metrics = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 };
const ALIAS_URL = '/token-usage/api/aliases';

function normalizeDetails(value: Details): Details {
  return {
    ...value,
    filters: value.filters ?? EMPTY_FILTERS,
    facets: value.facets ?? EMPTY_FACETS,
    excludedUnclassified: value.excludedUnclassified ?? { tokens: 0, calls: 0 },
  };
}

export async function fetchDetails(range: DetailRange, signal?: AbortSignal): Promise<Details | undefined>;
export async function fetchDetails(range: DetailRange, filters?: UsageFilters, signal?: AbortSignal): Promise<Details | undefined>;
export async function fetchDetails(range: DetailRange, filtersOrSignal?: UsageFilters | AbortSignal, signal?: AbortSignal): Promise<Details | undefined> {
  const isSignal = filtersOrSignal !== undefined && typeof filtersOrSignal === 'object' && 'aborted' in filtersOrSignal;
  const filters = isSignal ? EMPTY_FILTERS : (filtersOrSignal ?? EMPTY_FILTERS) as UsageFilters;
  const requestSignal = isSignal ? filtersOrSignal as AbortSignal : signal;
  try {
    const res = await fetch('/token-usage/api/details', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range, filters: { provider: filters.provider ?? null, model: filters.model ?? null } }),
      signal: requestSignal, cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const json = await res.json() as { ok?: boolean; value?: Details };
    return json.ok === true && json.value ? normalizeDetails(json.value) : undefined;
  } catch { return undefined; }
}

interface AliasResponse { ok?: boolean; value?: { groups?: ProviderAliasGroup[] }; error?: { message?: string }; }

async function aliasRequest(body: unknown, signal?: AbortSignal): Promise<ProviderAliasGroup[]> {
  const res = await fetch(ALIAS_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal, cache: 'no-store',
  });
  const json = await res.json().catch(() => ({})) as AliasResponse;
  if (!res.ok || json.ok !== true || !Array.isArray(json.value?.groups)) {
    throw new Error(json.error?.message ?? 'provider-alias-request-failed');
  }
  return json.value.groups;
}

export function fetchProviderAliases(signal?: AbortSignal): Promise<ProviderAliasGroup[]> {
  return aliasRequest({ action: 'list' }, signal);
}

export function saveProviderAliasGroup(group: { id?: string; label: string; rawValues: string[] }, signal?: AbortSignal): Promise<ProviderAliasGroup[]> {
  return aliasRequest({ action: 'upsert', group }, signal);
}

export function removeProviderAliasGroup(id: string, signal?: AbortSignal): Promise<ProviderAliasGroup[]> {
  return aliasRequest({ action: 'delete', id }, signal);
}

function fullTokens(n: number): string { return Math.round(n).toLocaleString('en-US'); }
function calls(n: number): string { return Math.round(n).toLocaleString('en-US'); }
function replace(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll('{' + key + '}', value), template);
}
function providerScopeKey(scope: ProviderScope | null | undefined): string { return scope ? JSON.stringify(scope) : ''; }
function providerScopeOf(value: string): ProviderScope | null {
  if (value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ProviderScope>;
    if (parsed.type === 'raw' && typeof parsed.value === 'string') return { type: 'raw', value: parsed.value };
    if (parsed.type === 'group' && typeof parsed.id === 'string') return { type: 'group', id: parsed.id };
  } catch { /* ignore malformed select values */ }
  return null;
}
function providerOptionLabel(option: ProviderOption, t: Translate): string {
  return option.type === 'group'
    ? option.label + ' · ' + replace(t('includesRawNames'), { count: String(option.rawValues.length) })
    : option.label;
}
function providerScopeLabel(scope: ProviderScope | null, facets: UsageFacets, t: Translate): string {
  if (!scope) return '';
  const option = facets.providers.find((candidate) => candidate.type === scope.type && candidate.value === (scope.type === 'raw' ? scope.value : scope.id));
  if (!option) return scope.type === 'raw' ? scope.value : scope.id;
  return providerOptionLabel(option, t);
}

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }): JSX.Element {
  return <div className="dtsu-metric"><span>{label}</span><strong title={fullTokens(value) + ' tokens'}>{formatTokens(value)}</strong>{hint && <small>{hint}</small>}</div>;
}

function MetricLine({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="dtsu-detail-line"><span>{label}</span><strong>{value}</strong></div>;
}

function ScopeFilters({ details, filters, setFilters, t }: { details: Details; filters: UsageFilters; setFilters: (next: UsageFilters) => void; t: Translate }): JSX.Element {
  const facets = details.facets ?? EMPTY_FACETS;
  const provider = filters.provider ?? null;
  const selectedProvider = providerScopeKey(provider);
  const modelOptions = useMemo(() => {
    const pairs = facets.pairs ?? [];
    if (!provider) return facets.models;
    const selected = facets.providers.find((option) => option.type === provider.type && option.value === (provider.type === 'raw' ? provider.value : provider.id));
    const rawValues = selected?.rawValues ?? (provider.type === 'raw' ? [provider.value] : []);
    return [...new Set(pairs.filter((pair) => rawValues.includes(pair.provider)).map((pair) => pair.model))].sort((a, b) => a.localeCompare(b));
  }, [facets, provider]);
  const active = provider !== null || (filters.model ?? null) !== null;
  return <>
    <div className="dtsu-filter-bar" aria-label={t('filterHelp')}>
      <label className="dtsu-filter-field"><span>{t('providerFilter')}</span><select value={selectedProvider} onChange={(event) => setFilters({ provider: providerScopeOf(event.target.value), model: null })}>
        <option value="">{t('allProviders')}</option>
        {facets.providers.some((option) => option.type === 'group') && <optgroup label={t('providerGroups')}>
          {facets.providers.filter((option) => option.type === 'group').map((option) => <option key={'group:' + option.value} value={JSON.stringify({ type: 'group', id: option.value })}>{providerOptionLabel(option, t)}</option>)}
        </optgroup>}
        {facets.providers.some((option) => option.type === 'raw') && <optgroup label={t('rawProviders')}>
          {facets.providers.filter((option) => option.type === 'raw').map((option) => <option key={'raw:' + option.value} value={JSON.stringify({ type: 'raw', value: option.value })}>{providerOptionLabel(option, t)}</option>)}
        </optgroup>}
      </select></label>
      <label className="dtsu-filter-field"><span>{t('modelFilter')}</span><select value={filters.model ?? ''} onChange={(event) => setFilters({ provider, model: event.target.value || null })}>
        <option value="">{t('allModels')}</option>
        {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>
      <button className="dtsu-clear-filter" type="button" disabled={!active} onClick={() => setFilters(EMPTY_FILTERS)}>{t('clearFilters')}</button>
    </div>
    {active && <p className="dtsu-filter-scope">{t('currentScope')}: {providerScopeLabel(provider, facets, t)}{provider && filters.model ? ' · ' : ''}{filters.model ?? ''}</p>}
  </>;
}

function AliasManager({ groups, setGroups, onChanged, t }: { groups: ProviderAliasGroup[]; setGroups: (groups: ProviderAliasGroup[]) => void; onChanged: (deletedId?: string) => void; t: Translate }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [rawValues, setRawValues] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reset = () => { setEditingId(undefined); setLabel(''); setRawValues(''); setError(undefined); setEditorOpen(false); };
  const edit = (group: ProviderAliasGroup) => { setEditingId(group.id); setLabel(group.label); setRawValues(group.rawValues.join('\n')); setError(undefined); setEditorOpen(true); setOpen(true); };
  const submit = async () => {
    const values: string[] = Array.from(new Set<string>(rawValues.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0)));
    setBusy(true); setError(undefined);
    try {
      const next = await saveProviderAliasGroup({ id: editingId, label, rawValues: values });
      setGroups(next); reset(); onChanged();
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)); }
    finally { setBusy(false); }
  };
  const remove = async (group: ProviderAliasGroup) => {
    if (!window.confirm(t('confirmDeleteAlias').replace('{label}', group.label))) return;
    setBusy(true); setError(undefined);
    try { setGroups(await removeProviderAliasGroup(group.id)); reset(); onChanged(group.id); }
    catch (cause) { setError(String((cause as Error)?.message ?? cause)); }
    finally { setBusy(false); }
  };

  return <div className="dtsu-alias-manager">
    <div className="dtsu-alias-manager-head"><div><h3>{t('providerAliases')}</h3><p>{t('filterHelp')}</p></div><button type="button" className="dtsu-secondary-button" onClick={() => { setOpen(!open); if (open) reset(); }}>{open ? t('hideAliases') : t('manageAliases')}</button></div>
    {open && <div className="dtsu-alias-panel">
      <div className="dtsu-alias-list">
        {groups.length === 0 && <p className="dtsu-muted">{t('noAliasGroups')}</p>}
        {groups.map((group) => <div className="dtsu-alias-row" key={group.id}><div><strong>{group.label}</strong><small>{group.rawValues.join(' · ')}</small></div><div className="dtsu-alias-actions"><button type="button" className="dtsu-secondary-button" disabled={busy} onClick={() => edit(group)}>{t('editAlias')}</button><button type="button" className="dtsu-danger-button" disabled={busy} onClick={() => void remove(group)}>{t('deleteAlias')}</button></div></div>)}
      </div>
      <button type="button" className="dtsu-secondary-button" disabled={busy} onClick={() => { reset(); setEditorOpen(true); setOpen(true); }}>{t('addAlias')}</button>
      {editorOpen && <div className="dtsu-alias-editor">
        <label><span>{t('aliasLabel')}</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} /></label>
        <label><span>{t('aliasValues')}</span><textarea value={rawValues} onChange={(event) => setRawValues(event.target.value)} rows={4} placeholder="provider-a\nprovider-b\nprovider-proxy" /></label>
        <small className="dtsu-muted">{t('aliasValuesHint')}</small>
        {error && <p className="dtsu-error">{error}</p>}
        <div className="dtsu-form-actions"><button type="button" className="dtsu-primary-button" disabled={busy} onClick={() => void submit()}>{t('save')}</button><button type="button" className="dtsu-secondary-button" disabled={busy} onClick={reset}>{t('cancel')}</button></div>
      </div>}
    </div>}
  </div>;
}

function DetailMetrics({ model, t }: { model: Model; t: Translate }): JSX.Element {
  return <div className="dtsu-expanded-content">
    <div className="dtsu-detail-grid">
      <MetricLine label={t('input')} value={formatTokens(model.inputTokens)} />
      <MetricLine label={t('output')} value={formatTokens(model.outputTokens)} />
      <MetricLine label={t('cacheRead')} value={formatTokens(model.cacheReadTokens)} />
      <MetricLine label={t('cacheWrite')} value={formatTokens(model.cacheWriteTokens)} />
      <MetricLine label={t('reasoning')} value={formatTokens(model.reasoningTokens)} />
      <MetricLine label={t('calls')} value={calls(model.callCount)} />
    </div>
    {model.rawProviders && model.rawProviders.length > 0 && <div className="dtsu-raw-breakdown"><strong>{t('rawBreakdown')}</strong>{model.rawProviders.map((raw) => <MetricLine key={raw.provider} label={raw.provider} value={formatTokens(raw.totalTokens) + ' · ' + calls(raw.callCount)} />)}</div>}
  </div>;
}

const SETTINGS_STYLE_ID = 'dsh-token-usage-sidebar/settings.css';

export function TokenUsageSettings({ t }: { t: Translate }): JSX.Element {
  const [range, setRange] = useState<DetailRange>('7d');
  const [summary, setSummary] = useState<Summary>();
  const [details, setDetails] = useState<Details>();
  const [sevenDay, setSevenDay] = useState<Details>();
  const [groups, setGroups] = useState<ProviderAliasGroup[]>([]);
  const [filters, setFilters] = useState<UsageFilters>(EMPTY_FILTERS);
  const [error, setError] = useState(false);
  const [aliasVersion, setAliasVersion] = useState(0);
  const [expandedModel, setExpandedModel] = useState<string>();
  const [expandedDay, setExpandedDay] = useState<string>();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(SETTINGS_STYLE_ID)) return;
    const tag = document.createElement('style');
    tag.id = SETTINGS_STYLE_ID;
    tag.textContent = `.dtsu-filter-bar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:end;margin:0 0 8px}.dtsu-filter-field{display:flex;flex-direction:column;gap:5px;min-width:0}.dtsu-filter-field>span,.dtsu-alias-editor label>span{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-filter-field select,.dtsu-alias-editor input,.dtsu-alias-editor textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#eee);font:inherit;padding:7px 8px}.dtsu-filter-field select{min-width:0}.dtsu-clear-filter,.dtsu-secondary-button,.dtsu-primary-button,.dtsu-danger-button{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#eee);font:inherit;padding:7px 10px;cursor:pointer;white-space:nowrap}.dtsu-clear-filter:disabled,.dtsu-secondary-button:disabled,.dtsu-primary-button:disabled,.dtsu-danger-button:disabled{opacity:.45;cursor:default}.dtsu-primary-button{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.22))}.dtsu-danger-button{color:#ff9b9b}.dtsu-filter-scope{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dtsu-alias-manager{margin:0 0 14px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:9px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.04))}.dtsu-alias-manager-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dtsu-alias-manager-head h3{margin:0}.dtsu-alias-manager-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-alias-panel{display:flex;flex-direction:column;gap:10px;margin-top:12px}.dtsu-alias-list{display:flex;flex-direction:column;gap:6px}.dtsu-alias-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border-radius:7px;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.08))}.dtsu-alias-row>div:first-child{min-width:0}.dtsu-alias-row strong,.dtsu-alias-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dtsu-alias-row small{margin-top:3px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-alias-actions,.dtsu-form-actions{display:flex;gap:6px;flex-wrap:wrap}.dtsu-alias-editor{display:flex;flex-direction:column;gap:8px;padding-top:4px}.dtsu-alias-editor label{display:flex;flex-direction:column;gap:5px}.dtsu-alias-editor textarea{resize:vertical}.dtsu-muted{margin:0;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-error{margin:0;color:#ff9b9b;font-size:12px}.dtsu-compact-table{min-width:0}.dtsu-compact-table th,.dtsu-compact-table td{padding:8px 9px}.dtsu-compact-table th:nth-child(1){width:24%}.dtsu-compact-table th:nth-child(2){width:31%}.dtsu-compact-table td:nth-child(1),.dtsu-compact-table td:nth-child(2){max-width:0;overflow:hidden;text-overflow:ellipsis}.dtsu-name-button,.dtsu-model-button,.dtsu-expand-button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}.dtsu-name-button:hover,.dtsu-model-button:hover{text-decoration:underline}.dtsu-expand-button{color:var(--dsw-alias-label-secondary,#aaa);font-size:16px;line-height:1}.dtsu-action-cell{text-align:center!important;width:34px}.dtsu-expanded-row td{padding:0 10px 10px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.04))}.dtsu-expanded-content{display:flex;flex-direction:column;gap:9px;padding-top:8px}.dtsu-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 16px}.dtsu-detail-line{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-detail-line strong{color:var(--dsw-alias-label-primary,#eee);font-weight:500;font-variant-numeric:tabular-nums}.dtsu-raw-breakdown{display:flex;flex-direction:column;gap:5px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14))}.dtsu-raw-breakdown>strong{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-daily-compact{min-width:0}.dtsu-daily-compact th:first-child{width:35%}.dtsu-daily-compact .dtsu-expanded-row td{padding-top:8px}.dtsu-daily-compact .dtsu-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:760px){.dtsu-filter-bar{grid-template-columns:1fr}.dtsu-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dtsu-alias-manager-head,.dtsu-alias-row{align-items:flex-start;flex-direction:column}.dtsu-alias-actions{width:100%}}`;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchProviderAliases().then((next) => { if (alive) setGroups(next); }).catch(() => { /* optional local config may be unavailable */ });
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async (selected: DetailRange, selectedFilters: UsageFilters) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const work: [Promise<Summary | undefined>, Promise<Details | undefined>, Promise<Details | undefined> | undefined] = [
      fetchSummary(controller.signal), fetchDetails(selected, selectedFilters, controller.signal), selected === '7d' ? undefined : fetchDetails('7d', selectedFilters, controller.signal),
    ];
    const [nextSummary, nextDetails, nextSeven] = await Promise.all([work[0], work[1], work[2] ?? Promise.resolve(undefined)]);
    if (controller.signal.aborted) return;
    if (nextSummary) setSummary(nextSummary);
    if (nextDetails) setDetails(nextDetails);
    if (nextSeven) setSevenDay(nextSeven);
    else if (selected === '7d' && nextDetails) setSevenDay(nextDetails);
    setError(!nextDetails);
  }, []);

  useEffect(() => {
    void refresh(range, filters);
    timer.current = setInterval(() => { if (!document.hidden) void refresh(range, filters); }, 30_000);
    return () => { if (timer.current) clearInterval(timer.current); request.current?.abort(); };
  }, [range, filters, aliasVersion, refresh]);

  const overviewSeven = sevenDay?.totalTokens ?? 0;
  const c = details?.categories ?? EMPTY_METRICS;
  const rangeLabel = range === '7d' && details?.rangeStartDate && details.rangeEndDate ? details.rangeStartDate + ' – ' + details.rangeEndDate : undefined;
  const activeFilter = filters.provider !== null || filters.model !== null;
  const currentModels = details?.models ?? [];
  const unknownNote = details && activeFilter && (details.excludedUnclassified?.tokens ?? 0) > 0
    ? replace(t('excludedUnknown'), { tokens: fullTokens(details.excludedUnclassified?.tokens ?? 0), calls: calls(details.excludedUnclassified?.calls ?? 0) })
    : details && !activeFilter && details.unknownTokens > 0
      ? replace(t('unknown'), { tokens: fullTokens(details.unknownTokens), calls: calls(details.unknownCallCount) })
      : undefined;

  const setFilterState = (next: UsageFilters) => { setExpandedModel(undefined); setFilters({ provider: next.provider ?? null, model: next.model ?? null }); };
  const modelKey = (model: Model) => providerScopeKey(model.providerScope) + '\u0000' + model.provider + '\u0000' + model.model;

  return <section className="dtsu-settings" data-dsh-token-usage-settings="1">
    <div className="dtsu-settings-head">
      <div><h2>{t('title')}</h2><p>{t('subtitle')}</p></div>
      {rangeLabel && <span className="dtsu-range-date">{rangeLabel}</span>}
    </div>

    <div className="dtsu-overview">
      <Metric label={t('allTime')} value={summary?.lifetimeTotal ?? 0} />
      <Metric label={t('today')} value={summary?.todayTotal ?? 0} />
      <Metric label={t('yesterday')} value={summary?.yesterdayTotal ?? 0} />
      <Metric label={t('last7Days')} value={overviewSeven} />
    </div>

    <div className="dtsu-section-head"><h3>{t('details')}</h3><div className="dtsu-range-switch" role="tablist" aria-label={t('details')}>
      {(['today', 'yesterday', '7d', 'all'] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? 'is-active' : ''} onClick={() => setRange(key)}>{t(key)}</button>)}
    </div></div>

    {!details && <p className="dtsu-loading">{error ? t('unavailable') : t('loading')}</p>}
    {details && <>
      <ScopeFilters details={details} filters={filters} setFilters={setFilterState} t={t} />
      <AliasManager groups={groups} setGroups={setGroups} onChanged={(deletedId) => {
        if (deletedId !== undefined && filters.provider?.type === 'group' && filters.provider.id === deletedId) {
          setFilterState({ provider: null, model: filters.model ?? null });
        }
        setAliasVersion((value) => value + 1);
      }} t={t} />
      <div className="dtsu-metrics-grid">
        <Metric label={t('total')} value={details.totalTokens} />
        <Metric label={t('input')} value={c.inputTokens} />
        <Metric label={t('output')} value={c.outputTokens} />
        <Metric label={t('cacheRead')} value={c.cacheReadTokens} />
        <Metric label={t('cacheWrite')} value={c.cacheWriteTokens} />
        <Metric label={t('reasoning')} value={c.reasoningTokens} hint={t('reasoningHint')} />
        <Metric label={t('calls')} value={c.callCount} />
      </div>
      {unknownNote && <p className="dtsu-note">{unknownNote}</p>}

      <h3 className="dtsu-table-title">{t('byModel')}</h3>
      <div className="dtsu-table-wrap"><table className="dtsu-table dtsu-compact-table"><thead><tr>
        <th>{t('provider')}</th><th>{t('model')}</th><th>{t('total')}</th><th>{t('calls')}</th><th aria-label={t('details')}></th>
      </tr></thead><tbody>{currentModels.length === 0 ? <tr><td colSpan={5} className="dtsu-empty-row">{t('noMatching')}</td></tr> : currentModels.map((model) => {
        const key = modelKey(model); const expanded = expandedModel === key; const scope = model.providerScope ?? { type: 'raw', value: model.provider } as ProviderScope;
        return <Fragment key={key}><tr>
          <td><button type="button" className="dtsu-name-button" title={model.provider} onClick={() => setFilterState({ provider: scope, model: null })}>{model.provider}</button></td>
          <td><button type="button" className="dtsu-model-button" title={model.model} onClick={() => setFilterState({ provider: null, model: model.model })}>{model.model}</button></td>
          <td>{formatTokens(model.totalTokens)}</td><td>{calls(model.callCount)}</td>
          <td className="dtsu-action-cell"><button type="button" className="dtsu-expand-button" aria-expanded={expanded} aria-label={expanded ? t('collapse') : t('expand')} onClick={() => setExpandedModel(expanded ? undefined : key)}>{expanded ? '−' : '+'}</button></td>
        </tr>{expanded && <tr className="dtsu-expanded-row"><td colSpan={5}><DetailMetrics model={model} t={t} /></td></tr>}</Fragment>;
      })}</tbody></table></div>

      <h3 className="dtsu-table-title">{t('sevenDayDaily')}</h3>
      <div className="dtsu-table-wrap"><table className="dtsu-table dtsu-compact-table dtsu-daily-compact"><thead><tr><th>{t('date')}</th><th>{t('total')}</th><th>{t('calls')}</th><th aria-label={t('details')}></th></tr></thead>
      <tbody>{(sevenDay?.daily ?? []).map((day) => { const expanded = expandedDay === day.date; return <Fragment key={day.date}><tr><td>{day.date}</td><td>{formatTokens(day.totalTokens + day.unknownTokens)}</td><td>{calls(day.callCount)}</td><td className="dtsu-action-cell"><button type="button" className="dtsu-expand-button" aria-expanded={expanded} aria-label={expanded ? t('collapse') : t('expand')} onClick={() => setExpandedDay(expanded ? undefined : day.date)}>{expanded ? '−' : '+'}</button></td></tr>{expanded && <tr className="dtsu-expanded-row"><td colSpan={4}><div className="dtsu-detail-grid"><MetricLine label={t('input')} value={formatTokens(day.inputTokens)} /><MetricLine label={t('output')} value={formatTokens(day.outputTokens)} /><MetricLine label={t('cacheRead')} value={formatTokens(day.cacheReadTokens)} /><MetricLine label={t('cacheWrite')} value={formatTokens(day.cacheWriteTokens)} /><MetricLine label={t('reasoning')} value={formatTokens(day.reasoningTokens)} /><MetricLine label={t('calls')} value={calls(day.callCount)} /></div></td></tr>}</Fragment>; })}</tbody></table></div>
    </>}
  </section>;
}
