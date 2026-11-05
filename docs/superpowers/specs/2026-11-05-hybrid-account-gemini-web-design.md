# Technical Specification: Hybrid Account & Gemini Web Integration (Gemini Argon 4 & Web Models)

**Date**: 2026-11-05  
**Author**: Zaky Irsyad Rais  
**Status**: APPROVED DESIGN  
**Branch**: `feat/hybrid-account-gemini-web`

---

## 1. Executive Summary

This specification defines the architecture for transforming Antigravity Bridge accounts into **Hybrid Accounts** capable of serving both Google CloudCode developer endpoints (Claude Opus/Sonnet, Gemini Tiered) via OAuth, and consumer Gemini Web RPC endpoints (`gemini.google.com`) via session cookies.

This allows client SDKs and AI agents to access exclusive web models such as **Gemini Argon 4**, `gemini-auto`, and `gemini-advanced` using standard OpenAI and Anthropic API formats, with unified management in the existing Stitch OLED Zinc web dashboard.

---

## 2. Goals & Invariants

### 2.1 Goals
- **Single Account Identity**: Existing accounts in `~/.zcode/antigravity-accounts.json` gain optional Gemini Web capabilities without creating duplicate account entries.
- **Dynamic Routing**: Requests for web models (`gemini-argon-4`, `gemini-auto`, `gemini-advanced`, `gemini-web-*`) automatically route to the Gemini Web RPC engine (`StreamGenerate`) using the linked account's session cookies.
- **Dynamic Model Discovery**: Queries Gemini Web's internal `otAQ7b` (`geminiUserStatusRPC`) to discover active model entries and IDs at runtime.
- **Flexible Cookie Ingestion**: The dashboard modal accepts both full raw cookie strings copied from browser DevTools or individual `__Secure-1PSID` / `__Secure-1PSIDTS` tokens.
- **Zero Runtime Dependencies**: Continues to rely purely on built-in Node 18+ APIs (`fetch`, `crypto`, `http`, `fs`).

### 2.2 Security Invariants
- **Credential Isolation**: Cookies (`webCookies`) are stored in `antigravity-accounts.json` with strict `0600` permissions.
- **Zero Leakage**: `webCookies` are stripped from all public management API outputs (`/api/pool`), returning only `hasWebCookies: boolean`.
- **Origin Guard**: `POST /api/accounts/link-web` rejects unauthorized cross-origin requests (`403 Forbidden`).

---

## 3. Architecture & Data Model

### 3.1 Data Model Changes (`src/oauth.ts`)

```typescript
export interface AccountToken {
  name?: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  projectId?: string;
  // Hybrid Account Additions:
  webCookies?: string;      // Raw or reconstructed Cookie header containing __Secure-1PSID
  webLinkedAt?: number;     // Timestamp in ms when cookies were linked
}

export interface PublicAccountSummary {
  email?: string;
  name?: string;
  projectId?: string;
  hasWebCookies?: boolean;  // Safe boolean flag indicating Gemini Web readiness
}
```

### 3.2 Management API Endpoint (`src/server.ts`)

- **`POST /api/accounts/link-web`**:
  - **Body**: `{ email: string, cookies: string }`
  - **Behavior**:
    1. Validates that `email` exists in the stored accounts list.
    2. Parses `cookies`: extracts `__Secure-1PSID` and `__Secure-1PSIDTS` if provided in raw format, or formats if given standalone.
    3. Rejects with `400 Bad Request` if no valid `__Secure-1PSID` is found.
    4. Persists the updated account with atomic `0600` mode.
    5. Records an activity event in the pool stream: `"Linked Gemini Web cookies to <email>"`.
    6. Returns `{ status: "ok", email, hasWebCookies: true }`.

---

## 4. Model Routing & Discovery

### 4.1 Model Classification
A request is classified as a **Gemini Web Request** if:
1. `model` matches `gemini-argon-4` or alias `gemini-argon`.
2. `model` matches `gemini-auto` or `gemini-advanced`.
3. `model` starts with `gemini-web-`.
4. `model` matches any dynamically discovered model ID from `GeminiWebClient.getDiscoveredModels()`.

All other models (`claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gemini-3.8-flash-tiered`, etc.) route to Google CloudCode via OAuth.

### 4.2 Dynamic Discovery via `otAQ7b` (`src/gemini-web-client.ts`)
- Queries Google's `otAQ7b` batch execute RPC using the account's `SNlM0e` CSRF token.
- Extracts `modelID`, `modelNumber`, and capacity flags.
- Maps discovered models to clean public names (e.g. `gemini-argon-4`, `gemini-auto`).

---

## 5. Stitch Dashboard UI Additions (`src/dashboard.html`)

1. **Account Cards**:
   - Displays dual status badges on each account:
     - `CloudCode: Active` (Emerald)
     - `Gemini Web: Linked` (Emerald) OR `Gemini Web: Unlinked` (Muted)
   - Adds a **"Link Web"** button on each account card.
2. **"Link Gemini Web" Modal**:
   - Textarea for pasting cookie strings.
   - Informative helper showing where to copy cookies in browser DevTools (`gemini.google.com -> Application -> Cookies -> __Secure-1PSID`).
   - "Save & Link" button triggering `POST /api/accounts/link-web` and refreshing pool status immediately.

---

## 6. Testing & Verification Plan

1. **`test/hybrid-accounts.test.ts`**:
   - Verifies `linkWebCookies` attaches cookies without mutating existing OAuth refresh tokens.
   - Verifies `hasWebCookies: true` in public summary while ensuring cookie contents are never exposed.
   - Verifies rejection of missing/invalid cookie strings (HTTP 400).
   - Verifies cross-origin protection blocks foreign origins on `/api/accounts/link-web` (HTTP 403).
   - Verifies model routing sends `gemini-argon-4` to `GeminiWebClient` and `claude-sonnet-4-6` to `AntigravityClient`.
2. **Full Regression Check**:
   - Runs all 27 offline test suites (`npm run test:<suite>`).
   - Runs TypeScript build typecheck (`npm run build`).
