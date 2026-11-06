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
import { RestBook } from "./rest-book";

const DEFAULT_REST_SECONDS = 300;
/** A year: longer is no rest, and a huge value overflows what a Date holds. */
const MAX_REST_SECONDS = 365 * 24 * 60 * 60;

/** Sessions one request may ask: three accounts, never the whole pool. */
export const MAX_WEB_SESSIONS_PER_REQUEST = 3;

/** How long a session that failed is skipped before it is tried again (at most a year). */
export function webRestSeconds(): number {
  const configured = Number(process.env.GEMINI_WEB_REST_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), MAX_REST_SECONDS)
    : DEFAULT_REST_SECONDS;
}

/** Gemini Web sessions resting after a failure, by account email. Not the CloudCode stall rest. */
export const WebSessionRests = new RestBook();

/**
 * Ask Gemini Web through the linked sessions, in order, until one answers. With no linked
 * session the client's own cookies (GEMINI_WEB_COOKIES) answer, as before. A single
 * session's failure is passed on unchanged; when several fail, the error counts them.
 */
export async function generateWithLinkedSessions(
  client: GeminiWebClient,
  linked: AccountToken[],
  prompt: any,
  model?: string,
): Promise<any> {
  const deadline = Date.now() + webTimeoutMs();
  if (linked.length === 0) return client.generateContent(prompt, model, deadline);

  // Resting sessions are skipped while another is available; when every one rests, they
  // are tried anyway, in order: refusing without asking would only fail the request sooner.
  const ready = linked.filter((a) => !WebSessionRests.isResting(a.email));
  const order = (ready.length > 0 ? ready : linked).slice(0, MAX_WEB_SESSIONS_PER_REQUEST);

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
      if (!(err instanceof GeminiWebAccountError)) throw err;
      const seconds = webRestSeconds();
      WebSessionRests.rest(account.email, seconds);
      const next = order[i + 1];
      if (!next || Date.now() >= deadline) {
        if (tried.length === 1) throw err;
        throw new GeminiWebAccountError(`Gemini Web failed on ${tried.length} linked sessions (${tried.join(", ")}); the last said: ${err.message}`);
      }
      console.warn(
        `[Gemini Web] ${name} failed (${err.message}); resting it ${seconds}s and trying ${next.email || `linked session ${i + 2}`}`
      );
    }
  }
  // Unreachable: the loop returns or throws on its last session.
  throw new Error("Gemini Web had no linked session to try");
}
