import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const USAGE_URL = "https://api.baseten.co/v1/billing/usage_summary";

interface UsageSummaryResponse {
  model_apis_usage?: {
    total?: string | number;
    credits_used?: string | number;
    subtotal?: string | number;
  };
}

function amount(value: string | number | undefined): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const basetenAdapter: UsageAdapter = {
  id: "baseten",
  label: "Baseten",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "baseten") return true;
    return urlOnDomain(target.baseUrl, "baseten.co");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const end = new Date();
      const start = new Date(end.getTime() - 30 * 86_400_000);
      const payload = await fetchJson<UsageSummaryResponse>(
        `${USAGE_URL}?start_date=${start.toISOString()}&end_date=${end.toISOString()}`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
        signal,
      );

      const usage = payload.model_apis_usage;
      if (!usage) return snapshot(this, target, "empty", { error: "No Model APIs usage returned" });
      const total = amount(usage.total);
      const credits = amount(usage.credits_used);
      const subtotal = amount(usage.subtotal);
      if (total === undefined && credits === undefined && subtotal === undefined) {
        return snapshot(this, target, "empty", { error: "No usage amounts returned" });
      }

      const metrics = [
        ...(total !== undefined && subtotal !== undefined
          ? [
              {
                kind: "usage-limit" as const,
                id: "baseten-model-apis",
                label: "Model APIs (30d)",
                used: subtotal,
                limit: total,
                unit: "USD",
                detail:
                  credits !== undefined
                    ? `net after ${credits.toFixed(2)} credits · gross ${total.toFixed(2)}`
                    : `gross ${total.toFixed(2)}`,
              },
            ]
          : []),
        ...(credits !== undefined && (total === undefined || subtotal === undefined)
          ? [
              {
                kind: "status" as const,
                id: "baseten-credits",
                label: "Credits used (30d)",
                value: `$${credits.toFixed(2)}`,
              },
            ]
          : []),
      ];
      if (!metrics.length) {
        metrics.push({
          kind: "status",
          id: "baseten-model-apis",
          label: "Model APIs (30d)",
          value: `$${(total ?? subtotal ?? 0).toFixed(2)}`,
        });
      }
      const spend = subtotal ?? total ?? 0;
      return snapshot(this, target, "ok", {
        accounts: [{ id: "baseten-org", label: "Baseten (org)", metrics }],
        summary: `$${spend.toFixed(2)} spend (30d) · Baseten`,
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
