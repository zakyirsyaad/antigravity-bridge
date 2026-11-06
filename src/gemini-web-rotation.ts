/**
 * Moving a Gemini Web request to another linked session when one fails.
 *
 * Every account with cookies linked in the dashboard is a session the request may use, the
 * active account's first. When a session fails in a way that is about the account
 * (GeminiWebAccountError: signed out, no token, a non-2xx or unreadable answer — which is
 * also how an exhausted Gemini app quota is most likely to look), the next one is tried and
 * the failed one is rested here, in memory, for GEMINI_WEB_REST_SECONDS. A transport
 * failure or the bridge's own timeout is not rotated: another account would meet the same
 * network. At most MAX_WEB_SESSIONS_PER_REQUEST sessions are asked, inside one
 * GEMINI_WEB_TIMEOUT_MS deadline, so a request never takes longer than it did before.
 *
 * Nothing here can recognize a limit Google words as an ordinary text answer: that reaches
 * the client as the model's reply, as before.
 */

import type { AccountToken } from "./oauth";
import { GeminiWebClient, GeminiWebAccountError, webTimeoutMs } from "./gemini-web-client";
import { RestBook, restSecondsFromEnv } from "./rest-book";

const DEFAULT_REST_SECONDS = 300;

/** Sessions one request may ask: three accounts, never the whole pool. */
export const MAX_WEB_SESSIONS_PER_REQUEST = 3;

/** How long a session that failed is skipped before it is tried again (at most a year). */
export function webRestSeconds(): number {
  return restSecondsFromEnv("GEMINI_WEB_REST_SECONDS", DEFAULT_REST_SECONDS);
}

/** Gemini Web sessions resting after a failure, by account email. Not the CloudCode stall rest. */
export const WebSessionRests = new RestBook();

/**
 * The sessions one request asks, in order. Resting ones are skipped while another is ready.
 * When every one rests, only the one whose rest ends first is asked: refusing without asking
 * would fail the request sooner, but asking all of them would multiply every request's work
 * through an outage that has already failed each of them once.
 */
function sessionsToTry(linked: AccountToken[]): AccountToken[] {
  const ready = linked.filter((a) => !WebSessionRests.isResting(a.email));
  if (ready.length > 0) return ready.slice(0, MAX_WEB_SESSIONS_PER_REQUEST);
  const soonest = [...linked].sort(
    (a, b) => (WebSessionRests.restEndsAt(a.email) ?? 0) - (WebSessionRests.restEndsAt(b.email) ?? 0)
  )[0];
  return soonest ? [soonest] : [];
}

/**
 * The linked session a request will try first. Set it as the client's cookies before checking
 * hasCredentials(): setting another one there and then rotating would drop the cached session
 * on every request while the first account rests (setCredentials() clears it on any change).
 */
export function preferredLinkedSession(linked: AccountToken[]): AccountToken | undefined {
  return sessionsToTry(linked)[0];
}

/**
 * Ask Gemini Web through the linked sessions, in order, until one answers. With no linked
 * session the client's own cookies (GEMINI_WEB_COOKIES) answer, as before. A single
 * session's failure is passed on unchanged; when several fail, the error counts them. The
 * accounts are named in the log only, never in the error, which reaches the client.
 */
export async function generateWithLinkedSessions(
  client: GeminiWebClient,
  linked: AccountToken[],
  prompt: any,
  model?: string,
): Promise<any> {
  const deadline = Date.now() + webTimeoutMs();
  if (linked.length === 0) return client.generateContent(prompt, model, deadline);

  const order = sessionsToTry(linked);
  const tried: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const account = order[i];
    const name = account.email || `linked session ${i + 1}`;
    tried.push(name);
    client.useLinkedCookies(account.webCookies);
    try {
      const answer = await client.generateContent(prompt, model, deadline);
      WebSessionRests.end(account.email);
      return answer;
    } catch (err: any) {
      if (!(err instanceof GeminiWebAccountError)) {
        // The network or the deadline, after earlier sessions failed: say so, or the client
        // reads a timeout and never learns that the accounts before it were set aside.
        if (tried.length === 1) throw err;
        console.warn(`[Gemini Web] ${name} failed after ${tried.slice(0, -1).join(", ")} did: ${err?.message}`);
        throw new Error(`${err?.message || "Gemini Web request failed"} (after ${tried.length - 1} linked session(s) failed first)`);
      }
      const seconds = webRestSeconds();
      WebSessionRests.rest(account.email, seconds);
      const next = order[i + 1];
      if (!next || Date.now() >= deadline) {
        if (tried.length === 1) throw err;
        console.warn(`[Gemini Web] every linked session tried failed (${tried.join(", ")}); resting each ${seconds}s`);
        throw new GeminiWebAccountError(`Gemini Web failed on ${tried.length} linked sessions; the last said: ${err.message}`);
      }
      console.warn(
        `[Gemini Web] ${name} failed (${err.message}); resting it ${seconds}s and trying ${next.email || `linked session ${i + 2}`}`
      );
    }
  }
  // Unreachable: the loop returns or throws on its last session.
  throw new Error("Gemini Web had no linked session to try");
}
