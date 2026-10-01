import type { Context } from '@deepseek-ai/cordis';
import { type JSX } from 'react';
import type { Summary } from './summary.js';
export type { Summary } from './summary.js';
export declare const inject: string[];
export declare const PLUGIN_VERSION: string;
export declare const PLUGIN_REPOSITORY_URL = "https://github.com/y2zyyr/dsh-token-usage-sidebar";
export declare function fetchSummary(signal?: AbortSignal): Promise<Summary | undefined>;
/** Compact human-readable token count: 843, 1.2K, 18.4K, 927K, 1.28M, 42.6M, 1.03B. */
export declare function formatTokens(n: number): string;
interface TokenUsageSidebarProps {
    wide?: boolean;
    t?: (key: string) => string;
}
export declare function TokenUsageSidebar(_props: TokenUsageSidebarProps): JSX.Element;
export declare function apply(ctx: Context): void;
