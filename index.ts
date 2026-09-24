import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  codexFastAvailability,
  correctCodexFastMessage,
  fastModeIsEffective,
  fastSuffix,
  rewriteServiceTierPayload,
  tierForMode,
  type FastMode,
} from "./src/codex-fast.ts";
import { compactStatus, detailLines } from "./src/format.ts";
import { safeError } from "./src/http.ts";
import { adapterFor, configuredTargets, currentTarget, withCredentials } from "./src/match.ts";
import type { ProviderTarget, UsageAdapter, UsageSnapshot } from "./src/types.ts";

const REFRESH_INTERVAL_S = 300;

function fastModePath(): string {
  return join(getAgentDir(), "pi-myusage.json");
}

function loadFastMode(): FastMode {
  try {
    const raw = (JSON.parse(readFileSync(fastModePath(), "utf8")) as { codexFastMode?: unknown }).codexFastMode;
    if (raw === true || raw === "fast") return "fast";
    if (raw === "ultrafast") return "ultrafast";
    return false;
  } catch {
    return false;
  }
}

function saveFastMode(mode: FastMode): void {
  const path = fastModePath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ codexFastMode: mode }, null, 2)}\n`);
}

const STATUS_ID = "pi-myusage";

interface CacheEntry {
  snapshot: UsageSnapshot;
  at: number;
}

interface PendingFast {
  tier: string;
  model: Model<Api>;
}

export default function usagePlus(pi: ExtensionAPI) {
  let fastMode = loadFastMode();
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<UsageSnapshot | undefined>>();
  const pendingFast = new Map<string, PendingFast>();
  const liveControllers = new Set<AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastContext: ExtensionContext | undefined;
  let postTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPostTurnFetch = 0;

  const POST_TURN_DELAY_MS = 1_500;
  const POST_TURN_MIN_GAP_MS = 30_000;

  function schedulePostTurnRefresh(): void {
    if (postTurnTimer) return;
    postTurnTimer = setTimeout(() => {
      postTurnTimer = undefined;
      const ctx = lastContext;
      if (!ctx) return;
      if (Date.now() - lastPostTurnFetch < POST_TURN_MIN_GAP_MS) return;
      lastPostTurnFetch = Date.now();
      void refresh(ctx, true).catch(() => {});
    }, POST_TURN_DELAY_MS);
    postTurnTimer.unref?.();
  }

  const modelKey = (model: Model<Api> | undefined): string | undefined =>
    model ? `${model.provider}:${model.id}` : undefined;

  function render(ctx: ExtensionContext, snapshot: UsageSnapshot | undefined): void {
    let text = compactStatus(snapshot);
    const suffix = fastModeIsEffective(ctx.model, fastMode) ? fastSuffix(fastMode) : undefined;
    if (suffix) text = text ? `${text} · ${suffix}` : suffix;
    ctx.ui.setStatus(STATUS_ID, text);
  }

  async function fetchSnapshot(ctx: ExtensionContext, force: boolean): Promise<UsageSnapshot | undefined> {
    const target = currentTarget(ctx);
    const adapter = adapterFor(target);
    if (!target || !adapter) return undefined;
    const key = `${target.providerId}:${target.model?.id ?? ""}`;
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.at < REFRESH_INTERVAL_S * 1000) return cached.snapshot;

    const existing = inflight.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    const chainSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    liveControllers.add(controller);
    const request = (async (): Promise<UsageSnapshot | undefined> => {
      try {
        const prepared = await withCredentials(ctx, target);
        const snapshot = await adapter.fetch({ target: prepared, signal: chainSignal, force });
        cache.set(key, { snapshot, at: Date.now() });
        return snapshot;
      } catch (error) {
        if (controller.signal.aborted) return undefined;
        const snapshot: UsageSnapshot = {
          adapterId: adapter.id,
          sourceProviderId: target.providerId,
          displayName: adapter.label,
          state: "unavailable",
          fetchedAt: new Date().toISOString(),
          accounts: [],
          error: safeError(error),
        };
        if (!chainSignal.aborted) cache.set(key, { snapshot, at: Date.now() });
        return snapshot;
      } finally {
        inflight.delete(key);
        liveControllers.delete(controller);
        if (lastContext && modelKey(lastContext.model) === key) {
          render(lastContext, cache.get(key)?.snapshot);
        }
      }
    })();
    inflight.set(key, request);
    return request;
  }

  async function refresh(ctx: ExtensionContext, force = false): Promise<UsageSnapshot | undefined> {
    try {
      lastContext = ctx;
      const key = modelKey(ctx.model);
      const snapshot = await fetchSnapshot(ctx, force);
      if (!snapshot) {
        render(ctx, undefined);
        return undefined;
      }
      if (modelKey(ctx.model) === key) render(ctx, snapshot);
      return snapshot;
    } catch {
      return undefined;
    }
  }

  async function refreshConfigured(ctx: ExtensionContext): Promise<UsageSnapshot[]> {
    const prepared = await Promise.all(
      configuredTargets(ctx).map(async (target) => {
        const adapter = adapterFor(target);
        if (!adapter) return undefined;
        try {
          return { target: await withCredentials(ctx, target), adapter };
        } catch {
          return undefined;
        }
      }),
    );
    const entries = prepared
      .filter(
        (entry): entry is { target: ProviderTarget; adapter: UsageAdapter } =>
          entry !== undefined && Boolean(entry.target.credentials?.apiKey),
      )
      .slice(0, 20);
    const results = await Promise.all(
      entries.map(async ({ target, adapter }) => {
        try {
          return await adapter.fetch({ target, signal: AbortSignal.timeout(20_000), force: true });
        } catch (error) {
          return {
            adapterId: adapter.id,
            sourceProviderId: target.providerId,
            displayName: adapter.label,
            state: "unavailable" as const,
            fetchedAt: new Date().toISOString(),
            accounts: [],
            error: safeError(error),
          } satisfies UsageSnapshot;
        }
      }),
    );
    return results;
  }

  function startTimers(ctx: ExtensionContext): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (lastContext) void refresh(lastContext).catch(() => {});
    }, REFRESH_INTERVAL_S * 1000);
    timer.unref?.();
    lastContext = ctx;
  }

  async function usageCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = args.trim().split(/\s+/)[0] ?? "";
    if (action === "refresh") {
      const snapshot = await refresh(ctx, true);
      if (snapshot) ctx.ui.notify(detailLines(snapshot).join("\n"), "info");
      else ctx.ui.notify("Active provider has no usage adapter.", "warning");
      return;
    }
    if (action === "fast" || action === "ultrafast") {
      await fastCommand(action, ctx);
      return;
    }
    if (action) {
      ctx.ui.notify("Usage: /usage [refresh|fast]", "warning");
      return;
    }
    const snapshots = await refreshConfigured(ctx);
    if (!snapshots.length) {
      ctx.ui.notify("No configured providers with usage support found.", "warning");
      return;
    }
    ctx.ui.notify(snapshots.map(detailLines).map((lines) => lines.join("\n")).join("\n\n"), "info");
  }

  async function fastCommand(mode: "fast" | "ultrafast", ctx: ExtensionCommandContext): Promise<void> {
    const availability = codexFastAvailability(ctx.model, fastMode);
    if (availability.kind === "unavailable") {
      ctx.ui.notify(availability.reason, "warning");
      return;
    }
    fastMode = fastMode === mode ? false : mode;
    try {
      saveFastMode(fastMode);
    } catch (error) {
      ctx.ui.notify(`Could not save fast mode: ${safeError(error)}`, "error");
      return;
    }
    const label = mode === "ultrafast" ? "Ultrafast" : "Fast";
    ctx.ui.notify(
      fastMode === mode
        ? `${label} enabled (persistent). ${label === "Ultrafast" ? "Up to 14× faster." : "~1.5× faster, uses more of your plan allowance."}`
        : `${label} disabled; standard routing.`,
      "info",
    );
    await refresh(ctx);
  }

  pi.registerCommand("usage", {
    description: "Provider usage, quota and balance (/usage [refresh|fast|ultrafast])",
    handler: usageCommand,
  });
  pi.registerCommand("fast", {
    description: "Toggle persistent Fast routing (service_tier: priority)",
    handler: (_args, ctx) => fastCommand("fast", ctx),
  });
  pi.registerCommand("ultrafast", {
    description: "Toggle persistent Ultrafast routing (service_tier: ultrafast)",
    handler: (_args, ctx) => fastCommand("ultrafast", ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    fastMode = loadFastMode();
    cache.clear();
    startTimers(ctx);
    await refresh(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const rewritten = rewriteServiceTierPayload(event.payload, ctx.model, fastMode);
    const key = ctx.model ? `${ctx.sessionManager.getSessionId()}:${ctx.model.provider}/${ctx.model.id}` : undefined;
    if (key && ctx.model) {
      pendingFast.set(key, { tier: tierForMode(fastMode), model: ctx.model });
    }
    return rewritten;
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") return undefined;
    if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
    schedulePostTurnRefresh();
    const key = `${ctx.sessionManager.getSessionId()}:${message.provider}/${message.model}`;
    const pending = pendingFast.get(key);
    pendingFast.delete(key);
    if (!pending) return undefined;
    return correctCodexFastMessage(event.message, pending.model, pending.tier) as { message: never } | undefined;
  });

  pi.on("session_shutdown", async () => {
    if (postTurnTimer) clearTimeout(postTurnTimer);
    postTurnTimer = undefined;
    for (const controller of liveControllers) controller.abort();
    liveControllers.clear();
    if (timer) clearInterval(timer);
    timer = undefined;
    lastContext = undefined;
    pendingFast.clear();
    inflight.clear();
  });
}
