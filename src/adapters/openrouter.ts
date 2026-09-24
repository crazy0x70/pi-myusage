import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

interface KeyResponse {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
  };
}

interface CreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

export const openrouterAdapter: UsageAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "openrouter") return true;
    return urlOnDomain(target.baseUrl, "openrouter.ai");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });
      const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

      const [keyResult, creditsResult] = await Promise.allSettled([
        fetchJson<KeyResponse>(KEY_URL, { headers }, signal),
        fetchJson<CreditsResponse>(CREDITS_URL, { headers }, signal),
      ]);
      if (keyResult.status === "rejected") throw keyResult.reason;
      const keyInfo = keyResult.value.data;
      const usage = typeof keyInfo?.usage === "number" && Number.isFinite(keyInfo.usage) ? keyInfo.usage : 0;
      const limit = typeof keyInfo?.limit === "number" && Number.isFinite(keyInfo.limit) ? keyInfo.limit : undefined;
      const credits = creditsResult.status === "fulfilled" ? creditsResult.value.data : undefined;

      const balance =
        typeof credits?.total_credits === "number" && typeof credits?.total_usage === "number"
          ? Math.max(0, credits.total_credits - credits.total_usage)
          : undefined;

      const metrics = [
        ...(limit !== undefined
          ? [
              {
                kind: "usage-limit" as const,
                id: "openrouter-usage",
                label: "Usage",
                used: usage,
                limit,
                unit: "USD",
              },
            ]
          : []),
        ...(balance !== undefined
          ? [
              {
                kind: "balance" as const,
                id: "openrouter-balance",
                label: "Balance",
                amount: balance,
                currency: "USD",
                detail:
                  credits && typeof credits.total_usage === "number"
                    ? `credits ${credits.total_credits} · used ${credits.total_usage.toFixed(2)}`
                    : undefined,
              },
            ]
          : []),
      ];
      if (!metrics.length) return snapshot(this, target, "empty");

      const summary =
        limit !== undefined
          ? `$${usage.toFixed(2)}/$${limit % 1 === 0 ? limit.toString() : limit.toFixed(2)} · OpenRouter`
          : balance !== undefined
            ? `$${balance.toFixed(2)} · OpenRouter`
            : `Used $${usage.toFixed(2)} · OpenRouter`;
      return snapshot(this, target, "ok", {
        accounts: [
          { id: "openrouter-account", label: keyInfo?.label ? `OpenRouter (${keyInfo.label})` : "OpenRouter", metrics },
        ],
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
