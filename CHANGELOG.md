# Changelog

## 2.5.0

Two things found while running OpenDesign and `npm test`, both reproduced against Google.

### Fixed: three model ids Google no longer serves

`npm test` failed at its Pro step with `Request contains an invalid argument`, which looked like
a `max_tokens` problem and was not: Google answers HTTP 400 to **every** request for
`gemini-3.1-pro-high` — on all six pooled accounts, with no generationConfig, a cap only, and fixed
or dynamic thinking. `gemini-pro-agent`, Google's name for the same "Gemini 3.1 Pro (High)", answers
on every account. The old id is still in Google's catalogue with full metadata, which is why
`bridge:models` never flagged it: only calling a model shows it is dead.

So any client asking for "pro" (the id, `gemini-3.1-pro`, `gemini-3-pro`, or any name containing
"pro") got a 400 and nothing said why. Likewise `gemini-3.7-flash-tiered` and
`gemini-3.6-flash-tiered` answer 404.

- `gemini-pro-agent` replaces `gemini-3.1-pro-high` (dynamic budget, floor 32, 65,536 output).
- The 3.7 and 3.6 tiered ids are removed from the model list.
- Every old name keeps working and resolves to a model that answers, with the usual one-time
  "deprecated" warning: `gemini-3.1-pro-high`, `gemini-3.1-pro`, `gemini-3-pro` -> `gemini-pro-agent`;
  `gemini-3.7-flash`, `gemini-3.7-flash-high`, `gemini-3.7-flash-tiered`, `gemini-3.6-flash-tiered`
  -> `gemini-3.8-flash-tiered`. A "pro" nearest-match lands on `gemini-pro-agent`.
- `gemini-3.1-pro-low` metadata follows Google's (floor 32, 65,536 output).
- `/v1/models` lists 15 models, down from 17. A client that cached the old list will still work
  through the aliases.

I tried every remaining id with one request: all answer, except `gemini-2.5-pro`, which currently
returns 503 "no capacity" on every account — capacity, not a dead id, so it stays.

### Fixed: a history that opens with a tool call was a 400 that ended the run

OpenDesign's run produced an empty turn, retried, and Google answered 400 "function call turn
comes immediately after a user turn or after a function response turn". Of six history shapes
sent to Google, exactly one produces that message: a conversation whose **first turn is a model
function call**. The client's retry had re-sent a history whose earlier messages were gone.

