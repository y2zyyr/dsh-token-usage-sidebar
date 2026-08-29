import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLUGIN_REPOSITORY_URL, PLUGIN_VERSION, formatTokens } from './index.tsx';
import type { ProviderScope, UsageFacets, UsageFilters } from '../usage/providerAliases.ts';

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
function providerScopeLabel(scope: ProviderScope | null): string {
  if (!scope) return '';
  return scope.type === 'raw' ? scope.value : scope.id;
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
  const rawProviders = facets.providers.filter((option) => option.type === 'raw');
  const modelOptions = useMemo(() => {
    const pairs = facets.pairs ?? [];
    if (!provider) return facets.models;
    const rawValues = provider.type === 'raw' ? [provider.value] : [];
    return [...new Set(pairs.filter((pair) => rawValues.includes(pair.provider)).map((pair) => pair.model))].sort((a, b) => a.localeCompare(b));
  }, [facets, provider]);
  const active = provider !== null || (filters.model ?? null) !== null;
  return <>
    <div className="dtsu-filter-bar" aria-label={t('filterHelp')}>
      <label className="dtsu-filter-field"><span>{t('providerFilter')}</span><select value={selectedProvider} onChange={(event) => setFilters({ provider: providerScopeOf(event.target.value), model: null })}>
        <option value="">{t('allProviders')}</option>
        {rawProviders.map((option) => <option key={'raw:' + option.value} value={JSON.stringify({ type: 'raw', value: option.value })}>{option.label}</option>)}
      </select></label>
      <label className="dtsu-filter-field"><span>{t('modelFilter')}</span><select value={filters.model ?? ''} onChange={(event) => setFilters({ provider, model: event.target.value || null })}>
        <option value="">{t('allModels')}</option>
        {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>
      <button className="dtsu-clear-filter" type="button" disabled={!active} onClick={() => setFilters(EMPTY_FILTERS)}>{t('clearFilters')}</button>
    </div>
    {active && <p className="dtsu-filter-scope">{t('currentScope')}: {providerScopeLabel(provider)}{provider && filters.model ? ' · ' : ''}{filters.model ?? ''}</p>}
  </>;
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
  const [details, setDetails] = useState<Details>();
  const [sevenDay, setSevenDay] = useState<Details>();
  const [filters, setFilters] = useState<UsageFilters>(EMPTY_FILTERS);
  const [error, setError] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string>();
  const [expandedDay, setExpandedDay] = useState<string>();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(SETTINGS_STYLE_ID)) return;
    const tag = document.createElement('style');
    tag.id = SETTINGS_STYLE_ID;
    tag.textContent = `.dtsu-filter-bar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:end;margin:0 0 8px}.dtsu-filter-field{display:flex;flex-direction:column;gap:5px;min-width:0}.dtsu-filter-field>span,.dtsu-alias-editor label>span{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-filter-field select,.dtsu-alias-editor input,.dtsu-alias-editor textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#eee);font:inherit;padding:7px 8px}.dtsu-filter-field select{min-width:0}.dtsu-clear-filter,.dtsu-secondary-button,.dtsu-primary-button,.dtsu-danger-button{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#eee);font:inherit;padding:7px 10px;cursor:pointer;white-space:nowrap}.dtsu-clear-filter:disabled,.dtsu-secondary-button:disabled,.dtsu-primary-button:disabled,.dtsu-danger-button:disabled{opacity:.45;cursor:default}.dtsu-primary-button{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.22))}.dtsu-danger-button{color:#ff9b9b}.dtsu-filter-scope{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dtsu-alias-manager{margin:0 0 14px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:9px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.04))}.dtsu-alias-manager-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dtsu-alias-manager-head h3{margin:0}.dtsu-alias-manager-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-alias-panel{display:flex;flex-direction:column;gap:10px;margin-top:12px}.dtsu-alias-list{display:flex;flex-direction:column;gap:6px}.dtsu-alias-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border-radius:7px;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.08))}.dtsu-alias-row>div:first-child{min-width:0}.dtsu-alias-row strong,.dtsu-alias-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dtsu-alias-row small{margin-top:3px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-alias-actions,.dtsu-form-actions{display:flex;gap:6px;flex-wrap:wrap}.dtsu-alias-editor{display:flex;flex-direction:column;gap:8px;padding-top:4px}.dtsu-alias-editor label{display:flex;flex-direction:column;gap:5px}.dtsu-alias-editor textarea{resize:vertical}.dtsu-muted{margin:0;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-error{margin:0;color:#ff9b9b;font-size:12px}.dtsu-compact-table{min-width:0}.dtsu-compact-table th,.dtsu-compact-table td{padding:8px 9px}.dtsu-compact-table th:nth-child(1){width:24%}.dtsu-compact-table th:nth-child(2){width:31%}.dtsu-compact-table td:nth-child(1),.dtsu-compact-table td:nth-child(2){max-width:0;overflow:hidden;text-overflow:ellipsis}.dtsu-name-button,.dtsu-model-button,.dtsu-expand-button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}.dtsu-name-button:hover,.dtsu-model-button:hover{text-decoration:underline}.dtsu-expand-button{color:var(--dsw-alias-label-secondary,#aaa);font-size:16px;line-height:1}.dtsu-action-cell{text-align:center!important;width:34px}.dtsu-expanded-row td{padding:0 10px 10px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.04))}.dtsu-expanded-content{display:flex;flex-direction:column;gap:9px;padding-top:8px}.dtsu-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 16px}.dtsu-detail-line{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-detail-line strong{color:var(--dsw-alias-label-primary,#eee);font-weight:500;font-variant-numeric:tabular-nums}.dtsu-raw-breakdown{display:flex;flex-direction:column;gap:5px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14))}.dtsu-raw-breakdown>strong{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-daily-compact{min-width:0}.dtsu-daily-compact th:first-child{width:35%}.dtsu-daily-compact .dtsu-expanded-row td{padding-top:8px}.dtsu-daily-compact .dtsu-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:760px){.dtsu-filter-bar{grid-template-columns:1fr}.dtsu-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dtsu-alias-manager-head,.dtsu-alias-row{align-items:flex-start;flex-direction:column}.dtsu-alias-actions{width:100%}}`;
    // Keep the settings surface compact in DSH's narrow modal. Four columns
    // fit the short metric labels comfortably; only very narrow windows fall
    // back to two columns.
    tag.textContent += `.dtsu-filter-bar{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:6px}.dtsu-filter-field{gap:3px}.dtsu-filter-field select,.dtsu-clear-filter{height:30px;box-sizing:border-box}.dtsu-filter-field select{padding:6px 7px}.dtsu-clear-filter{align-self:end;margin:0;padding:6px 8px}.dtsu-metrics-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:10px;margin-bottom:14px}.dtsu-metric{min-height:0;padding:8px 9px;gap:3px;border-radius:8px}.dtsu-metric span,.dtsu-metric small{font-size:11px}.dtsu-metric strong{font-size:16px;line-height:1.2}.dtsu-about{margin-top:24px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-about-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:5px}.dtsu-about-head h3{color:var(--dsw-alias-label-primary,#eee);font-size:13px}.dtsu-about-version,.dtsu-about p,.dtsu-about a{font-size:11px}.dtsu-about-version{color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}.dtsu-about p{margin:3px 0;line-height:1.45}.dtsu-about a{color:var(--dsw-alias-label-secondary,#bbb);text-decoration:none}.dtsu-about a:hover{text-decoration:underline}@media(max-width:430px){.dtsu-metrics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:360px){.dtsu-filter-bar{grid-template-columns:1fr}.dtsu-clear-filter{width:100%}}`;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  const refresh = useCallback(async (selected: DetailRange, selectedFilters: UsageFilters) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const work: [Promise<Details | undefined>, Promise<Details | undefined> | undefined] = [
      fetchDetails(selected, selectedFilters, controller.signal), selected === '7d' ? undefined : fetchDetails('7d', selectedFilters, controller.signal),
    ];
    const [nextDetails, nextSeven] = await Promise.all([work[0], work[1] ?? Promise.resolve(undefined)]);
    if (controller.signal.aborted) return;
    if (nextDetails) setDetails(nextDetails);
    if (nextSeven) setSevenDay(nextSeven);
    else if (selected === '7d' && nextDetails) setSevenDay(nextDetails);
    setError(!nextDetails);
  }, []);

  useEffect(() => {
    void refresh(range, filters);
    timer.current = setInterval(() => { if (!document.hidden) void refresh(range, filters); }, 30_000);
    return () => { if (timer.current) clearInterval(timer.current); request.current?.abort(); };
  }, [range, filters, refresh]);

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
      <div><h2>{t('title')}</h2></div>
      {rangeLabel && <span className="dtsu-range-date">{rangeLabel}</span>}
    </div>

    <div className="dtsu-section-head"><h3>{t('details')}</h3><div className="dtsu-range-switch" role="tablist" aria-label={t('details')}>
      {(['today', 'yesterday', '7d', 'all'] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? 'is-active' : ''} onClick={() => setRange(key)}>{t(key)}</button>)}
    </div></div>

    {!details && <p className="dtsu-loading">{error ? t('unavailable') : t('loading')}</p>}
    {details && <>
      <ScopeFilters details={details} filters={filters} setFilters={setFilterState} t={t} />
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

      <div className="dtsu-about" aria-label={t('aboutPlugin')}>
        <div className="dtsu-about-head"><h3>{t('aboutPlugin')}</h3><span className="dtsu-about-version">{t('version')} v{PLUGIN_VERSION}</span></div>
        <p>{t('aboutDescription')}</p>
        <p>{t('aboutChanges')}</p>
        <a href={PLUGIN_REPOSITORY_URL} target="_blank" rel="noreferrer">{t('viewOnGithub')}</a>
      </div>
    </>}
  </section>;
}
