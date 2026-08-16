import { useCallback, useEffect, useRef, useState } from 'react';
import type { Summary } from './index.tsx';
import { fetchSummary, formatTokens } from './index.tsx';

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
interface Model extends Metrics { provider: string; model: string; }
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
}

type Translate = (key: string) => string;

export async function fetchDetails(range: DetailRange, signal?: AbortSignal): Promise<Details | undefined> {
  try {
    const res = await fetch('/token-usage/api/details', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range }), signal, cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const json = await res.json() as { ok?: boolean; value?: Details };
    return json.ok === true && json.value ? json.value : undefined;
  } catch { return undefined; }
}

function fullTokens(n: number): string { return Math.round(n).toLocaleString('en-US'); }

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }): JSX.Element {
  return <div className="dtsu-metric"><span>{label}</span><strong title={fullTokens(value) + ' tokens'}>{formatTokens(value)}</strong>{hint && <small>{hint}</small>}</div>;
}

export function TokenUsageSettings({ t }: { t: Translate }): JSX.Element {
  const [range, setRange] = useState<DetailRange>('7d');
  const [summary, setSummary] = useState<Summary>();
  const [details, setDetails] = useState<Details>();
  const [sevenDay, setSevenDay] = useState<Details>();
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>();

  const refresh = useCallback(async (selected: DetailRange) => {
    const work: [Promise<Summary | undefined>, Promise<Details | undefined>, Promise<Details | undefined> | undefined] = [
      fetchSummary(), fetchDetails(selected), selected === '7d' ? undefined : fetchDetails('7d'),
    ];
    const [nextSummary, nextDetails, nextSeven] = await Promise.all([work[0], work[1], work[2] ?? Promise.resolve(undefined)]);
    if (nextSummary) setSummary(nextSummary);
    if (nextDetails) setDetails(nextDetails);
    if (nextSeven) setSevenDay(nextSeven);
    else if (selected === '7d' && nextDetails) setSevenDay(nextDetails);
    setError(!nextDetails);
  }, []);

  useEffect(() => {
    void refresh(range);
    timer.current = setInterval(() => { if (!document.hidden) void refresh(range); }, 30_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [range, refresh]);

  const overviewSeven = sevenDay?.totalTokens ?? 0;
  const c = details?.categories;
  const rangeLabel = range === '7d' && details?.rangeStartDate && details.rangeEndDate
    ? details.rangeStartDate + ' – ' + details.rangeEndDate : undefined;

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
      {(['today', 'yesterday', '7d', 'all'] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={range === key}
        className={range === key ? 'is-active' : ''} onClick={() => setRange(key)}>{t(key)}</button>)}
    </div></div>

    {!details && <p className="dtsu-loading">{error ? t('unavailable') : t('loading')}</p>}
    {details && <>
      <div className="dtsu-metrics-grid">
        <Metric label={t('total')} value={details.totalTokens} />
        <Metric label={t('input')} value={c.totalTokens === undefined ? 0 : c.inputTokens} />
        <Metric label={t('output')} value={c.outputTokens} />
        <Metric label={t('cacheRead')} value={c.cacheReadTokens} />
        <Metric label={t('cacheWrite')} value={c.cacheWriteTokens} />
        <Metric label={t('reasoning')} value={c.reasoningTokens} hint={t('reasoningHint')} />
        <Metric label={t('calls')} value={c.callCount} />
      </div>
      {details.unknownTokens > 0 && <p className="dtsu-note">{t('unknown').replace('{tokens}', fullTokens(details.unknownTokens)).replace('{calls}', String(details.unknownCallCount))}</p>}

      <h3 className="dtsu-table-title">{t('byModel')}</h3>
      <div className="dtsu-table-wrap"><table className="dtsu-table"><thead><tr>
        <th>{t('provider')}</th><th>{t('model')}</th><th>{t('total')}</th><th>{t('input')}</th><th>{t('output')}</th><th>{t('cacheRead')}</th><th>{t('cacheWrite')}</th><th>{t('reasoning')}</th><th>{t('calls')}</th>
      </tr></thead><tbody>{details.models.length === 0 ? <tr><td colSpan={9} className="dtsu-empty-row">{t('noClassified')}</td></tr> : details.models.map((model) => <tr key={model.provider + model.model}>
        <td>{model.provider}</td><td>{model.model}</td><td>{formatTokens(model.totalTokens)}</td><td>{formatTokens(model.inputTokens)}</td><td>{formatTokens(model.outputTokens)}</td><td>{formatTokens(model.cacheReadTokens)}</td><td>{formatTokens(model.cacheWriteTokens)}</td><td>{formatTokens(model.reasoningTokens)}</td><td>{model.callCount}</td>
      </tr>)}</tbody></table></div>

      <h3 className="dtsu-table-title">{t('sevenDayDaily')}</h3>
      <div className="dtsu-table-wrap"><table className="dtsu-table dtsu-daily"><thead><tr><th>{t('date')}</th><th>{t('total')}</th><th>{t('input')}</th><th>{t('output')}</th><th>{t('cacheRead')}</th><th>{t('cacheWrite')}</th><th>{t('reasoning')}</th><th>{t('calls')}</th></tr></thead>
      <tbody>{(sevenDay?.daily ?? []).map((day) => <tr key={day.date}><td>{day.date}</td><td>{formatTokens(day.totalTokens + day.unknownTokens)}</td><td>{formatTokens(day.inputTokens)}</td><td>{formatTokens(day.outputTokens)}</td><td>{formatTokens(day.cacheReadTokens)}</td><td>{formatTokens(day.cacheWriteTokens)}</td><td>{formatTokens(day.reasoningTokens)}</td><td>{day.callCount}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
