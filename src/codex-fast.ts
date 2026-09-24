import type { Api, Model } from "@earendil-works/pi-ai";

export type FastMode = false | "fast" | "ultrafast";

export const FAST_TIER = "priority";
export const ULTRAFAST_TIER = "ultrafast";
const STANDARD_TIER = "default";

export function supportsCodexFastModelId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("gpt-");
}

export function codexFastCostMultiplier(modelId: string): number {
  return modelId === "gpt-5.5" ? 2.5 : 2;
}

export function tierForMode(mode: FastMode): string {
  if (mode === "ultrafast") return ULTRAFAST_TIER;
  if (mode === "fast") return FAST_TIER;
  return STANDARD_TIER;
}

function isOpenAiApi(model: Model<Api> | undefined): boolean {
  return typeof model?.api === "string" && model.api.startsWith("openai");
}

function isOfficialCodexModel(model: Model<Api> | undefined): boolean {
  if (!model || model.provider !== "openai-codex") return false;
  try {
    return new URL(model.baseUrl).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

export type CodexFastAvailability =
  | { kind: "available"; mode: FastMode }
  | { kind: "unavailable"; reason: string };

/** Fast and Ultrafast apply to any gpt-* model on an OpenAI-family API, regardless of provider or gateway. */
export function codexFastAvailability(model: Model<Api> | undefined, mode: FastMode): CodexFastAvailability {
  if (!model) return { kind: "unavailable", reason: "No active model." };
  if (!supportsCodexFastModelId(model.id)) {
    return { kind: "unavailable", reason: `${model.id} does not support Fast or Ultrafast.` };
  }
  if (!isOpenAiApi(model)) {
    return { kind: "unavailable", reason: "Fast and Ultrafast require an OpenAI-family API." };
  }
  return { kind: "available", mode };
}

export function rewriteServiceTierPayload(
  payload: unknown,
  model: Model<Api> | undefined,
  mode: FastMode,
): unknown | undefined {
  if (!model || !supportsCodexFastModelId(model.id) || !isOpenAiApi(model) || !isRecord(payload)) {
    return undefined;
  }
  return { ...payload, service_tier: tierForMode(mode) };
}

export function fastSuffix(mode: FastMode): string | undefined {
  return mode === false ? undefined : mode;
}

export function fastModeIsEffective(model: Model<Api> | undefined, mode: FastMode): boolean {
  return mode !== false && codexFastAvailability(model, mode).kind === "available";
}

/** Cost correction (×2/×2.5 priority pricing) applies only to Fast on the official Codex endpoint. */
export function correctCodexFastMessage(
  message: unknown,
  model: Model<Api> | undefined,
  tier: string,
): { message: unknown } | undefined {
  if (tier !== FAST_TIER || !isOfficialCodexModel(model) || !isRecord(message) || message.role !== "assistant") {
    return undefined;
  }
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
  if (!usage || !cost) return undefined;
  const multiplier = codexFastCostMultiplier(model?.id ?? "");
  const corrected = structuredClone(usage) as Record<string, unknown>;
  const correctedCost = corrected.cost as Record<string, number>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (typeof correctedCost[key] === "number") correctedCost[key] *= multiplier;
  }
  return { message: { ...message, usage: corrected } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
