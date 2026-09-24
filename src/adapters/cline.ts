import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const ORIGIN = "https://api.cline.bot";

interface Envelope<T> {
  success?: boolean;
  error?: string;
  data?: T;
}

interface MeResponse {
  id?: string | number;
  email?: string;
  name?: string;
}

interface UsageLimitItem {
  type?: string;
  percentUsed?: number;
  resetsAt?: string;
}

interface UsageLimitsResponse {
  limits?: UsageLimitItem[];
}

interface BalanceResponse {
  balance?: number;
}

const MICRO_USD = 1_000_000;

async function clineGet<T>(path: string, apiKey: string, signal: AbortSignal): Promise<T | undefined> {
  const payload = await fetchJson<Envelope<T>>(
    `${ORIGIN}${path}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    signal,
  );
  if (typeof payload.error === "string" && payload.error) throw new Error(payload.error);
  return payload.data;
}

function normalizeReset(raw: string | undefined): string | undefined {
  if (!raw || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function parseWindows(data: UsageLimitsResponse | undefined): Metric[] {
  if (!data || !Array.isArray(data.limits)) return [];
  const metrics: Metric[] = [];
  for (const limit of data.limits) {
    if (typeof limit.percentUsed !== "number" || !Number.isFinite(limit.percentUsed)) continue;
    const type = (limit.type ?? "").toLowerCase();
    const label =
      type === "five_hour" ? "Cline 5h"
      : type === "weekly" ? "Cline Weekly"
      : type === "monthly" ? "Cline Monthly"
      : `Cline ${limit.type ?? "limit"}`;
    const used = Math.min(100, Math.max(0, limit.percentUsed));
    const resetAt = normalizeReset(limit.resetsAt);
    metrics.push({
      kind: "quota-window",
      id: `cline-${type || metrics.length}`,
      label,
      remainingFraction: Math.max(0, (100 - used) / 100),
      ...(resetAt ? { resetAt } : {}),
    });
  }
  return metrics;
}

export const clineAdapter: UsageAdapter = {
  id: "cline",
  label: "Cline",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "cline") return true;
    return urlOnDomain(target.baseUrl, "cline.bot");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const [me, plan] = await Promise.all([
        clineGet<MeResponse>("/api/v1/users/me", apiKey, signal),
        clineGet<unknown>("/api/v1/users/me/plan", apiKey, signal),
      ]);
      const userId = me?.id;

      const metrics: Metric[] = [];
      const [limits, balance] = await Promise.all([
        plan !== null && plan !== undefined
          ? clineGet<UsageLimitsResponse>("/api/v1/users/me/plan/usage-limits", apiKey, signal)
          : undefined,
        userId !== undefined
          ? clineGet<BalanceResponse>(`/api/v1/users/${userId}/balance`, apiKey, signal)
          : undefined,
      ]);
      if (limits) metrics.push(...parseWindows(limits));

      let balanceAmount: number | undefined;
      if (typeof balance?.balance === "number" && Number.isFinite(balance.balance)) {
        balanceAmount = balance.balance / MICRO_USD;
        metrics.push({
          kind: "balance",
          id: "cline-balance",
          label: "Balance",
          amount: balanceAmount,
          currency: "USD",
        });
      }

      if (!metrics.length) {
        return snapshot(this, target, "empty", {
          error: plan === null || plan === undefined ? "No ClinePass plan" : "No usage or balance data",
        });
      }

      const windows = metrics.filter((m): m is QuotaWindowMetric => m.kind === "quota-window");
      const summary = windowsSummary(windows) ?? `$${(balanceAmount ?? 0).toFixed(2)} · Cline`;
      return snapshot(this, target, "ok", {
        accounts: [{ id: "cline-account", label: "Cline", metrics }],
        summary,
      });
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        return snapshot(this, target, "unauthorized", { error: `HTTP ${error.status}` });
      }
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
