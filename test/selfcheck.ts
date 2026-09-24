import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  codexFastAvailability,
  codexFastCostMultiplier,
  correctCodexFastMessage,
  fastSuffix,
  rewriteServiceTierPayload,
  supportsCodexFastModelId,
  tierForMode,
} from "../src/codex-fast.ts";
import { compactStatus, metricText, percentBar, relativeTime, windowsSummary } from "../src/format.ts";
import { safeError, urlOnDomain, urlOrigin } from "../src/http.ts";
import { resolveRemaining } from "../src/adapters/minimax.ts";
import { glmWindowLabel, resetIso } from "../src/adapters/glm.ts";

function codexModel(id: string, baseUrl = "https://chatgpt.com/backend-api/codex"): Model<Api> {
  return { provider: "openai-codex", id, baseUrl, api: "openai-codex-responses" } as unknown as Model<Api>;
}

function otherModel(): Model<Api> {
  return { provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com", api: "openai-completions" } as unknown as Model<Api>;
}

function relayGptModel(): Model<Api> {
  return { provider: "my-relay", id: "gpt-5.6-sol", baseUrl: "https://relay.example/v1", api: "openai-responses" } as unknown as Model<Api>;
}

assert.equal(codexFastAvailability(otherModel(), false).kind, "unavailable");
assert.deepEqual(codexFastAvailability(codexModel("gpt-5.5"), "fast"), { kind: "available", mode: "fast" });
assert.deepEqual(codexFastAvailability(codexModel("gpt-5.5"), "ultrafast"), { kind: "available", mode: "ultrafast" });
assert.equal(codexFastAvailability(codexModel("gpt-4.1"), "fast").kind, "available");
assert.equal(codexFastAvailability(codexModel("o4-mini"), false).kind, "unavailable");
assert.equal(codexFastAvailability(relayGptModel(), false).kind, "available"); // gpt via any provider
assert.equal(codexFastAvailability(codexModel("gpt-5.5", "https://proxy.example/v1"), false).kind, "available"); // origin no longer gates
assert.equal(
  codexFastAvailability(
    { provider: "x", id: "gpt-9", baseUrl: "https://x.example", api: "anthropic-messages" } as unknown as Model<Api>,
    false,
  ).kind,
  "unavailable",
); // gpt id on a non-OpenAI api

assert.equal(supportsCodexFastModelId("gpt-5.5"), true);
assert.equal(supportsCodexFastModelId("GPT-6-NOVA"), true);
assert.equal(supportsCodexFastModelId("o3"), false);
assert.equal(supportsCodexFastModelId("codex-mini"), false);

const payload = { model: "gpt-5.5", messages: [] };
assert.equal((rewriteServiceTierPayload(payload, codexModel("gpt-5.5"), "fast") as { service_tier?: string }).service_tier, "priority");
assert.equal((rewriteServiceTierPayload(payload, codexModel("gpt-5.5"), "ultrafast") as { service_tier?: string }).service_tier, "ultrafast");
assert.equal((rewriteServiceTierPayload(payload, codexModel("gpt-5.5"), false) as { service_tier?: string }).service_tier, "default");
assert.equal(rewriteServiceTierPayload(payload, otherModel(), "fast"), undefined);
assert.equal((rewriteServiceTierPayload(payload, relayGptModel(), "ultrafast") as { service_tier?: string }).service_tier, "ultrafast"); // relay rewrite
assert.equal((rewriteServiceTierPayload(payload, codexModel("gpt-4.1"), "fast") as { service_tier?: string }).service_tier, "priority");
assert.equal(rewriteServiceTierPayload(payload, codexModel("o4-mini"), "fast"), undefined); // non-gpt: payload untouched
assert.deepEqual(payload, { model: "gpt-5.5", messages: [] });

assert.equal(tierForMode(false), "default");
assert.equal(tierForMode("fast"), "priority");
assert.equal(tierForMode("ultrafast"), "ultrafast");
assert.equal(fastSuffix(false), undefined);
assert.equal(fastSuffix("fast"), "fast");
assert.equal(fastSuffix("ultrafast"), "ultrafast");

const assistant = {
  role: "assistant",
  provider: "openai-codex",
  model: "gpt-5.5",
  usage: { cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, total: 3.5 } },
};
const corrected = correctCodexFastMessage(assistant, codexModel("gpt-5.5"), "priority")?.message as {
  usage: { cost: Record<string, number> };
};
assert.equal(corrected.usage.cost.input, 2.5); // ×2.5 for gpt-5.5
assert.equal(corrected.usage.cost.total, 8.75);
assert.equal(corrected.usage.cost.output, 5);
assert.equal(correctCodexFastMessage(assistant, codexModel("gpt-5.6-sol"), "priority")!.message && (correctCodexFastMessage(assistant, codexModel("gpt-5.6-sol"), "priority")!.message as { usage: { cost: Record<string, number> } }).usage.cost.input, 2); // ×2
assert.equal(correctCodexFastMessage(assistant, codexModel("gpt-5.5"), "ultrafast"), undefined); // ultrafast has no known multiplier
assert.equal(correctCodexFastMessage(assistant, codexModel("gpt-5.5"), "default"), undefined);
assert.equal(correctCodexFastMessage({ role: "user" }, codexModel("gpt-5.5"), "priority"), undefined);
assert.equal(correctCodexFastMessage(assistant, relayGptModel(), "priority"), undefined); // cost correction is official-endpoint only
assert.equal(codexFastCostMultiplier("gpt-5.5"), 2.5);
assert.equal(codexFastCostMultiplier("gpt-5.6-sol"), 2);

