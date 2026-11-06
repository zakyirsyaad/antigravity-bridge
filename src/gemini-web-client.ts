/**
 * Gemini Web Client (Fallback & Secondary Provider).
 *
 * Implements the browser-based RPC protocol for gemini.google.com:
 * 1. Session initialization from __Secure-1PSID / __Secure-1PSIDTS cookies.
 * 2. Extraction of SNlM0e (c.at CSRF token) and session parameters from https://gemini.google.com/app.
 * 3. Double-JSON RPC submission to assistant.lamda.BardFrontendService/StreamGenerate.
 * 4. Parsing of Anti-XSSI prefixed stream envelopes (`)]}'\n`) into standard candidate parts.
 *
 * Used as automatic fallback when the CloudCode account pool exhausts (all 429/503),
 * or when configured with GEMINI_WEB_COOKIES.
 */

import https from "node:https";

export interface GeminiWebCredentials {
  psid?: string;
  psidts?: string;
  rawCookies?: string;
  authUser?: string; // target account in multi-login (e.g. "0", "1")
}

export interface GeminiWebSession {
  at: string; // SNlM0e
  bl: string; // buildLabel (cfb2h)
  fsid: string; // sessionID (FdrFJe)
  cookies: string;
  expiresAt: number;
  /** "" or "/u/<n>": the multi-login path the session was read from. Generate must post to the same one. */
  authPath?: string;
}

/** Gemini Web's own id for Argon, discovered via otAQ7b. */
const ARGON_MODEL_ID = "95a4c0abcba24364";
/** The shape of Gemini Web's model ids; anything else is a bridge name, not one Google knows. */
const WEB_MODEL_ID_PATTERN = /^[0-9a-f]{16}$/;
const DEFAULT_WEB_TIMEOUT_MS = 180_000;
/** setTimeout's ceiling: a longer delay is clamped to 1 ms by Node, so every request would fail at once. */
const MAX_TIMER_MS = 2_147_483_647;
/** A session read from another signed-in account than the configured one is retried after this. */
const FALLBACK_SESSION_TTL_MS = 10 * 60 * 1000;
const CHARS_PER_TOKEN = 4;
/** An answer larger than this is not a chat reply; stop reading rather than buffer it all. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * The model id usage is recorded under when the pool fell back to Gemini Web, so the
 * estimate is not added to the CloudCode model that was asked for.
 */
export const GEMINI_WEB_FALLBACK_USAGE_ID = "gemini-web-fallback";

/**
 * How long one Gemini Web request may take in all: the session pages and the generate
 * share it. The answer arrives whole, so this covers generation too.
 */
export function webTimeoutMs(): number {
  const configured = Number(process.env.GEMINI_WEB_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 && configured <= MAX_TIMER_MS
    ? Math.floor(configured)
    : DEFAULT_WEB_TIMEOUT_MS;
}

/**
 * Google answered, but not with anything usable for these cookies: a session page that
 * redirects (signed out) or carries no token, a generate that answers non-2xx, a 200 with
 * no readable reply. It is about the account's session, so another linked session may do
 * better (gemini-web-rotation.ts). A transport failure or the bridge's own timeout is a
 * plain Error: that is the network, and another account would meet the same one.
 */
export class GeminiWebAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiWebAccountError";
  }
}

/**
 * An error that says what happened. A connection that fails on every address is an
 * AggregateError with an empty message, which used to reach the log and the client as
 * nothing at all; its code (ECONNREFUSED, ETIMEDOUT) is the useful part.
 */
function describedError(err: any): Error {
  if (err instanceof Error && err.message) return err;
  const codes = [err?.code, ...(Array.isArray(err?.errors) ? err.errors.map((e: any) => e?.code || e?.message) : [])]
    .filter(Boolean);
  return new Error(`Gemini Web connection failed${codes.length ? `: ${Array.from(new Set(codes)).join(", ")}` : ""}`);
}

/**
 * Room for Google's response headers. gemini.google.com sends ~29 KB of them (a 21 KB
 * Content-Security-Policy alone), past the 16 KB that Node's built-in fetch accepts, so
 * every fetch() to it died as UND_ERR_HEADERS_OVERFLOW ("fetch failed"). Raising that
 * limit means a process flag (--max-http-header-size) set outside this repo, so these
 * requests go through node:https, which takes the limit per request.
 */
