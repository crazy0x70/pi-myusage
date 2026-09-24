import { urlOnDomain } from "../http.ts";
import { snapshot, type UsageAdapter, type UsageSnapshot } from "../types.ts";

export const vertexAdapter: UsageAdapter = {
  id: "google-vertex",
  label: "Google Vertex AI",
  canHandle(target) {
    if (["vertex", "google-vertex", "vertex-ai"].includes(target.providerId.toLowerCase())) return true;
    return urlOnDomain(target.baseUrl, "aiplatform.googleapis.com") || urlOnDomain(target.baseUrl, "geminivertexai");
  },
  async fetch({ target }): Promise<UsageSnapshot> {
    return snapshot(this, target, "ok", {
      accounts: [
        {
          id: "vertex-billing",
          label: "Google Vertex AI",
          metrics: [{ kind: "status", id: "vertex-billing", label: "Billing", value: "pay-as-you-go (GCP billing)" }],
        },
      ],
      summary: "Vertex · PAYG",
    });
  },
};
