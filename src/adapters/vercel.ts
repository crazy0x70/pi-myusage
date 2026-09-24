import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";

interface CreditsResponse {
  balance?: string | number;
  total_used?: string | number;
}

function amount(value: string | number | undefined): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const vercelGatewayAdapter: UsageAdapter = {
  id: "vercel-ai-gateway",
  label: "Vercel AI Gateway",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "vercel-ai-gateway") return true;
    return urlOnDomain(target.baseUrl, "vercel.sh") || urlOnDomain(target.baseUrl, "ai-gateway.vercel.sh");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const payload = await fetchJson<CreditsResponse>(
        CREDITS_URL,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
        signal,
      );

      const balance = amount(payload.balance);
      const lifetime = amount(payload.total_used);
      if (balance === undefined && lifetime === undefined) {
        return snapshot(this, target, "empty", { error: "No credits data returned" });
      }

      const metrics = [
        ...(balance !== undefined
          ? [
              {
                kind: "balance" as const,
                id: "vercel-credits",
                label: "Credits remaining",
                amount: balance,
                currency: "USD",
                detail: lifetime !== undefined ? `lifetime spend ${lifetime.toFixed(2)}` : undefined,
              },
            ]
          : []),
        ...(balance !== undefined && lifetime !== undefined && balance + lifetime > 0
          ? [
              {
                kind: "usage-limit" as const,
                id: "vercel-lifetime",
                label: "Lifetime spend",
                used: lifetime,
                limit: balance + lifetime,
                unit: "USD",
                detail: "lifetime credits issued",
              },
            ]
          : []),
      ];
      const primary = balance ?? lifetime ?? 0;
      return snapshot(this, target, "ok", {
        accounts: [{ id: "vercel-gateway-account", label: "Vercel AI Gateway", metrics }],
        summary: `${balance !== undefined ? `$${balance.toFixed(2)} left` : `$${primary.toFixed(2)} used`} · Vercel AI Gateway`,
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
