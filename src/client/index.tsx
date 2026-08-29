// src/client/index.tsx
// Client half of dsh-token-usage-sidebar.
//
// Registers a compact Token Usage component into the sidebar shell's
// 'sidebar.leading' slot (declared between the DeepSeek logo row and the New
// Session button). It fetches the host-aggregated Today/Total over the plugin's
// fenced POST /token-usage/api/summary route and refetches on a low-cost
// interval + when the tab regains focus, so the numbers stay live without any
// core-data-transport modification.
import type { Context } from '@deepseek-ai/cordis';
import { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TokenUsageSettings } from './settings.tsx';

declare const __DTSU_PLUGIN_VERSION__: string;

export const inject = ['slots', 'locale', 'connection'];
export const PLUGIN_VERSION = __DTSU_PLUGIN_VERSION__;
export const PLUGIN_REPOSITORY_URL = 'https://github.com/y2zyyr/dsh-token-usage-sidebar';

const SETTINGS_NS = 'dsh-token-usage-sidebar';
const settingsLocale = {
  en: {
    nav: 'Token Usage', title: 'Token Usage', today: 'Today', yesterday: 'Yesterday', details: 'Usage details', '7d': '7D', all: 'All time', total: 'Total', input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write', reasoning: 'Reasoning', reasoningHint: 'included in output', calls: 'Calls', byModel: 'By provider and model', provider: 'Provider', model: 'Model', sevenDayDaily: 'Last 7 local days', date: 'Date', loading: 'Loading token usage…', unavailable: 'Usage data is temporarily unavailable.', noClassified: 'No classified usage in this range.', noMatching: 'No matching usage in this range.', unknown: '{tokens} tokens across {calls} calls cannot be classified from older records. They remain included in Total.', excludedUnknown: '{tokens} tokens across {calls} calls are unclassified and excluded from this filter.', providerFilter: 'Provider', modelFilter: 'Model', allProviders: 'All providers', allModels: 'All models', clearFilters: 'Clear filters', currentScope: 'Current scope', filterHelp: 'Filters use the exact names reported by DSH; the plugin does not define provider aliases.', rawBreakdown: 'Raw provider breakdown', expand: 'Show details', collapse: 'Hide details', aboutPlugin: 'About this plugin', version: 'Version', aboutDescription: 'Persistent local token-usage accounting for DeepSeek Harness.', aboutChanges: 'v1.1.5: automatic history discovery, exact DSH provider names, and a more compact settings layout.', viewOnGithub: 'View project on GitHub',
  },
  zh: {
    nav: 'Token 用量', title: 'Token 用量', today: '今天', yesterday: '昨天', details: '用量明细', '7d': '7 天', all: '全部时间', total: '总计', input: '输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入', reasoning: '推理', reasoningHint: '已包含在输出中', calls: '调用次数', byModel: '按供应商和模型', provider: '供应商', model: '模型', sevenDayDaily: '最近 7 个本地自然日', date: '日期', loading: '正在加载 Token 用量…', unavailable: 'Token 用量暂时不可用。', noClassified: '这个范围内没有可分类的用量。', noMatching: '当前范围内没有匹配用量。', unknown: '有 {tokens} tokens、{calls} 次调用无法从旧记录中分类；它们仍计入总计。', excludedUnknown: '有 {tokens} tokens、{calls} 次调用未分类，因此未计入当前筛选。', providerFilter: '供应商', modelFilter: '模型', allProviders: '全部供应商', allModels: '全部模型', clearFilters: '清除筛选', currentScope: '当前范围', filterHelp: '筛选使用 DSH 实际上报的精确名称；插件不再要求单独配置供应商别名。', rawBreakdown: '原始供应商名称明细', expand: '展开明细', collapse: '收起明细', aboutPlugin: '关于插件', version: '版本', aboutDescription: '为 DeepSeek Harness 提供本地持久化 Token 用量统计。', aboutChanges: 'v1.1.5：自动发现历史记录、直接使用 DSH 供应商名称，并优化设置页布局。', viewOnGithub: '在 GitHub 查看项目',
  },
};

// ── summary wire shape ─────────────────────────────────────────────────────
export interface Summary {
  todayTotal: number;
  yesterdayTotal: number;
  lifetimeTotal: number;
  todayDate: string;
  recordCount: number;
  serverNow: string;
}

const SUMMARY_URL = '/token-usage/api/summary';

