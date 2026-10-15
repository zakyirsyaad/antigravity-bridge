/**
 * How long the bridge gives a connection to Google before calling it failed.
 *
 * Google's hosts resolve to an IPv6 and an IPv4 address, and Node tries them in turn
 * ("happy eyeballs"), allowing every address but the last 250 ms. On a host with no
 * IPv6 route that turns a small hiccup into a failure: when DNS lists IPv4 first, the
 * only address that can work is abandoned after 250 ms, IPv6 fails at once, and the
 * request ends as `fetch failed` (AggregateError ETIMEDOUT). That is what reached FCC
 * as a 500 from the VPS, where IPv6 never connects and IPv4 normally takes 3 ms.
 */
import net from "node:net";

const DEFAULT_CONNECT_ATTEMPT_MS = 2_000;

/**
 * Waits before the second and third attempt after an error that arrived quickly
 * (a refused, reset or abandoned connection). The old 1 s and 2 s were spent inside
 * the same few-second blip that caused the error.
 */
const NETWORK_RETRY_DELAYS_MS = [2_000, 5_000];

/**
 * The range Node accepts: it raises anything below 10 to 10, and throws past int32. A value
 * it throws on would stop `start()`, and with it the bridge, from booting.
 */
const MIN_CONNECT_ATTEMPT_MS = 10;
const MAX_CONNECT_ATTEMPT_MS = 2_147_483_647;

/** How long one address may take to connect before Node moves on to the next. */
export function connectAttemptTimeoutMs(): number {
  const configured = Math.floor(Number(process.env.BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS));
  return configured >= MIN_CONNECT_ATTEMPT_MS && configured <= MAX_CONNECT_ATTEMPT_MS
    ? configured
    : DEFAULT_CONNECT_ATTEMPT_MS;
}

/** Make every connection this process opens, `fetch` included, use that timeout. */
export function applyConnectAttemptTimeout(): number {
  const ms = connectAttemptTimeoutMs();
  net.setDefaultAutoSelectFamilyAttemptTimeout(ms);
  return ms;
}

/** How long to wait after failed attempt `attempt` (1-based) before the next one. */
export function networkRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), NETWORK_RETRY_DELAYS_MS.length) - 1;
  return NETWORK_RETRY_DELAYS_MS[index];
}
