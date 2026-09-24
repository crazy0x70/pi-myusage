# 📊 pi-myusage — Provider Usage, API Balance, and Codex Fast Mode for Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Inspect usage windows and API balances for Pi's active provider account, query every other configured provider, and toggle persistent Fast routing for OpenAI Codex models.
The extension keeps each provider's native quota, allowance, and billing semantics instead of treating unlike values as equivalent, and resolves credentials current-model-first so any number of custom providers in `models.json` — with plain API keys or OAuth — report correctly.

## ✨ Features

- Shows the active provider's usage windows or balance on a single statusline line, each window carrying its own reset countdown.
- `/usage` reports every provider that has both a usage adapter and resolvable credentials; unconfigured providers are skipped instead of surfacing auth noise.
- Toggles persistent Fast and Ultrafast routing for `gpt-*` models on any OpenAI-compatible provider through `/fast` and `/ultrafast`.
- Matches adapters from the active model itself (provider id aliases, base URL origin, id family) — no fixed provider-id assumptions, no official-origin refusals.
- Resolves credentials through Pi's runtime auth chain (`getApiKeyAndHeaders` → provider auth → stored credentials), with a 30-second memo for static keys only; OAuth paths always re-resolve so token refresh keeps working.
- Refreshes after every completed turn (bounded to one fetch per 30 s), on model switch, on session start, and on a configurable timer; in-flight requests are deduplicated and aborted on shutdown.
- Multi-request providers (Cline, OpenRouter) fetch independent endpoints in parallel; failed lookups degrade to per-provider snapshots instead of failing the report.

## 📦 Install

Requires Pi 0.84.0 or newer (`getApiKeyAndHeaders`, `before_provider_request` payload replacement).

```bash
pi install npm:pi-myusage
```

Try without installing permanently:

```bash
pi -e npm:pi-myusage
```

Or point Pi at a local checkout — the package ships raw TypeScript and needs no build step:

```bash
pi install ./pi-myusage
```

## 🚀 Quick start

Start Pi and wait a moment: the statusline shows the active provider's windows, for example `GLM 5h 56% (2m) · 7d 82% (3d 4h)` or `$12.34 · DeepSeek`.
Run `/usage` for every configured provider's details, `/usage refresh` to force a fresh fetch, and `/fast` (on a supported Codex model) to toggle Fast routing.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/usage` | Report usage for every provider with an adapter and configured credentials. |
| `/usage refresh` | Force a fresh fetch of the active provider. |
| `/usage fast` | Same as `/fast`. |
| `/usage ultrafast` | Same as `/ultrafast`. |
| `/fast` | Toggle persistent Fast routing (`service_tier: priority`) for the active `gpt-*` model. |
| `/ultrafast` | Toggle persistent Ultrafast routing (`service_tier: ultrafast`), the separate Cerebras-backed tier. |

## ⚙️ Settings

Preferences live in `pi-myusage.json` under Pi's user agent directory, normally `~/.pi/agent/pi-myusage.json`.
It holds a single field — `codexFastMode`: `false`, `"fast"`, or `"ultrafast"` — written by `/fast` and `/ultrafast` and read at every session start (`true` from older versions is read as `"fast"`).
The statusline auto-refresh interval is fixed at 300 seconds; usage always refreshes after each completed turn as well.

### Fast and Ultrafast modes

Two independent service tiers, mutually exclusive, each toggled by its own command:

- **Fast** (`/fast`) sends `service_tier: "priority"` — about 1.5× faster (up to 2.5× on `gpt-5.6-sol`), uses more of your plan allowance; message costs are corrected ×2 (×2.5 for `gpt-5.5`) on the official Codex endpoint.
- **Ultrafast** (`/ultrafast`) sends `service_tier: "ultrafast"` — the separate Cerebras-backed tier (up to 14× faster). No model restriction is imposed here: any `gpt-*` model can request it, and OpenAI falls back or errors per account entitlement and model support. Costs are shown as returned — no multiplier is applied.

Both apply to every `gpt-*` model on an OpenAI-family API — `openai-completions`, `openai-responses`, or `openai-codex-responses` — including relays and gateways. Disabling either sends an explicit `service_tier: "default"`.
The statusline appends `· fast` or `· ultrafast` whenever the active mode is effective — even when no usage window is displayed.
Non-gpt models and non-OpenAI APIs are never rewritten.

## 📋 Provider semantics

Usage is provider-specific: a subscription window, a prepaid balance, and rated spend are not interchangeable.

