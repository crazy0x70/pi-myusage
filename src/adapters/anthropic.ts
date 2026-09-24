import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

interface OAuthWindow {
  utilization?: number;
  resets_at?: string;
}

interface StructuredLimit {
  kind?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string; id?: string } };
}

interface OAuthUsageResponse {
  five_hour?: OAuthWindow | null;
  seven_day?: OAuthWindow | null;
  seven_day_sonnet?: OAuthWindow | null;
  seven_day_opus?: OAuthWindow | null;
  seven_day_oauth_apps?: OAuthWindow | null;
  limits?: StructuredLimit[];
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
  } | null;
}

type QuotaMetric = Extract<Metric, { kind: "quota-window" }>;

function quotaMetric(id: string, label: string, utilization: unknown, resetAt?: string): QuotaMetric | undefined {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  const used = Math.max(0, Math.min(100, utilization));
  const parsedReset = resetAt && Number.isFinite(Date.parse(resetAt)) ? new Date(resetAt).toISOString() : undefined;
  return {
    kind: "quota-window",
    id,
    label,
    remainingFraction: (100 - used) / 100,
    ...(parsedReset ? { resetAt: parsedReset } : {}),
  };
}

function parseOAuthMetrics(data: OAuthUsageResponse): Metric[] {
  const metrics: Metric[] = [];
  const flat = [
    quotaMetric("claude-5h", "Claude 5h", data.five_hour?.utilization, data.five_hour?.resets_at),
    quotaMetric("claude-7d", "Claude 7d", data.seven_day?.utilization, data.seven_day?.resets_at),
    quotaMetric("claude-7d-sonnet", "Claude 7d Sonnet", data.seven_day_sonnet?.utilization, data.seven_day_sonnet?.resets_at),
    quotaMetric("claude-7d-opus", "Claude 7d Opus", data.seven_day_opus?.utilization, data.seven_day_opus?.resets_at),
    quotaMetric("claude-7d-oauth", "Claude 7d OAuth", data.seven_day_oauth_apps?.utilization, data.seven_day_oauth_apps?.resets_at),
  ].filter((metric): metric is QuotaMetric => Boolean(metric));
  metrics.push(...flat);

  if (Array.isArray(data.limits)) {
    for (const [index, limit] of data.limits.entries()) {
      const kind = (limit.kind ?? "").toLowerCase();
      const modelName = limit.scope?.model?.display_name || limit.scope?.model?.id;
      const id = kind === "session"
        ? "claude-session"
        : kind === "weekly_all"
          ? "claude-7d"
          : `claude-weekly-${modelName?.toLowerCase().replace(/[^a-z0-9]+/g, "-") || index}`;
      if (metrics.some((metric) => metric.kind === "quota-window" && metric.id === id)) continue;
      const label = kind === "session"
        ? "Claude Session"
        : kind === "weekly_all"
          ? "Claude 7d"
          : modelName
            ? `Claude 7d ${modelName}`
            : "Claude Weekly";
      const metric = quotaMetric(id, label, limit.percent, limit.resets_at);
      if (metric) metrics.push(metric);
    }
  }

  const extra = data.extra_usage;
  if (extra?.is_enabled && typeof extra.utilization === "number") {
    const metric = quotaMetric("claude-extra-monthly", "Claude Extra Monthly", extra.utilization);
    if (metric) metrics.push(metric);
  }
  if (extra?.is_enabled && typeof extra.monthly_limit === "number" && typeof extra.used_credits === "number") {
    metrics.push({
      kind: "usage-limit",
      id: "claude-extra-credits",
      label: "Extra usage",
      used: extra.used_credits,
      limit: extra.monthly_limit,
      unit: "credits",
    });
  }

  return metrics;
}

function quotaSummary(metrics: Metric[]): string | undefined {
  const quotas = metrics.filter((metric): metric is QuotaWindowMetric => metric.kind === "quota-window");
  const session = quotas.find((metric) => metric.id === "claude-5h" || metric.id === "claude-session");
  const weekly = quotas.find((metric) => metric.id === "claude-7d")
    ?? quotas.find((metric) => metric.id.startsWith("claude-7d-") || metric.id.startsWith("claude-weekly-"));
  return windowsSummary([session, weekly].filter((metric): metric is QuotaWindowMetric => Boolean(metric)));
}

export const anthropicAdapter: UsageAdapter = {
  id: "anthropic",
  label: "Anthropic Claude",
  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    if (pid === "anthropic" || pid === "claude") return true;
    return urlOnDomain(target.baseUrl, "anthropic.com");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const token = target.credentials?.apiKey;
      if (!token) return snapshot(this, target, "unauthorized", { error: "No API key" });

      try {
        const payload = await fetchJson<OAuthUsageResponse>(
          OAUTH_USAGE_URL,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "oauth-2025-04-20",
              "User-Agent": "claude-cli (external, cli)",
              "x-app": "cli",
            },
          },
          signal,
        );

        const metrics = parseOAuthMetrics(payload);
        if (!metrics.length) return snapshot(this, target, "empty");
        return snapshot(this, target, "ok", {
          accounts: [{ id: "claude-subscription", label: "Claude Subscription", metrics }],
          summary: quotaSummary(metrics),
        });
      } catch (oauthError) {
        if (signal.aborted) throw oauthError;
        const rejected = oauthError instanceof HttpError && (oauthError.status === 401 || oauthError.status === 403);
        if (!rejected) throw oauthError;
      }

      return snapshot(this, target, "ok", {
        accounts: [
          {
            id: "claude-api-key",
            label: "Claude API Account",
            metrics: [
              { kind: "status", id: "claude-billing", label: "Billing", value: "API key (pay-as-you-go)" },
            ],
          },
        ],
        summary: "Claude API key · PAYG",
      });
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
