import { shortReset, windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, safeError, urlOnDomain, HttpError } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";

const CLI_HEADERS: Record<string, string> = {
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-grok-client-version": "1.0.10",
  "x-grok-client-mode": "interactive",
};

interface CentWrapper {
  val?: number;
}

interface BillingConfig {
  creditUsagePercent?: number | null;
  monthlyLimit?: CentWrapper | null;
  used?: CentWrapper | null;
  onDemandCap?: CentWrapper | null;
  onDemandUsed?: CentWrapper | null;
  prepaidBalance?: CentWrapper | null;
  currentPeriod?: { type?: string; start?: string; end?: string } | null;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
}

interface UserResponse {
  userId?: string;
  subscriptionTier?: string;
}

interface UserinfoResponse {
  sub?: string;
  name?: string;
  email?: string;
}

function cents(value: CentWrapper | null | undefined): number | undefined {
  if (!value || typeof value.val !== "number" || !Number.isFinite(value.val)) return undefined;
  return value.val / 100;
}

function isoOrNull(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isAuthError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

async function fetchConsumer(
  adapter: UsageAdapter,
  target: Parameters<UsageAdapter["fetch"]>[0]["target"],
  token: string,
  signal: AbortSignal,
): Promise<UsageSnapshot> {
  const authHeaders = { Authorization: `Bearer ${token}`, ...CLI_HEADERS };
  const user = await fetchJson<UserResponse>(USER_URL, { headers: authHeaders }, signal);

  const billingHeaders: Record<string, string> = { ...authHeaders };
  if (user.userId) billingHeaders["x-userid"] = user.userId;
  const payload = await fetchJson<{ config?: BillingConfig | null }>(
    BILLING_URL,
    { headers: billingHeaders },
    signal,
  );
  const config = payload.config ?? undefined;

  const metrics: Metric[] = [];
  const resetAt = isoOrNull(config?.currentPeriod?.end) ?? isoOrNull(config?.billingPeriodEnd);
  const percent = config?.creditUsagePercent;
  const usedUsd = cents(config?.used);
  const limitUsd = cents(config?.monthlyLimit);

  if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
    metrics.push({
      kind: "quota-window",
      id: "grok-allowance",
      label: "Included allowance",
      remainingFraction: (100 - percent) / 100,
      ...(resetAt ? { resetAt } : {}),
    });
  } else if (usedUsd !== undefined || limitUsd !== undefined) {
    metrics.push({
      kind: "usage-limit",
      id: "grok-allowance",
      label: "Included allowance",
      used: usedUsd ?? 0,
      limit: limitUsd ?? 0,
      unit: "USD",
      ...(resetAt ? { detail: `resets ${shortReset(resetAt)}` } : {}),
    });
  }

  const onDemandUsed = cents(config?.onDemandUsed);
  const onDemandCap = cents(config?.onDemandCap);
  if (onDemandUsed !== undefined || onDemandCap !== undefined) {
    metrics.push({
      kind: "usage-limit",
      id: "grok-on-demand",
      label: "On-demand usage",
      used: onDemandUsed ?? 0,
      limit: onDemandCap ?? 0,
      unit: "USD",
    });
  }

  const prepaid = cents(config?.prepaidBalance);
  if (prepaid !== undefined) {
    metrics.push({
      kind: "balance",
      id: "grok-prepaid",
      label: "Prepaid balance",
      amount: prepaid,
      currency: "USD",
    });
  }

  if (user.subscriptionTier) {
    metrics.push({ kind: "status", id: "grok-plan", label: "Plan", value: user.subscriptionTier });
  }

  if (!metrics.length) return snapshot(adapter, target, "empty");

  const windows = metrics.filter(
    (metric): metric is QuotaWindowMetric => metric.kind === "quota-window",
  );
  let summary: string | undefined;
  if (windows.length) {
    summary = windowsSummary(windows);
  } else if (prepaid !== undefined) {
    summary = `Grok · $${prepaid.toFixed(2)}`;
  } else if (user.subscriptionTier) {
    summary = `Grok · ${user.subscriptionTier}`;
  }

  return snapshot(adapter, target, "ok", {
    accounts: [{ id: user.userId ?? "xai-user", label: "Grok Account", metrics }],
    summary,
  });
}

async function fetchUserinfo(
  adapter: UsageAdapter,
  target: Parameters<UsageAdapter["fetch"]>[0]["target"],
  token: string,
  signal: AbortSignal,
): Promise<UsageSnapshot> {
  const info = await fetchJson<UserinfoResponse>(
    USERINFO_URL,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    signal,
  );

  const label = info.email || info.name || "Grok Account";
  const metrics: Metric[] = [
    { kind: "status", id: "grok-identity", label: "Account", value: label.slice(0, 40) },
    { kind: "status", id: "grok-subscription", label: "Subscription", value: "Active" },
  ];

  return snapshot(adapter, target, "ok", {
    accounts: [{ id: info.sub ?? "xai-user", label, metrics }],
    summary: `Grok · ${label === "Grok Account" ? "Active" : label.slice(0, 40)}`,
  });
}

export const xaiAdapter: UsageAdapter = {
  id: "xai",
  label: "xAI Grok",
  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    if (pid === "xai" || pid === "grok") return true;
    return urlOnDomain(target.baseUrl, "x.ai") || urlOnDomain(target.baseUrl, "grok.com");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const token = target.credentials?.apiKey;
      if (!token) return snapshot(this, target, "unauthorized", { error: "No API key" });

      let consumerFailure: unknown;
      try {
        return await fetchConsumer(this, target, token, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        consumerFailure = error;
      }

      try {
        return await fetchUserinfo(this, target, token, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (isAuthError(error) || isAuthError(consumerFailure)) {
          return snapshot(this, target, "unauthorized", { error: safeError(error) });
        }
        throw error;
      }
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
