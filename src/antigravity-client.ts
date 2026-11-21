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
import { PoolExhaustedError, PoolFailures, rotationReason } from "./pool-failures";
import { RateLimitRests, rateRestSeconds } from "./rate-limit-rest";
import {
  COMPARISON_MAX_CHARS,
  COMPARISON_MAX_TOKENS,
  comparisonRequest,
  comparisonTimeoutMs,
  comparisonTokens,
  countableText,
} from "./request-refusal";
import { clearVerification, flagVerification, isVerificationChallenge, isVerificationFlagged } from "./account-verification";
import { GeminiWebClient, GEMINI_WEB_FALLBACK_USAGE_ID } from "./gemini-web-client";
import { generateWithLinkedSessions, preferredLinkedSession } from "./gemini-web-rotation";

/** A whole response as the one-chunk stream the server's SSE handlers read. */
async function* singleChunkStream(response: any): AsyncIterable<any> {
  yield { response };
}

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
   * The pool's own error, resting every tried account when the exhaustion was a
   * per-minute 429: a retry inside the rest fails fast instead of burning one
   * upstream attempt per account inside the same saturated minute.
   */
  private async exhaustedWithRest(failures: PoolFailures, payload: AntigravityPayload): Promise<Error | null> {
    const err = failures.exhaustedError(payload.model);
    if (!(err instanceof PoolExhaustedError) || err.retryAfterSeconds === undefined) return err;
    // A reset-less 429 is also how Google refuses a request for what it says. Resting the
    // pool for that fails every other client for a minute over one request nobody can send.
    //
    // The account asked is the one that answered 429 last, and it is asked at once. A real
    // limit that clears between that 429 and the comparison reads as a refusal, so the gap
    // has to stay as short as it can be: not the active account (after rotation that is the
    // first one tried, seconds earlier), no delay, no retry.
    if (await this.comparisonAnswered(payload, failures.lastRateLimitedAccount())) {
      console.warn(
        `[AutoPool] Google answered 429 to a request for ${payload.model}, then answered a neutral request of ` +
          `the same size on the same account: the request is refused, not rate limited. No account rests.`
      );
      return failures.refusedError(payload.model);
    }
    for (const email of failures.triedAccounts()) RateLimitRests.rest(email, rateRestSeconds());
    return err;
  }

  /**
   * Whether Google answers a neutral request of as many tokens as `payload`'s, for the same model,
   * on the account that just answered 429 (see request-refusal.ts). Google counts the request
   * first; with no count there is no comparison. Each is asked once, never retried: anything but
   * an answer (another 429, any other status, the network, the timeout) proves nothing and is
   * false, which leaves the per-minute handling as it was.
   *
   * The comparison is streamed and dropped as soon as it opens. Its status is the whole result,
   * and it runs under the request's own output settings, where a full answer took up to 17 s.
   */
  private async comparisonAnswered(payload: AntigravityPayload, email: string | null): Promise<boolean> {
    const account = email ? this.oauth.listAccounts().accounts.find((a) => a.email === email) : undefined;
    const countable = countableText(payload.request);
    if (!account || countable.text.length > COMPARISON_MAX_CHARS) return false;
    const inconclusive = (why: string) => {
      // Said every time: a 429 confirms the limit, anything else is why detection is off.
      console.warn(`[AutoPool] The comparison for ${payload.model} ${why}; treating the 429 as a rate limit.`);
      return false;
    };
    try {
      const accessToken = await this.oauth.getValidAccessTokenForAccount(account);
      // One budget for the count and the comparison together.
      const signal = AbortSignal.timeout(comparisonTimeoutMs());
      const ask = (method: string, body: unknown) =>
        fetch(`${ANTIGRAVITY_ENDPOINTS[0]}/v1internal:${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getAntigravityHeaders(),
          },
          body: JSON.stringify(body),
          signal,
        });
      const counted = await ask("countTokens", {
        request: { model: payload.model, contents: [{ role: "user", parts: [{ text: countable.text }] }] },
      });
      const total = counted.ok ? Number((await counted.json())?.totalTokens) : NaN;
      if (!counted.ok) await counted.arrayBuffer();
      if (!Number.isFinite(total) || total <= 0) return inconclusive(`could not be sized (count answered HTTP ${counted.status})`);
      const tokens = comparisonTokens(total, countable.inlineParts);
      if (tokens > COMPARISON_MAX_TOKENS) return inconclusive(`was not asked (the request is ${tokens} tokens)`);

      const res = await ask("streamGenerateContent?alt=sse", {
        project: payload.project || account.projectId || DEFAULT_PROJECT_ID,
        model: payload.model,
        request: comparisonRequest(tokens, payload.request),
      });
      await res.body?.cancel().catch(() => {});
      return res.ok || inconclusive(`was answered HTTP ${res.status}`);
    } catch (e: any) {
      return inconclusive(`got no answer (${e?.cause?.code ?? e?.name ?? "error"})`);
    }
  }

  /**
   * Before a request goes out, move off the active account when it is cooling down for this model's
   * family or resting after a stall. The quota file is read once: the answer that decides the move
   * is also the reason it gives. When both hold, the family's own cooldown is the more specific
   * reason (a rest covers every family).
   *
   * Returns the seconds a per-minute rest still blocks this request when every account rests and
   * none is free to move to; null otherwise. A blocked request skips upstream attempts but still
   * gets the opt-in Gemini Web fallback: a different provider, outside this per-minute limit.
   */
  private skipUnavailableActive(model: string): number | null {
    const account = this.oauth.loadSavedAccount();
    if (!account?.email) return null;
    // A per-minute rest covers the whole pool that just burned: with nowhere free
    // to move, block upstream attempts rather than spend another one per account.
    const rateRestEnd = RateLimitRests.restEndsAt(account.email);
    if (rateRestEnd !== null) {
      const nextAcc = this.oauth.isAutoFailoverEnabled()
        ? this.oauth.selectNextAvailableAccount(account.email, model, "resting")
        : null;
      if (nextAcc) {
        console.log(
          `[AutoPool] Active account ${account.email} is resting after a per-minute 429. Switched to ${nextAcc.email}`
        );
        return null;
      }
      return Math.max(1, Math.ceil((rateRestEnd - Date.now()) / 1000));
    }
    if (!this.oauth.isAutoFailoverEnabled()) return null;
    // A Google-refused active account is moved off before a request is spent on it.
    // With nowhere free to go the request still proceeds: stranding a one-account
    // pool would be worse than the honest 403 it already answers.
    if (isVerificationFlagged(account.email)) {
      const nextAcc = this.oauth.selectNextAvailableAccount(account.email, model, "refused");
      if (nextAcc) {
        console.log(
          `[AutoPool] Active account ${account.email} was refused by Google (403). Switched to ${nextAcc.email}`
        );
      }
      return null;
    }
    const why = QuotaTracker.getInstance().isAccountRateLimited(account.email, model)
      ? "cooling_down"
      : StallRegistry.isResting(account.email)
        ? "resting"
        : null;
    if (!why) return null;
    const nextAcc = this.oauth.selectNextAvailableAccount(account.email, model, why);
    if (!nextAcc) return null;
    console.log(
      `[AutoPool] Active account ${account.email} is ${why === "resting" ? "resting after a stall" : "cooling down"}. Switched to ${nextAcc.email}`
    );
    return null;
  }

  /** The fail-fast error for a request whose whole pool is resting after a per-minute 429. */
  private rateRestError(model: string, retrySeconds: number): PoolExhaustedError {
    console.warn(
      `[AutoPool] Every pooled account is resting after a per-minute 429 for ${model}; failing fast for ${retrySeconds}s.`
    );
    return new PoolExhaustedError(
      "quota",
      429,
      `All pooled accounts are resting after a per-minute 429 for model ${model}; the limit clears ` +
        `within a minute. Retry after ${retrySeconds}s, or send a smaller request.`,
      retrySeconds,
    );
  }

  /**
   * The pool ran out: answer from Gemini Web, or null to let the pool's own error through.
   *
   * A different provider and model answering is a large substitution, so it is opt-in
   * (`GEMINI_WEB_FALLBACK=1`), follows the failover switch, runs only when the pool ran
   * out (the caller checks PoolFailures.ranOut()), and never takes a request that carries
   * tools or asks for structured output: Gemini Web has no native function calling or
   * JSON mode (the schema never reaches its prompt), and an agent's tool
   * loop silently continued by another model on a prompt-based bridge is worse than an
   * honest 429/503. Asking for a Gemini Web model by name (gemini-argon-4) is the way to
   * use it with tools.
   *
   * The answer is awaited, also for a stream, so a Gemini Web failure leaves the pool's
   * error in place instead of surfacing mid-stream after the client was told 200. It is
   * marked `servedBy`, so its usage is recorded under GEMINI_WEB_FALLBACK_USAGE_ID and not
   * added to the counters of the CloudCode model that was asked for.
   */
  private async tryGeminiWebFallback(payload: AntigravityPayload): Promise<any | null> {
    if (process.env.GEMINI_WEB_FALLBACK !== "1" || !this.oauth.isAutoFailoverEnabled()) return null;
    const refusal = GeminiWebClient.fallbackRefusal(payload.request);
    if (refusal) {
      console.log(`[AutoPool] CloudCode pool exhausted for ${payload.model}; ${refusal}, so no Gemini Web fallback.`);
      return null;
    }
    const geminiWeb = GeminiWebClient.getInstance();
    const linked = this.oauth.listAccountsWithWebCookies();
    // The session the rotation will try first, so it is not set here and replaced there.
    geminiWeb.useLinkedCookies(preferredLinkedSession(linked)?.webCookies);
    if (!geminiWeb.hasCredentials()) return null;
    try {
      console.warn(`[AutoPool] CloudCode pool exhausted for ${payload.model}; Gemini Web's default model answers instead.`);
      const answer = await generateWithLinkedSessions(geminiWeb, linked, payload.request);
      return { ...answer, servedBy: GEMINI_WEB_FALLBACK_USAGE_ID };
    } catch (gwErr: any) {
      console.warn("[AutoPool] Gemini Web fallback also failed:", gwErr?.message);
      return null;
    }
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
    let rateBlocked: number | null = null;

    while (attempts < totalAccounts) {
      attempts++;

      // Proactive check: if current account is in cooldown, or resting after a
      // stall, switch proactively
      rateBlocked = this.skipUnavailableActive(payload.model);

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
      let hit403 = false;
      let message503 = "";
      let message429 = "";
      let cooldownRecorded = false;
      let stalled = false;
      let stallAttempts = 1;
      // Whether this pool has anywhere to go if Google stops answering. When it
      // does, the first timeout gives up; when it does not, retrying in place is
      // all there is.
      const poolRotates = this.oauth.isAutoFailoverEnabled() && totalAccounts > 1;

      for (const endpoint of rateBlocked === null ? ANTIGRAVITY_ENDPOINTS : []) {
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
              message429 = message;
              if (currentAccount?.email) {
                cooldownRecorded =
                  QuotaTracker.getInstance().record429(currentAccount.email, message, payload.model) || cooldownRecorded;
              }
            } else if (res.status === 503) {
              // "No capacity available for model X on the server" is per project,
              // so another account is a genuine second chance. Deliberately no
              // record429(): parking a healthy account for hours over a transient
              // server condition is worse than the failure it replaces.
              hit503 = true;
              message503 = message;
            } else if (res.status === 403) {
              // Google refused the account. Name it here, because the client-facing
              // 403 carries no email. No record429(): a refusal is not quota. Only the
              // verification challenge raises the dashboard sign, which claims exactly that.
              console.warn(`[Upstream 403] ${currentAccount?.email ?? "the active account"}: ${message}`);
              hit403 = true;
              if (isVerificationChallenge(message)) flagVerification(currentAccount?.email);
            }

            lastError = new UpstreamError(res.status, `Antigravity ${endpoint} (${res.status}): ${message}`);
            if (res.status === 400) {
              // Google's message names the rule broken, not the turn that broke it.
              console.warn(`[Upstream 400] request shape: ${describeContentsShape(payload.request?.contents)}`);
              throw lastError;
            }
            continue;
          }

          // Google took the account again, so the verification sign comes down.
          clearVerification(currentAccount?.email);
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

      failures.record(currentAccount?.email, {
        hit429,
        hit503,
        message503,
        message429,
        cooldownRecorded,
        stalled,
        stallAttempts,
        hit403,
      });

      // Google stopped answering: leave this account for another one, a bounded
      // number of times, rather than spend the request waiting inside the burst.
      if (stalled && poolRotates && stallRotations < MAX_STALL_ROTATIONS) {
        if (this.restAndRotate(currentAccount?.email, payload.model)) {
          stallRotations++;
          continue;
        }
      }

      // If rate limited, starved of capacity, or refused by Google, auto-failover to
      // the next available account. A 403 is per-account, so another card is a real
      // second chance; no cooldown is written for it.
      if ((hit429 || hit503 || hit403) && this.oauth.isAutoFailoverEnabled()) {
        const why = hit403 ? "refused" : rotationReason(hit429, message503);
        const nextAccount = this.oauth.selectNextAvailableAccount(currentAccount?.email, payload.model, why);
        if (nextAccount) {
          console.log(
            `[AutoPool] Failover from ${currentAccount?.email} to ${nextAccount.email} due to ${
              hit403 ? "403 account refused" : hit429 ? "429 rate limit" : why === "no_capacity" ? "503 no capacity" : "503 service unavailable"
            }.`
          );
          continue;
        }
      }

      // Only a pool that ran out falls back. Any other failure (401, 404, 500, the
      // network) is the caller's to see, and used to be answered by Gemini Web instead.
      const webFallback = failures.ranOut() || rateBlocked !== null ? await this.tryGeminiWebFallback(payload) : null;
      if (webFallback) return webFallback;
      if (rateBlocked !== null) throw this.rateRestError(payload.model, rateBlocked);

      throw (await this.exhaustedWithRest(failures, payload)) ?? lastError ?? new Error("All Antigravity endpoints failed.");
    }

    const webFallback = failures.ranOut() || rateBlocked !== null ? await this.tryGeminiWebFallback(payload) : null;
    if (webFallback) return webFallback;
    if (rateBlocked !== null) throw this.rateRestError(payload.model, rateBlocked);

    throw (await this.exhaustedWithRest(failures, payload)) ?? new Error(POOL_RATE_LIMITED);
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
    let rateBlocked: number | null = null;

    while (attempts < totalAccounts) {
      attempts++;

      // Proactive check: if current account is in cooldown, or resting after a
      // stall, switch proactively
      rateBlocked = this.skipUnavailableActive(payload.model);

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
      let hit403 = false;
      let message503 = "";
      let message429 = "";
      let cooldownRecorded = false;
      let stalled = false;
      let stallAttempts = 1;
      // Whether this pool has anywhere to go if Google stops answering. When it
      // does, the first timeout gives up; when it does not, retrying in place is
      // all there is.
      const poolRotates = this.oauth.isAutoFailoverEnabled() && totalAccounts > 1;

      for (const endpoint of rateBlocked === null ? ANTIGRAVITY_ENDPOINTS : []) {
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
              message429 = message;
              if (currentAccount?.email) {
                cooldownRecorded =
                  QuotaTracker.getInstance().record429(currentAccount.email, message, payload.model) || cooldownRecorded;
              }
            } else if (res.status === 503) {
              // "No capacity available for model X on the server" is per project,
              // so another account is a genuine second chance. Deliberately no
              // record429(): parking a healthy account for hours over a transient
              // server condition is worse than the failure it replaces.
              hit503 = true;
              message503 = message;
            } else if (res.status === 403) {
              // Same account-level refusal as the non-stream path; the email goes to
              // the log only, never into the 403 the client receives.
              console.warn(`[Upstream 403] ${currentAccount?.email ?? "the active account"}: ${message}`);
              hit403 = true;
              if (isVerificationChallenge(message)) flagVerification(currentAccount?.email);
            }

            lastError = new UpstreamError(res.status, `Antigravity stream ${endpoint} (${res.status}): ${message}`);
            if (res.status === 400) {
              // Google's message names the rule broken, not the turn that broke it.
              console.warn(`[Upstream 400] request shape: ${describeContentsShape(payload.request?.contents)}`);
              throw lastError;
            }
            continue;
          }

          clearVerification(currentAccount?.email);
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

      failures.record(currentAccount?.email, {
        hit429,
        hit503,
        message503,
        message429,
        cooldownRecorded,
        stalled,
        stallAttempts,
        hit403,
      });

      if (stalled && poolRotates && stallRotations < MAX_STALL_ROTATIONS) {
        if (this.restAndRotate(currentAccount?.email, payload.model)) {
          stallRotations++;
          continue;
        }
      }

      if ((hit429 || hit503 || hit403) && this.oauth.isAutoFailoverEnabled()) {
        const why = hit403 ? "refused" : rotationReason(hit429, message503);
        const nextAccount = this.oauth.selectNextAvailableAccount(currentAccount?.email, payload.model, why);
        if (nextAccount) {
          console.log(
            `[AutoPool] Stream failover from ${currentAccount?.email} to ${nextAccount.email} due to ${
              hit403 ? "403 account refused" : hit429 ? "429 rate limit" : why === "no_capacity" ? "503 no capacity" : "503 service unavailable"
            }.`
          );
          continue;
        }
      }

      const webFallback = failures.ranOut() || rateBlocked !== null ? await this.tryGeminiWebFallback(payload) : null;
      if (webFallback) return singleChunkStream(webFallback);
      if (rateBlocked !== null) throw this.rateRestError(payload.model, rateBlocked);

      throw (await this.exhaustedWithRest(failures, payload)) ?? lastError ?? new Error("All Antigravity streaming endpoints failed.");
    }

    const webFallback = failures.ranOut() || rateBlocked !== null ? await this.tryGeminiWebFallback(payload) : null;
    if (webFallback) return singleChunkStream(webFallback);
    if (rateBlocked !== null) throw this.rateRestError(payload.model, rateBlocked);

    throw (await this.exhaustedWithRest(failures, payload)) ?? new Error(POOL_RATE_LIMITED);
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