const MAX_RESPONSE_HEADER_BYTES = 128 * 1024;

export interface WebRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** What is left of the request's deadline; defaults to the whole GEMINI_WEB_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface WebResponse {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * One request to gemini.google.com, read whole. Redirects are not followed: a redirect
 * means signed out. The timeout bounds the whole request, not just a quiet socket:
 * StreamGenerate (rt=c) sends chunks as it goes, so an idle timeout alone never fires
 * on a slow drip. `request` is https.request; the offline suite passes http.request to
 * test the header room against a local server.
 */
export function webRequest(
  url: string,
  init: WebRequestInit,
  request: typeof https.request = https.request
): Promise<WebResponse> {
  const timeoutMs = Math.max(1, Math.min(init.timeoutMs ?? webTimeoutMs(), MAX_TIMER_MS));
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Every way out goes through here, so the timer never outlives the request (it used
    // to stay armed, holding the buffered body, when the response errored mid-body).
    let settled = false;
    const settle = (err: unknown, value?: WebResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(describedError(err));
      else resolve(value as WebResponse);
    };
    const headers = init.body !== undefined
      ? { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) }
      : init.headers;
    const req = request(
      url,
      { method: init.method, headers, maxHeaderSize: MAX_RESPONSE_HEADER_BYTES },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`Gemini Web answer exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err) => settle(err));
        res.on("end", () => {
          const status = res.statusCode || 0;
          settle(null, { ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    timer = setTimeout(
      () => req.destroy(new Error(bytes > 0
        ? `Gemini Web did not finish answering within ${timeoutMs} ms`
        : `Gemini Web did not answer within ${timeoutMs} ms`)),
      timeoutMs
    );
    req.on("error", (err) => settle(err));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function authPathFor(authUser: string): string {
  return authUser && authUser !== "0" ? `/u/${authUser}` : "";
}

export class GeminiWebClient {
  private static instance: GeminiWebClient;
  private session: GeminiWebSession | null = null;
  private credentials: GeminiWebCredentials | null = null;
  /** How requests reach Google; a field so the offline suites can stand in for it. */
  private transport: (url: string, init: WebRequestInit) => Promise<WebResponse> = webRequest;

  private constructor() {
    this.loadCredentialsFromEnv();
  }

  public static getInstance(): GeminiWebClient {
    if (!GeminiWebClient.instance) {
      GeminiWebClient.instance = new GeminiWebClient();
    }
    return GeminiWebClient.instance;
  }

  public setCredentials(creds: GeminiWebCredentials): void {
    if (
      this.credentials &&
      this.credentials.rawCookies === creds.rawCookies &&
      this.credentials.psid === creds.psid &&
      this.credentials.psidts === creds.psidts &&
      this.credentials.authUser === creds.authUser
    ) {
      return; // Credentials unchanged; preserve cached session
    }
    this.credentials = creds;
    this.session = null; // Invalidate cached session only when credentials change
  }

  /**
   * Use the cookies linked to an account in the dashboard. Only the cookies come from the
   * account: the multi-login choice (GEMINI_AUTH_USER) is still the operator's, and it was
   * dropped when the whole credentials object was replaced with `{ rawCookies }`.
   */
  public useLinkedCookies(webCookies: string | undefined): void {
    if (!webCookies) return;
    this.setCredentials({ rawCookies: webCookies, authUser: process.env.GEMINI_AUTH_USER });
  }

  public hasCredentials(): boolean {
    if (this.credentials?.rawCookies || this.credentials?.psid) return true;
    const envCookies = process.env.GEMINI_WEB_COOKIES || process.env.GEMINI_COOKIES || process.env.GEMINI_PSID;
    return Boolean(envCookies);
  }

  private loadCredentialsFromEnv(): void {
    const raw = process.env.GEMINI_WEB_COOKIES || process.env.GEMINI_COOKIES;
    const psid = process.env.GEMINI_PSID;
    const psidts = process.env.GEMINI_PSIDTS;
    // Left undefined when unset: an explicit choice pins the session to that account.
    const authUser = process.env.GEMINI_AUTH_USER;

    if (raw || psid) {
      this.credentials = {
        rawCookies: raw,
        psid,
        psidts,
        authUser,
      };
    }
  }

  public buildCookieHeader(): string {
    if (this.credentials?.rawCookies) {
      // Filter out massive tracking cookies (NID, COMPASS) that exceed Node.js HTTP header size limits (UND_ERR_HEADERS_OVERFLOW)
      const raw = this.credentials.rawCookies;
      const essentialKeys = [
        "__Secure-1PSID",
        "__Secure-1PSIDTS",
        "__Secure-1PAPISID",
        "__Secure-3PSID",
        "__Secure-3PSIDTS",
        "__Secure-1PSIDCC",
        "__Secure-3PSIDCC",
        "SID",
        "HSID",
        "SSID",
        "SAPISID",
        "APISID",
      ];
      const found: string[] = [];
      const parts = raw.split(";");
      for (const p of parts) {
        const trimmed = p.trim();
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const k = trimmed.slice(0, eqIdx).trim();
          if (essentialKeys.includes(k)) {
            found.push(trimmed);
          }
        }
      }
      if (found.length > 0) {
        return found.join("; ");
      }
      return raw;
    }
    const parts: string[] = [];
    if (this.credentials?.psid) {
      parts.push(`__Secure-1PSID=${this.credentials.psid}`);
    }
    if (this.credentials?.psidts) {
      parts.push(`__Secure-1PSIDTS=${this.credentials.psidts}`);
    }
    return parts.join("; ");
  }

  /**
   * Initializes or refreshes session by fetching https://gemini.google.com/app
   * and extracting SNlM0e and build metadata.
   */
  public async ensureSession(deadline: number = Date.now() + webTimeoutMs()): Promise<GeminiWebSession> {
    if (this.session && this.session.expiresAt > Date.now()) {
      return this.session;
    }

    const credentials = this.credentials;
    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) {
      throw new Error("Gemini Web fallback credentials missing (set GEMINI_WEB_COOKIES or GEMINI_PSID)");
    }

    // An explicit GEMINI_AUTH_USER pins the session to that account: answering as another
    // signed-in Google account instead is not a fallback anyone asked for. Without one, the
    // default account ("/app", which is also "/u/0") is tried, then the second one; a
    // session from that second one is retried after FALLBACK_SESSION_TTL_MS rather than
    // kept for the full six hours.
    const configured = credentials?.authUser;
    const candidatePaths = configured !== undefined ? [authPathFor(configured)] : ["", "/u/1"];

    let firstError: Error | null = null;
    for (const authPath of candidatePaths) {
      const page = `${authPath}/app`;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        firstError ??= new Error(`Gemini Web did not answer within ${webTimeoutMs()} ms`);
        break;
      }
      try {
        const res = await this.transport(`https://gemini.google.com${page}`, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Cookie": cookieHeader,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          timeoutMs: remaining,
        });

        if (!res.ok) {
          firstError ??= res.status >= 300 && res.status < 400
            ? new GeminiWebAccountError(`Gemini Web session page ${page} redirected (HTTP ${res.status}): the browser cookies are signed out; link fresh ones`)
            : new GeminiWebAccountError(`Gemini Web session page ${page} answered HTTP ${res.status}`);
          continue;
        }

        const extracted = GeminiWebClient.extractSessionParameters(res.text, cookieHeader);
        const isFallback = authPath !== candidatePaths[0];
        const session: GeminiWebSession = {
          ...extracted,
          authPath,
          expiresAt: isFallback ? Date.now() + FALLBACK_SESSION_TTL_MS : extracted.expiresAt,
        };
        // Cookies switched while this page was loading: the session belongs to the old ones.
        if (this.credentials === credentials) this.session = session;
        if (isFallback) {
          // A different signed-in Google account than the default one is answering.
          console.warn(`[Gemini Web] session page ${candidatePaths[0]}/app failed; using ${page} instead`);
        }
        return session;
      } catch (err: any) {
        firstError ??= err instanceof GeminiWebAccountError ? err : describedError(err);
      }
    }

    throw firstError || new Error("Failed to initialize Gemini Web session (check that your browser session cookies are still valid)");
  }

  /**
   * Helper extracting SNlM0e, buildLabel, and sessionID from HTML
   */
  public static extractSessionParameters(html: string, cookieHeader: string): GeminiWebSession {
    // 1. Extract action token (SNlM0e or new WIZ_global_data action token thykhd)
    let at = "";
    const atMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/) || html.match(/\[\s*"SNlM0e"\s*,\s*"([^"]+)"\s*\]/);
    if (atMatch) {
      at = atMatch[1];
    } else {
      // Fallback to WIZ_global_data action token (Google Gemini 2026 update: thykhd or uS02ke)
      const wizMatch = html.match(/"thykhd"\s*:\s*"([^"]+)"/) || html.match(/"uS02ke"\s*:\s*"([^"]+)"/);
      if (wizMatch) {
        at = wizMatch[1];
      } else {
        throw new GeminiWebAccountError("Failed to extract action session token from Gemini Web HTML (check your cookie session)");
      }
    }

    // 2. Extract buildLabel (cfb2h)
    let bl = "boq_assistant-bard-web-server_20240101.00_p0";
    const blMatch = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
    if (blMatch) bl = blMatch[1];

    // 3. Extract sessionID (FdrFJe)
    let fsid = "";
    const fsidMatch = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
    if (fsidMatch) fsid = fsidMatch[1];

    return {
      at,
      bl,
      fsid,
      cookies: cookieHeader,
      expiresAt: Date.now() + 6 * 3600 * 1000, // 6 hour TTL
    };
  }

  /**
   * Checks whether a requested model name targets the Gemini Web engine.
   * Strips routing prefixes (e.g. google/, antigravity-, antigravity/) before testing.
   */
  public static isGeminiWebModel(modelName: string): boolean {
    const clean = GeminiWebClient.normalizeWebModelName(modelName);
    return (
      clean.startsWith("gemini-argon") ||
      clean.startsWith("argon") ||
      clean === "gemini-auto" ||
      clean === "gemini-advanced" ||
      clean.startsWith("gemini-web-")
    );
  }

  /**
   * The model name without any `provider/` routing prefix or `antigravity-` prefix,
   * lowercased. The single place both the server and Transformer read a web id from.
   */
  public static normalizeWebModelName(modelName: string): string {
    if (!modelName || typeof modelName !== "string") return "";
    const lastSegment = modelName.trim().toLowerCase().split("/").pop() || "";
    return lastSegment.replace(/^antigravity-/, "");
  }

  /**
   * A whole Antigravity request (system instruction plus contents) as one prompt.
   */
  public static requestToPromptText(request: any): string {
    const systemText = Array.isArray(request?.systemInstruction?.parts)
      ? request.systemInstruction.parts.map((p: any) => p?.text || "").filter(Boolean).join("\n")
      : "";
    const conversation = GeminiWebClient.contentsToPromptText(request?.contents || []);
    return systemText ? `System: ${systemText}\n\n${conversation}` : conversation;
  }

  /**
   * Formats Antigravity contents array into a single combined prompt text for Gemini Web.
   */
  public static contentsToPromptText(contents: any[]): string {
    if (!Array.isArray(contents) || contents.length === 0) return "";

    const lines: string[] = [];
    for (const turn of contents) {
      const role = turn.role === "model" ? "Assistant" : "User";
      const texts: string[] = [];
      // A turn's calls are written in the JSON shape the tool bridge asks the model to
      // answer in, so a model that continues in the style of its history still produces
      // something parseToolBridgeOutput() reads (a `[Tool Call: ...]` notation it did not).
      const calls: Array<{ id?: string; name: string; arguments: unknown }> = [];
      if (Array.isArray(turn.parts)) {
        for (const p of turn.parts) {
          if (p.text && p.thought !== true) {
            texts.push(p.text);
          } else if (p.functionCall?.name) {
            calls.push({ ...(p.functionCall.id ? { id: p.functionCall.id } : {}), name: p.functionCall.name, arguments: p.functionCall.args ?? {} });
          } else if (p.functionResponse) {
            // Named and tied to its call: parallel results can come back in any order, and
            // an empty result is still an answer (dropping it left the call unanswered).
            const fr = p.functionResponse;
            const content = fr.response?.content;
            const shown = content === undefined || content === null || content === "" ? "(empty)" : String(content);
            const label = [fr.name, fr.id ? `id ${fr.id}` : ""].filter(Boolean).join(", ");
            texts.push(`[Tool Result${label ? ` (${label})` : ""}: ${shown}]`);
          }
        }
      }
      if (calls.length > 0) texts.push(JSON.stringify({ tool_calls: calls }));
      if (texts.length > 0) {
        lines.push(`${role}: ${texts.join("\n")}`);
      }
    }

    return lines.join("\n\n");
  }

  /**
   * Gemini Web's own model id for a requested model, or null to leave Gemini Web on its
   * default. A bridge name such as "gemini-auto" is never sent: Google does not know it.
   */
  public static resolveWebModelId(modelId?: string): string | null {
    if (!modelId) return null;
    const clean = GeminiWebClient.normalizeWebModelName(modelId);
    if (clean.includes("argon")) return ARGON_MODEL_ID;
    if (WEB_MODEL_ID_PATTERN.test(clean)) return clean;
    return null;
  }

  /**
   * Builds the double-JSON encoded RPC form payload (`f.req`).
   * Supports specific modelId routing (e.g. Argon: 95a4c0abcba24364) at index 79.
   */
  public static buildRpcPayload(prompt: string, atToken: string, modelId?: string): URLSearchParams {
    // Sparse array format used by assistant.lamda.BardFrontendService
    const innerData = new Array(81).fill(null);
    innerData[0] = [prompt];
    innerData[1] = ["en"];
    innerData[2] = ["", "", ""];

    // A model Gemini Web knows is routed via index 79; anything else stays on its default.
    const webModelId = GeminiWebClient.resolveWebModelId(modelId);
    if (webModelId) innerData[79] = webModelId;

    const fReq = JSON.stringify([null, JSON.stringify(innerData)]);
    return new URLSearchParams({
      at: atToken,
      "f.req": fReq,
    });
  }

  /**
   * Parses the raw Anti-XSSI response text (`)]}'\n...`) into Antigravity candidate format.
   */
  public static parseAntiXssiResponse(rawText: string): any {
    // Strip leading )]}' and newlines
    let clean = rawText.replace(/^\)]}'\s*/, "").trim();
    if (!clean) {
      return { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] };
    }

    let parsedText = "";
    const lines = clean.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^\d+$/.test(trimmed)) continue; // Skip chunk length prefixes

      try {
        const chunkJson = JSON.parse(trimmed);
        if (Array.isArray(chunkJson)) {
          // Find envelope where item[2] is a nested JSON string
          for (const item of chunkJson) {
            if (Array.isArray(item) && typeof item[2] === "string") {
              const payload = JSON.parse(item[2]);
              // In wrb.fr responses:
              // Candidates are at payload[4] -> candidates[0][1][0]
              // Or in turn updates at payload[2]["7"][0] or payload[0]
              if (payload && Array.isArray(payload[4]) && payload[4].length > 0) {
                const cand = payload[4][0];
                if (cand && Array.isArray(cand[1]) && typeof cand[1][0] === "string") {
                  parsedText = cand[1][0];
                }
              }
              // Otherwise look inside the candidate subtree only (an extra level of nesting
              // has been seen there). The whole payload must not be scanned: its first string
              // is metadata such as the response id ("r_9f8e7d"), which then went out as the
              // model's answer and defeated the "no readable reply" check.
              if (!parsedText && payload && Array.isArray(payload[4])) {
                const findDeepText = (obj: any): string | null => {
                  if (typeof obj === "string" && obj.length > 0 && !/^(?:r|rc|c)_[A-Za-z0-9]+$/.test(obj)) {
                    return obj;
                  }
                  if (Array.isArray(obj)) {
                    for (const elem of obj) {
                      const res = findDeepText(elem);
                      if (res) return res;
                    }
                  }
                  return null;
                };
                const candText = findDeepText(payload[4]);
                if (candText) parsedText = candText;
              }
            }
          }
        }
      } catch {
        // Continue scanning remaining lines
      }
    }

    return {
      candidates: [
        {
          content: {
            parts: [{ text: parsedText }],
            role: "model",
          },
          finishReason: "STOP",
        },
      ],
    };
  }

  /**
   * Generates content via Gemini Web upstream.
   */
  public async generateContent(
    promptOrContents: any,
    targetModelId?: string,
    deadline: number = Date.now() + webTimeoutMs(),
  ): Promise<any> {
    // One deadline for the whole request: the session pages and the generate share it, and
    // so do the linked sessions a rotation tries (gemini-web-rotation.ts passes it in).
    const session = await this.ensureSession(deadline);
    let prompt = typeof promptOrContents === "string"
      ? promptOrContents
      : GeminiWebClient.requestToPromptText(promptOrContents || {});

    if (!prompt.trim()) prompt = "Hello";

    // Post to the account the session's token came from.
    const authPath = session.authPath ?? "";
    const generateUrl = `https://gemini.google.com${authPath}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.fsid)}&_reqid=${Math.floor(Math.random() * 89999 + 10000)}&rt=c`;

    const bodyParams = GeminiWebClient.buildRpcPayload(prompt, session.at, targetModelId);

    const res = await this.transport(generateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        "Origin": "https://gemini.google.com",
        "Referer": "https://gemini.google.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": session.cookies,
        "X-Same-Domain": "1",
      },
      body: bodyParams.toString(),
      timeoutMs: Math.max(1, deadline - Date.now()),
    });

    if (!res.ok) {
      // The token or the rotating 1PSIDTS cookie may have gone stale: fetch a fresh
      // session next time instead of failing every request until the TTL runs out.
      if (this.session === session) this.session = null;
      throw new GeminiWebAccountError(`Gemini Web generation failed with HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }

    const raw = res.text;
    const parsed = GeminiWebClient.parseAntiXssiResponse(raw);
    if (!parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
      // A 200 with no answer we can read: a format change, an interstitial, a quota page.
      // Passed on, it reaches the client as a successful empty reply ("completed without
      // producing any output") with nothing in the log. Say so, and fetch a fresh session.
      if (this.session === session) this.session = null;
      throw new GeminiWebAccountError(`Gemini Web answered HTTP ${res.status} with no readable reply (${raw.length} bytes)`);
    }
    return GeminiWebClient.withEstimatedUsage(parsed, prompt);
  }

  /** A rough token count: Gemini Web reports none, and ~4 characters per token is the usual rule. */
  public static estimateTokens(text: string): number {
    return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
  }

  /**
   * Gemini Web's answer with a usageMetadata estimated from the prompt actually sent and
   * the text that came back, in Google's own shape, so every reader of usageMetadata (the
   * protocol converters, the pool-fallback streams, the usage tracker) gets a figure.
   * Without it a client is told 0 input tokens, and Claude Code then shows no context in
   * use and never compacts, re-sending an ever larger prompt.
   */
  public static withEstimatedUsage(response: any, prompt: string): any {
    const answer = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const promptTokenCount = GeminiWebClient.estimateTokens(prompt);
    const candidatesTokenCount = GeminiWebClient.estimateTokens(answer);
    return {
      ...response,
      usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount: promptTokenCount + candidatesTokenCount },
    };
  }

  /**
   * Why a CloudCode request must not be answered by Gemini Web in the pool's place, or null
   * when it may be: what it asks for would be silently lost in a flattened text prompt.
   */
  public static fallbackRefusal(request: any): string | null {
    if (Array.isArray(request?.tools) && request.tools.length > 0) return "request carries tools";
    const config = request?.generationConfig;
    if (config?.responseSchema || config?.responseJsonSchema || config?.responseMimeType === "application/json") {
      return "request asks for structured output";
    }
    return null;
  }

  /** The answer text of a Gemini Web response (one candidate, one text part). */
  public static answerText(response: any): string {
    return response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
}
