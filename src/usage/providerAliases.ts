/**
 * Provider identity and view-filter contracts.
 *
 * The ledger keeps the exact provider string reported by DSH. Alias groups are
 * a local presentation/query layer on top of those raw values; they never
 * rewrite historical records.
 */

export interface ProviderAliasGroup {
  id: string;
  label: string;
  rawValues: string[];
}

export type ProviderScope =
  | { type: 'raw'; value: string }
  | { type: 'group'; id: string };

export interface UsageFilters {
  provider?: ProviderScope | null;
  model?: string | null;
}

export interface ProviderOption {
  type: 'raw' | 'group';
  value: string;
  label: string;
  rawValues: string[];
}

export interface ProviderModelPair {
  provider: string;
  model: string;
}

export interface UsageFacets {
  providers: ProviderOption[];
  models: string[];
  pairs: ProviderModelPair[];
  groups: ProviderAliasGroup[];
}

export interface ExcludedUnclassified {
  tokens: number;
  calls: number;
}