| Provider | Reported data |
| --- | --- |
| OpenAI Codex | 5h/7d subscription windows with per-window resets, credits balance |
| Anthropic Claude | OAuth subscription windows (5h/7d/per-model); API keys report pay-as-you-go status |
| Kimi / Moonshot | Coding Plan usage windows, or platform API balance (USD/CNY) |
| OpenRouter | Per-key usage limit and account credit balance |
| OpenCode Zen | Rolling, weekly, and monthly plan windows |
| MiniMax Global/China | Token Plan windows (JWT keys) or pay-as-you-go balance |
| GLM / Zhipu / Z.AI | Coding Plan quota windows (5h/weekly, any `TOKENS_LIMIT` window echoed), MCP allowance, plan level |
| DeepSeek | Exact current CNY and USD API balances |
| xAI / Grok | OAuth subscription windows and credits; API keys report userinfo status |
| Google Vertex AI | Status only — billing lives in GCP, quota is not queryable via model credentials |
| Gemini API / AI Studio | Key validation and model count — no public quota endpoint exists |
| Vercel AI Gateway | Credit balance and lifetime spend |
| CLIProxyAPI | Per-api-user request counts via the management API (`CLIPROXY_MANAGEMENT_KEY`), else proxy status |
| GitHub Copilot | Plan entitlements and quota snapshots |
| Fireworks | Rated trailing 30-day spend |
| Baseten | Trailing 30-day Model APIs spend after credits |
| Cline | ClinePass five-hour/weekly/monthly utilization windows and credit balance (micro-USD) |

## 🧭 Matching and credentials

The adapter is chosen from the **current model**: provider id aliases first, then base URL origin, then id families (for example any `glm-*` provider without a base URL).
Credentials resolve through Pi's runtime chain and are memoized for 30 s only when static — OAuth results always re-resolve.
A provider id whose base URL points elsewhere never sends its credential to the official origin (the `glm-` prefix rule requires no base URL for exactly this reason).

## 📊 Statusline behavior

The status item key is `pi-myusage`.
All usage windows render on one line with per-window reset suffixes; providers without windows render balances (`$0.50 · Cline`, `¥12.34 · DeepSeek`).
The line refreshes after each completed turn, on model switch, and on the interval timer; chain-timeout failures are reported without pinning the cache, so the next trigger retries immediately.
With [`pi-cc-extensions`](https://www.npmjs.com/package/pi-cc-extensions) installed, the chip lands on footer line 1 next to the token stats — the key deliberately avoids that extension's reserved `pi-usage` status key, which it erases when its own usage pull is empty.

## 🔒 Security and privacy

Credentials resolve in memory, are never logged or persisted by this extension, and error text is scrubbed of token-like fragments before display.
Every provider call is a read-only `GET` to the provider's official usage endpoint with `redirect: "error"`, carrying only that provider's resolved credential.
Usage endpoints are queried with exactly the credential the model itself uses — nothing is sent anywhere the active provider doesn't already send it.
Pi extensions run with the user's process privileges; install only trusted extensions.

## 🚧 Limitations

- Providers without a public quota API (Vertex, Gemini, CLIProxyAPI without a management key) degrade to status metrics instead of inventing numbers.
- Provider reports are snapshots and may lag the provider's own accounting.
- Fireworks and Baseten expose rated 30-day spend only; balances and caps live in their web consoles.
- MiniMax window counts are historically ambiguous (used vs remaining); contradictory payloads are reported as unavailable rather than guessed.
- Cline balance is micro-USD; the dashboard's credit figure equals `balance / 1,000,000`.
- Kimi Coding and Cline usage-limits rely on provider-owned endpoints that may change without notice.
- A later-loaded extension can still rewrite the final provider payload, so arbitrary third-party payload conflicts cannot be prevented.

## 🗂️ Package layout

```text
pi-myusage/
├── index.ts          # Pi entrypoint: commands, events, timers, statusline, Fast routing
├── src/
│   ├── adapters/     # One file per provider (17 adapters)
│   ├── auth.ts       # Credential resolution chain and memo
│   ├── match.ts      # Adapter registry and current-model-first matching
│   ├── codex-fast.ts # Fast tier rewrite and cost correction (pure logic)
│   ├── format.ts     # Window summaries, bars, relative times
│   ├── http.ts       # fetchJson with timeout/abort, safe error redaction
│   ├── settings.ts   # pi-myusage.json load/save
│   └── types.ts      # Snapshot, metric, adapter, target contracts
└── test/selfcheck.ts # Assert-based self-check for pure logic
```

## 🔎 Verify

```bash
npm run verify   # tsc --noEmit (strict, noUnused*) + tsx test/selfcheck.ts
```

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
