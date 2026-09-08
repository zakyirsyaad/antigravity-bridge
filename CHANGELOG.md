# Changelog

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
