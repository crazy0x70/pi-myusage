import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

interface WhamUsageResponse {
  rate_limit?: {
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
  } | null;
  credits?: {
    has_credits?: boolean;
    balance?: string;
  } | null;
}

function windowLabel(window: WhamWindow | null | undefined, fallback: string): string {
  const seconds = window?.limit_window_seconds;
  if (seconds === 18_000) return "Codex 5h";
  if (seconds === 604_800) return "Codex 7d";
  if (typeof seconds === "number" && seconds > 0) {
    if (seconds % 86_400 === 0) return `Codex ${seconds / 86_400}d`;
    if (seconds % 3_600 === 0) return `Codex ${seconds / 3_600}h`;
  }
  return fallback;
}

function parseWindow(
  window: WhamWindow | null | undefined,
  id: string,
  fallbackLabel: string,
): Metric | undefined {
  if (!window || typeof window.used_percent !== "number") return undefined;
  const used = Math.min(100, Math.max(0, window.used_percent));
  const remainingFraction = Math.min(1, Math.max(0, (100 - used) / 100));

  let resetAt: string | undefined;
  if (typeof window.reset_at === "number" && window.reset_at > 0) {
    resetAt = new Date(window.reset_at * 1000).toISOString();
  } else if (typeof window.reset_after_seconds === "number" && window.reset_after_seconds > 0) {
    resetAt = new Date(Date.now() + window.reset_after_seconds * 1000).toISOString();
  }

  return {
    kind: "quota-window",
    id,
    label: windowLabel(window, fallbackLabel),
    remainingFraction,
    ...(resetAt ? { resetAt } : {}),
  };
}

export const openaiCodexAdapter: UsageAdapter = {
  id: "openai-codex",
  label: "OpenAI Codex",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "openai-codex") return true;
    return urlOnDomain(target.baseUrl, "chatgpt.com");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const creds = target.credentials;
      const apiKey = creds?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "pi-myusage",
      };
      if (creds?.accountId) headers["chatgpt-account-id"] = creds.accountId;

      const payload = await fetchJson<WhamUsageResponse>(USAGE_URL, { headers }, signal);

      const metrics: Metric[] = [];
      const primary = parseWindow(payload.rate_limit?.primary_window, "primary", "Codex 5h");
      if (primary) metrics.push(primary);
      const secondary = parseWindow(payload.rate_limit?.secondary_window, "secondary", "Codex 7d");
      if (secondary) metrics.push(secondary);

      const credits = payload.credits;
      if (credits?.has_credits === true) {
        metrics.push({
          kind: "status",
          id: "codex-credits",
          label: "Credits",
          value: credits.balance ?? "enabled",
        });
      }

      if (!metrics.length) return snapshot(this, target, "empty");

      const windows = metrics.filter(
        (metric): metric is QuotaWindowMetric => metric.kind === "quota-window",
      );
      const creditsMetric = metrics.find((metric) => metric.kind === "status");
      let summary = windowsSummary(windows);
      if (!summary && creditsMetric && creditsMetric.kind === "status") {
        summary = `Codex · credits ${creditsMetric.value}`;
      }

      return snapshot(this, target, "ok", {
        accounts: [{ id: "openai-codex", label: "Codex", metrics }],
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
