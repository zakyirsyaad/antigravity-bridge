# Hybrid Account & Gemini Web Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform existing Antigravity Bridge accounts into Hybrid Accounts capable of serving Google CloudCode developer endpoints via OAuth and consumer Gemini Web RPC endpoints via session cookies, enabling access to Gemini Argon 4 and web-exclusive models.

**Architecture:** Extend `AccountToken` in `src/oauth.ts` to store `webCookies` with strict `0600` permissions. Add `POST /api/accounts/link-web` to attach cookies to accounts without exposing credentials over HTTP. Enhance `src/gemini-web-client.ts` with dynamic `otAQ7b` model discovery and route web models (`gemini-argon-4`, `gemini-auto`, `gemini-web-*`) in `src/server.ts` to the Gemini Web engine while keeping CloudCode models on OAuth. Update the Stitch dashboard with dual status badges and a linking modal.

**Tech Stack:** TypeScript, Node.js 18+ HTTP/fetch (zero runtime dependencies), tsx.

**Spec:** `docs/superpowers/specs/2026-11-05-hybrid-account-gemini-web-design.md`

## Global Constraints
- Zero runtime dependencies in `package.json`.
- State file permissions must remain `0600` for files and `0700` for directories under `~/.zcode/`.
- No sensitive cookies or OAuth tokens leaked in API responses (`PublicAccountSummary` exposes only `hasWebCookies: boolean`).
- Management API origin guard blocks unauthorized cross-origin requests with HTTP 403.
- All offline test suites must run without external network access or quota consumption.

## Review Focus
1. An input cookie string without `__Secure-1PSID` must be rejected with HTTP 400 without corrupting the existing account's OAuth tokens.
2. Linking cookies to a non-existent account email must return HTTP 404.
3. Requests to `gemini-argon-4` when the account has no `webCookies` linked must return a clear client error (HTTP 400/403) instructing to link web cookies.
4. An account with both OAuth and `webCookies` must route `claude-opus-4-6-thinking` to CloudCode and `gemini-argon-4` to Gemini Web without cross-talk.
5. Trailing whitespace, semicolons, and quotes around cookie input must be trimmed cleanly.

---

### Task 1: Extend AccountToken Schema and Add linkWebCookies in OAuthManager

**Files:**
- Modify: `src/oauth.ts:40-80, 260-310`
- Test: `test/hybrid-accounts.test.ts`

**Interfaces:**
- Consumes: `AccountToken`, `AccountsStorage`, `PublicAccountSummary` from `src/oauth.ts`.
- Produces: `OAuthManager.linkWebCookies(email: string, cookies: string): boolean`, `PublicAccountSummary.hasWebCookies`.

- [ ] **Step 1: Write the failing test for linking web cookies**

In `test/hybrid-accounts.test.ts`:
```typescript
import { OAuthManager } from "../src/oauth";

// Assert linkWebCookies persists cookie and returns hasWebCookies: true
const oauth = OAuthManager.getInstance();
const ok = oauth.linkWebCookies("test@example.com", "__Secure-1PSID=mock-psid-123; __Secure-1PSIDTS=mock-ts-456");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: FAIL with `linkWebCookies is not a function`

- [ ] **Step 3: Implement `linkWebCookies` and update `PublicAccountSummary` in `src/oauth.ts`**

Add `webCookies?: string` and `webLinkedAt?: number` to `AccountToken`. Add `hasWebCookies?: boolean` to `PublicAccountSummary`. Implement `linkWebCookies(email: string, rawCookies: string): boolean` which extracts `__Secure-1PSID`, saves via `writeStorage`, and emits a pool activity event.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts test/hybrid-accounts.test.ts
git commit -m "feat(oauth): add linkWebCookies method and hasWebCookies public summary"
```

---

### Task 2: Implement POST /api/accounts/link-web Endpoint in BridgeServer

**Files:**
- Modify: `src/server.ts:340-390`
- Test: `test/hybrid-accounts.test.ts`

**Interfaces:**
- Consumes: `oauth.linkWebCookies()` from Task 1.
- Produces: Route `POST /api/accounts/link-web` and `/api/pool` carrying `hasWebCookies: boolean`.

- [ ] **Step 1: Write the failing test for /api/accounts/link-web endpoint**

