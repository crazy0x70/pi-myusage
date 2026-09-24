import { windowsSummary, type QuotaWindowMetric } from "../format.ts";
import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAccount, type UsageAdapter, type UsageSnapshot } from "../types.ts";

interface MiniMaxRemainsResponse {
  base_resp?: { status_code?: number };
  model_remains?: unknown[];
}

interface MiniMaxBalanceResponse {
  base_resp?: { status_code?: number };
  available_amount?: string;
  cash_balance?: string;
  voucher_balance?: string;
  credit_balance?: string;
  owed_amount?: string;
}

type Row = Record<string, unknown>;

const DECIMAL_AMOUNT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const WINDOW_FIELDS = [
  {
    id: "interval",
    label: "Rolling",
    count: "current_interval_usage_count",
    total: "current_interval_total_count",
    percent: "current_interval_remaining_percent",
    status: "current_interval_status",
    end: "end_time",
  },
  {
    id: "weekly",
    label: "Weekly",
    count: "current_weekly_usage_count",
    total: "current_weekly_total_count",
    percent: "current_weekly_remaining_percent",
    status: "current_weekly_status",
    end: "weekly_end_time",
  },
] as const;

function intVal(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function percentVal(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

export function resolveRemaining(reported: number, total: number, percent: number | undefined): number | undefined {
  if (total <= 0 || reported > total) return undefined;
  let remaining = reported;
  if (percent !== undefined) {
    const asRemaining = (reported / total) * 100;
    const asUsed = ((total - reported) / total) * 100;
    const remainingDistance = Math.abs(asRemaining - percent);
    const usedDistance = Math.abs(asUsed - percent);
    if (Math.min(remainingDistance, usedDistance) > 1) return undefined;
    if (usedDistance < remainingDistance) remaining = total - reported;
  }
  return remaining;
}

function windowMetric(
  row: Row,
  fields: (typeof WINDOW_FIELDS)[number],
  id: string,
  label: string,
): Metric | undefined {
  const status = intVal(row[fields.status]);
  if (status !== undefined && ![1, 2, 3].includes(status)) return undefined;
  const end = intVal(row[fields.end]);
  if (end === undefined || end <= 0) return undefined;
  const resetAt = new Date(end).toISOString();
  if (status === 3) return { kind: "quota-window", id, label, remainingFraction: 1, resetAt };
  const percent = percentVal(row[fields.percent]);
  const total = intVal(row[fields.total]) ?? 0;
  const count = intVal(row[fields.count]);
  if (total === 0) {
    if (percent === undefined || (count !== undefined && count !== 0)) return undefined;
    return { kind: "quota-window", id, label, remainingFraction: Math.min(1, percent / 100), resetAt };
  }
  if (count === undefined) return undefined;
  const remaining = resolveRemaining(count, total, percent);
  if (remaining === undefined) return undefined;
  return { kind: "quota-window", id, label, remainingFraction: Math.max(0, Math.min(1, remaining / total)), resetAt };
}

function balanceMetric(id: string, label: string, value: string | undefined, currency: string): Metric | undefined {
  if (value === undefined || !DECIMAL_AMOUNT.test(value)) return undefined;
  return { kind: "balance", id, label, amount: Number(value), currency };
}

export const minimaxAdapter: UsageAdapter = {
  id: "minimax",
  label: "MiniMax",

  canHandle(target) {
    const pid = target.providerId.toLowerCase();
    return (
      pid === "minimax" ||
      pid === "minimax-cn" ||
      urlOnDomain(target.baseUrl, "minimax.io") ||
      urlOnDomain(target.baseUrl, "minimaxi.com")
    );
  },

  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const cn = urlOnDomain(target.baseUrl, "minimaxi.com") || target.providerId.toLowerCase() === "minimax-cn";
      const root = cn ? "https://api.minimaxi.com" : "https://api.minimax.io";
      const currency = cn ? "CNY" : "USD";

      if (apiKey.startsWith("eyJ")) {
        const payload = await fetchJson<MiniMaxRemainsResponse>(
          `${root}/v1/token_plan/remains`,
          { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
          signal,
        );
        if (payload.base_resp?.status_code !== 0) {
          throw new Error("MiniMax usage response did not report success");
        }

        const accounts: UsageAccount[] = [];
        for (const [index, raw] of (payload.model_remains ?? []).entries()) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const row = raw as Row;
          const modelName =
            typeof row.model_name === "string" && row.model_name ? row.model_name : `Quota ${index + 1}`;
          const metrics = WINDOW_FIELDS.map((fields) =>
            windowMetric(row, fields, `minimax-${index}-${fields.id}`, `${modelName} ${fields.label}`),
          ).filter((metric): metric is Metric => metric !== undefined);
          if (metrics.length) accounts.push({ id: `minimax-${index}`, label: modelName, metrics });
        }
        if (!accounts.length) return snapshot(this, target, "empty");
        const windows = accounts[0].metrics.filter(
          (metric): metric is QuotaWindowMetric => metric.kind === "quota-window",
        );
        return snapshot(this, target, "ok", {
          accounts,
          summary: windowsSummary(windows),
        });
      }

      const payload = await fetchJson<MiniMaxBalanceResponse>(
        `${root}/account/query_balance`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
        signal,
      );
      if (payload.base_resp?.status_code !== 0) {
        throw new Error("MiniMax usage response did not report success");
      }

      const metrics = [
        balanceMetric("available", "Available balance", payload.available_amount, currency),
        balanceMetric("cash", "Cash balance", payload.cash_balance, currency),
        balanceMetric("voucher", "Voucher balance", payload.voucher_balance, currency),
        balanceMetric("credit", "Credit balance", payload.credit_balance, currency),
        balanceMetric("owed", "Owed amount", payload.owed_amount, currency),
      ].filter((metric): metric is Metric => metric !== undefined);
      if (!metrics.length) return snapshot(this, target, "empty");
      const primary = metrics[0];
      return snapshot(this, target, "ok", {
        accounts: [{ id: "minimax", label: `MiniMax (${currency})`, metrics }],
        summary:
          primary.kind === "balance"
            ? `${currency === "CNY" ? "¥" : "$"}${primary.amount.toFixed(2)} · MiniMax`
            : undefined,
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