export async function fetchSummary(signal?: AbortSignal): Promise<Summary | undefined> {
  try {
    const res = await fetch(SUMMARY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal,
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const json: unknown = await res.json().catch(() => undefined);
    const value = (json as { ok?: boolean; value?: Partial<Summary> })?.ok === true
      ? (json as { value: Partial<Summary> }).value
      : undefined;
    if (!value) return undefined;
    return {
      todayTotal: Number(value.todayTotal) || 0,
      yesterdayTotal: Number(value.yesterdayTotal) || 0,
      lifetimeTotal: Number(value.lifetimeTotal) || 0,
      todayDate: value.todayDate ?? '',
      recordCount: Number(value.recordCount) || 0,
      serverNow: value.serverNow ?? '',
    };
  } catch {
    return undefined;
  }
}

/** Compact human-readable token count: 843, 1.2K, 18.4K, 927K, 1.28M, 42.6M, 1.03B. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const;
  for (const [div, suffix] of units) {
    if (n >= div) {
      const v = n / div;
      const rounded = v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
      return String(rounded) + suffix;
    }
  }
  return String(Math.round(n));
}

const styleTagId = 'dsh-token-usage-sidebar/summary.css';

interface TokenUsageSidebarProps {
  wide?: boolean;
}

export function TokenUsageSidebar(_props: TokenUsageSidebarProps): JSX.Element {
  const [summary, setSummary] = useState<Summary | undefined>(undefined);
  const [connected, setConnected] = useState<boolean | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const summaryRef = useRef<Summary | undefined>(undefined);
  summaryRef.current = summary;

  const refresh = useCallback(async () => {
    const s = await fetchSummary();
    if (s) {
      setSummary(s);
      setConnected(true);
    } else {
      // Only mark disconnected when we had (or expected) an established link.
      setConnected((prev) => (prev === undefined ? undefined : true));
    }
    // Keep failed probes from flipping a working display to blank.
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, 4000);
    return () => { if (timer.current !== undefined) clearInterval(timer.current); };
  }, [refresh]);

  // Pause polling while the tab is hidden; resume on visibility.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        if (timer.current !== undefined) { clearInterval(timer.current); timer.current = undefined; }
      } else if (timer.current === undefined) {
        void refresh();
        timer.current = setInterval(() => { void refresh(); }, 4000);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // Inject styles once (framework-style CSS injection).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.querySelector('style[data-dtsu = "1"]')) return;
    const tag = document.createElement('style');
    tag.dataset.dtsu = '1';
    tag.dataset.plugin = 'dsh-token-usage-sidebar';
    tag.textContent = `.dtsu-w{display:flex;flex-direction:column;gap:2px;margin:0 2px 8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:10px;background:var(--dsw-alias-fill-l2,transparent);font-size:12px;line-height:1.35;color:var(--dsw-alias-label-secondary);user-select:none;flex:none;width:auto}
html[data-dsh-desktop=true] .dtsu-w{border-color:transparent}
.dtsu-t{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,inherit);margin-bottom:2px}
.dtsu-r{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.dtsu-k{color:inherit}
.dtsu-v{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary)}
.dtsu-empty{opacity:.45}
.dtsu-settings{width:100%;padding:4px 0 18px;color:var(--dsw-alias-label-primary,#eee);font-size:13px}.dtsu-settings h2,.dtsu-settings h3{margin:0;font-weight:600}.dtsu-settings h2{font-size:16px}.dtsu-settings h3{font-size:14px}.dtsu-settings-head,.dtsu-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}.dtsu-settings-head p{margin:5px 0 0;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-range-date{color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums;white-space:nowrap}.dtsu-overview,.dtsu-metrics-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:22px}.dtsu-metrics-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:12px}.dtsu-metric{min-height:66px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:10px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.06));display:flex;flex-direction:column;gap:5px}.dtsu-metric span,.dtsu-metric small{color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dtsu-metric small{font-size:10px}.dtsu-metric strong{font-size:18px;font-variant-numeric:tabular-nums}.dtsu-range-switch{display:flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;padding:2px;gap:2px}.dtsu-range-switch button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#aaa);padding:5px 9px;border-radius:6px;font:inherit;cursor:pointer}.dtsu-range-switch button.is-active{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#fff)}.dtsu-table-title{margin:24px 0 10px}.dtsu-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:9px}.dtsu-table{border-collapse:collapse;width:100%;min-width:760px;font-variant-numeric:tabular-nums}.dtsu-table th,.dtsu-table td{padding:9px 10px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14));white-space:nowrap}.dtsu-table th{color:var(--dsw-alias-label-secondary,#aaa);font-weight:500;font-size:11px}.dtsu-table th:first-child,.dtsu-table td:first-child,.dtsu-table th:nth-child(2),.dtsu-table td:nth-child(2){text-align:left}.dtsu-table tr:last-child td{border-bottom:0}.dtsu-note,.dtsu-loading,.dtsu-empty-row{color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-note{margin:0 0 4px;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.06))}.dtsu-empty-row{text-align:center!important;padding:20px!important}@media(max-width:760px){.dtsu-overview,.dtsu-metrics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dtsu-section-head{flex-direction:column}.dtsu-range-date{display:none}}
`;
    document.head.appendChild(tag);
  }, []);

  const today = summary ? formatTokens(summary.todayTotal) : '–';
  const yesterday = summary ? formatTokens(summary.yesterdayTotal) : '–';
  const total = summary ? formatTokens(summary.lifetimeTotal) : '–';
  const ready = summary !== undefined;

  return (
    <div className={'dtsu-w' + (ready ? '' : ' dtsu-empty')} data-dsh-token-usage-sidebar="1">
      <div className="dtsu-t">Token Usage</div>
      <div className="dtsu-r">
        <span className="dtsu-k">Today</span>
        <span className="dtsu-v" title={summary ? summary.todayTotal.toLocaleString('en-US') + ' tokens' : undefined}>{today}</span>
      </div>
      <div className="dtsu-r">
        <span className="dtsu-k">Yesterday</span>
        <span className="dtsu-v" title={summary ? summary.yesterdayTotal.toLocaleString('en-US') + ' tokens' : undefined}>{yesterday}</span>
      </div>
      <div className="dtsu-r">
        <span className="dtsu-k">Total</span>
        <span className="dtsu-v" title={summary ? summary.lifetimeTotal.toLocaleString('en-US') + ' tokens' : undefined}>{total}</span>
      </div>
    </div>
  );
}

// Older DSH Web shells do not declare `sidebar.leading`. Keep the official
// slot path below as the preferred integration, but mount immediately before
// DSH's own New Session button when that slot never becomes available.
//
// Hardened v1.0.1 fallback (§23-24): never mis-mount on just any button that
// happens to contain a <span>. The secondary fallback requires BOTH
// sidebar-context ancestry AND an aria-label keyword, so a non-sidebar button
// is never treated as DSH's New Session button. If no confident candidate
// exists, we return undefined (mount nothing) rather than guess wrong.
function hasSidebarAncestry(button: HTMLButtonElement): boolean {
  let node: Element | null = button.parentElement;
  let depth = 0;
  while (node && depth < 12) {
    const cls = typeof node.className === 'string' ? node.className : '';
    if (/sidebar|newSession|left-nav|session-list/i.test(cls)) return true;
    node = node.parentElement;
    depth += 1;
  }
  return false;
}

function isLikelyNewSessionButton(button: HTMLButtonElement): boolean {
  if (typeof button.className === 'string' && button.className.includes('newSession')) return true;
  if (!hasSidebarAncestry(button)) return false;
  const label = (button.getAttribute('aria-label') ?? '').toLowerCase().replace(/\s+/g, '');
  if (!label) return false;
  return /new|session|neues|会话|新建/.test(label);
}

function findNewSessionButton(): HTMLButtonElement | undefined {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  const exact = buttons.filter((b) => typeof b.className === 'string' && b.className.includes('newSession'));
  if (exact.length > 0) return exact[0];
  return buttons.find(isLikelyNewSessionButton);
}

function mountLegacySidebarFallback(): () => void {
  if (typeof document === 'undefined' || !document.body) return () => {};
  let mount: HTMLDivElement | undefined;
  let root: Root | undefined;
  let resize: ResizeObserver | undefined;

  const disposeMount = () => {
    resize?.disconnect();
    resize = undefined;
    root?.unmount();
    root = undefined;
    mount?.remove();
    mount = undefined;
  };
  const attach = () => {
    const target = findNewSessionButton();
    if (!target || !target.parentElement) return;
    if (mount?.parentElement === target.parentElement && mount.nextElementSibling === target) {
      mount.style.display = target.getBoundingClientRect().width < 100 ? 'none' : '';
      return;
    }
    disposeMount();
    mount = document.createElement('div');
    mount.dataset.dshTokenUsageSidebarFallback = '1';
    target.parentElement.insertBefore(mount, target);
    root = createRoot(mount);
    root.render(<TokenUsageSidebar />);
    const updateCollapsedVisibility = () => {
      if (mount) mount.style.display = target.getBoundingClientRect().width < 100 ? 'none' : '';
    };
    resize = new ResizeObserver(updateCollapsedVisibility);
    resize.observe(target);
    updateCollapsedVisibility();
  };
  const observer = new MutationObserver(attach);
  observer.observe(document.body, { childList: true, subtree: true });
  attach();
  return () => {
    observer.disconnect();
    disposeMount();
  };
}

// ── client plugin body ─────────────────────────────────────────────────────
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, settingsLocale), 'dsh-token-usage-sidebar: locale');
  const t = ctx.locale.bind(SETTINGS_NS) as (key: string) => string;
  ctx.effect(() => {
    let slotMounted = false;
    let fallbackDispose: (() => void) | undefined;
    const fallbackTimer = window.setTimeout(() => {
      if (!slotMounted) fallbackDispose = mountLegacySidebarFallback();
    }, 400);
    const slotDispose = ctx.slots.inject('sidebar.leading', () => {
      slotMounted = true;
      window.clearTimeout(fallbackTimer);
      fallbackDispose?.();
      fallbackDispose = undefined;
      return ctx.slots.register(
        {
          name: 'sidebar.leading',
          registrant: 'dsh-token-usage-sidebar',
          inject: () => ({}),
        },
        TokenUsageSidebar,
      );
    });
    return () => {
      window.clearTimeout(fallbackTimer);
      fallbackDispose?.();
      slotDispose?.();
    };
  }, 'dsh-token-usage-sidebar: sidebar placement');
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section', id: 'token-usage', order: 25,
      label: () => t('nav'), locale: SETTINGS_NS,
      inject: () => ({ t }),
    },
    () => <TokenUsageSettings t={t} />,
  ));
}