A history that opens with a model turn now gets a short user note in front ("Earlier messages in
this conversation were omitted"). The calls and responses that remain are left exactly as they were,
which dropping them would not do. Verified against Google: such a history now answers.

### Added: a rejected request logs its shape

Google's 400 names the rule that broke, not the turn that broke it, and the history is private. On
every 400 the bridge now logs `[Upstream 400] request shape: 3 turns: model:call > user:response >
user:text` — roles and part kinds, never any text; a long history keeps its first and last turns and
its true length.

### Known, not changed

The same run's empty turn was `finishReason=MALFORMED_FUNCTION_CALL` ("Function call is empty - no
input to parse") after 20,406 thinking tokens and over two minutes. It is a model failure, seen once,
and the bridge still closes it as an empty `end_turn`. Retrying it upstream would double a
two-minute wait on one occurrence, so it is left until it recurs.

## 2.4.1

### Fixed: an upstream that stops answering no longer costs three minutes on one account

OpenDesign's run finished its design and then died: three requests in a row ended as 500s,
each exactly three minutes after it started, with five of the six accounts idle. Google
had accepted the requests and never answered — no 429, no 503 — and the client waited
60 s, aborted, and retried the **same** account twice more before giving up. The caller's own
retry then did the same, three times over.

These stalls come in bursts of five to nine minutes on one account, and each one followed a
run of large requests on it (seven in 70 s, five in 70 s, nine in 80 s). Prompt size and long
thinking were ruled out by measurement: 100–160k-token prompts and reasoning-heavy questions
all got their first response in 5–11 s. That the burst belongs to the account, rather than to
Google as a whole, is the working hypothesis, not a measured fact.

When failover is on and the pool has another account, the **first** timeout now gives up and
moves on:

- the stalled account is rested in memory for 300 s (`BRIDGE_STALL_REST_SECONDS`) and skipped by
  pool selection — it is **not** written to the quota file, because it is not out of quota and
  the dashboard's cooldown should keep meaning that;
- the request goes to the next account, at most twice, so three accounts and never the whole
  pool; if all three stall the error says "No response from Google within 60s";
- each rotation logs `[Upstream Stall] <account> gave no response within 60s; resting it ...`.
  If that line fires on every account in turn, the stall is global and rotation cannot help.

A single-account pool, or failover turned off, keeps the three in-place retries. A reset or
dropped connection is quick and local and is still retried in place.

### Added: `BRIDGE_UPSTREAM_TIMEOUT_MS`

The wait for Google's first response, 60000 by default. It covers only that wait; once the
response starts, the stream is the caller's to read.

## 2.4.0

The real cause of OpenDesign's "Agent completed without producing any output", found with
the 2.3.2/2.3.3 `[Stream End]` line and then reproduced (and a correction: 2.3.3 attributed
it to a small cap, which was a coincidence of numbers — its two fixes are real but were not
this failure).

The agent asks for **one `write` call whose argument is a whole file** — about 40,000 tokens
here — under a 16,384-token output cap. Google sends a function call only once it is
complete, so a call the cap cuts off never arrives: the stream ends `MAX_TOKENS` with no text
and no tool call (`text=0 tools=0`, ~100 s of generation discarded). The bridge closed that as
a normal `end_turn`, and the client reported nothing. Reproduced: cap 16384 gave exactly that;
cap 65536 gave one `tool_use` block of 41,627 tokens. The client's own max-tokens setting did
not reach that path (the log still read `maxOut=16384`).

### Changed: a turn cut at the token limit now says so on the stream

Both streaming handlers closed every outcome as `end_turn` / `stop`; the non-streaming path
already answered `max_tokens` / `length`. A `MAX_TOKENS` finish now ends the stream with
`stop_reason: "max_tokens"` (Anthropic) or `finish_reason: "length"` (OpenAI), so a client
can tell a truncated answer, or a dropped tool call, from a finished turn. A complete tool
call still wins (`tool_use` / `tool_calls`), and every other finish reason closes as before.

### Added: `BRIDGE_TOOL_MIN_OUTPUT_TOKENS` (off by default)

When set, a request that **carries tools** and sent a smaller output cap is raised to that
value (never above the model's own limit, never lowering a cap, and a request that sent no cap
keeps the usual default). It is the only way to let a client whose cap you cannot change finish
a large tool call — `65536` is the limit of the Gemini flash models.

It deliberately overrides a cap the caller chose, which this project otherwise refuses to do,
because the output is quota: a model that writes at length now can. Hence off, and limited to
requests with tools, so a title or a "reply ok" call keeps its small cap.

Measured with a 16,384 cap and the variable set to 65536: one `tool_use` block of 42,679 tokens,
`stop_reason: tool_use`, no warning. It took 253 s, and the client receives nothing meanwhile
(Google delivers the call whole), so a client with a shorter idle timeout can still give up first.

## 2.3.3

Both fixes below come from one OpenDesign failure ("Agent completed without producing
any output") that the 2.3.2 `[Stream End]` line explained the first time it recurred.

### Fixed: a small output cap could be spent entirely on thinking

A dynamic model (declared budget `-1`, e.g. `gemini-3.8-flash-tiered`) was sent `-1`
whatever the caller's `max_tokens`, so it reasoned until the window was gone and the
reserve the bridge holds back for the answer was never enforced for it. Measured with
one prompt, only the cap changing:

| `max_tokens` | thinking | answer | result |
|---|---|---|---|
| 1200 | 1150 | **46** | `MAX_TOKENS` |
| 2500 | 2399 | **97** | `MAX_TOKENS` |

OpenDesign's agent steps run with a small output window beside a ~100k-token prompt, so
a step could finish with thinking and no text, which the client reports as empty output
(`finishReason=MAX_TOKENS text=0 thinking=3 thoughts=1152`).

When the room left after the answer reserve is under 4096 tokens, the thinking budget is
now pinned to that room instead of `-1`, so the reserve is real. Same prompt, after:
3,563 / 7,677 / 14,808 visible characters at caps 1200 / 2500 / 4096.

- Larger caps are untouched: Claude Code's 32000, no cap at all, and 8192 stay dynamic.
- An explicit `budget_tokens`, `thinking: disabled` and `reasoning_effort` still win.
- **Trade-off:** in a window that small the model no longer writes reasoning of its own;
  the answer gets the room. A thinking-heavy task needs a larger `max_tokens`.
- A `tiny` cap (below twice the model's floor) disables thinking, as before.

### Fixed: a `provider/` prefix made the bridge pick a different model

`open-design-byok/gemini-3.8-flash-tiered` — the shape OpenCode and OpenRouter-style
clients use — was guessed from the whole string and landed on `gemini-3.6-flash-high`, an
older generation, with a warning that appears once per process. A prefix is now dropped
when what follows is an exact (or retired) model id, so it resolves to the model it names.
The guess for a name that matches nothing also looks at the model name alone, not the
prefix: `someprovider/totally-made-up` used to match "pro" in "provider".

### Changed: `[Stream End]` says what was asked of Google

The line now ends with `maxOut=<cap sent> think=<thinking budget sent>` (`?` when the
caller sent none), because a `MAX_TOKENS` turn only reads against those two numbers.

## 2.3.2

### Added: a stream that ends badly now says why

Google can end a response with nothing a client can use — a function call it judged
malformed, a token limit, a safety filter, a dropped connection — and both streaming
handlers closed every one of them as a normal `end_turn` / `stop`. They never read
`finishReason`. OpenDesign then reported "Agent completed without producing any
output" (the request had spent 1,663 output tokens), and the bridge's logs held
nothing to say which of those it was.

A stream that ends empty, or with any finish reason but a clean `STOP`, or with no
finish reason at all, now leaves one warning:

    [Stream End] /v1/messages model=... finishReason=MALFORMED_FUNCTION_CALL text=0
    thinking=1 tools=0 prompt=99859 candidates=5 thoughts=1658 finishMessage="..."

It carries Google's own `finishMessage` and any `blockReason`, plus counts of the
parts actually delivered — never the text the model produced. A healthy stream
logs nothing (checked against a real request).

**Diagnostic only.** What a client receives is byte-for-byte what it received
before; the next step is to read these lines for a real failure and fix what they
show, rather than guess at why Google stopped.

## 2.3.1

### Fixed: `/v1/models` now says how large each model's window is

The model list carried an id and a few constants, nothing about size. A client that
sizes its own prompt from the list had to guess, and Onyx guesses 32,000 tokens for
a model it does not know. With `gemini-3.8-flash-tiered` — a 1,048,576-token
window — it refused a 54,000-token prompt itself ("Not enough tokens to include the
last user message… Required: 53902, Available: 27201") before sending anything, so
the bridge's own logs showed no failure at all.

Every entry now carries `context_length`, taken from the model table, which is
Google's own metadata. It is the one field name OpenAI-compatible clients agree on
(Onyx reads it; so do OpenRouter-style listings). The fields that were already
there are unchanged, so no client sees anything it did not before except the extra
number.

A client that has already stored a guessed size keeps it until it refreshes its
model list. In Onyx that means re-fetching the models for the provider.

## 2.3.0

### Changed: a request Google rejects is now a 400, on every path

When Google answers HTTP 400 — a tool schema it cannot take, a parameter out of
range — the request itself is wrong and retrying can never help. The bridge did
not say so:

| Path | before | after |
|---|---|---|
| OpenAI non-stream | 500 `server_error` | **400** `invalid_request_error` |
| OpenAI stream | **200**, error as an in-band event | **400** `invalid_request_error` |
| Anthropic non-stream | 500 `server_error` | **400** `invalid_request_error` |
| Anthropic stream | 500 `api_error` | **400** `invalid_request_error` |

The OpenAI stream was the worst of them, and it is the one FCC uses. The handler
wrote `200` before asking Google anything, so a refused request arrived as an event
inside a success; FCC labelled it a 500 and printed "usually temporary — try again",
sending a permanent mistake looking for a transient cause. It now obtains the
upstream stream first, as the Anthropic handler always did.

The body is `{ "type": "error", "error": { "type": "invalid_request_error",
"message": ... } }` with Google's own message kept verbatim, because it names what
to fix (`...parameters.properties[2].value.enum[0]`). OpenAI clients ignore the
extra top-level `type`; Anthropic clients expect it.

**Only 400 changed.** A 401 is the bridge's credentials, a 429 or 503 is capacity,
and none of those is the caller's mistake, so they behave exactly as before — which
means the OpenAI stream still reports *those* as an in-band event inside a `200`.
That asymmetry is recorded in `CLAUDE.md` rather than hidden. A failure after a
stream has begun can only ever be in-band.

**Behaviour change for clients**: a client that retried automatically on 5xx will
no longer retry these, which is the point. A client that parsed the in-band error
event for this case will now receive an ordinary HTTP error instead.

Underneath, errors from Google are an `UpstreamError` carrying `.status`. It used
to exist only inside the message text; the text is unchanged.

### Added

- `npm run test:upstream` — the four paths, what must not change, and a failure after streaming began.

## 2.2.2

### Fixed: one MCP plugin with a numeric `const` took down every request

Google's function-declaration `enum` is a list of strings, and the request is
refused outright if any element is not one:

```
Invalid value at 'request.tools[0].function_declarations[260].parameters.properties[2].value.enum[0]' (TYPE_STRING), 10143
```

`{ "const": 10143, "type": "number" }` is how an MCP server declares a chain id.
The cleaner turned it into `enum: [10143]` with the number intact. A client sends
all of its tools on every request, so three such tools in one plugin made every
call fail, for every client, with nothing to say which tool was at fault. It
looked like the gateway being down.

A quieter bug sat beside it. A union of consts (`anyOf: [{ const: 143 }, { const:
10143 }]`) avoided the refusal by calling `String()` on the values and retyping
the parameter as a string, so a model asked for the chain id sent `"10143"` where
the server wanted `10143`.

An enum that cannot be expressed as strings is now dropped and its values go into
the description, the way every other keyword Google cannot take already does
(`must equal 10143`, `one of: 143, 10143`). The declared type is kept, or inferred
from the values when there was none, so a number stays a number. A genuine string
enum is untouched.

Checked against Google with the nine real tool schemas of the plugin that
triggered it:

| | before | after |
|---|---|---|
| all nine tools in one request | HTTP 500, three violations at `property[2]`, `[4]`, `[1]` | HTTP 200 |
| `chainId` the model sends, union tool | `"10143"` (string) | `10143` (number) |
| `chainId` the model sends, `const` tool | request refused | `10143` (number) |

**Behaviour change**: a parameter declared as a union of numeric or boolean
constants is now a number or boolean in what the model sees, where before it was a
string enum.

Not changed: an upstream 400 is not reported to the client as a client error.
Three of the four API paths answer HTTP 500 (`server_error` / `api_error`). The
OpenAI **stream** — what FCC uses — answers `200` and carries the error as an
in-band `data: {"error": ...}` event with no type or code, which FCC then labels a
500 and describes as "usually temporary — try again". It is neither; retrying a
malformed schema never helps.

## 2.2.1

### Fixed: Anthropic `output_tokens` left out the thinking

2.2.0 fixed this for OpenAI's `completion_tokens` and recorded the Anthropic side
as a known inconsistency. This closes it. Anthropic defines `output_tokens` as
*including* thinking; Google's `candidatesTokenCount` is the visible answer only,
so a request that spent thousands of tokens reasoning was reported as having
produced a handful.

- **Non-streaming**: `output_tokens` is now `candidatesTokenCount +
  thoughtsTokenCount`.
- **Streaming**: it was an estimate from the length of the text actually emitted,
  and what is emitted for thinking is a short summary, not the tokens spent. It now
  takes Google's own figure, thinking included, and keeps the estimate only as the
  fallback for when upstream reports nothing.

This is a visible change: **`output_tokens` goes up on models that think**, which
is also what they were billed as. For a turn that did not think nothing moves, apart
from the streamed figure now being Google's count rather than a guess.

Checked against ground truth rather than against itself. The local bridge serves
only this check, so its tracker deltas are exact:

```
Claude Code (streaming)  output_tokens = 3576    tracker: 163 visible + 3413 thinking = 3576
curl (non-streaming)     output_tokens = 1955    tracker:   1 visible + 1954 thinking = 1955
```

`bridge:usage` is unaffected: it stores visible output and thinking in separate
columns, so the non-streaming handler subtracts the thinking back out before
recording, exactly as the OpenAI one learned to in 2.2.0. `test:usage` guards it.

## 2.2.0

### Changed: OpenAI usage now counts reasoning, and itemises it

OpenAI responses gain `completion_tokens_details.reasoning_tokens`, in both the
non-streaming body and the `include_usage` stream chunk.

**`completion_tokens` goes up on reasoning models, and that is the point.**
OpenAI defines it as *including* reasoning, with `reasoning_tokens` as the subset.
Google keeps them apart — `candidatesTokenCount` is the visible answer only — so
the bridge reported `completion_tokens: 2` for a request that spent 2,730 tokens
thinking. Adding the detail without folding the reasoning in would have produced
`reasoning_tokens: 2730` beside `completion_tokens: 2`, a pair nobody can
subtract. Both figures now follow OpenAI's definition, and `total_tokens` is
`prompt_tokens + completion_tokens`:

```
prompt=38  completion=2731  reasoning=2730  total=2769     (visible answer = 1)
```

Reasoning is billed as output, so this is also the number that matches the cost.
A client that budgets on `completion_tokens` will see larger values than before
for reasoning models; for a model that did not think, nothing moves
(`reasoning_tokens: 0`).

`bridge:usage` is unaffected: the tracker keeps visible output and reasoning in
separate columns, and the non-streaming handler now subtracts the reasoning back
out before recording, so it is not counted twice. `test:usage` guards this.

Not changed: the Anthropic non-streaming `output_tokens` is still
`candidatesTokenCount` alone, which excludes thinking although Anthropic's
definition includes it. It is an inconsistency, not a decision, and is recorded
in `CLAUDE.md`.

Checked with the OpenAI Python SDK 2.24.0 on a prompt that makes the model think:
non-streaming and streaming both returned `reasoning_tokens` inside
`completion_tokens`, and `total_tokens == prompt_tokens + completion_tokens`.

## 2.1.4

### Fixed: the OpenAI stream never reported usage

`/v1/chat/completions` with `stream: true` sent no usage at all, so any client
that meters from the stream — the OpenAI SDKs that ask for it with
`stream_options: { include_usage: true }` — got silence. It is the same family of
gap that 2.1.3 closed for the Anthropic stream, on the other protocol.

The OpenAI contract is followed exactly: when `include_usage` is set, one extra
chunk with `choices: []` and `usage: { prompt_tokens, completion_tokens,
total_tokens }` is sent after the finish chunk and before `[DONE]`. Without the
option nothing changes, as the spec requires. When upstream never reported a
prompt size the chunk is left out rather than zeroed, because a client reads `0`
as an answer.

Checked with the OpenAI Python SDK 2.24.0 (the copy in Hermes's venv), which
parsed the chunk and read `prompt_tokens=7, completion_tokens=2, total_tokens=9`.
A request without the option returned no usage, as it should. Other SDK versions
were not tried; the chunk follows the documented shape, but that is the extent of
the claim.

`completion_tokens` is Google's `candidatesTokenCount`, matching the non-streaming
path; reasoning tokens are not folded in or broken out.

### Documented

`CLAUDE.md` now records an asymmetry that makes logs easy to misread: the
Anthropic handler obtains the upstream stream before writing `200`, so an
exhausted pool is a real error status, while the OpenAI handler writes `200`
first and reports the same failure as an event inside it.

## 2.1.3

### Fixed: streamed responses reported `input_tokens: 0`

The Anthropic stream's `message_start` has to be written before the first chunk
arrives, when the prompt size is not yet known, so it said `0` — and nothing ever
corrected it. Claude Code, T3 Code and anything else that reads usage from the
stream saw zero context in use: no meter, and no auto-compact to fire before a
long session overran the model's window.

`message_delta`, the last event, now carries `input_tokens` from Google's
`promptTokenCount`, the first moment the figure exists. It is omitted rather than
zeroed when upstream never reported one, because a client reads `0` as an answer.
Usage that Google puts on the final chunk, or inside a `response` wrapper, is read
too.

Checked with Claude Code itself: the same request that reported `input_tokens: 0`
before reports 18,785 now, which agrees with an independent estimate (~20,000)
taken from the request body it sends.

**One visible consequence**: clients that were never told the context size will
now compact when they approach their assumed window (200,000 tokens unless
configured otherwise), where before they never did. That is the behaviour they
were designed for; set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` if your model's real
window is larger.

Not changed: the OpenAI stream still emits no usage chunk.

## 2.1.2

### Fixed: `bridge:update` refused to run a second time

The update command shipped in 2.1.0 worked once, and then refused every time
after with `Local changes are present` on a tree nobody had touched.

The committed `package-lock.json` still said version `1.0.0` — it had never been
touched through the whole 2.x series. The `npm install` that `update` runs
rewrote those two `version` lines to match `package.json`, which dirtied the
checkout, which the next update correctly refused to build on. It affected every
user, not one server: the first update always passed, so the case I verified was
exactly the one that could not fail.

- The lockfile now tracks `package.json`, and `test:updater` asserts it, so a
  version bump that forgets `npm install --package-lock-only` fails a test
  instead of shipping.
- `update` restores a lockfile whose **only** change is its own `version` lines —
  before pulling, for checkouts an older release already dirtied, and after
  installing. Any other edit to the file is the user's: it is left alone and still
  refused.
- Reading `git status` was also subtly wrong: trimming the whole output ate the
  leading space of ` M package-lock.json`, so the filename never matched. Found
  by the new suite, which is why it runs against real porcelain output too.

**If you are already stuck on 2.1.0 or 2.1.1** the updater you are running cannot
rescue itself. Once:

```bash
git checkout -- package-lock.json && npm run bridge:update
```

Verified against a real git repository with a real remote and a real `npm
install` — including the second consecutive update, a checkout inherited dirty
from the old updater, and a genuine user edit to the lockfile (kept, and refused).

## 2.1.1

### Fixed: reasoning effort was ignored on the Anthropic API

Claude Code sends `output_config.effort` (`low` … `max`) on every request, beside a
`thinking: { type: "adaptive" }` block that carries no token count. The bridge only
read `thinking.budget_tokens`, so effort was dropped: `/effort low` saved nothing,
and in clients like T3 Code the only reasoning knob was the model id. The OpenAI
path already honoured `reasoning_effort`.

`output_config.effort` now scales the model's declared budget, and a tiered model
takes 1,000 / 4,000 / dynamic by level. An explicit `thinking.budget_tokens` or
`thinking: disabled` still outranks it.

**Doing nothing changes nothing.** Each protocol's *default* level maps to the
model's own default budget: OpenAI's `medium`, Anthropic's `high`. That matters
because Claude Code sends `high` on every request whether or not anyone chose it —
mapping the word to the OpenAI path's 4× would have quadrupled thinking spend on
every fixed-budget model for every user who merely upgraded. Lower levels save,
higher levels spend.

| Anthropic `effort` | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| Fixed-budget model | 0.25× | 0.5× | **1×** | 2× | 4× |
| Tiered / dynamic model | 1,000 | 4,000 | dynamic | dynamic | dynamic |

Verified through Claude Code itself, against a local bridge whose counters nothing
else touches: `low` produced 719 reasoning tokens and `high` 2,628 on one prompt,
and 1,734 against 5,239 on another.

The OpenAI path now shares the same helper; its numbers are unchanged.

### Added

- `npm run test:effort` — the mapping, the precedence, and a guard that the OpenAI path did not move.

## 2.1.0

### Added: `npm run bridge:update`

Updating was undocumented. Readers had to infer `git pull`, guess whether
dependencies had changed, and work out for themselves which of three restart
paths applied to their install — so in practice people ran old code without
knowing it.

One command now fast-forwards the checkout, installs dependencies, and reloads
the LaunchAgent when one is installed, reporting the version it left and the
version it reached.

It refuses rather than guesses, because it runs on your checkout:

- uncommitted changes are never discarded, and nothing is pulled while they exist;
- a non-git install is told so, instead of being handed a cryptic git error;
- only a fast-forward is accepted.

`npm run bridge:status` now also mentions a newer release when one exists. The
check is advisory: a 3-second timeout, silent on every failure, and never made
by `start` — a daemon that waits on the network to boot is a daemon that fails
to boot.

`README.md` gained an Updating section covering the pm2 and foreground cases,
including the `--update-env` trap that drops `BRIDGE_API_KEY`.

### Added

- `npm run test:updater` — refusals, command order, and the silent release check.

## 2.0.4

### Changed: the dashboard says which model family, not just "cooling"

A card could read `COOLING · resets in 130h` directly below meters reporting
100% quota remaining. Both were correct — the meters come from Google's live
summary, the badge from the bridge's parsed 429 — but nothing on screen said so,
and the card looked broken.

- Each account card now leads with a row per model family (Gemini, Claude,
  GPT-OSS): a status dot and, when cooling, a live countdown. An account is
  never simply down — it is down *for something*.
- The quota meters keep their place but gain a `GOOGLE QUOTA · LIVE` label, so
  the reader knows whose numbers they are.
- The separate red "Rate limited (HTTP 429)" banner is gone; it repeated what
  the family rows now state precisely.
- The status chip distinguishes `Ready`, `N of 3 cooling`, and `Cooling`. Only a
  wholly unusable account gets the dimmed cooling treatment.
- Two KPI tiles that averaged Google's percentages — and so read 100% while the
  pool was unusable — were replaced by `Ready for Gemini` and `Ready for Claude`,
  counted as accounts failover can actually pick. The averages moved to the
  accounts section header, attributed to Google.
- The header endpoint pill showed `http://127.0.0.1:52130` even when the page was
  served from a remote host, so copying it produced an address that could not
  work. It now names the page's own origin.
- Setup snippets no longer flash a hardcoded localhost URL and the
  `antigravity-local` key that 2.0.0 stopped accepting for remote callers.
- Countdowns drop seconds past the first hour, and an empty event feed says so.

## 2.0.3

### Fixed: one model's exhausted quota parked the whole account

A 429 was recorded against the account and nothing else. But Antigravity meters
Claude — served through Vertex — separately from Gemini, so an exhausted Claude
weekly quota said nothing about Gemini.

One test request to `claude-sonnet-4-6` was enough to demonstrate the cost: it
rang the failover loop through all six pooled accounts in three seconds and
parked every one of them for up to 134 hours. `selectNextAvailableAccount()` had
nothing left to return — failover was dead until the following week — while the
dashboard's quota meters, which read Google's own numbers rather than our parsed
429 text, still showed ~100% of the Gemini quota available. Two quota systems,
one of them wrong, side by side on the same card.

Cooldowns are now keyed by `(account, family)`. `record429()`,
`isAccountRateLimited()` and `selectNextAvailableAccount()` take the model;
without one they behave exactly as before, which is also how windows written by
earlier versions keep working. The dashboard names the family that earned the
cooldown.

### Added

- `npm run test:quota` — a Claude 429 leaves Gemini selectable; the display path still reports cooling; legacy windows still limit everything.

## 2.0.2

Two production failure classes, found by reading the server's own error log.

### Fixed: Claude models died on the second turn

Requests to `claude-opus-4-6-thinking` / `claude-sonnet-4-6` failed with
`messages.1.content.0: Invalid signature in thinking block` as soon as the
conversation had any history containing reasoning.

Antigravity does not serve those ids from Gemini — it forwards them to Vertex's
Anthropic API, which validates a thinking block's `signature` cryptographically.
The bridge cannot mint one: it emits the `skip_thought_signature_validator`
sentinel that Gemini 3 *requires*, fabricates `antigravity_thought` on the way
out, and the client dutifully echoes that back on the next turn.

Prior-turn thinking is now dropped for Claude targets instead of being sent with
a fabricated signature, including the turn itself when thinking was all it held.
Gemini behaviour is unchanged — there the sentinel is still mandatory. Reasoning
history is lost for Claude multi-turn; the request now completes.

### Fixed: a 503 ended the request instead of trying another account

`No capacity available for model X on the server` was the single largest error
class in production. Only 429 rotated the pool, and `ANTIGRAVITY_ENDPOINTS` holds
one endpoint, so a 503 reached the caller on the first attempt with no second
chance anywhere.

Capacity is per project, so another account is a real retry. A 503 now fails over
on both the streaming and non-streaming paths, and deliberately records **no**
quota cooldown: parking a healthy account for hours over a transient server
condition is worse than the failure it replaces. 400 still refuses to rotate — a
malformed request is malformed everywhere.

### Added

- `npm run test:signature` — thinking history per model family.
- `npm run test:capacity` — 503 rotates, 429 still records cooldown, 400 does not rotate.

## 2.0.0

Breaking. Three things can stop working after this upgrade; each is listed with
what to do about it.

### ⚠️ Remote requests now need an API key

The bridge held pooled Google quota and could delete accounts from the pool,
through unauthenticated endpoints, on whatever address it was bound to. It now
requires a shared secret from anything that is not this machine.

```bash
export BRIDGE_API_KEY="$(openssl rand -hex 32)"
```

Clients send it as `Authorization: Bearer <key>` or `x-api-key: <key>` — the
headers they already use, so this is a value change, not new plumbing. Point
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` at it instead of `antigravity-local`.

**This fails closed**: with no key set, remote requests are refused rather than
served. A localhost-only install is unaffected and needs no configuration. If
you run behind a reverse proxy, the key is required — the proxy's own loopback
address does not count as local.

`GET /api/pool` also no longer returns OAuth tokens. If you were reading
`activeAccount.accessToken` from it, that field is gone by design.

### ⚠️ Model ids changed

Ids are now Google's own ids, sent verbatim. The old table advertised models it
did not deliver: `gemini-3-pro` pointed at a model Google no longer serves, and
five separate flash ids all resolved to the same `gemini-3-flash`.

| Old id | Now resolves to |
| :--- | :--- |
| `gemini-3.1-pro`, `gemini-3-pro` | `gemini-3.1-pro-high` |
| `gemini-3.8-flash`, `gemini-3.8-flash-high` | `gemini-3.8-flash-tiered` |
| `gemini-3.7-flash`, `gemini-3.7-flash-high` | `gemini-3.7-flash-tiered` |
| `gemini-2.5-flash` | `gemini-3.1-flash-lite` |

Old ids still resolve, and the bridge logs a deprecation warning naming the
replacement the first time it sees each one. Move your configs to the real ids;
`npm run bridge:models` lists what Google actually serves.

### ⚠️ Thinking budgets follow Google's per-model figures

Every thinking model previously received a flat 32,768 budget, against models
that declare 1,001–10,001 — and against dynamic models, where an explicit number
switches self-sizing off. Budgets now come from Google's metadata, and
`reasoning_effort` scales each model's own default rather than substituting
fixed numbers.

`max_tokens` is also honoured: it used to be overwritten with 64,000 whenever
the thinking budget did not fit, so `max_tokens: 100` became 64,000.

### Fixed

- Streaming tool calls were never dispatched: both SSE handlers hardcoded
  `stop_reason: "end_turn"` / `finish_reason: "stop"`. Streaming is the default
  for Claude Code, Hermes and Cursor, so tool calling was broken for every
  primary client.
- Parallel tool calls all carried `index: 0` and collapsed into one entry with
  concatenated names and unparseable arguments.
- A token refresh could hand one account's access token to a caller operating
  on another, and could overwrite a different account's stored credentials.
- `bridge:switch` unloaded the working LaunchAgent and installed a plist
  pointing at nothing, while reporting success.
- JSON Schema keywords (`if`, `not`, `patternProperties`) were advertised to the
  model as tool parameters.
- The OpenAI endpoint never recorded usage, so `bridge:usage` reported zero for
  all Hermes/Cursor traffic.
- A malformed accounts file threw a 500 from `POST /api/pool/delete`.

### Added

- `npm run bridge:models` — diffs the model table against Google's live
  catalogue and reports withdrawn ids, drifted metadata, and unexposed models.
- `bridge:usage` now reports reasoning tokens actually consumed.
- Nine offline test suites that need no account, network or quota.
- `BRIDGE_ANSWER_RESERVE_TOKENS` to tune how much of the output window is held
  back for the visible answer.

### Note on git history

`main` was rewritten to remove a hardcoded deployment address from earlier
commits, so its commit SHAs changed. Existing clones need:

```bash
git fetch origin && git reset --hard origin/main
```

A plain `git pull` will conflict.

## 1.0.0

Initial release.