Test:
1. Rejects missing email or cookie with HTTP 400.
2. Rejects foreign Origin with HTTP 403.
3. Successfully links valid cookies, returning `{ status: "ok", email, hasWebCookies: true }`.
4. Verifies `/api/pool` output has `hasWebCookies: true` and no cookie string.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: FAIL with 404 Not Found on `/api/accounts/link-web`

- [ ] **Step 3: Implement `POST /api/accounts/link-web` in `src/server.ts`**

In `src/server.ts` request router:
Parse body `{ email, cookies }`. Validate non-empty `email` and presence of `__Secure-1PSID`. Invoke `this.oauth.linkWebCookies(email, cookies)`. Return HTTP 200 with JSON summary.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/hybrid-accounts.test.ts
git commit -m "feat(server): add POST /api/accounts/link-web endpoint with origin guard"
```

---

### Task 3: Support Gemini Argon 4 and Web Models Dynamic Routing in BridgeServer & GeminiWebClient

**Files:**
- Modify: `src/gemini-web-client.ts:30-100`
- Modify: `src/server.ts:600-650, 800-850`
- Test: `test/hybrid-accounts.test.ts`

**Interfaces:**
- Consumes: `geminiWeb.generateContent()`, `geminiWeb.streamGenerateContent()`.
- Produces: `isGeminiWebModel(model: string): boolean`, per-account `GeminiWebClient` instances.

- [ ] **Step 1: Write failing test for model routing**

Test:
1. Request for `gemini-argon-4` or `gemini-auto` on `/v1/chat/completions` routes to `GeminiWebClient`.
2. Request for `claude-opus-4-6-thinking` routes to `AntigravityClient`.
3. Request for `gemini-argon-4` without linked web cookies returns HTTP 400 error.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: FAIL (attempted to route `gemini-argon-4` to CloudCode findModel)

- [ ] **Step 3: Implement model routing in `src/server.ts` and `src/gemini-web-client.ts`**

Define `isGeminiWebModel(model: string)`: returns true if model starts with `gemini-argon`, `gemini-auto`, `gemini-advanced`, or `gemini-web-`. In `handleOpenAIChatCompletions` and `handleAnthropicMessages`, check `isGeminiWebModel`: if true, look up active account's `webCookies`, instantiate `GeminiWebClient`, and invoke stream or non-stream generation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gemini-web-client.ts src/server.ts test/hybrid-accounts.test.ts
git commit -m "feat(routing): route Gemini Argon 4 and web models directly to Gemini Web engine"
```

---

### Task 4: Add Hybrid Status Badges and Link Web Modal to Stitch Dashboard

**Files:**
- Modify: `src/dashboard.html`
- Test: `test/hybrid-accounts.test.ts` (renders HTML correctly and registers API action)

**Interfaces:**
- Consumes: `/api/pool` output with `hasWebCookies`.
- Produces: Visual dual badges (`[CloudCode]` + `[Gemini Web]`) and "Link Web" modal.

- [ ] **Step 1: Write verification test for dashboard modal and badges**

Verify `src/dashboard.html` contains:
1. Modal element `linkWebModal`.
2. Function `openLinkWebModal(email)`.
3. Badge rendering logic for `hasWebCookies`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: FAIL with missing modal element in dashboard HTML

- [ ] **Step 3: Update `src/dashboard.html` with Stitch OLED Zinc styles**

Add "Link Web" button to account card row. Render `Gemini Web: Linked` (emerald) vs `Gemini Web: Unlinked` (zinc muted). Add modal with instruction and textarea for pasting `__Secure-1PSID`. Connect submit button to `POST /api/accounts/link-web`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/hybrid-accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.html test/hybrid-accounts.test.ts
git commit -m "feat(dashboard): add hybrid account badges and Link Gemini Web modal"
```

---

### Task 5: Final Verification & Test Suite Registration

**Files:**
- Modify: `package.json`
- Test: All offline test suites (`npm run test:<name>`) and `npm run build`

- [ ] **Step 1: Register `test:hybrid` script in `package.json`**
- [ ] **Step 2: Run `npm run build` (tsc) to verify 0 type errors**
- [ ] **Step 3: Run all offline test suites sequentially to ensure zero regressions**
- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "test: register test:hybrid in package.json and complete verification"
```
