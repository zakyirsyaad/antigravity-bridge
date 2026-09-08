import http from "node:http";
import crypto from "node:crypto";
import { BRIDGE_DEFAULT_PORT, SUPPORTED_MODELS } from "./constants";
import { OAuthManager } from "./oauth";
import { AntigravityClient } from "./antigravity-client";
import { Transformer, UnknownModelError } from "./transformer";
import { UsageTracker } from "./usage-tracker";
import { QuotaService } from "./quota-service";
import { QuotaTracker } from "./quota-tracker";
import { getDashboardHtml } from "./dashboard-html";

export class BridgeServer {
  private server: http.Server | null = null;
  private client: AntigravityClient;
  private oauth: OAuthManager;
  private port: number;

  constructor(port: number = BRIDGE_DEFAULT_PORT) {
    this.port = port;
    this.client = new AntigravityClient();
    this.oauth = OAuthManager.getInstance();
  }

  private parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (!body.trim()) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  /**
   * Requests arriving over loopback are trusted by default: the dashboard, the
   * CLI and any local agent reach the bridge that way, and anything already
   * running as this user can read ~/.zcode/antigravity-accounts.json directly
   * anyway. Set BRIDGE_TRUST_LOCAL=0 to require a key even locally.
   */
  private isTrustedLocalRequest(req: http.IncomingMessage): boolean {
    if (process.env.BRIDGE_TRUST_LOCAL === "0") return false;

    // A reverse proxy terminates the client connection itself, so the socket
    // address is the proxy's own loopback address for *every* caller. Trusting
    // it alone hands the whole internet a loopback exemption — which is exactly
    // what happened behind nginx. Any forwarding header means the request did
    // not arrive directly from this machine.
    //
    // Spoofing only tightens this: a local caller that sets the header loses
    // its exemption, and a remote one cannot make the socket address loopback.
    if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["forwarded"]) {
      return false;
    }

