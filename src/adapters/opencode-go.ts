import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

interface UsageWindow {
  status?: string;
  percent?: number;
  resetsAt?: string;
}

interface UsageResponse {
  usage?: {
    rolling?: UsageWindow;
    weekly?: UsageWindow;
    monthly?: UsageWindow;
  };
}

function windowMetric(id: string, label: string, w: UsageWindow | undefined): Metric | undefined {
  if (w?.status && w.status !== "ok" && w.status !== "rate-limited") return undefined;
  if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) return undefined;
  const used = Math.min(100, Math.max(0, w.percent));
  const resetAt =
    w.resetsAt && !Number.isNaN(Date.parse(w.resetsAt)) ? new Date(w.resetsAt).toISOString() : undefined;
  return {
    kind: "quota-window",
    id,
    label,
    remainingFraction: Math.max(0, (100 - used) / 100),
    ...(resetAt ? { resetAt } : {}),
  };
}

export const opencodeGoAdapter: UsageAdapter = {
  id: "opencode-go",
  label: "OpenCode Zen",
  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    if (["opencode-go", "opencode", "opencode-zen"].includes(pid)) return true;
    return urlOnDomain(target.baseUrl, "opencode.ai");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      let payload: UsageResponse;
      try {
        payload = await fetchJson<UsageResponse>(
          USAGE_URL,
          { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
          signal,
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          return snapshot(this, target, "unauthorized", { error: safeError(error) });
        }
        throw error;
      }

      const metrics = [
        windowMetric("opencode-go-5h", "OpenCode 5h", payload.usage?.rolling),
        windowMetric("opencode-go-weekly", "OpenCode Weekly", payload.usage?.weekly),
        windowMetric("opencode-go-monthly", "OpenCode Monthly", payload.usage?.monthly),
      ].filter((m): m is QuotaWindowMetric => m !== undefined);
      if (!metrics.length) return snapshot(this, target, "empty", { error: "No usage windows returned" });

      const summary = windowsSummary(metrics);
      return snapshot(this, target, "ok", {
        accounts: [{ id: "opencode-go-account", label: "OpenCode Zen", metrics }],
        summary: summary ? `${summary} · Zen` : "Zen",
      });
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
