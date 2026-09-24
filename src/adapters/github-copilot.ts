import { shortReset } from "../format.ts";
import { fetchJson, HttpError, safeError } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const USER_URL = "https://api.github.com/copilot_internal/user";

interface CopilotUserPayload {
  login?: string;
  copilot_plan?: string;
  access_type_sku?: string;
  features?: string[];
  quota_reset_date_utc?: string;
  quota_reset_date?: string;
  limited_user_reset_date?: string;
  quota_snapshots?: {
    premium_interactions?: {
      unlimited?: boolean;
      token_based_billing?: boolean;
      entitlement?: number;
      remaining?: number;
      quota_remaining?: number;
      credits_used?: number;
      overage_count?: number;
    } | null;
  } | null;
  limited_user_quotas?: { chat?: number } | null;
  monthly_quotas?: { chat?: number } | null;
}

function resetIso(payload: CopilotUserPayload): string | undefined {
  const raw = payload.quota_reset_date_utc ?? payload.quota_reset_date ?? payload.limited_user_reset_date;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function parseMetrics(payload: CopilotUserPayload): Metric[] {
  const metrics: Metric[] = [];
  const reset = resetIso(payload);
  const resetDetail = reset ? `resets ${shortReset(reset)}` : undefined;

  const premium = payload.quota_snapshots?.premium_interactions;
  if (premium) {
    if (premium.unlimited === true) {
      metrics.push({ kind: "status", id: "copilot-premium", label: "Premium requests", value: "Unlimited" });
    } else {
      const entitlement = premium.entitlement;
      const remaining = premium.remaining ?? premium.quota_remaining;
      if (typeof entitlement === "number" && typeof remaining === "number") {
        const overage = Math.max(premium.overage_count ?? 0, Math.max(0, -remaining));
        const used = premium.credits_used ?? Math.max(0, entitlement - remaining);
        metrics.push({
          kind: "usage-limit",
          id: premium.token_based_billing === true ? "copilot-credits" : "copilot-premium",
          label: premium.token_based_billing === true ? "AI credits" : "Premium requests",
          used,
          limit: entitlement,
          unit: "requests",
          ...(resetDetail ? { detail: resetDetail } : {}),
        });
        if (overage > 0) {
          metrics.push({
            kind: "status",
            id: "copilot-overage",
            label: "Additional usage",
            value: `${overage}`,
          });
        }
      }
    }
  } else {
    const remaining = payload.limited_user_quotas?.chat;
    const entitlement = payload.monthly_quotas?.chat;
    if (typeof remaining === "number" && typeof entitlement === "number") {
      metrics.push({
        kind: "usage-limit",
        id: "copilot-chat",
        label: "Chat requests",
        used: Math.max(0, entitlement - remaining),
        limit: entitlement,
        unit: "requests",
        ...(resetDetail ? { detail: resetDetail } : {}),
      });
    }
  }

  const plan = payload.copilot_plan ?? payload.access_type_sku;
  if (plan) metrics.push({ kind: "status", id: "copilot-plan", label: "Plan", value: plan });

  if (payload.features?.length) {
    const trimmed = payload.features.slice(0, 4).join(", ");
    metrics.push({
      kind: "status",
      id: "copilot-features",
      label: "Features",
      value: trimmed + (payload.features.length > 4 ? ", …" : ""),
    });
  }

  return metrics;
}

export const githubCopilotAdapter: UsageAdapter = {
  id: "github-copilot",
  label: "GitHub Copilot",
  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    return pid === "github-copilot" || pid === "copilot";
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const payload = await fetchJson<CopilotUserPayload>(
        USER_URL,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.github+json" } },
        signal,
      );

      const metrics = parseMetrics(payload);
      const plan = payload.copilot_plan ?? payload.access_type_sku;
      if (!metrics.length || !plan) return snapshot(this, target, "empty");

      return snapshot(this, target, "ok", {
        accounts: [{ id: payload.login ?? "github-copilot", label: payload.login ?? "Copilot", metrics }],
        summary: `Copilot · ${plan}`,
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