    const address = req.socket.remoteAddress || "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  /** The key a caller presented, via either header clients already send. */
  private presentedApiKey(req: http.IncomingMessage): string | null {
    const authorization = req.headers.authorization;
    if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
      const value = authorization.slice(7).trim();
      if (value) return value;
    }
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
    return null;
  }

  /**
   * Thinking tokens Google reported for a response.
   *
   * Reported separately from candidatesTokenCount, and previously discarded, so
   * `bridge:usage` always showed zero reasoning. It is the only way to tell
   * whether a thinking budget is actually being used or is sitting idle — which
   * is what a budget-vs-answer-window tradeoff has to be tuned against.
   */
  private static thoughtsTokens(resp: any): number {
    const raw = resp?.response || resp;
    return raw?.usageMetadata?.thoughtsTokenCount || 0;
  }

  /** Compare via fixed-length digests so the check does not leak the key. */
  private static keysMatch(presented: string, expected: string): boolean {
    const a = crypto.createHash("sha256").update(presented).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Returns null when the request may proceed, or the reason it may not.
   *
   * Fail-closed on purpose: a bridge reachable from a non-local address holds
   * pooled Google quota and can delete accounts, so an unset key refuses remote
   * callers rather than serving them. A localhost-only install sees no change.
   */
  private authorize(req: http.IncomingMessage): string | null {
    if (this.isTrustedLocalRequest(req)) return null;

    const expected = process.env.BRIDGE_API_KEY;
    if (!expected) {
      return "This bridge is reachable from a non-local address but BRIDGE_API_KEY is not set, so remote requests are refused. Set BRIDGE_API_KEY on the server and send it as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.";
    }

    const presented = this.presentedApiKey(req);
    if (!presented || !BridgeServer.keysMatch(presented, expected)) {
      return "Missing or invalid API key. Send it as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.";
    }
    return null;
  }

  /**
   * The management API reads and mutates stored Google credentials, so it is
   * held to a stricter policy than the inference endpoints, which stay open for
   * browser-based clients.
   */
  private isManagementPath(pathname: string): boolean {
    return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/oauth/");
  }

  private setCorsHeaders(res: http.ServerResponse, isManagement: boolean) {
    // Never hand out a wildcard on the management API: it would let any page the
    // user has open read the pool state and drive the mutation endpoints.
    if (!isManagement) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, anthropic-version");
  }

  /**
   * Withholding the CORS header stops a foreign page reading a response, but a
   * simple cross-origin POST still reaches the handler, so an account could be
   * deleted without the attacker ever seeing the reply. Reject those outright.
   *
   * Requests carrying no Origin (curl, the CLI, native GUIs, and top-level
   * navigations such as the dashboard's add-account link) are allowed through;
   * a browser Origin must match the host the request was addressed to.
   */
  private isCrossOriginRequest(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${this.port}`);
        const pathname = url.pathname.replace(/\/+$/, "");
        const isManagement = this.isManagementPath(pathname);

        this.setCorsHeaders(res, isManagement);

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // The dashboard shell carries no secrets and has to load before it can
        // present a key, so the HTML itself stays open. Its JSON variant does
        // not: that one reports the signed-in account.
        const acceptHeader = String(req.headers.accept || "");
        const wantsJson = acceptHeader.includes("application/json") && !acceptHeader.includes("text/html");
        const isDashboardShell =
          (pathname === "" || pathname === "/dashboard") && req.method === "GET" && !wantsJson;

        if (!isDashboardShell) {
          const denial = this.authorize(req);
          if (denial) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: denial, type: "unauthorized" } }));
            return;
          }
        }

        if (isManagement && this.isCrossOriginRequest(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Cross-origin requests are not allowed on the management API",
                type: "forbidden",
              },
            })
          );
          return;
        }

        try {
          // Web Dashboard
          if ((pathname === "" || pathname === "/dashboard") && req.method === "GET") {
            const accept = req.headers.accept || "";
            if (accept.includes("application/json") && !accept.includes("text/html")) {
              const acc = this.oauth.loadSavedAccount();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  status: "ok",
                  service: "antigravity-zcode-bridge",
                  account: acc?.email || "Connected via OAuth",
                  projectId: acc?.projectId,
                  models: SUPPORTED_MODELS.map((m) => m.id),
                })
              );
              return;
            }

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(getDashboardHtml());
            return;
          }

          // Health & Info (JSON)
          if (pathname === "/health") {
            const acc = this.oauth.loadSavedAccount();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "ok",
                service: "antigravity-zcode-bridge",
                account: acc?.email || "Connected via OAuth",
                projectId: acc?.projectId,
                models: SUPPORTED_MODELS.map((m) => m.id),
              })
            );
            return;
          }

          // Pool API: Status with Live Quotas
          if (pathname === "/api/pool" && req.method === "GET") {
            const pool = this.oauth.getPoolStatus();
            const accounts = this.oauth.listAccounts().accounts;

            const liveQuotas = await Promise.all(
              accounts.map(async (account) => {
                try {
                  const token = await this.oauth.getValidAccessTokenForAccount(account);
                  const quota = await QuotaService.getCachedQuota({ ...account, accessToken: token });
                  return { email: account.email, quota };
                } catch {
                  return { email: account.email, quota: null };
                }
              })
            );

            pool.accounts.forEach((acc) => {
              const match = liveQuotas.find((q) => q.email === acc.email);
              (acc as any).liveQuota = match?.quota || null;
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(pool));
            return;
          }

          // Pool API: Manual Switch Account
          if (pathname === "/api/pool/switch" && req.method === "POST") {
            const body = await this.parseBody(req);
            if (!body.email) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Email is required" }));
              return;
            }
            const active = this.oauth.switchAccountByEmail(body.email);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", active }));
            return;
          }

          // Pool API: Toggle Auto-Failover
          if (pathname === "/api/pool/toggle" && req.method === "POST") {
            const current = this.oauth.isAutoFailoverEnabled();
            this.oauth.setAutoFailoverEnabled(!current);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", autoFailoverEnabled: !current }));
            return;
          }

          // Pool API: Clear Cooldown
          if (pathname === "/api/pool/clear-cooldown" && req.method === "POST") {
            const body = await this.parseBody(req);
            if (body.email) {
              QuotaTracker.getInstance().clearCooldown(body.email);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          // Pool API: Delete Account
          if (pathname === "/api/pool/delete" && req.method === "POST") {
            const body = await this.parseBody(req);
            if (!body.email) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Email is required" }));
              return;
            }
            const success = this.oauth.deleteAccountByEmail(body.email);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", success }));
            return;
          }

          // Pool API: Add Google Account via OAuth
          if (pathname === "/api/pool/auth-url" && req.method === "GET") {
            const authUrl = this.oauth.getWebOAuthUrl();
            res.writeHead(302, { Location: authUrl });
            res.end();
            return;
          }

          // Local OAuth exchange for the standalone GUI. The bridge owns the
          // client secret so it never needs to be embedded in the GUI binary.
          if (pathname === "/oauth/exchange" && req.method === "POST") {
            const body = await this.parseBody(req);
            if (typeof body.code !== "string" || !body.code.trim()) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: "OAuth code is required", type: "invalid_request" } }));
              return;
            }

            const account = await this.oauth.exchangeAuthorizationCode(body.code);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                email: account.email,
                name: account.name,
                accessToken: account.accessToken,
                refreshToken: account.refreshToken,
                expiresAt: account.expiresAt,
                projectId: account.projectId,
              }),
            );
            return;
          }

          // Usage Metrics
          if (pathname === "/v1/usage" || pathname === "/usage") {
            const usage = UsageTracker.getInstance().getUsage();
            const acc = this.oauth.loadSavedAccount();
            const accounts = this.oauth.listAccounts().accounts;
            const quotas = await Promise.all(
              accounts.map(async (account) => {
                try {
                  const token = await this.oauth.getValidAccessTokenForAccount(account);
                  const liveQuota = await QuotaService.fetchQuota({ ...account, accessToken: token });
                  return { email: account.email || "Google Account", quota: liveQuota };
                } catch (error: any) {
                  return {
                    email: account.email || "Google Account",
                    quota: null,
                    error: error?.message || "Quota lookup failed",
                  };
                }
              }),
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "ok",
                account: acc?.email || "Google Account",
                name: acc?.name,
                quota: quotas.find((item) => item.email === (acc?.email || "Google Account"))?.quota || null,
                quotas,
                ...usage,
              })
            );
            return;
          }

          // Models List (OpenAI format)
          if (pathname === "/v1/models" || pathname === "/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                object: "list",
                data: SUPPORTED_MODELS.map((m) => ({
                  id: m.id,
                  object: "model",
                  created: 1786800000,
                  owned_by: "google-antigravity",
                  permission: [],
                  root: m.id,
                  parent: null,
                })),
              })
            );
            return;
          }

          // Anthropic Messages API: /v1/messages or /anthropic/v1/messages
          if (
            (pathname === "/v1/messages" || pathname === "/anthropic/v1/messages" || pathname === "/anthropic") &&
            req.method === "POST"
          ) {
            await this.handleAnthropicMessages(req, res);
            return;
          }

          // OpenAI Chat Completions API: /v1/chat/completions or /chat/completions
          if ((pathname === "/v1/chat/completions" || pathname === "/chat/completions") && req.method === "POST") {
            await this.handleOpenAIChatCompletions(req, res);
            return;
          }

          // Not found
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Route ${pathname} not found`, type: "not_found" } }));
        } catch (err: any) {
          // An unusable model id is the caller's mistake, not ours: say 400 so
          // clients can tell it apart from a bridge failure.
          if (err instanceof UnknownModelError) {
            if (!res.headersSent) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
            }
            return;
          }
          console.error(`[Bridge Error] ${pathname}:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: err.message || "Internal Server Error", type: "server_error" } }));
          }
        }
      });

      this.server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} is already in use by another process.`));
        } else {
          reject(err);
        }
      });

      const host = process.env.BRIDGE_HOST || "0.0.0.0";
      this.server.listen(this.port, host, () => {
        resolve(this.port);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle Anthropic /v1/messages endpoint
   */
  private async handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.parseBody(req);
    const requestedModel = body.model || "claude-opus-4-6-thinking";
    const payload = Transformer.anthropicToAntigravity(body);
    const msgId = `msg_${crypto.randomBytes(12).toString("hex")}`;

    if (body.stream) {
      try {
        const stream = await this.client.streamGenerateContent(payload);

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // 1. message_start
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: requestedModel,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`
        );

        let currentBlockIndex = 0;
        let currentBlockType: "thinking" | "text" | null = null;
        let outputTokens = 0;
        let sawToolUse = false;
        let streamUsage: any = null;

        for await (const chunk of stream) {
          const chunkUsage = chunk.response?.usageMetadata || chunk.usageMetadata;
          if (chunkUsage) streamUsage = chunkUsage;
          const candidate = chunk.response?.candidates?.[0] || chunk.candidates?.[0];
          const parts = candidate?.content?.parts || [];

          for (const part of parts) {
            const isThought = Boolean(part.thought);
            const text = part.text || "";

            if (isThought) {
              if (currentBlockType !== "thinking") {
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
                  currentBlockIndex++;
                }
                currentBlockType = "thinking";
                res.write(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: currentBlockIndex,
                    content_block: { type: "thinking", thinking: "" },
                  })}\n\n`
                );
              }
              res.write(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: { type: "thinking_delta", thinking: text },
                })}\n\n`
              );
              outputTokens += Math.ceil(text.length / 4);
            } else if (text) {
              if (currentBlockType !== "text") {
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
                  currentBlockIndex++;
                }
                currentBlockType = "text";
                res.write(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: currentBlockIndex,
                    content_block: { type: "text", text: "" },
                  })}\n\n`
                );
              }
              res.write(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: { type: "text_delta", text: text },
                })}\n\n`
              );
              outputTokens += Math.ceil(text.length / 4);
            } else if (part.functionCall) {
              if (currentBlockType !== null) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
                currentBlockIndex++;
              }
              currentBlockType = null;
              sawToolUse = true;
              const toolUseId = `call_${crypto.randomBytes(8).toString("hex")}`;
              res.write(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolUseId,
                    name: part.functionCall.name,
                    input: {},
                  },
                })}\n\n`
              );
              res.write(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(part.functionCall.args || {}),
                  },
                })}\n\n`
              );
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
              currentBlockIndex++;
            }
          }
        }

        if (currentBlockType !== null) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
        }

        // message_delta
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: sawToolUse ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })}\n\n`
        );

        // message_stop
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();

        UsageTracker.getInstance().recordUsage(
          requestedModel,
          streamUsage?.promptTokenCount || 0,
          streamUsage?.candidatesTokenCount || outputTokens,
          streamUsage?.thoughtsTokenCount || 0
        );
      } catch (streamErr: any) {
        console.error("[Stream Error]", streamErr);
        if (res.headersSent) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: streamErr.message } })}\n\n`);
          res.end();
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: streamErr.message || "Failed to stream content from Antigravity",
              },
            })
          );
        }
      }
    } else {
      // Non-streaming
      const resp = await this.client.generateContent(payload);
      const formatted = Transformer.antigravityToAnthropic(resp, requestedModel);
      UsageTracker.getInstance().recordUsage(
        requestedModel,
        formatted.usage?.input_tokens || 0,
        formatted.usage?.output_tokens || 0,
        BridgeServer.thoughtsTokens(resp)
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatted));
    }
  }

  /**
   * Handle OpenAI /v1/chat/completions endpoint
   */
  private async handleOpenAIChatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.parseBody(req);
    const requestedModel = body.model || "claude-opus-4-6-thinking";
    const payload = Transformer.openaiToAntigravity(body);
    const cmplId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      try {
        const stream = await this.client.streamGenerateContent(payload);
        // Estimated like the Anthropic streaming path: the SSE frames carry no
        // usage metadata, so both protocols approximate rather than one of them
        // silently reporting nothing.
        let outputTokens = 0;
        // Position of the next tool call within this turn. OpenAI clients
        // accumulate tool_call deltas keyed by this index, so parallel calls
        // must each get their own — sharing one index merges them into a
        // single call with concatenated names and unparseable arguments.
        let toolCallIndex = 0;
        let streamUsage: any = null;

        for await (const chunk of stream) {
          const chunkUsage = chunk.response?.usageMetadata || chunk.usageMetadata;
          if (chunkUsage) streamUsage = chunkUsage;
          const candidate = chunk.response?.candidates?.[0] || chunk.candidates?.[0];
          const parts = candidate?.content?.parts || [];

          for (const part of parts) {
            const isThought = Boolean(part.thought);
            const text = part.text || "";

            if (isThought) {
              res.write(
                `data: ${JSON.stringify({
                  id: cmplId,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: text },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
              outputTokens += Math.ceil(text.length / 4);
            } else if (text) {
              res.write(
                `data: ${JSON.stringify({
                  id: cmplId,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [
                    {
                      index: 0,
                      delta: { content: text },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
              outputTokens += Math.ceil(text.length / 4);
            } else if (part.functionCall) {
              const toolCallId = part.functionCall.id || `call_${crypto.randomBytes(8).toString("hex")}`;
              res.write(
                `data: ${JSON.stringify({
                  id: cmplId,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolCallIndex,
                            id: toolCallId,
                            type: "function",
                            function: {
                              name: part.functionCall.name,
                              arguments: JSON.stringify(part.functionCall.args || {}),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`
              );
              toolCallIndex++;
            }
          }
        }

        res.write(
          `data: ${JSON.stringify({
            id: cmplId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: toolCallIndex > 0 ? "tool_calls" : "stop",
              },
            ],
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();

        UsageTracker.getInstance().recordUsage(
          requestedModel,
          streamUsage?.promptTokenCount || 0,
          streamUsage?.candidatesTokenCount || outputTokens,
          streamUsage?.thoughtsTokenCount || 0
        );
      } catch (streamErr: any) {
        console.error("[OpenAI Stream Error]", streamErr);
        res.write(`data: ${JSON.stringify({ error: { message: streamErr.message } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      const resp = await this.client.generateContent(payload);
      const formatted = Transformer.antigravityToOpenAI(resp, requestedModel);
      UsageTracker.getInstance().recordUsage(
        requestedModel,
        formatted.usage?.prompt_tokens || 0,
        formatted.usage?.completion_tokens || 0,
        BridgeServer.thoughtsTokens(resp)
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatted));
    }
  }
}
