import { fetchJson, HttpError, safeError, urlOrigin } from "../http.ts";
import { snapshot, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const BALANCE_URL = "https://api.deepseek.com/user/balance";

interface BalanceResponse {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: string;
    granted_balance?: string;
    topped_up_balance?: string;
  }>;
}

export const deepseekAdapter: UsageAdapter = {
  id: "deepseek",
  label: "DeepSeek",
  canHandle(target) {
    if (target.providerId.toLowerCase() === "deepseek") return true;
    return urlOrigin(target.baseUrl) === "https://api.deepseek.com";
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const creds = target.credentials;
      const apiKey = creds?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      const payload = await fetchJson<BalanceResponse>(
        BALANCE_URL,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
        signal,
      );

      const accounts = (payload.balance_infos ?? []).map((info, index) => ({
        id: `deepseek-${info.currency ?? index}`,
        label: info.currency === "CNY" ? "Account (CNY)" : `Account (${info.currency ?? "?"})`,
        metrics: [
          ...(info.total_balance !== undefined
            ? [
                {
                  kind: "balance" as const,
                  id: "total",
                  label: "Balance",
                  amount: Number(info.total_balance) || 0,
                  currency: info.currency ?? "CNY",
                  detail:
                    info.granted_balance !== undefined || info.topped_up_balance !== undefined
                      ? `granted ${info.granted_balance ?? "0"} · topped up ${info.topped_up_balance ?? "0"}`
                      : undefined,
                },
              ]
            : []),
          ...(payload.is_available === false
            ? [{ kind: "status" as const, id: "availability", label: "Status", value: "insufficient balance" }]
            : []),
        ],
      }));
      if (!accounts.length) return snapshot(this, target, "empty");
      const primary = accounts[0].metrics[0];
      return snapshot(this, target, "ok", {
        accounts,
        summary:
          primary?.kind === "balance"
            ? `${primary.currency === "CNY" ? "¥" : "$"}${primary.amount.toFixed(2)} · DeepSeek`
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
