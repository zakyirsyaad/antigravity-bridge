# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                      # zero runtime deps; installs tsx + typescript only
npm run bridge:start             # start the gateway (tsx bin/cli.ts start), port 52130
npm run dev                      # same, with tsx watch
npm run build                    # tsc -> dist/. Typecheck only; NOT how the app runs (see below)
npm test                         # tsx test/bridge.test.ts — live end-to-end suite
```

CLI subcommands all route through `bin/cli.ts <command>`: `start`, `login`, `status`,
`usage`, `accounts`, `switch <index|email>`, `sync`, `service:install`, `service:uninstall`.

### Testing

All suites are hand-rolled sequential scripts, not a framework. They share a house style: a local
`expect(label, actual, wanted)` that counts failures, numbered `[n/m]` sections, and a throw at the
end that exits non-zero. There is no "run a single test" flag — copy the block you want into a
scratch script.

**`npm test` (`test/bridge.test.ts`) is the odd one out**: it issues **real requests to Google's
CloudCode API**, so it needs a logged-in account (`npm run bridge:login`) and consumes real quota.
It throws on the first failure. Its console numbering is stale (`[2/5]`, `[3/5]`… while 7 tests
run); ignore it.

Everything else runs offline — no account, no network, no quota — by stubbing `AntigravityClient`,
`OAuthManager`, `UsageTracker`, or `fs`. Prefer adding to these; CI can run them.

| Script | Guards |
|---|---|
| `test:stream` | SSE framing: turn terminators, parallel tool-call indices |
| `test:security` | management API leaks no OAuth tokens; cross-origin rejected |
| `test:refresh` | token refresh is bound to its own account, not the active one |
| `test:launchagent` | project-root resolution; `install()` rejects a bad root |
| `test:budget` | thinking budget fits inside the caller's `max_tokens` |
| `test:schema` | schema keywords are dropped, not hoisted into `properties` |
| `test:usage` | both protocols record usage |
| `test:storage` | malformed accounts file does not throw |

When stubbing, keep side effects off the real `~/.zcode` files and off `launchctl` — several suites
assert that explicitly, and that is deliberate.

### Build vs. run

The bridge is always executed as TypeScript through `tsx`. `npm run build` emits `dist/` but that
output is not runnable as-is: `src/dashboard-html.ts` reads `dashboard.html` from `__dirname`, and
`tsc` does not copy the 52KB HTML asset. Treat `npm run build` as a typecheck. The LaunchAgent
plist likewise invokes `node node_modules/tsx/dist/cli.mjs bin/cli.ts start`.

## Architecture

A local HTTP gateway that speaks **Anthropic Messages** and **OpenAI Chat Completions** on the
front, and Google Antigravity/CloudCode's internal `v1internal:generateContent` protocol on the
back, pooling multiple Google accounts with automatic 429 failover.

### Request pipeline

```
server.ts (routing, SSE emission)
  -> transformer.ts        protocol request  -> AntigravityPayload   (via schema-cleaner.ts for tools)
  -> antigravity-client.ts failover loop     -> Google CloudCode
  -> transformer.ts        Antigravity resp  -> protocol response
