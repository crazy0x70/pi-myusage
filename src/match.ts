import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { codexAccountId, resolveCredentials } from "./auth.ts";
import { anthropicAdapter } from "./adapters/anthropic.ts";
import { basetenAdapter } from "./adapters/baseten.ts";
import { clineAdapter } from "./adapters/cline.ts";
import { cliproxyAdapter } from "./adapters/cliproxy.ts";
import { deepseekAdapter } from "./adapters/deepseek.ts";
import { fireworksAdapter } from "./adapters/fireworks.ts";
import { geminiAdapter } from "./adapters/gemini.ts";
import { githubCopilotAdapter } from "./adapters/github-copilot.ts";
import { glmAdapter } from "./adapters/glm.ts";
import { kimiAdapter } from "./adapters/kimi.ts";
import { minimaxAdapter } from "./adapters/minimax.ts";
import { openaiCodexAdapter } from "./adapters/openai-codex.ts";
import { opencodeGoAdapter } from "./adapters/opencode-go.ts";
import { openrouterAdapter } from "./adapters/openrouter.ts";
import { vertexAdapter } from "./adapters/vertex.ts";
import { vercelGatewayAdapter } from "./adapters/vercel.ts";
import { xaiAdapter } from "./adapters/xai.ts";
import type { ProviderTarget, UsageAdapter } from "./types.ts";

const adapters: readonly UsageAdapter[] = [
  openaiCodexAdapter,
  anthropicAdapter,
  kimiAdapter,
  openrouterAdapter,
  opencodeGoAdapter,
  minimaxAdapter,
  glmAdapter,
  deepseekAdapter,
  xaiAdapter,
  vertexAdapter,
  geminiAdapter,
  vercelGatewayAdapter,
  cliproxyAdapter,
  githubCopilotAdapter,
  fireworksAdapter,
  basetenAdapter,
  clineAdapter,
];

export function adapterFor(target: ProviderTarget | undefined): UsageAdapter | undefined {
  if (!target) return undefined;
  return adapters.find((adapter) => {
    try {
      return adapter.canHandle(target);
    } catch {
      return false;
    }
  });
}

function targetFor(ctx: ExtensionContext, model: Model<Api>): ProviderTarget {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  return {
    providerId: model.provider,
    model,
    provider,
    baseUrl: provider?.baseUrl ?? model.baseUrl,
  };
}

export function currentTarget(ctx: ExtensionContext): ProviderTarget | undefined {
  return ctx.model ? targetFor(ctx, ctx.model) : undefined;
}

export function configuredTargets(ctx: ExtensionContext): ProviderTarget[] {
  const seen = new Map<string, Model<Api>>();
  for (const model of ctx.modelRegistry.getAll()) {
    if (!seen.has(model.provider)) seen.set(model.provider, model);
  }
  return [...seen.values()].map((model) => targetFor(ctx, model));
}

export async function withCredentials(ctx: ExtensionContext, target: ProviderTarget): Promise<ProviderTarget> {
  const credentials = await resolveCredentials(ctx, target);
  if (target.providerId === "openai-codex" && credentials) {
    const accountId = await codexAccountId(ctx, credentials);
    if (accountId) return { ...target, credentials: { ...credentials, accountId } };
  }
  return { ...target, credentials };
}
