# Changelog

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
