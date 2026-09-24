import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, HttpError, safeError, urlOrigin, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const CODING_USAGES_URL = "https://api.kimi.com/coding/v1/usages";

const KIMI_IDS = new Set(["kimi", "kimi-coding", "moonshotai", "moonshotai-cn", "moonshot"]);

interface KimiQuotaDetail {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiUsagesResponse {
  usage?: KimiQuotaDetail;
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: KimiQuotaDetail }>;
}

interface MoonshotBalanceResponse {
  balance_infos?: Array<{ currency?: string; total_balance?: string }>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseFraction(detail: KimiQuotaDetail | undefined): number | undefined {
  if (!detail) return undefined;
  const lim = Number(detail.limit);
  const rem = Number(detail.remaining);
  if (Number.isFinite(rem) && Number.isFinite(lim) && lim > 0) return clamp01(rem / lim);
  const used = Number(detail.used);
  if (Number.isFinite(used) && Number.isFinite(lim) && lim > 0) return clamp01((lim - used) / lim);
  return undefined;
}

function isoTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function quotaExhaustedMessage(body: string): string | undefined {
  try {
    const data = JSON.parse(body) as {
      code?: string;
      message?: string;
      details?: Array<{ debug?: { reason?: string; localizedMessage?: { message?: string } } }>;
    };
    const detail = data.details?.[0]?.debug;
    if (data.code === "resource_exhausted" || detail?.reason === "REASON_QUOTA_EXCEEDED") {
      return detail?.localizedMessage?.message ?? data.message ?? "Quota exhausted";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const kimiAdapter: UsageAdapter = {
  id: "kimi",
  label: "Kimi / Moonshot",

  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    return (
      KIMI_IDS.has(pid) ||
      urlOnDomain(target.baseUrl, "api.kimi.com") ||
      urlOnDomain(target.baseUrl, "moonshot.cn") ||
      urlOnDomain(target.baseUrl, "moonshot.ai")
    );
  },

  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const pid = target.providerId.toLowerCase();
      const codingPlan =
        urlOnDomain(target.baseUrl, "api.kimi.com") || pid.includes("coding") || apiKey.startsWith("eyJ");

      if (codingPlan) {
        const payload = await fetchJson<KimiUsagesResponse>(
          CODING_USAGES_URL,
          { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
          signal,
        );

        const metrics: Metric[] = [];
        const fiveHour = payload.limits?.find(
          (limit) => limit.window?.duration === 300 && limit.window?.timeUnit === "TIME_UNIT_MINUTE",
        )?.detail;
        const fiveHourFraction = parseFraction(fiveHour);
        const fiveHourReset = isoTime(fiveHour?.resetTime);
        if (fiveHourFraction !== undefined) {
          metrics.push({
            kind: "quota-window",
            id: "kimi-5h",
            label: "Kimi 5h",
            remainingFraction: fiveHourFraction,
            ...(fiveHourReset ? { resetAt: fiveHourReset } : {}),
          });
        }
        const weeklyFraction = parseFraction(payload.usage);
        const weeklyReset = isoTime(payload.usage?.resetTime);
        if (weeklyFraction !== undefined) {
          metrics.push({
            kind: "quota-window",
            id: "kimi-weekly",
            label: "Kimi Weekly",
            remainingFraction: weeklyFraction,
            ...(weeklyReset ? { resetAt: weeklyReset } : {}),
          });
        }
        if (!metrics.length) return snapshot(this, target, "empty");
        const windows = metrics.filter(
          (metric): metric is QuotaWindowMetric => metric.kind === "quota-window",
        );
        return snapshot(this, target, "ok", {
          accounts: [{ id: "kimi-coding", label: "Kimi Coding", metrics }],
          summary: windowsSummary(windows),
        });
      }

      const origin =
        urlOrigin(target.baseUrl) ?? (pid.endsWith("-cn") ? "https://api.moonshot.cn" : "https://api.moonshot.ai");
      const payload = await fetchJson<MoonshotBalanceResponse>(
        `${origin}/v1/users/me/balance`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
        signal,
      );

      const accounts = (payload.balance_infos ?? []).map((info, index) => ({
        id: `kimi-${info.currency ?? index}`,
        label: info.currency === "CNY" ? "Account (CNY)" : `Account (${info.currency ?? "?"})`,
        metrics:
          info.total_balance !== undefined
            ? [
                {
                  kind: "balance" as const,
                  id: "total",
                  label: "Balance",
                  amount: Number(info.total_balance) || 0,
                  currency: info.currency ?? "CNY",
                },
              ]
            : [],
      }));
      const primary = accounts[0]?.metrics[0];
      if (!primary) return snapshot(this, target, "empty");
      return snapshot(this, target, "ok", {
        accounts,
        summary:
          primary.kind === "balance"
            ? `${primary.currency === "CNY" ? "¥" : "$"}${primary.amount.toFixed(2)} · Kimi`
            : undefined,
      });
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        return snapshot(this, target, "unauthorized", { error: `HTTP ${error.status}` });
      }
      if (error instanceof HttpError && error.status === 429) {
        const message = quotaExhaustedMessage(error.body);
        if (message) {
          return snapshot(this, target, "empty", {
            accounts: [
              {
                id: "kimi-coding",
                label: "Kimi Coding",
                metrics: [{ kind: "status", id: "kimi-quota", label: "Quota", value: message }],
              },
            ],
          });
        }
      }
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
