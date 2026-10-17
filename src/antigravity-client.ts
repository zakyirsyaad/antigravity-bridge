import { Readable } from "node:stream";
import {
  ANTIGRAVITY_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  getAntigravityHeaders,
} from "./constants";
import { OAuthManager } from "./oauth";
import { QuotaTracker } from "./quota-tracker";
import { MAX_STALL_ROTATIONS, StallRegistry, UpstreamStall, stallRestSeconds, upstreamTimeoutMs } from "./upstream-stall";
import { describeContentsShape } from "./stream-diagnostics";
import { networkRetryDelayMs } from "./network";
import { UpstreamError } from "./upstream-error";
// Its home is upstream-error.ts; callers and tests have always imported it from here.
export { UpstreamError };
import { PoolFailures, rotationReason } from "./pool-failures";

const POOL_RATE_LIMITED = "All accounts in the pool are currently rate limited. Please wait for cooldown to reset.";

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
   * Safe fetch with retries on network timeout/drop.
   *
   * `onTimeout` says what Google not answering means. "retry" is the old behaviour:
   * try the same account again, which is all there is to do when the pool has no
   * other account. "throw" gives up at the first timeout with an UpstreamStall so
   * the caller can move to another account — a stall comes in bursts on one
   * account, and two more minutes spent inside it only ended as a 500. A dropped or
   * reset connection is quick and local, and is retried in place either way.
   *
   * "retry" still ends in an UpstreamStall when its last attempt timed out, so the
   * run is recorded as a stall and the caller is told Google stopped answering. It
   * used to end in the bare AbortError, "This operation was aborted", after three
   * minutes and with no model named, on exactly the pools that cannot rotate.
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    onTimeout: "retry" | "throw" = "retry",
    maxRetries: number = 3
  ): Promise<Response> {
    let lastError: any = null;
    const timeoutMs = upstreamTimeoutMs();
    let timeouts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let timedOut = false;
      const controller = new AbortController();
      // Covers the wait for the first response only; once it arrives the stream
      // is the caller's to read.
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        return await fetch(url, {
          ...options,
          signal: controller.signal,
        });
      } catch (err: any) {
        lastError = err;
        if (timedOut) timeouts++;
        if (timedOut && (onTimeout === "throw" || attempt === maxRetries)) {
          throw new UpstreamStall(url, timeoutMs, timeouts);
        }
        const isNetworkErr =
          err.name === "AbortError" ||
          err.code === "UND_ERR_CONNECT_TIMEOUT" ||
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT" ||
          err.message?.includes("fetch failed");

        if (isNetworkErr && attempt < maxRetries) {
          // A timeout has already waited the full upstream window; an error that came
          // back quickly is usually a brief blip, so give the network time to recover.
          const delay = timedOut ? attempt * 1000 : networkRetryDelayMs(attempt);
          // undici says only "fetch failed"; the code that explains it (ETIMEDOUT,
          // ECONNRESET) is on the cause.
          const cause = err.cause?.code ? `: ${err.cause.code}` : "";
          console.warn(`[Network Retry] Attempt ${attempt}/${maxRetries} to ${url} failed (${err.message}${cause}). Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError;
  }

  /**
   * Rest an account that stalled and move the pool to the next one.
   * Returns false when there is no other account to move to.
   */
  private restAndRotate(stalledEmail: string | undefined, model: string): boolean {
    StallRegistry.rest(stalledEmail);
    const next = this.oauth.selectNextAvailableAccount(stalledEmail, model, "stall");
    if (!next) return false;
    console.warn(
      `[Upstream Stall] ${stalledEmail ?? "The active account"} gave no response within ` +
        `${Math.round(upstreamTimeoutMs() / 1000)}s; resting it for ${stallRestSeconds()}s and switching to ${next.email}.`
    );
    return true;
  }

  /**
   * Execute non-streaming generateContent with multi-account auto-failover
   */
  public async generateContent(payload: AntigravityPayload): Promise<any> {
    const totalAccounts = Math.max(1, this.oauth.listAccounts().accounts.length);
    let attempts = 0;
    let stallRotations = 0;
    // Why each account failed, so the pool running out can say which it was.
    const failures = new PoolFailures();

    while (attempts < totalAccounts) {
      attempts++;

      // Proactive check: if current account is in cooldown, or resting after a
      // stall, switch proactively
      let account = this.oauth.loadSavedAccount();
      if (
        this.oauth.isAutoFailoverEnabled() &&
        account?.email &&
        (QuotaTracker.getInstance().isAccountRateLimited(account.email, payload.model) ||
          StallRegistry.isResting(account.email))
      ) {
        // A quota cooldown outlasts a stall rest, so it is the reason to report, as the
        // dashboard does.
        const why = QuotaTracker.getInstance().isAccountRateLimited(account.email, payload.model)
          ? "cooling_down"
          : "resting";
        const nextAcc = this.oauth.selectNextAvailableAccount(account.email, payload.model, why);
        if (nextAcc) {
          console.log(
            `[AutoPool] Active account ${account.email} is ${why === "resting" ? "resting after a stall" : "cooling down"}. Switched to ${nextAcc.email}`
          );
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
      let hit503 = false;
      let message503 = "";
      let stalled = false;
      let stallAttempts = 1;
      // Whether this pool has anywhere to go if Google stops answering. When it
      // does, the first timeout gives up; when it does not, retrying in place is
      // all there is.
      const poolRotates = this.oauth.isAutoFailoverEnabled() && totalAccounts > 1;

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
          }, poolRotates ? "throw" : "retry");

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
                QuotaTracker.getInstance().record429(currentAccount.email, message, payload.model);
              }
            } else if (res.status === 503) {
              // "No capacity available for model X on the server" is per project,
              // so another account is a genuine second chance. Deliberately no
              // record429(): parking a healthy account for hours over a transient
              // server condition is worse than the failure it replaces.
              hit503 = true;
              message503 = message;
            }

            lastError = new UpstreamError(res.status, `Antigravity ${endpoint} (${res.status}): ${message}`);
            if (res.status === 400) {
              // Google's message names the rule broken, not the turn that broke it.
              console.warn(`[Upstream 400] request shape: ${describeContentsShape(payload.request?.contents)}`);
              throw lastError;
            }
            continue;
          }

          const data = await res.json();
          return data;
        } catch (e: any) {
          lastError = e;
          if (e instanceof UpstreamStall) {
            stalled = true;
            stallAttempts = e.timedOutAttempts;
          }
          // Only a 400 is thrown inside the try; a 429 or 503 response is recorded
          // above and never reaches here.
          if (e.message?.includes("(400)")) {
            throw e;
          }
          continue;
        }
      }

      failures.record(currentAccount?.email, { hit429, hit503, message503, stalled, stallAttempts });

      // Google stopped answering: leave this account for another one, a bounded
      // number of times, rather than spend the request waiting inside the burst.
      if (stalled && poolRotates && stallRotations < MAX_STALL_ROTATIONS) {
        if (this.restAndRotate(currentAccount?.email, payload.model)) {
          stallRotations++;
          continue;
        }
      }

      // If rate limited or starved of capacity, auto-failover to next available account
      if ((hit429 || hit503) && this.oauth.isAutoFailoverEnabled()) {
        const why = rotationReason(hit429, message503);
        const nextAccount = this.oauth.selectNextAvailableAccount(currentAccount?.email, payload.model, why);
        if (nextAccount) {
          console.log(
            `[AutoPool] Failover from ${currentAccount?.email} to ${nextAccount.email} due to ${
              hit429 ? "429 rate limit" : why === "no_capacity" ? "503 no capacity" : "503 service unavailable"
            }.`
          );
          continue;
        }
      }

      throw failures.exhaustedError(payload.model) ?? lastError ?? new Error("All Antigravity endpoints failed.");
    }

    throw failures.exhaustedError(payload.model) ?? new Error(POOL_RATE_LIMITED);
  }

  /**
   * Execute streaming streamGenerateContent with multi-account auto-failover
   */
  public async streamGenerateContent(
    payload: AntigravityPayload
  ): Promise<AsyncIterable<any>> {
    const totalAccounts = Math.max(1, this.oauth.listAccounts().accounts.length);
    let attempts = 0;
    let stallRotations = 0;
    // Why each account failed, so the pool running out can say which it was.
    const failures = new PoolFailures();

    while (attempts < totalAccounts) {
      attempts++;

      // Proactive check: if current account is in cooldown, or resting after a
      // stall, switch proactively
      let account = this.oauth.loadSavedAccount();
      if (
        this.oauth.isAutoFailoverEnabled() &&
        account?.email &&
        (QuotaTracker.getInstance().isAccountRateLimited(account.email, payload.model) ||
          StallRegistry.isResting(account.email))
      ) {
        // A quota cooldown outlasts a stall rest, so it is the reason to report, as the
        // dashboard does.
        const why = QuotaTracker.getInstance().isAccountRateLimited(account.email, payload.model)
          ? "cooling_down"
          : "resting";
        const nextAcc = this.oauth.selectNextAvailableAccount(account.email, payload.model, why);
        if (nextAcc) {
          console.log(
            `[AutoPool] Active account ${account.email} is ${why === "resting" ? "resting after a stall" : "cooling down"}. Switched to ${nextAcc.email}`
          );
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
      let hit503 = false;
      let message503 = "";
      let stalled = false;
      let stallAttempts = 1;
      // Whether this pool has anywhere to go if Google stops answering. When it
      // does, the first timeout gives up; when it does not, retrying in place is
      // all there is.
      const poolRotates = this.oauth.isAutoFailoverEnabled() && totalAccounts > 1;

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
          }, poolRotates ? "throw" : "retry");

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
                QuotaTracker.getInstance().record429(currentAccount.email, message, payload.model);
              }
            } else if (res.status === 503) {
              // "No capacity available for model X on the server" is per project,
              // so another account is a genuine second chance. Deliberately no
              // record429(): parking a healthy account for hours over a transient
              // server condition is worse than the failure it replaces.
              hit503 = true;
              message503 = message;
            }

            lastError = new UpstreamError(res.status, `Antigravity stream ${endpoint} (${res.status}): ${message}`);
            if (res.status === 400) {
              // Google's message names the rule broken, not the turn that broke it.
              console.warn(`[Upstream 400] request shape: ${describeContentsShape(payload.request?.contents)}`);
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
          if (e instanceof UpstreamStall) {
            stalled = true;
            stallAttempts = e.timedOutAttempts;
          }
          // Only a 400 is thrown inside the try; a 429 or 503 response is recorded
          // above and never reaches here.
          if (e.message?.includes("(400)")) {
            throw e;
          }
          continue;
        }
      }

      failures.record(currentAccount?.email, { hit429, hit503, message503, stalled, stallAttempts });

      if (stalled && poolRotates && stallRotations < MAX_STALL_ROTATIONS) {
        if (this.restAndRotate(currentAccount?.email, payload.model)) {
          stallRotations++;
          continue;
        }
      }

      if ((hit429 || hit503) && this.oauth.isAutoFailoverEnabled()) {
        const why = rotationReason(hit429, message503);
        const nextAccount = this.oauth.selectNextAvailableAccount(currentAccount?.email, payload.model, why);
        if (nextAccount) {
          console.log(
            `[AutoPool] Stream failover from ${currentAccount?.email} to ${nextAccount.email} due to ${
              hit429 ? "429 rate limit" : why === "no_capacity" ? "503 no capacity" : "503 service unavailable"
            }.`
          );
          continue;
        }
      }

      throw failures.exhaustedError(payload.model) ?? lastError ?? new Error("All Antigravity streaming endpoints failed.");
    }

    throw failures.exhaustedError(payload.model) ?? new Error(POOL_RATE_LIMITED);
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
