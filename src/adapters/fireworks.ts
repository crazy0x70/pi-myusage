import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const ORIGIN = "https://api.fireworks.ai";
const WINDOW_DAYS = 30;

interface AccountsResponse {
  accounts?: Array<{ name?: string }>;
}

interface LineItem {
  series?: string;
  totalCost?: { currencyCode?: string; units?: string | number; nanos?: string | number };
}

interface BillingSummaryResponse {
  lineItems?: LineItem[];
}

const SERIES_LABELS: Record<string, string> = {
  serverless: "Serverless",
  dedicated: "Dedicated",
  training: "Training",
  other: "Other",
};

function money(cost: LineItem["totalCost"]): { currency: string; amount: number } | undefined {
  if (!cost?.currencyCode) return undefined;
  const units = Number(cost.units ?? 0);
  const nanos = Number(cost.nanos ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return undefined;
  return { currency: cost.currencyCode, amount: Math.round((units + nanos / 1e9) * 100) / 100 };
}

export const fireworksAdapter: UsageAdapter = {
  id: "fireworks",
  label: "Fireworks",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "fireworks") return true;
    return urlOnDomain(target.baseUrl, "fireworks.ai");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });
      const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

      const accountsPayload = await fetchJson<AccountsResponse>(`${ORIGIN}/v1/accounts`, { headers }, signal);
      const first = accountsPayload.accounts?.[0]?.name?.match(/^accounts\/([^/]+)$/)?.[1];
      if (!first) return snapshot(this, target, "empty", { error: "No accounts returned" });

      const dayMs = 86_400_000;
      const day = (t: number) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const url =
        `${ORIGIN}/v1/accounts/${first}/billing/summary` +
        `?startTime=${day(now - (WINDOW_DAYS - 1) * dayMs)}T00:00:00Z&endTime=${day(now + dayMs)}T00:00:00Z`;
      const summary = await fetchJson<BillingSummaryResponse>(url, { headers }, signal);

      const totals = new Map<string, Map<string, number>>();
      for (const item of summary.lineItems ?? []) {
        const m = money(item.totalCost);
        if (!m) continue;
        const series = item.series === "SERVERLESS" ? "serverless"
          : item.series === "DEDICATED_DEPLOYMENT" ? "dedicated"
          : item.series === "TRAINING" ? "training"
          : "other";
        const bySeries = totals.get(m.currency) ?? new Map<string, number>();
        bySeries.set(series, Math.round(((bySeries.get(series) ?? 0) + m.amount) * 100) / 100);
        totals.set(m.currency, bySeries);
      }

      const metrics: Metric[] = [];
      let primaryValue = "";
      for (const [currency, bySeries] of totals) {
        const total = Math.round([...bySeries.values()].reduce((a, b) => a + b, 0) * 100) / 100;
        const detail = Object.entries(bySeries)
          .map(([series, v]) => `${SERIES_LABELS[series] ?? series} ${v.toFixed(2)}`)
          .join(" · ");
        const value = `${currency === "USD" ? "$" : ""}${total.toFixed(2)}${currency === "USD" ? "" : ` ${currency}`}`;
        if (!primaryValue) primaryValue = value;
        metrics.push({
          kind: "status",
          id: `fireworks-${currency.toLowerCase()}`,
          label: "Spend (30d)",
          value,
          detail: detail || undefined,
        });
      }
      if (!metrics.length) {
        return snapshot(this, target, "empty", { error: "No rated line items for the last 30 days" });
      }
      return snapshot(this, target, "ok", {
        accounts: [{ id: `fireworks-${first}`, label: `Fireworks (${first})`, metrics }],
        summary: `${primaryValue} spend (30d) · Fireworks`,
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
