import type { Context } from '@deepseek-ai/cordis';
import { apply as mount, inject as services } from './index.tsx';

// Public loader contract. UI components remain internal implementation details.
export const inject: string[] = services;
export function apply(ctx: Context): void { mount(ctx); }
export type { Summary } from './summary.ts';
