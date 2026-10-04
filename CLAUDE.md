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
`usage`, `accounts`, `switch <index|email>`, `sync`, `models`, `update`, `service:install`,
`service:uninstall`.

`update` fast-forwards the checkout, runs `npm install`, and reloads the LaunchAgent when one is
installed. It refuses on a dirty worktree, a non-git install, or a non-fast-forward: it runs on
other people's checkouts, so its refusals are the feature. `status` additionally asks GitHub for the
latest release — advisory, 3s timeout, silent on every failure. **`start` must never make that call**;
a daemon that waits on the network to boot is a daemon that fails to boot.

**Bumping the version means syncing the lockfile**: run `npm install --package-lock-only` after
editing `package.json`'s `version` (`test:updater` asserts the two agree). The committed lockfile said
`1.0.0` through the entire 2.x series, so the `npm install` that `update` runs rewrote two `version`
lines and left the checkout dirty — and the *next* update refused, forever, on a tree nobody had
touched. `update` now restores a lockfile whose only change is those lines (before pulling, for
checkouts an older release already dirtied, and after installing), and still refuses any other edit
to it. Do not "fix" this by switching to `npm ci` or `--no-package-lock`: the first wipes `node_modules`
under a running daemon, the second drops the lockfile's pinning.

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
| `test:stream` | SSE framing: turn terminators, parallel tool-call indices, prompt size in `message_delta`, OpenAI `include_usage` chunk |
| `test:security` | management API leaks no OAuth tokens; cross-origin rejected |
| `test:refresh` | token refresh is bound to its own account, not the active one |
| `test:launchagent` | project-root resolution; `install()` rejects a bad root |
| `test:budget` | thinking budget fits inside the caller's `max_tokens` |
| `test:schema` | schema keywords are dropped, not hoisted into `properties` |
| `test:usage` | both protocols record usage; both report reasoning inside their output figure without double counting it in the tracker |
| `test:storage` | malformed accounts file does not throw |
| `test:auth` | non-loopback callers need a key; a proxy confers no exemption |
| `test:models` | id resolution: exact, retired, approximated, and rejected |
| `test:signature` | thinking history is dropped for Claude targets, kept for Gemini |
| `test:capacity` | a 503 rotates the pool without recording a cooldown; 400 still does not rotate |
| `test:quota` | a 429 cools the model family that earned it, not the whole account |
| `test:updater` | `update` refuses dirty worktrees and non-git installs, tolerates only npm's own lockfile version rewrite; the release check never throws; the lockfile tracks package.json |
| `test:effort` | Anthropic `output_config.effort` scales the budget; the default level changes nothing |

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

One consequence worth knowing: the Anthropic `message_start` is written before the first chunk
arrives, so anything only upstream's `usageMetadata` can tell you — the prompt size — can only go out
in `message_delta`. It used to say `input_tokens: 0` and nothing ever corrected it, so Claude Code and
T3 saw zero context in use (no meter, no auto-compact). `message_delta` now carries
`input_tokens`, omitted rather than zeroed when upstream never reported it. The OpenAI stream follows
OpenAI's contract instead: one extra chunk (`choices: []` plus the totals) after the finish chunk and
before `[DONE]`, sent **only** when the caller sets `stream_options.include_usage`, and left out
rather than zeroed when upstream reported no prompt size.

The two handlers also differ in *when* they commit: the Anthropic one obtains the upstream stream
first and only then writes `200`, so an exhausted pool is a real error status; the OpenAI one writes
`200` first, so the same failure arrives as an in-band `data: {"error": ...}` event inside a `200`.
Read nginx status codes with that in mind — a `200` on `/v1/chat/completions` proves nothing about
success, while on `/v1/messages` it does.

### Failover model (`antigravity-client.ts`)

Two nested loops per request: an outer loop bounded by pool size, an inner loop over
`ANTIGRAVITY_ENDPOINTS`. Rules encoded there:

- HTTP 400 throws immediately (client error — retrying another account won't help).
- HTTP 429 calls `QuotaTracker.record429()` and, if auto-failover is on, rotates to the next
  non-cooling account and retries the whole request.
- HTTP 503 (`No capacity available for model X on the server`) rotates too, but records **no**
  cooldown — capacity is per project, not a quota signal, and parking a healthy account for hours
  over a transient server condition is worse than the failure it replaces. `ANTIGRAVITY_ENDPOINTS`
  holds a single endpoint, so without this a 503 reached the caller on the first try.
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

**Cooldowns are keyed by (account, family), and that distinction is load-bearing.** Antigravity
meters Claude — served through Vertex — separately from Gemini, so an exhausted Claude weekly quota
says nothing about Gemini. Recorded against the bare account it was catastrophic: one test request
to `claude-sonnet-4-6` rang the failover loop through all six pooled accounts in three seconds and
parked every one of them for up to 134 hours, leaving `selectNextAvailableAccount()` with nothing to
return, while the dashboard's own meters — which come from the *other* quota system — still read
~100%. Pass the model to `record429()`, `isAccountRateLimited()` and `selectNextAvailableAccount()`;
omitting it is the account-wide behaviour, kept for windows written before 2.0.3 and for models that
cannot be classified.

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

**The sentinel is a Gemini affordance, and Claude models are not Gemini.** Antigravity forwards the
`claude-*` ids to Vertex's Anthropic API, which validates `signature` on a thinking block
cryptographically. The bridge fabricates `antigravity_thought` on the way out, the client echoes it
back, and the next turn died as `messages.1.content.0: Invalid signature in thinking block` — the
largest 400 class in production. So `sanitizeThoughtSignaturesInContents()` takes `isClaude` and
**drops prior-turn thinking entirely** for Claude targets, including the turn itself when thinking
was all it held (Google rejects a turn with no parts). Losing reasoning history costs context;
sending it cost the whole request.

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

### Models

`SUPPORTED_MODELS` in `src/constants.ts` is the single source: it drives `/v1/models`, the health
payload, `Transformer.resolveModel()`, the thinking configuration, and the generated ZCode provider
config. **Model ids are Google's own ids, sent verbatim** — there is no `targetModel` indirection
any more. Do not reintroduce one: the previous table mapped five separate flash ids onto a single
`gemini-3-flash`, and pointed `gemini-3-pro` at a model Google had withdrawn, so what you configured
told you nothing about what ran.

Every field is Google's metadata from `v1internal:fetchAvailableModels`. **Run `npm run bridge:models`
before editing the table** — it reports ids that no longer exist, metadata that drifted, and
thinking-capable models Google offers that the bridge does not expose. It needs a logged-in account
but costs no inference quota.

Reasoning config is per model, not global:

- `thinkingBudget` is Google's declared default. `-1` means the model sizes its own reasoning, and
  the bridge forwards `-1` rather than pinning a number — an explicit budget switches dynamic
  thinking off.
- **Tiered ids carry no upstream `displayName`, and that does not make them internal.** Google's
  `tieredModelIds` maps Antigravity's own picker: `flash` -> `gemini-3.8-flash-tiered`. Their tier
  is a per-request parameter, which is why they are dynamic. Filter Google's catalogue on the
  `chat_` / `tab_` id prefixes only — filtering on a missing display name hides exactly the models
  the product surfaces.
- `minThinkingBudget` is the floor; below it the bridge disables thinking rather than sending a
  value the model would reject.
- `Transformer.applyThinkingConfig()` fits the budget inside the caller's `max_tokens`, holding back
  `BRIDGE_ANSWER_RESERVE_TOKENS` (default 8192, clamped to half the window) for the visible answer.
  Thinking tokens are billed as output and count against that cap.
- Effort scales the model's own default instead of substituting fixed numbers, so "high" means high
  *for that model*. Both paths share `Transformer.budgetForEffort()` with one scale each, **anchored
  on that protocol's default level at 1×**: OpenAI `reasoning_effort` is 0.25× / 1× / 4× for
  low / medium / high; Anthropic `output_config.effort` is 0.25× / 0.5× / 1× / 2× / 4× for
  low / medium / high / xhigh / max. Claude Code sends `high` on every request whether or not anyone
  chose it, so mapping the *word* "high" to 4× would have silently quadrupled thinking spend for
  every fixed-budget model on upgrade. Precedence on the Anthropic path: `thinking: disabled` >
  `budget_tokens` > `output_config.effort` > the model's declared default. Dynamic (-1) models take
  1000 / 4000 / dynamic by tier instead.

Retired ids are kept as explicit aliases in `resolveModel()` so existing client configs keep working;
each points at the model its name claimed, which is often not what it used to resolve to.

**`resolveModel()` never resolves silently.** An inexact match warns once naming what it used, and
an id matching nothing throws `UnknownModelError`, which `server.ts` turns into a 400. Approximation
is deliberate — Claude Code sends Anthropic's own ids and refusing them would break the main use
case — but a client that appends a reasoning suffix (`gemini-3.8-flash-tiered-high`) once silently
got a different model generation, so the guess has to be audible.

OpenAI responses — the non-streaming body and the `include_usage` stream chunk alike, both built by
`Transformer.openaiUsage()` — report `completion_tokens` **including** reasoning, with
`completion_tokens_details.reasoning_tokens` as the subset, because that is how OpenAI defines it.
Google keeps them apart (`candidatesTokenCount` is the visible answer only), and reporting 300
reasoning beside a completion of 22 would be a pair no client could subtract sensibly. Mind the
consequence: `UsageTracker` stores visible output and reasoning in **separate columns**, so the
non-streaming handler subtracts the reasoning back out before recording; feed it `completion_tokens`
as-is and `bridge:usage` counts every thought twice (`test:usage` guards it).

The Anthropic path does the same arithmetic, because Anthropic also defines `output_tokens` as
including thinking: `Transformer.anthropicUsage()` for the non-streaming body, and the stream's
`message_delta` takes Google's `candidatesTokenCount + thoughtsTokenCount` (the old text-length
estimate only sees the short thinking *summary* that is emitted, not the thousands of tokens spent,
and survives purely as the fallback when upstream reports nothing). The tracker double-count trap
applies here too, and the non-streaming Anthropic handler subtracts the thinking back out as well.
Both protocols now agree: whatever a client reads as output is visible answer plus reasoning.

`thoughtsTokenCount` from Google is recorded via `UsageTracker`, so `bridge:usage` shows reasoning
actually consumed. That is the number to tune budgets against — a declared budget says nothing about
whether it gets used.

## Gotchas

- **Bind address**: `server.ts` listens on `process.env.BRIDGE_HOST || "0.0.0.0"`, i.e. it is
  reachable on the LAN by default. The README's security section still claims `127.0.0.1`.
- **This bridge is deployed publicly.** `src/dashboard.html` takes its remote base URL from
  `window.location.origin` and defaults the setup guide to that host whenever the page is not
  loaded from localhost. Anything hardcoded there is a bug: the endpoint pill read
  `http://127.0.0.1:52130` on a public page until 2.0.4, handing every visitor an address that
  could not work. Assume any endpoint you add is internet-reachable, not LAN-at-worst.
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
