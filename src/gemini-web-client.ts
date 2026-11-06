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

/** How long one Gemini Web request may take. The answer arrives whole, so this covers generation too. */
function webTimeoutMs(): number {
  const configured = Number(process.env.GEMINI_WEB_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_WEB_TIMEOUT_MS;
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
}

export interface WebResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** One request to gemini.google.com, read whole. Redirects are not followed: a redirect means signed out. */
export function webRequest(url: string, init: WebRequestInit): Promise<WebResponse> {
  const timeoutMs = webTimeoutMs();
  return new Promise((resolve, reject) => {
    const headers = init.body !== undefined
      ? { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) }
      : init.headers;
    const req = https.request(
      url,
      { method: init.method, headers, maxHeaderSize: MAX_RESPONSE_HEADER_BYTES, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Gemini Web did not answer within ${timeoutMs} ms`)));
    req.on("error", reject);
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

  public hasCredentials(): boolean {
    if (this.credentials?.rawCookies || this.credentials?.psid) return true;
    const envCookies = process.env.GEMINI_WEB_COOKIES || process.env.GEMINI_COOKIES || process.env.GEMINI_PSID;
    return Boolean(envCookies);
  }

  private loadCredentialsFromEnv(): void {
    const raw = process.env.GEMINI_WEB_COOKIES || process.env.GEMINI_COOKIES;
    const psid = process.env.GEMINI_PSID;
    const psidts = process.env.GEMINI_PSIDTS;
    const authUser = process.env.GEMINI_AUTH_USER || "0";

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
  public async ensureSession(): Promise<GeminiWebSession> {
    if (this.session && this.session.expiresAt > Date.now()) {
      return this.session;
    }

    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) {
      throw new Error("Gemini Web fallback credentials missing (set GEMINI_WEB_COOKIES or GEMINI_PSID)");
    }

    // Attempt root /app, /u/0/app, and /u/1/app in order to handle Google multi-login accounts
    // Attempt the configured account first, then /u/0 and /u/1, to handle Google multi-login.
    // The path that worked is kept on the session: its token is only good for that account.
    const authUser = this.credentials?.authUser || "0";
    const candidatePaths = Array.from(new Set([authPathFor(authUser), "/u/0", "/u/1"]));

    let lastError: any = null;
    for (const authPath of candidatePaths) {
      try {
        const res = await this.transport(`https://gemini.google.com${authPath}/app`, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Cookie": cookieHeader,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });

        if (!res.ok) {
          lastError = new Error(`Gemini Web session page ${authPath || "/"}app answered HTTP ${res.status}`);
          continue;
        }

        const html = res.text;
        const session = { ...GeminiWebClient.extractSessionParameters(html, cookieHeader), authPath };
        this.session = session;
        return session;
      } catch (err: any) {
        lastError = err;
      }
    }

    throw lastError || new Error("Failed to initialize Gemini Web session (check that your browser session cookies are still valid)");
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
        throw new Error("Failed to extract action session token from Gemini Web HTML (check your cookie session)");
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
      if (Array.isArray(turn.parts)) {
        for (const p of turn.parts) {
          if (p.text && p.thought !== true) {
            texts.push(p.text);
          } else if (p.functionCall?.name) {
            texts.push(`[Tool Call: ${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {})})]`);
          } else if (p.functionResponse?.response?.content) {
            texts.push(`[Tool Result: ${p.functionResponse.response.content}]`);
          }
        }
      }
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
              // If not found in payload[4], scan strings inside payload
              if (!parsedText) {
                const findDeepText = (obj: any): string | null => {
                  if (typeof obj === "string" && obj.length > 0 && !obj.startsWith("c_") && !obj.startsWith("rc_")) {
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
                const candText = findDeepText(payload);
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
  public async generateContent(promptOrContents: any, targetModelId?: string): Promise<any> {
    const session = await this.ensureSession();
    let prompt = typeof promptOrContents === "string"
      ? promptOrContents
      : GeminiWebClient.requestToPromptText(promptOrContents || {});

    if (!prompt.trim()) prompt = "Hello";

    // Post to the account the session's token came from, not the one configured.
    const authPath = session.authPath ?? authPathFor(this.credentials?.authUser || "0");
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
    });

    if (!res.ok) {
      // The token or the rotating 1PSIDTS cookie may have gone stale: fetch a fresh
      // session next time instead of failing every request until the TTL runs out.
      if (this.session === session) this.session = null;
      throw new Error(`Gemini Web generation failed with HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }

    const raw = res.text;
    return GeminiWebClient.parseAntiXssiResponse(raw);
  }

  /**
   * Streams content chunk by chunk.
   */
  public async *streamGenerateContent(promptOrContents: any, targetModelId?: string): AsyncIterable<any> {
    // Generate complete response and yield as single candidate chunk
    const full = await this.generateContent(promptOrContents, targetModelId);
    yield {
      response: full,
    };
  }
}
