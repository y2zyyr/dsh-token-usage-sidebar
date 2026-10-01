import type { UsageHealth } from '../usage/health.ts';

/** Aggregate-only wire shape shared by the browser and package consumers. */
export interface Summary {
  health?: UsageHealth;
  todayTotal: number;
  yesterdayTotal: number;
  lifetimeTotal: number;
  todayDate: string;
  recordCount: number;
  serverNow: string;
}
