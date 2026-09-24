import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const BIGMODEL_ORIGIN = "https://open.bigmodel.cn";
const ZAI_ORIGIN = "https://api.z.ai";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";

const GLM_IDS = new Set(["glm", "zhipu", "bigmodel", "zai", "zai-coding-cn", "glm-v2max"]);

interface QuotaLimit {
  type?: string;
  percentage?: number;
  unit?: number;
  number?: number;
  nextResetTime?: number;
  currentValue?: number;
  usage?: number;
  remaining?: number;
}

interface QuotaLimitResponse {
  success?: boolean;
  data?: { level?: string; limits?: QuotaLimit[] };
}

export function glmWindowLabel(unit: number | undefined, quantity: number | undefined): { label: string; order: number } {
  const q = quantity ?? 1;
  if (unit === 3) return q === 5 ? { label: "5h", order: 0 } : { label: `${q}h`, order: 2 };
  if (unit === 6) return q === 1 ? { label: "7d", order: 1 } : { label: `${q}w`, order: 3 };
  return { label: `u${unit ?? "?"}·${q}`, order: 4 };
}

export function resetIso(nextResetTime: number | undefined): string | undefined {
  if (nextResetTime === undefined || !Number.isFinite(nextResetTime)) return undefined;
  const millis = nextResetTime < 10_000_000_000 ? nextResetTime * 1000 : nextResetTime;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export const glmAdapter: UsageAdapter = {
  id: "glm",
  label: "GLM / Zhipu",

  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    return (
      GLM_IDS.has(pid) ||
      (!target.baseUrl && pid.startsWith("glm-")) ||
      urlOnDomain(target.baseUrl, "bigmodel.cn") ||
      urlOnDomain(target.baseUrl, "z.ai")
    );
  },

  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const origin = urlOnDomain(target.baseUrl, "z.ai") ? ZAI_ORIGIN : BIGMODEL_ORIGIN;
      const payload = await fetchJson<QuotaLimitResponse>(
        `${origin}${QUOTA_PATH}`,
        { headers: { Authorization: apiKey, Accept: "application/json" } },
        signal,
      );

      const limits = payload.success ? (payload.data?.limits ?? []) : [];
      if (!limits.length) return snapshot(this, target, "empty");

      const metrics: Metric[] = [];
      const planLevel = payload.data?.level ? payload.data.level.toUpperCase() : "Coding Plan";

      const classified = limits
        .filter((limit) => limit.type === "TOKENS_LIMIT")
        .map((limit) => ({ limit, ...glmWindowLabel(limit.unit, limit.number) }))
        .sort((a, b) => a.order - b.order);
      for (const { limit, label } of classified) {
        const used = Math.max(0, Math.min(100, limit.percentage ?? 0));
        const resetAt = resetIso(limit.nextResetTime);
        metrics.push({
          kind: "quota-window",
          id: `glm-${label}`,
          label: `GLM ${label}`,
          remainingFraction: (100 - used) / 100,
          ...(resetAt ? { resetAt } : {}),
        });
      }

      const mcp = limits.find((limit) => limit.type === "TIME_LIMIT");
      if (mcp && mcp.usage !== undefined && mcp.usage > 0) {
        const remaining = mcp.remaining ?? mcp.usage - (mcp.currentValue ?? 0);
        metrics.push({
          kind: "quota-window",
          id: "glm-mcp",
          label: "MCP Monthly",
          remainingFraction: Math.max(0, Math.min(1, remaining / mcp.usage)),
          detail: `${mcp.currentValue ?? 0}/${mcp.usage}`,
        });
      }

      if (!metrics.length) return snapshot(this, target, "empty");
      metrics.push({ kind: "status", id: "glm-plan-level", label: "Plan", value: planLevel });

      const windows = metrics.filter(
        (metric): metric is QuotaWindowMetric => metric.kind === "quota-window" && metric.id !== "glm-mcp",
      );
      const summary = windowsSummary(windows) ?? `GLM · ${planLevel}`;
      return snapshot(this, target, "ok", {
        accounts: [{ id: "glm-coding-plan", label: `GLM ${planLevel}`, metrics }],
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
