import type { Api, AuthResult, Model, Provider } from "@earendil-works/pi-ai";

export type UsageState =
  | "ok"
  | "unauthorized"
  | "unsupported"
  | "empty"
  | "unavailable";

export type Metric =
  | { kind: "balance"; id: string; label: string; amount: number; currency: string; detail?: string }
  | { kind: "quota-window"; id: string; label: string; remainingFraction: number; resetAt?: string; detail?: string }
  | { kind: "usage-limit"; id: string; label: string; used: number; limit: number; unit: string; detail?: string }
  | { kind: "status"; id: string; label: string; value: string; detail?: string };

export interface UsageAccount {
  id: string;
  label: string;
  metrics: Metric[];
}

export interface UsageSnapshot {
  adapterId: string;
  sourceProviderId: string;
  displayName: string;
  state: UsageState;
  fetchedAt: string;
  accounts: UsageAccount[];
  summary?: string;
  error?: string;
}

export interface Credentials {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  accountId?: string;
  source: "model" | "provider" | "stored";
}

export interface ProviderTarget {
  providerId: string;
  model?: Model<Api>;
  provider?: Provider<Api>;
  baseUrl?: string;
  auth?: AuthResult;
  authError?: string;
  credentials?: Credentials;
}

export interface FetchContext {
  target: ProviderTarget;
  signal: AbortSignal;
  force: boolean;
}

export interface UsageAdapter {
  id: string;
  label: string;
  canHandle(target: ProviderTarget): boolean;
  fetch(context: FetchContext): Promise<UsageSnapshot>;
}

export function snapshot(
  adapter: UsageAdapter,
  target: ProviderTarget,
  state: UsageState,
  extra?: Partial<Pick<UsageSnapshot, "accounts" | "error" | "summary">>,
): UsageSnapshot {
  return {
    adapterId: adapter.id,
    sourceProviderId: target.providerId,
    displayName: adapter.label,
    state,
    fetchedAt: new Date().toISOString(),
    accounts: [],
    ...extra,
  };
}
