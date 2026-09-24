import { fetchJson, safeError, urlOrigin, urlOnDomain } from "../http.ts";
import { snapshot, type Metric, type UsageAdapter, type UsageSnapshot } from "../types.ts";

interface ApiUser {
  name?: string;
  requests?: number;
  expires?: string;
}

function isLocal(url: string | undefined): boolean {
  return urlOnDomain(url, "localhost") || urlOnDomain(url, "127.0.0.1");
}

export const cliproxyAdapter: UsageAdapter = {
  id: "cliproxyapi",
  label: "CLIProxyAPI",
  canHandle(target) {
    if (!target.providerId.toLowerCase().includes("cliproxy")) return false;
    return !target.baseUrl || isLocal(target.baseUrl);
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const origin = urlOrigin(target.baseUrl);
      const statusOnly = (): UsageSnapshot =>
        snapshot(this, target, "ok", {
          accounts: [
            {
              id: "cliproxy-local",
              label: "CLIProxyAPI",
              metrics: [{ kind: "status", id: "cliproxy-proxy", label: "Proxy", value: `configured ${origin ?? "local"}` }],
            },
          ],
          summary: "CLIProxy · local proxy",
        });

      const mgmtKey = process.env.CLIPROXY_MANAGEMENT_KEY;
      if (!mgmtKey || !origin) return statusOnly();

      let users: ApiUser[];
      try {
        users = await fetchJson<ApiUser[]>(
          `${origin}/v0/management/api-users`,
          { headers: { Authorization: `Bearer ${mgmtKey}`, Accept: "application/json" } },
          signal,
        );
      } catch {
        if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
        return statusOnly();
      }
      if (!Array.isArray(users)) return statusOnly();

      const metrics: Metric[] = users.slice(0, 5).map((user, index) => ({
        kind: "status",
        id: `cliproxy-${user.name ?? index}`,
        label: user.name ?? `user ${index + 1}`,
        value: `${typeof user.requests === "number" ? user.requests : 0} requests`,
        ...(user.expires ? { detail: `expires ${user.expires}` } : {}),
      }));
      if (!metrics.length) return statusOnly();
      return snapshot(this, target, "ok", {
        accounts: [{ id: "cliproxy-local", label: "CLIProxyAPI", metrics }],
        summary: `CLIProxy · ${users.length} api users`,
      });
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
