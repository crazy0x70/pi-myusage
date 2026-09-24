import { getAgentDir, readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credentials, ProviderTarget } from "./types.ts";

function bearerOf(headers: Record<string, string> | undefined, apiKey: string | undefined): string | undefined {
  const auth = headers?.Authorization ?? headers?.authorization;
  if (auth) return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return apiKey;
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

async function readAuthJson(): Promise<Record<string, Record<string, unknown>>> {
  try {
    return JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as never;
  } catch {
    return {};
  }
}

const STATIC_CREDENTIAL_TTL_MS = 30_000;
const credentialMemo = new Map<string, { value: Credentials | undefined; at: number }>();

export async function resolveCredentials(
  ctx: ExtensionContext,
  target: ProviderTarget,
): Promise<Credentials | undefined> {
  const memo = credentialMemo.get(target.providerId);
  if (memo && Date.now() - memo.at <= STATIC_CREDENTIAL_TTL_MS) return memo.value;
  const resolved = await resolveCredentialsUncached(ctx, target);
  const oauth = Boolean(target.model && ctx.modelRegistry.isUsingOAuth(target.model));
  if (resolved === undefined || (resolved.source === "model" && !oauth)) {
    credentialMemo.set(target.providerId, { value: resolved, at: Date.now() });
  }
  return resolved;
}

async function attempt<T>(step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step();
  } catch {
    return undefined;
  }
}

async function resolveCredentialsUncached(
  ctx: ExtensionContext,
  target: ProviderTarget,
): Promise<Credentials | undefined> {
  const model = target.model;
  if (model) {
    const resolved = await attempt(() => ctx.modelRegistry.getApiKeyAndHeaders(model));
    if (resolved?.ok) {
      const headers = normalizeHeaders(resolved.headers);
      const apiKey = bearerOf(headers, resolved.apiKey);
      if (apiKey || headers) {
        return { apiKey, headers, baseUrl: resolved.baseUrl ?? model.baseUrl, source: "model" };
      }
    }
  }

  const providerAuth = await attempt(() => ctx.modelRegistry.getProviderAuth(target.providerId));
  if (providerAuth) {
    const auth = providerAuth.auth;
    const headers = normalizeHeaders(auth?.headers);
    const apiKey = auth ? bearerOf(headers, auth.apiKey) : undefined;
    if (apiKey || headers) {
      return { apiKey, headers, baseUrl: auth?.baseUrl ?? target.baseUrl, source: "provider" };
    }
  }

  const stored = readStoredCredential(target.providerId);
  if (stored && typeof stored === "object") {
    const record = stored as Record<string, unknown>;
    const headers = normalizeHeaders(record.headers);
    const apiKey = bearerOf(headers, record.apiKey as string | undefined);
    if (apiKey) return { apiKey, headers, source: "stored" };
  }

  const raw = (await readAuthJson())[target.providerId];
  if (raw) {
    const headers = normalizeHeaders(raw.headers);
    const apiKey = bearerOf(headers, raw.apiKey as string | undefined);
    if (apiKey) return { apiKey, headers, source: "stored" };
  }
  return undefined;
}

export async function codexAccountId(_ctx: ExtensionContext, creds: Credentials | undefined): Promise<string | undefined> {
  if (creds?.headers?.["chatgpt-account-id"] ?? creds?.headers?.["ChatGPT-Account-Id"]) {
    return (creds.headers["chatgpt-account-id"] ?? creds.headers["ChatGPT-Account-Id"]) as string;
  }
  const raw = (await readAuthJson())["openai-codex"];
  const id = raw?.accountId ?? raw?.chatgpt_account_id ?? raw?.account_id;
  return typeof id === "string" ? id : undefined;
}
