import { Readable } from "node:stream";
import {
  ANTIGRAVITY_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  getAntigravityHeaders,
} from "./constants";
import { OAuthManager } from "./oauth";
import { QuotaTracker } from "./quota-tracker";

export interface AntigravityPayload {
  project?: string;
  model: string;
  request: {
    contents?: any[];
    systemInstruction?: any;
    generationConfig?: any;
    tools?: any[];
    toolConfig?: any;
    safetySettings?: any[];
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AntigravityClient {
  private oauth: OAuthManager;

  constructor() {
    this.oauth = OAuthManager.getInstance();
  }

  /**
   * Safe fetch with retries on network timeout/drop
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = 3
  ): Promise<Response> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        const res = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return res;
      } catch (err: any) {
        lastError = err;
        const isNetworkErr =
          err.name === "AbortError" ||
          err.code === "UND_ERR_CONNECT_TIMEOUT" ||
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT" ||
          err.message?.includes("fetch failed");

        if (isNetworkErr && attempt < maxRetries) {
          const delay = attempt * 1000;
          console.warn(`[Network Retry] Attempt ${attempt}/${maxRetries} to ${url} failed (${err.message}). Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Execute non-streaming generateContent with multi-account auto-failover
   */
  public async generateContent(payload: AntigravityPayload): Promise<any> {
    const totalAccounts = Math.max(1, this.oauth.listAccounts().accounts.length);
    let attempts = 0;

    while (attempts < totalAccounts) {
      attempts++;

      // Proactive check: if current account is in cooldown, switch proactively
      let account = this.oauth.loadSavedAccount();
      if (
        this.oauth.isAutoFailoverEnabled() &&
        account?.email &&
        QuotaTracker.getInstance().isAccountRateLimited(account.email)
      ) {
        const nextAcc = this.oauth.selectNextAvailableAccount(account.email);
        if (nextAcc) {
          console.log(`[AutoPool] Active account ${account.email} is cooling down. Switched to ${nextAcc.email}`);
          account = nextAcc;
        }
      }

      const accessToken = await this.oauth.getValidAccessToken();
      const currentAccount = this.oauth.loadSavedAccount();
      const projectId = payload.project || currentAccount?.projectId || DEFAULT_PROJECT_ID;

      const requestBody = {
        project: projectId,
        model: payload.model,
        request: payload.request,
      };

      let lastError: any = null;
      let hit429 = false;

      for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
        const url = `${endpoint}/v1internal:generateContent`;
        try {
          const res = await this.fetchWithRetry(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              ...getAntigravityHeaders(),
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errText = await res.text();
            let message = errText;
            try {
              const errObj = JSON.parse(errText);
              if (errObj.error?.message) {
                message = errObj.error.message;
              }
            } catch {}

            if (res.status === 429) {
              hit429 = true;
              if (currentAccount?.email) {
                QuotaTracker.getInstance().record429(currentAccount.email, message);
              }
            }

            lastError = new Error(`Antigravity ${endpoint} (${res.status}): ${message}`);
            if (res.status === 400) {
              throw lastError;
            }
            continue;
          }

          const data = await res.json();
          return data;
        } catch (e: any) {
          lastError = e;
          if (e.message?.includes("(400)")) {
            throw e;
          }
          if (e.message?.includes("(429)")) {
            hit429 = true;
          }
          continue;
        }
      }

      // If rate limited, auto-failover to next available account
      if (hit429 && this.oauth.isAutoFailoverEnabled()) {
        const nextAccount = this.oauth.selectNextAvailableAccount(currentAccount?.email);
        if (nextAccount) {
          console.log(
            `[AutoPool] Failover from ${currentAccount?.email} to ${nextAccount.email} due to 429 rate limit.`
          );
          continue;
        }
      }

      throw lastError || new Error("All Antigravity endpoints failed.");
    }

    throw new Error("All accounts in the pool are currently rate limited. Please wait for cooldown to reset.");
  }

  /**
   * Execute streaming streamGenerateContent with multi-account auto-failover
   */
  public async streamGenerateContent(
    payload: AntigravityPayload
  ): Promise<AsyncIterable<any>> {
    const totalAccounts = Math.max(1, this.oauth.listAccounts().accounts.length);
    let attempts = 0;

    while (attempts < totalAccounts) {
      attempts++;

      // Proactive check: if current account is in cooldown, switch proactively
      let account = this.oauth.loadSavedAccount();
      if (
        this.oauth.isAutoFailoverEnabled() &&
        account?.email &&
        QuotaTracker.getInstance().isAccountRateLimited(account.email)
      ) {
        const nextAcc = this.oauth.selectNextAvailableAccount(account.email);
        if (nextAcc) {
          console.log(`[AutoPool] Active account ${account.email} is cooling down. Switched to ${nextAcc.email}`);
          account = nextAcc;
        }
      }

      const accessToken = await this.oauth.getValidAccessToken();
      const currentAccount = this.oauth.loadSavedAccount();
      const projectId = payload.project || currentAccount?.projectId || DEFAULT_PROJECT_ID;

      const requestBody = {
        project: projectId,
        model: payload.model,
        request: payload.request,
      };

      let lastError: any = null;
      let hit429 = false;

      for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
        const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
        try {
          const res = await this.fetchWithRetry(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              ...getAntigravityHeaders(),
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errText = await res.text();
            let message = errText;
            try {
              const errObj = JSON.parse(errText);
              if (errObj.error?.message) {
                message = errObj.error.message;
              }
            } catch {}

            if (res.status === 429) {
              hit429 = true;
              if (currentAccount?.email) {
                QuotaTracker.getInstance().record429(currentAccount.email, message);
              }
            }

            lastError = new Error(`Antigravity stream ${endpoint} (${res.status}): ${message}`);
            if (res.status === 400) {
              throw lastError;
            }
            continue;
          }

          if (!res.body) {
            throw new Error("No response body from streamGenerateContent");
          }

          return this.parseSSEStream(res.body);
        } catch (e: any) {
          lastError = e;
          if (e.message?.includes("(400)")) {
            throw e;
          }
          if (e.message?.includes("(429)")) {
            hit429 = true;
          }
          continue;
        }
      }

      if (hit429 && this.oauth.isAutoFailoverEnabled()) {
        const nextAccount = this.oauth.selectNextAvailableAccount(currentAccount?.email);
        if (nextAccount) {
          console.log(
            `[AutoPool] Stream failover from ${currentAccount?.email} to ${nextAccount.email} due to 429 rate limit.`
          );
          continue;
        }
      }

      throw lastError || new Error("All Antigravity streaming endpoints failed.");
    }

    throw new Error("All accounts in the pool are currently rate limited. Please wait for cooldown to reset.");
  }

  /**
   * Parse SSE Stream chunks from Google Antigravity into parsed JSON payloads
   */
  private async *parseSSEStream(
    body: ReadableStream<Uint8Array> | any
  ): AsyncIterable<any> {
    const reader = body.getReader ? body.getReader() : Readable.from(body);
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      if (body.getReader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr && dataStr !== "[DONE]") {
                try {
                  const parsed = JSON.parse(dataStr);
                  yield parsed;
                } catch {
                  // Ignore JSON parse chunk errors
                }
              }
            }
          }
        }
      } else {
        for await (const chunk of reader) {
          buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim();
              if (dataStr && dataStr !== "[DONE]") {
                try {
                  const parsed = JSON.parse(dataStr);
                  yield parsed;
                } catch {
                  // Ignore
                }
              }
            }
          }
        }
      }

      if (buffer.trim().startsWith("data:")) {
        const dataStr = buffer.trim().slice(5).trim();
        if (dataStr && dataStr !== "[DONE]") {
          try {
            yield JSON.parse(dataStr);
          } catch {}
        }
      }
    } finally {
      if (reader.releaseLock) reader.releaseLock();
    }
  }
}
