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

export const inject = ['slots', 'locale', 'connection'];

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

// ── client plugin body ─────────────────────────────────────────────────────
export function apply(ctx: Context): void {
  // Wait for the sidebar shell's 'sidebar.leading' declaration (slots.inject
  // waits for it; declaration collapse disposer re-registers), then mount.
  ctx.effect(() =>
    ctx.slots.inject('sidebar.leading', () =>
      ctx.slots.register(
        {
          name: 'sidebar.leading',
          registrant: 'dsh-token-usage-sidebar',
          inject: () => ({}),
        },
        TokenUsageSidebar,
      ),
    ),
    'dsh-token-usage-sidebar: sidebar.leading slot registration',
  );
}