```

Streaming is **not** handled by the transformer. `server.ts` hand-writes both SSE dialects
(`handleAnthropicMessages` / `handleOpenAIChatCompletions`) directly from the Antigravity part
stream. A change to non-streaming output shape usually needs a mirrored change in the streaming
branch, and vice versa — they share no code.

### Failover model (`antigravity-client.ts`)

Two nested loops per request: an outer loop bounded by pool size, an inner loop over
`ANTIGRAVITY_ENDPOINTS`. Rules encoded there:

- HTTP 400 throws immediately (client error — retrying another account won't help).
- HTTP 429 calls `QuotaTracker.record429()` and, if auto-failover is on, rotates to the next
  non-cooling account and retries the whole request.
- Before each attempt, a *proactive* check skips the active account if it's already cooling down.
- Failover happens before the response is streamed, so a mid-stream 429 is not recovered.

`selectNextAvailableAccount()` mutates `activeAccountIndex` in the accounts file as a side effect —
failover permanently changes which account is active for every subsequent request and process.

### Two independent quota systems (do not conflate)

| | `quota-tracker.ts` | `quota-service.ts` |
|---|---|---|
| Source | parses `"Resets in 3h55m50s"` out of 429 error text | polls Google `retrieveUserQuotaSummary` |
| Storage | `~/.zcode/antigravity-quota.json` | in-memory `Map`, 45s TTL |
| Purpose | **drives cooldown + failover decisions** | dashboard display only |
| Window type | inferred (`<6h` -> five_hour, else weekly) | read from bucket metadata |

`QuotaTracker.getQuota()` deletes expired windows as a read side effect. If Google changes its 429
message wording, `parseResetDuration()` silently returns null and cooldown tracking stops working —
failover degrades to reactive-only.

### Schema cleaning (`schema-cleaner.ts`)

Antigravity's protobuf parser rejects most JSON Schema vocabulary. `cleanToolDeclarations()` strips
`$schema`, `$ref`, `$defs`, `const`, `additionalProperties`, `propertyNames`, `title`, `pattern`,
`format`, `minLength`, etc., folding the semantics into the `description` string as hints, and
flattens `allOf`/`anyOf`/`oneOf` and type arrays. Tool calling breaks in opaque ways when a keyword
slips through, so any new tool-schema support belongs here rather than in `transformer.ts`.

### Thought signatures

Gemini 3 validates a `thoughtSignature` on thinking parts in multi-turn history. The bridge cannot
produce valid ones, so it emits the `SKIP_THOUGHT_SIGNATURE` sentinel
(`"skip_thought_signature_validator"`). `Transformer.sanitizeThoughtSignaturesInContents()` also
strips signatures from parallel function calls, which reject them.

### State: file-backed singletons

`OAuthManager`, `QuotaTracker`, `UsageTracker` are all `getInstance()` singletons that read and
write JSON on every call rather than caching. State lives outside the repo under `~/.zcode/`:

- `antigravity-accounts.json` — tokens + `activeAccountIndex` (the pool)
- `antigravity-quota.json` — cooldown windows
- `antigravity-usage.json` — request/token counters
- `v2/config.json` — ZCode provider config, rewritten by `zcode-sync.ts`
- `logs/antigravity-bridge{,.err}.log` — LaunchAgent output

Because these are files, two bridge processes (e.g. a manual `npm run dev` alongside the installed
LaunchAgent) will fight over the active account and quota state. `~/.gemini/jetski-standalone-oauth-token`
is read as a fallback single-account source when no accounts file exists.

### Adding a model

Append to `SUPPORTED_MODELS` in `src/constants.ts` — that single array drives `/v1/models`, the
health payload, `Transformer.resolveModel()`, and the generated ZCode provider config. `id` is the
name clients send; `targetModel` (when present) is what Google actually receives. `resolveModel()`
additionally has substring fallbacks so unknown Claude/Gemini names degrade to a close match instead
of erroring.

## Gotchas

- **Bind address**: `server.ts` listens on `process.env.BRIDGE_HOST || "0.0.0.0"`, i.e. it is
  reachable on the LAN by default. The README's security section still claims `127.0.0.1`.
- **This bridge is deployed publicly.** `src/dashboard.html` hardcodes
  `VPS_BASE_URL = "https://bridge.example.com"` and defaults its setup guide to
  that host whenever the page is not loaded from localhost. Assume any endpoint you add is
  internet-reachable, not LAN-at-worst.
- **Two independent gates, and they cover different attackers.** `authorize()` requires a shared
  secret (`BRIDGE_API_KEY`) from non-loopback callers and fails closed when the key is unset —
  that is what stops `curl`. `isCrossOriginRequest()` additionally blocks foreign web pages from
  driving `/api/*` and `/oauth/*`, which the key alone would not, since a browser attaches
  credentials the user already has. Loopback is trusted by both unless `BRIDGE_TRUST_LOCAL=0`.
  Only the dashboard shell (`/`, `/dashboard`, HTML variant) is exempt, so it can load and prompt
  for a key; its JSON variant is not, because that one reports the signed-in account.
- `getPoolStatus()` returns `PublicAccountSummary`, deliberately without OAuth tokens. Keep it
  that way — the type is the guard — and put new credential-touching routes under `/api/` so they
  inherit the origin check.
- **`syncZCodeConfig()` runs on every `start` and `login`** and writes a fresh timestamped
  `.backup.<iso>` copy of `~/.zcode/v2/config.json` each time — that directory accumulates files.
- **Client credentials in `constants.ts`** are the public Antigravity desktop app's, assembled from
  split string literals to dodge secret scanners. Override with `ANTIGRAVITY_CLIENT_ID` /
  `ANTIGRAVITY_CLIENT_SECRET`.
- **LaunchAgent paths go through `LaunchAgentService.resolveProjectDir()`** — never resolve the
  project root by hand. It distinguishes a standalone clone (`bin/` beside package.json) from a
  vendored copy with hoisted deps, and `switch` and `service:install` disagreeing about that is
  exactly what silently killed the daemon before. `install()` validates the resolved tsx CLI and
  `bin/cli.ts` *before* unloading anything, because a `launchctl load` failure is still swallowed.
- `.gitignore` excludes `src/**/*.js`, `bin/**/*.js`, `test/**/*.js` — stray compiled JS next to the
  sources is invisible to git and will shadow nothing, but can confuse greps.

## Dashboard

`src/dashboard.html` is a single self-contained ~52KB file (inline CSS + JS, no build step) served
at `/`. It polls `/api/pool`. Its visual system — OLED Zinc palette, concentric radii, tabular
numerals on all live-updating numbers — is specified in `DESIGN.md`; follow that file when changing
the UI.
