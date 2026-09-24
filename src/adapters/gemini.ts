import { fetchJson, HttpError, safeError, urlOnDomain } from "../http.ts";
import { snapshot, type UsageAdapter, type UsageSnapshot } from "../types.ts";

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface ModelsResponse {
  models?: unknown[];
}

export const geminiAdapter: UsageAdapter = {
  id: "gemini",
  label: "Gemini API",
  canHandle(target) {
    if (["gemini", "google-ai-studio", "aistudio"].includes(target.providerId.toLowerCase())) return true;
    return urlOnDomain(target.baseUrl, "generativelanguage.googleapis.com");
  },
  async fetch({ target, signal }): Promise<UsageSnapshot> {
    try {
      const apiKey = target.credentials?.apiKey;
      if (!apiKey) return snapshot(this, target, "unauthorized", { error: "No API key" });

      let payload: ModelsResponse;
      try {
        payload = await fetchJson<ModelsResponse>(
          MODELS_URL,
          { headers: { "x-goog-api-key": apiKey, Accept: "application/json" } },
          signal,
        );
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          return snapshot(this, target, "unauthorized", { error: safeError(error) });
        }
        throw error;
      }

      const count = Array.isArray(payload.models) ? payload.models.length : 0;
      return snapshot(this, target, "ok", {
        accounts: [
          {
            id: "gemini-key",
            label: "Gemini API",
            metrics: [{ kind: "status", id: "gemini-key", label: "Key", value: `valid · ${count} models` }],
          },
        ],
        summary: `Gemini key ok · ${count} models`,
      });
    } catch (error) {
      if (signal.aborted) return snapshot(this, target, "unavailable", { error: "aborted" });
      return snapshot(this, target, "unavailable", { error: safeError(error) });
    }
  },
};
