import http from "node:http";
import crypto from "node:crypto";
import { BRIDGE_DEFAULT_PORT, SUPPORTED_MODELS } from "./constants";
import { OAuthManager } from "./oauth";
import { AntigravityClient } from "./antigravity-client";
import { Transformer } from "./transformer";
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

  private setCorsHeaders(res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, anthropic-version");
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        this.setCorsHeaders(res);

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url || "/", `http://localhost:${this.port}`);
        const pathname = url.pathname.replace(/\/+$/, "");

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

        for await (const chunk of stream) {
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
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })}\n\n`
        );

        // message_stop
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();

        UsageTracker.getInstance().recordUsage(requestedModel, 0, outputTokens, 0);
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
        0
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

        for await (const chunk of stream) {
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
                            index: 0,
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
                finish_reason: "stop",
              },
            ],
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (streamErr: any) {
        console.error("[OpenAI Stream Error]", streamErr);
        res.write(`data: ${JSON.stringify({ error: { message: streamErr.message } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      const resp = await this.client.generateContent(payload);
      const formatted = Transformer.antigravityToOpenAI(resp, requestedModel);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatted));
    }
  }
}
