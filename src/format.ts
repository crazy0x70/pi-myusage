import type { Metric, UsageSnapshot } from "./types.ts";

export type QuotaWindowMetric = Extract<Metric, { kind: "quota-window" }>;

export function windowsSummary(windows: readonly QuotaWindowMetric[]): string | undefined {
  if (!windows.length) return undefined;
  const firstWord = (windows[0].label.split(" ")[0] ?? "").trim();
  const sharedPrefix =
    windows.length > 1 && firstWord && windows.every((w) => w.label.startsWith(`${firstWord} `))
      ? `${firstWord} `
      : "";
  const parts = windows.map((w, index) => {
    const label = sharedPrefix && index > 0 ? w.label.slice(sharedPrefix.length) : w.label;
    const reset = shortReset(w.resetAt);
    return `${label} ${Math.round(w.remainingFraction * 100)}%${reset ? ` (${reset})` : ""}`;
  });
  return parts.join(" · ");
}

export function shortReset(resetAt: string | undefined): string | undefined {
  const text = relativeTime(resetAt);
  if (!text) return undefined;
  if (text === "reset due") return "due";
  return text.replace(/^resets in /, "");
}

export function percentBar(fraction: number, width = 10): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const count = Math.round(clamped * width);
  return `${"━".repeat(count)}${"─".repeat(width - count)}`;
}

export function relativeTime(value?: string): string | undefined {
  if (!value) return undefined;
  const delta = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(delta)) return undefined;
  if (delta <= 0) return "reset due";
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 48) return `resets in ${hours}h${mins ? ` ${mins}m` : ""}`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function metricText(metric: Metric): string {
  switch (metric.kind) {
    case "balance": {
      const symbol =
        metric.currency === "CNY" || metric.currency === "RMB"
          ? "¥"
          : metric.currency === "USD"
            ? "$"
            : `${metric.currency} `;
      return `${metric.label}: ${symbol}${metric.amount.toFixed(2)}${metric.detail ? ` · ${metric.detail}` : ""}`;
    }
    case "quota-window": {
      const reset = relativeTime(metric.resetAt);
      return `${metric.label} ${percentBar(metric.remainingFraction)} ${Math.round(metric.remainingFraction * 100)}% left${reset ? ` · ${reset}` : ""}`;
    }
    case "usage-limit":
      return `${metric.label}: ${metric.used}/${metric.limit} ${metric.unit}`;
    case "status":
      return `${metric.label}: ${metric.value}`;
  }
}

export function compactStatus(snapshot: UsageSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.summary) return snapshot.summary;
  switch (snapshot.state) {
    case "ok":
    case "empty":
      return undefined;
    case "unauthorized":
      return `${snapshot.displayName}: auth needed`;
    case "unsupported":
      return `${snapshot.displayName}: unsupported`;
    default:
      return `${snapshot.displayName}: unavailable`;
  }
}

export function detailLines(snapshot: UsageSnapshot): string[] {
  const lines = [`${snapshot.displayName} [${snapshot.state}]`];
  if (snapshot.error) lines.push(`  Error: ${snapshot.error}`);
  if (!snapshot.accounts.length) lines.push("  No data");
  for (const account of snapshot.accounts) {
    lines.push(`  ${account.label}`);
    if (!account.metrics.length) lines.push("    No metrics reported");
    for (const metric of account.metrics) lines.push(`    ${metricText(metric)}`);
  }
  return lines;
}
