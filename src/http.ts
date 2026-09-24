export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export async function fetchJson<T>(
  url: string | URL,
  init: RequestInit & { timeoutMs?: number },
  signal?: AbortSignal,
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      redirect: "error",
      ...rest,
      signal: AbortSignal.any([rest.signal ?? controller.signal, controller.signal]),
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, text);
    try {
      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch {
      throw new Error(`Invalid JSON from ${new URL(url.toString()).origin}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function urlOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function urlOnDomain(url: string | undefined, domain: string): boolean {
  const origin = urlOrigin(url);
  if (!origin) return false;
  try {
    return new URL(origin).hostname === domain || new URL(origin).hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]{24,}/g, "…").slice(0, 300);
}
