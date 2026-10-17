# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                      # zero runtime deps; installs tsx + typescript only
npm run bridge:start             # start the gateway (tsx bin/cli.ts start), port 52130
npm run dev                      # same, with tsx watch
npm run build                    # tsc -> dist/. Typecheck only; NOT how the app runs (see below)
npm test                         # tsx test/bridge.test.ts — live end-to-end suite
npm run test:<name>              # one offline suite (table below)
```

Every offline suite in one pass (stops nothing on failure; each line says ok/FAIL):

```bash
for s in $(node -p "Object.keys(require('./package.json').scripts).filter(k=>k.startsWith('test:')&&k!=='test:bridge').join(' ')"); do npm run -s $s >/dev/null 2>&1 && echo "ok   $s" || echo "FAIL $s"; done
```

There is no linter or formatter configured, and no CI workflow in the repo; `npm run build` is the
only static check.

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
It throws on the first failure, and every step checks the reply's content, not just that a reply came.
**Use exact model ids in it** (`FLASH`, `FLASH_DYNAMIC`, `PRO`, `CLAUDE` at the top of the file), and
check them with `npm run bridge:models` first: it used to send retired names such as `gemini-3.1-pro`,
which the bridge aliased onto a model Google had stopped serving, so a failure looked like a
`max_tokens` problem when the model was simply gone. `bridge:models` alone is not enough, because the
catalogue keeps listing dead ids: the suite's own requests are what prove an id is served. `[2/7]` refuses any id it uses that the bridge
does not list. The Claude step is reported as SKIPPED, loudly, when Claude's quota is exhausted —
that says nothing about the bridge — and every other failure still fails the run.

Everything else runs offline — no account, no network, no quota — by stubbing `AntigravityClient`,
`OAuthManager`, `UsageTracker`, or `fs`. Prefer adding to these: they are what a CI job would run.

| Script | Guards |
|---|---|
| `test:stream` | SSE framing: turn terminators, parallel tool-call indices, prompt size in `message_delta`, OpenAI `include_usage` chunk |
| `test:security` | management API leaks no OAuth tokens; cross-origin rejected |
| `test:refresh` | token refresh is bound to its own account, not the active one |
| `test:launchagent` | project-root resolution; `install()` rejects a bad root |
| `test:budget` | thinking budget fits inside the caller's `max_tokens`; a dynamic model is pinned to its room in a small window and stays dynamic in a large one; `BRIDGE_TOOL_MIN_OUTPUT_TOKENS` raises a small cap only on requests with tools and never past the model's limit |
| `test:schema` | schema keywords are dropped, not hoisted into `properties`; a non-string enum is folded into the description with its type kept, a string enum is untouched |
| `test:usage` | both protocols record usage; both report reasoning inside their output figure without double counting it in the tracker |
| `test:storage` | malformed accounts file does not throw |
| `test:auth` | non-loopback callers need a key; a proxy confers no exemption |
| `test:models` | id resolution: exact, retired, approximated, and rejected; a `provider/` prefix is dropped when the tail is exact |
| `test:signature` | thinking history is dropped for Claude targets, kept for Gemini |
| `test:capacity` | a 503 rotates the pool without recording a cooldown; 400 still does not rotate; a pool that runs out on a 503 says capacity (status 503, model named) only when Google said "No capacity", and service unavailable otherwise; accounts are counted once each, not per pass; one that runs out on a 429 keeps the rate-limited wording |
| `test:quota` | a 429 cools the model family that earned it, not the whole account |
| `test:updater` | `update` refuses dirty worktrees and non-git installs, tolerates only npm's own lockfile version rewrite; the release check never throws; the lockfile tracks package.json |
| `test:effort` | Anthropic `output_config.effort` scales the budget; the default level changes nothing; a model with no declared budget reasons only above the default level; a retired fixed-tier id, or a reasoning suffix on a guessed one, keeps its tier on both protocols; every ZCode reasoning variant sends a distinct budget |
| `test:upstream` | a request Google rejects (400) is a 400 on all four paths, the OpenAI stream included; a 503 is a 503 on all four paths, `overloaded_error` for no capacity and `api_error` for any other; a pool that ran out on a stall is still a 500 (in-band on the OpenAI stream); every other failure keeps its old shape; a failure after streaming began stays in-band |
| `test:models-context` | every `/v1/models` entry carries `context_length` from `SUPPORTED_MODELS`; the older fields are unchanged; `/models` answers the same |
| `test:turns` | a history that opens with a model turn gets a user note in front (both protocols, Claude too) and is otherwise untouched; the logged request shape names roles and part kinds and never carries text |
| `test:stall` | a request Google never answers rotates to the next account after one timeout (not three), rests the stalled one in memory without a quota cooldown, is bounded to two rotations, and keeps the old in-place retries with one account or failover off; a pool that runs out on a stall — one that rotated, or one that retried in place — says the accounts stopped answering (model named, distinct accounts counted, the waits it actually made; a 500 with no Google status), not rate limited or "This operation was aborted" |
| `test:pool` | `/api/pool` reports an account resting after a stall as `resting` (with when it ends), leaves it out of `readyCount`, and lets a quota cooldown win over it; every failover event carries a `reason` and says it, and the client passes one from each place it moves the pool, on both paths; the dashboard reads the field and its failover tooltip names 429, 503 and stalls |
| `test:network` | `start()` sets Node's per-address connect timeout (2 s, configurable; a value Node would reject falls back instead of stopping the boot); a quick connect failure is retried after 2 s then 5 s on the same account, and the retry line names the cause code; a retry after a timeout keeps the old short pause |
| `test:stream-end` | a stream that ends empty, non-STOP or without a finish reason leaves one `[Stream End]` warning (with the `maxOut`/`think` that were sent) on both routes; a healthy one stays silent; a `MAX_TOKENS` turn closes as `max_tokens` / `length` (a complete tool call still wins); everything else the client receives is unchanged |

When stubbing, keep side effects off the real `~/.zcode` files and off `launchctl` — several suites
assert that explicitly, and that is deliberate.

### Build vs. run

The bridge is always executed as TypeScript through `tsx`. `npm run build` emits `dist/` but that
output is not runnable as-is: `src/dashboard-html.ts` reads `dashboard.html` from `__dirname`, and
`tsc` does not copy the ~60KB HTML asset. Treat `npm run build` as a typecheck. The LaunchAgent
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

The two handlers differ in what a failure *before the first byte of the stream* looks like. Both
answer HTTP 400 `invalid_request_error`, carrying Google's own message, when Google rejected the
request itself (an `UpstreamError` with `status === 400`: a schema it cannot take, a parameter out of
range). The OpenAI handler used to write `200` before asking Google anything, which made that
impossible — the failure arrived as an event inside a success, and FCC described a permanent mistake
as "usually temporary — try again" — so it now obtains the upstream stream first, as the Anthropic one
always did. A Google 503 (`UpstreamError` with `status === 503`) is likewise HTTP 503 on all four
paths: `overloaded_error` only when the pool ran out on "No capacity" (`PoolExhaustedError` with
`kind === "capacity"`, read as data, never from the message), `api_error` for any other 503. Every other pre-stream failure is as before:
the Anthropic handler answers a real 500 (`api_error`), but the OpenAI stream still commits to `200`
and reports it as an in-band `data: {"error": ...}` event. So read nginx status codes with that in
mind: a `200` on `/v1/chat/completions` proves nothing about success, while on `/v1/messages` it does. A failure after
the stream has started can only ever be in-band, on either protocol.

The streams read exactly one thing from Google's `finishReason`: `MAX_TOKENS` closes the turn as
`max_tokens` / `length` (a complete tool call still wins: `tool_use` / `tool_calls`), as the
non-streaming path always did. Every other reason — a malformed function call, a safety filter, a
dropped connection — still closes as `end_turn` / `stop`, so it reaches the client as an
empty-but-successful answer (OpenDesign: "Agent completed without producing any output").
`StreamEndTally` (`stream-diagnostics.ts`) records the cause as a `[Stream End]` warning, with the
`maxOut` / `think` that were sent, when a stream ends empty, non-STOP or without a finish reason —
**look there first**; it has diagnosed every case so far. Do not map more reasons without a real
failure's `finishReason` in hand.

**A function call is delivered whole, or not at all.** Google sends it only when complete, so one the
output cap cuts off simply never arrives: `MAX_TOKENS`, `text=0 tools=0`, ~100 s of generation
discarded, and the usage figure omits those tokens. That is what OpenDesign hit — one `write` call
carrying a ~40,000-token file under a 16,384 cap, with the client's own max-tokens setting not
reaching that path. `BRIDGE_TOOL_MIN_OUTPUT_TOKENS` (off by default) raises a smaller cap on requests
that carry tools; it overrides what the caller chose, which is why it is opt-in. Such a call also
takes minutes with the client receiving nothing, so a short idle timeout on the client side can still
cut it off.

### Failover model (`antigravity-client.ts`)

Two nested loops per request: an outer loop bounded by pool size, an inner loop over
`ANTIGRAVITY_ENDPOINTS`. Rules encoded there:

- HTTP 400 throws immediately (client error — retrying another account won't help) and reaches the
  caller as a 400, not a 500. Google's errors are `UpstreamError`, which carries `.status` as data;
  the message still embeds `(400)` and some checks in this file still read it from the text. Do not
  widen `isUpstreamClientError()` in `server.ts` beyond 400: a 401 is our credentials, a 429/503 is
  capacity, and none of those is the caller's mistake.
- HTTP 429 calls `QuotaTracker.record429()` and, if auto-failover is on, rotates to the next
  non-cooling account and retries the whole request.
- HTTP 503 (`No capacity available for model X on the server`) rotates too, but records **no**
  cooldown — capacity is per project, not a quota signal, and parking a healthy account for hours
  over a transient server condition is worse than the failure it replaces. `ANTIGRAVITY_ENDPOINTS`
  holds a single endpoint, so without this a 503 reached the caller on the first try.
  When the last account tried answered 503, the pool running out says so. `PoolFailures`
  (`pool-failures.ts`) records how each pass ended and builds the final error: status 503, the
  model named, Google's message kept, "not quota". Only a message saying "No capacity" is called
  capacity; any other 503 reads "service unavailable". Accounts are counted by email, not by pass —
  a 503 writes no cooldown, so the selector can come back to an account it already tried. Running
  out used to read "All accounts in the pool are currently rate limited. Please wait for cooldown to
  reset." whatever happened — `gemini-2.5-pro` on all six accounts — which sent people to the quota
  file for a cooldown no 503 ever writes. That wording now means a 429 ended the run; keep it that
  way. A new failure kind gets its wording in `PoolFailures.exhaustedError()`, not at the call sites.
- **A stall rotates, it does not retry.** Google sometimes accepts a request and never answers — no
  429, no 503 — in bursts of several minutes on one account, usually after a run of large requests.
  The wait for the first response is `BRIDGE_UPSTREAM_TIMEOUT_MS` (60 s). When failover is on and the
  pool has another account, the *first* timeout gives up (`UpstreamStall`), the account is rested in
  memory for `BRIDGE_STALL_REST_SECONDS` (300 s) and the request goes to the next one, at most
  `MAX_STALL_ROTATIONS` (2) times, so three accounts and never the whole pool. It used to retry the
  same account three times, which spent three minutes inside the burst and ended as a 500 — and
  OpenDesign's run died after three of those in a row with five accounts idle. A single-account pool,
  or failover off, keeps the old three in-place retries. A reset or dropped connection is quick and
  local and is still retried in place. Resting lives in `StallRegistry` (`upstream-stall.ts`), **not**
  in the quota file: the account is not out of quota, and the dashboard's cooldown should keep meaning
  that. `/api/pool` reports it as its own status, `resting` (`StallRegistry.restEndsAt()` gives the end),
  and the dashboard draws it monochrome, not amber. Look for `[Upstream Stall]` in the log; if it fires on every account in turn, the stall is
  global and rotation cannot help. When the last account tried stalled, the pool running out says so:
  `PoolFailures.exhaustedError()` returns a `PoolStalledError` (kind `"stall"`) that names the
  model, says Google stopped answering and not quota, and counts the distinct accounts that stalled.
  A two-account pool (A 503, B stalled, rotated back to A) used to end as "rate limited ... wait for
  cooldown to reset", for a cooldown no stall writes. **`PoolStalledError` is not an `UpstreamError`
  and has no status**: that type means "Google answered with this status", and Google answered
  nothing. The server answers it with its generic 500, as a stall always was — do not give it a
  status to route on, or code that reads Google's status (the 503 routing, any future "retry on 5xx")
  will take the bridge's choice for Google's answer. A pool that cannot rotate retries in place as
  before, but `fetchWithRetry()` now ends in an `UpstreamStall` when the *last* attempt timed out, so
  it gets the same wording instead of the bare "This operation was aborted" after three minutes. The
  stall carries how many attempts timed out, and the message says so ("to 3 attempts of 60s each",
  against "within 60s" for a pool that rotated); it claims no resting, because that path rests
  nothing.
- **A connect failure is the network, not the account**, so it is retried in place and never rotates.
  The VPS has no IPv6 route, and Node's happy eyeballs gives every address but the last only 250 ms:
  whenever DNS listed IPv4 first, a slow moment abandoned the one address that works, IPv6 failed at
  once, and the request died as `fetch failed` (AggregateError `ETIMEDOUT`) — FCC's "500 Upstream
  provider TOKENROUTER". `BridgeServer.start()` now sets that per-address limit to
  `BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS` (2 s; `network.ts`), process-wide, so it covers `fetch` too. An
  error that comes back quickly is retried after 2 s and then 5 s (it was 1 s and 2 s, all inside the
  same blip); a retry after the bridge's own timeout keeps the 1 s / 2 s pause, since it has already
  waited a full minute. Do not "fix" this with `dns.setDefaultResultOrder("ipv4first")`: that makes
  IPv4 never the last address, so it would *always* get the short limit. A value outside Node's range
  (10 ms to int32) falls back to the default: Node throws on it, and `start()` applies it first, so it
  would stop the boot. `[Network Retry]` names the cause code (`fetch failed: ETIMEDOUT`); the message
  alone says nothing.
- Before each attempt, a *proactive* check skips the active account if it's already cooling down or
  resting after a stall.
- Failover happens before the response is streamed, so a mid-stream 429 is not recovered.

`selectNextAvailableAccount()` mutates `activeAccountIndex` in the accounts file as a side effect —
failover permanently changes which account is active for every subsequent request and process. Pass it a `FailoverReason` too: it is
what the dashboard's activity stream shows, and a failover recorded without one reads like every
other kind.

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

**An `enum` that is not all strings never reaches Google.** Its function-declaration `enum` is a list
of strings, and the whole request is refused (`Invalid value at '...properties[2].value.enum[0]'
(TYPE_STRING), 10143`) if one element is not. `{"const": 10143, "type": "number"}` — how an MCP
server declares a chain id — used to become `enum: [10143]` with the number intact, and because a
client sends *all* its tools on *every* request, three such tools in one plugin took down every call
for every client, which looked exactly like the gateway being down. `foldNonStringEnums()` now drops
such an enum, keeps the declared `type` (inferred from the values when there was none) and says the
values in the description (`must equal 10143`, `one of: 143, 10143`). The `anyOf`/`oneOf`-of-consts
path used to dodge the refusal with `String()` and retype the parameter as a string, so the model sent
`"10143"` where the server wanted `10143`; it no longer does. A genuine string enum is untouched. Do
not "fix" a numeric enum by stringifying it: the model then sends a string, and the tool's own
validation rejects it.

### History shape

Gemini wants a conversation to open with a user turn: a history whose first turn is a model function
call is refused with "function call turn comes immediately after a user turn or after a function
response turn" — verified against Google, the only one of six shapes that produced it. Clients can send
one (OpenDesign's agent, after a long run, re-sent a history whose earlier messages had been dropped), so
`ensureStartsWithUser()` puts a short user note in front rather than dropping the calls and responses
that remain. When Google does reject a request with a 400, the client logs `[Upstream 400] request shape:`
— roles and part kinds only, never text (`describeContentsShape()`), because the message names the rule
that broke and not the turn.

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

**The catalogue can list an id that no longer works, and `bridge:models` cannot see that.**
`gemini-3.1-pro-high` stayed in `fetchAvailableModels` with full metadata while Google answered HTTP
400 "Request contains an invalid argument" to every request for it, on all six accounts and every request
shape; the 3.7 and 3.6 tiered ids went 404. Every client that asked for "pro" got a 400 and nothing in
the bridge said why. Only calling a model proves it is served: after editing the table, send each id one
tiny request **and read the reply** (`npm test` does this for the ones it uses). A status code is not
enough. The 3.5 Flash tiers (`gemini-3-flash-agent`, `gemini-3.5-flash-low`, `-extra-low`) are still in
the catalogue and answer HTTP 200, but the reply is one canned sentence, "Gemini 3.5 Flash is no longer
available...", with no `finishReason` and no usage, and a client shows it as the model's answer.

As of 2026-10-17 **no Gemini Pro is served**. `gemini-pro-agent` and `gemini-3.1-pro-low` went 404, along
with the 3.6 Flash tiers. `gemini-2.5-pro` is listed but answers 503 "no capacity" on every account, as
it did a table earlier. Every pro id, and the nearest-match guess for "pro", is a retired alias of
`gemini-3.8-flash-tiered`, so the substitution is logged; re-add 2.5 Pro once a request to it succeeds.
Google's catalogue still lists the retired 3.5 Flash tiers, `gemini-2.5-pro` and the three `gemini-2.5-flash*`
ids. The 2.5 Flash ids are labelled "Gemini 3.5 Flash Lite" and alias to `gemini-3.5-flash-lite`.
`bridge:models` prints every id that `Transformer.retiredTarget()` knows under "retired here on purpose",
with its target, not as a model to add.

`/v1/models` advertises each model's `context_length` (from `contextLimit`). OpenAI-compatible
clients size their own prompts from it, and Onyx assumes 32,000 tokens for a model it does not
know — it then refuses a 54k prompt *in the client*, so the bridge's logs show no failure at all.
If a client claims "not enough tokens" for a model with a 1M window, check what it was told
before looking at the bridge. Keep the field when touching that handler.

Reasoning config is per model, not global:

- `thinkingBudget` is Google's declared default. `-1` means the model sizes its own reasoning, and
  the bridge forwards `-1` rather than pinning a number — an explicit budget switches dynamic
  thinking off. **Except in a small window:** when the room left after the answer reserve is under
  `DYNAMIC_PIN_BELOW` (4096), the budget is pinned to that room. Left at `-1`, a dynamic model spends
  the whole cap thinking (measured: `max_tokens` 1200 -> 1150 thought, 46 answer) and the turn ends
  `MAX_TOKENS` with no text, which clients report as empty output — OpenDesign's agent steps hit
  exactly this, with a ~100k prompt and a small output window.
- **Tiered ids carry no upstream `displayName`, and that does not make them internal.** Google's
  `tieredModelIds` maps Antigravity's own picker: `flash` -> `gemini-3.8-flash-tiered`. Their tier
  is a per-request parameter, which is why they are dynamic. Filter Google's catalogue on the
  `chat_` / `tab_` id prefixes only — filtering on a missing display name hides exactly the models
  the product surfaces.
- `minThinkingBudget` is the floor; below it the bridge disables thinking rather than sending a
  value the model would reject.
- **No `thinkingBudget` at all** (the Flash Lites) means Google declares no default, and those models
  do not reason unless asked: with no `thinkingConfig` they spent 0 thought tokens, against about 200
  when sent `-1`. The bridge sends nothing by default. An effort level turns reasoning on (dynamic)
  only when it is above the protocol's default: OpenAI `high`, Anthropic `xhigh` / `max`. Treating
  absent as `-1`, as the code used to, would have made every lite request reason. For the same reason
  `zcodeReasoning()` gives these models **no** ZCode picker: ZCode speaks Anthropic, where its
  "low" / "high" would both leave them off. `test:effort` asserts that every variant ZCode is offered
  sends a distinct budget.
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

A `provider/` routing prefix (`open-design-byok/gemini-3.8-flash-tiered`, `openrouter/google/...`)
is dropped when the tail is an exact or retired id, and the nearest-match guess reads only the model
name, never the prefix — it used to guess from the whole string, so that id became
`gemini-3.6-flash-high`, an older generation, and `someprovider/...` matched "pro".

Retired ids are kept as explicit aliases in `resolveModel()` so existing client configs keep working;
each points at the model its name claimed, which is often not what it used to resolve to. An alias
whose name fixed a reasoning tier keeps it. The tier is read off the id's own suffix
(`gemini-3.6-flash-low`, `gemini-3.5-flash-extra-low`); a `RETIRED_IDS` entry spells it out only where
the name says otherwise or nothing (`gemini-3.5-flash-low` was Google's Medium,
`gemini-2.5-flash-thinking` asks for high). `withAliasTier()` then substitutes that
tier's budget (`ALIAS_TIER_BUDGETS`: 1000 / 4000 / dynamic, what the old fixed models declared) for the
target model's declared one, and every
effort and explicit-budget rule treats it as the model's own default. Without it, a tool loop configured
with a `-low` id and no effort went from 1000 thinking tokens to unbounded dynamic reasoning on every
step, behind a single warning. The tier lives on the alias, never on the target: the same model
requested by its own id keeps its own default. `ALIAS_TIER_BUDGETS` holds the same numbers as
`DYNAMIC_TIERS` but is a separate constant on purpose: the effort scale may be retuned, and an old id's
promise should not move with it.

**`resolveModel()` never resolves silently.** An inexact match warns once naming what it used, and
an id matching nothing throws `UnknownModelError`, which `server.ts` turns into a 400. Approximation
is deliberate — Claude Code sends Anthropic's own ids and refusing them would break the main use
case — but a client that appends a reasoning suffix (`gemini-3.8-flash-tiered-high`) once silently
got a different model generation, so the guess has to be audible. The suffix itself is kept, and it
is read **before** guessing. The order is: exact id; retired id; a known (exact or retired) id plus a
trailing `-low` / `-medium` / `-high` / `-extra-low`; and only then the guess. So `gemini-3-flash-low`
is gemini-3-flash at low, warned as `[Model suffixed]`. Resolving the whole name and guessing on
failure sent it to the tiered model, and `gemini-3.1-flash-lite-high` to the 3.5 lite, which is exactly
the generation change the warning exists to catch. A suffix appended to a retired id outranks that
id's own tier. Only a whole trailing segment counts (`-lite` is a model). Claude and GPT-OSS ignore
the suffix and the warning says so: their budgets are fixed, and `-high` would send `-1`. The suffixes
come from `REASONING_TIERS` plus `TIER_SYNONYMS` (`extra-low` -> low), so a new tier is one edit.

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
  reachable on the LAN by default. The README says so (Quick Start, Configuration, Security); keep it
  that way if the default ever changes.
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

`src/dashboard.html` is a single self-contained ~60KB file (inline CSS + JS, no build step) served
at `/`. It polls `/api/pool`. Its visual system — OLED Zinc palette, concentric radii, tabular
numerals on all live-updating numbers — is specified in `DESIGN.md`; follow that file when changing
the UI.
