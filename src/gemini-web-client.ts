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

import { Readable } from "node:stream";

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
}

export class GeminiWebClient {
  private static instance: GeminiWebClient;
  private session: GeminiWebSession | null = null;
  private credentials: GeminiWebCredentials | null = null;

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

    const authUser = this.credentials?.authUser || "0";
    const initUrl = authUser !== "0"
      ? `https://gemini.google.com/u/${authUser}/app`
      : "https://gemini.google.com/app";

    const res = await fetch(initUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": cookieHeader,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      throw new Error(`Gemini Web session init failed with HTTP ${res.status}`);
    }

    const html = await res.text();
    const session = GeminiWebClient.extractSessionParameters(html, cookieHeader);
    this.session = session;
    return session;
  }

  /**
   * Helper extracting SNlM0e, buildLabel, and sessionID from HTML
   */
  public static extractSessionParameters(html: string, cookieHeader: string): GeminiWebSession {
    // 1. Extract SNlM0e (support varied JSON / JS quotes and whitespace)
    let at = "";
    const atMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/) || html.match(/\[\s*"SNlM0e"\s*,\s*"([^"]+)"\s*\]/);
    if (atMatch) {
      at = atMatch[1];
    } else {
      throw new Error("Failed to extract SNlM0e session token from Gemini Web HTML (check your cookie session)");
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
    if (!modelName || typeof modelName !== "string") return false;
    const clean = modelName
      .trim()
      .toLowerCase()
      .replace(/^(google|antigravity)\//, "")
      .replace(/^antigravity-/, "");

    return (
      clean.startsWith("gemini-argon") ||
      clean === "gemini-auto" ||
      clean === "gemini-advanced" ||
      clean.startsWith("gemini-web-") ||
      clean.includes("argon")
    );
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
   * Builds the double-JSON encoded RPC form payload (`f.req`).
   * Supports specific modelId routing (e.g. Argon: 95a4c0abcba24364) at index 79.
   */
  public static buildRpcPayload(prompt: string, atToken: string, modelId?: string): URLSearchParams {
    // Sparse array format used by assistant.lamda.BardFrontendService
    const innerData = new Array(81).fill(null);
    innerData[0] = [prompt];
    innerData[1] = ["en"];
    innerData[2] = ["", "", ""];

    // If targeting Argon or specific model, route via index 79
    if (modelId) {
      if (modelId.toLowerCase().includes("argon") || modelId.toLowerCase().includes("gemini-argon")) {
        innerData[79] = "95a4c0abcba24364"; // Exact Argon Model ID from otAQ7b discovery
      } else {
        innerData[79] = modelId;
      }
    }

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
      : GeminiWebClient.contentsToPromptText(promptOrContents.contents || []);

    if (!prompt.trim()) prompt = "Hello";

    const authUser = this.credentials?.authUser || "0";
    const generateUrl = authUser !== "0"
      ? `https://gemini.google.com/u/${authUser}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.fsid)}&_reqid=${Math.floor(Math.random() * 89999 + 10000)}&rt=c`
      : `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(session.bl)}&f.sid=${encodeURIComponent(session.fsid)}&_reqid=${Math.floor(Math.random() * 89999 + 10000)}&rt=c`;

    const bodyParams = GeminiWebClient.buildRpcPayload(prompt, session.at, targetModelId);

    const res = await fetch(generateUrl, {
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
      const errText = await res.text();
      throw new Error(`Gemini Web generation failed with HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const raw = await res.text();
    return GeminiWebClient.parseAntiXssiResponse(raw);
  }

  /**
   * Streams content chunk by chunk.
   */
  public async *streamGenerateContent(promptOrContents: any): AsyncIterable<any> {
    // Generate complete response and yield as single candidate chunk
    const full = await this.generateContent(promptOrContents);
    yield {
      response: full,
    };
  }
}