assert.equal(percentBar(0.5, 4), "━━──");
assert.equal(percentBar(0), "──────────");
assert.equal(percentBar(1, 2), "━━");
assert.equal(percentBar(-1), "──────────");
assert.match(relativeTime(new Date(Date.now() + 90 * 60_000).toISOString())!, /^resets in 1h( 3[0-9]m)?$/);
assert.equal(relativeTime(new Date(Date.now() - 1000).toISOString()), "reset due");
assert.equal(relativeTime(undefined), undefined);
assert.equal(relativeTime("not-a-date"), undefined);
assert.match(
  metricText({ kind: "balance", id: "x", label: "Balance", amount: 12.3456, currency: "CNY" }),
  /^Balance: ¥12\.35$/,
);
assert.match(
  metricText({ kind: "usage-limit", id: "x", label: "Credits", used: 3, limit: 10, unit: "USD" }),
  /^Credits: 3\/10 USD$/,
);
assert.equal(
  compactStatus({ adapterId: "a", sourceProviderId: "p", displayName: "X", state: "ok", fetchedAt: "", accounts: [] }),
  undefined,
);
assert.equal(compactStatus({ adapterId: "a", sourceProviderId: "p", displayName: "X", state: "ok", fetchedAt: "", accounts: [], summary: "X 62%" }), "X 62%");
assert.match(compactStatus({ adapterId: "a", sourceProviderId: "p", displayName: "X", state: "unauthorized", fetchedAt: "", accounts: [] })!, /auth needed/);

assert.equal(urlOrigin("https://api.z.ai/v1"), "https://api.z.ai");
assert.equal(urlOrigin("garbage"), undefined);
assert.equal(urlOrigin(undefined), undefined);
assert.equal(urlOnDomain("https://open.bigmodel.cn/api/v1", "bigmodel.cn"), true);
assert.equal(urlOnDomain("https://api.evil-bigmodel.cn/", "bigmodel.cn"), false);
assert.equal(urlOnDomain("https://sub.z.ai/", "z.ai"), true);
assert.equal(urlOnDomain(undefined, "z.ai"), false);

assert.equal(safeError(new Error("HTTP 401: Bearer sk-abcdefghijklmnopqrstuvwxyz012345")), "HTTP 401: Bearer …");
assert.equal(safeError("plain failure"), "plain failure");

assert.equal(resolveRemaining(20, 100, 20), 20); // reported==remaining
assert.equal(resolveRemaining(80, 100, 20), 20); // reported==used → remaining=total-used
assert.equal(resolveRemaining(50, 100, 90), undefined); // ambiguous beyond 1% tolerance
assert.equal(resolveRemaining(150, 100, 50), undefined); // reported>total invalid
assert.equal(resolveRemaining(30, 100, undefined), 30); // no percent → trust reported

{
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const later = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
  const summary = windowsSummary([
    { kind: "quota-window", id: "glm-5h", label: "GLM 5h", remainingFraction: 0.56, resetAt: soon },
    { kind: "quota-window", id: "glm-7d", label: "GLM 7d", remainingFraction: 0.82, resetAt: later },
  ])!;
  assert.match(summary, /^GLM 5h 56% \(5m\)/);
  assert.match(summary, /7d 82% \(3d( 0h)?\)$/);
}
assert.equal(
  windowsSummary([{ kind: "quota-window", id: "x", label: "Codex 5h", remainingFraction: 1 }]),
  "Codex 5h 100%",
);
assert.equal(windowsSummary([]), undefined);
assert.ok(
  windowsSummary([
    { kind: "quota-window", id: "a", label: "Claude 5h", remainingFraction: 0.3, resetAt: new Date(Date.now() - 1000).toISOString() },
  ])!.endsWith("30% (due)"),
  "past reset times render as due",
);

assert.deepEqual(glmWindowLabel(3, 5), { label: "5h", order: 0 });
assert.deepEqual(glmWindowLabel(3, 12), { label: "12h", order: 2 });
assert.deepEqual(glmWindowLabel(6, 1), { label: "7d", order: 1 });
assert.deepEqual(glmWindowLabel(6, 2), { label: "2w", order: 3 });
assert.deepEqual(glmWindowLabel(9, 3), { label: "u9·3", order: 4 });
assert.deepEqual(glmWindowLabel(undefined, undefined), { label: "u?·1", order: 4 });
assert.equal(resetIso(1_700_000_000), new Date(1_700_000_000_000).toISOString());
assert.equal(resetIso(1_700_000_000_000), new Date(1_700_000_000_000).toISOString());
assert.equal(resetIso(Number.NaN), undefined);

console.log("selfcheck: all assertions passed");
