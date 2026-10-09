/**
 * Regression guard for how a request Google rejects reaches the client.
 *
 * When Google answers HTTP 400 — a tool schema it cannot take, an out-of-range
 * parameter — the request itself is wrong and retrying can never help. The
 * bridge did not say so:
 *
 *   - three of the four API paths answered HTTP 500 `server_error`, and
 *   - the OpenAI stream, which is what FCC uses, had already written `200`
 *     before it asked Google anything, so it delivered the failure as an
 *     in-band event inside a success. FCC labelled that a 500 and printed
 *     "usually temporary — try again", which sent a permanent mistake looking
 *     for a transient cause.
 *
 * An upstream 400 is now HTTP 400 `invalid_request_error` on every path, carrying
 * Google's own message. For the OpenAI stream that means obtaining the upstream
 * stream before committing to `200`, as the Anthropic handler already did.
 *
 * Only 400 changes. Every other failure keeps exactly the behaviour it had, and
 * a failure after streaming has begun cannot become a status code at all.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import * as clientModule from "../src/antigravity-client";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { UsageTracker } from "../src/usage-tracker";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52144;
const GOOGLE_400 =
  "Invalid value at 'request.tools[0].function_declarations[2].parameters.properties[2].value.enum[0]' (TYPE_STRING), 10143";

// Resolved at runtime so a missing export fails an assertion, not the import.
const UpstreamError: any = (clientModule as any).UpstreamError;

function upstream(status: number, text: string): Error {
  const message = `Antigravity https://example.invalid (${status}): ${text}`;
  return UpstreamError ? new UpstreamError(status, message) : Object.assign(new Error(message), { status });
}

// No real account, tracker file or usage file is touched.
(OAuthManager.prototype as any).loadSavedAccount = () => ({ email: "a@example.com", projectId: "p", refreshToken: "r" });
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => false;
(OAuthManager.prototype as any).selectNextAvailableAccount = () => null;
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {};
(UsageTracker.prototype as any).recordUsage = () => {};

// Keep the real methods: section 1 exercises them, the rest replace them.
const realGenerate = AntigravityClient.prototype.generateContent;
const realStream = AntigravityClient.prototype.streamGenerateContent;

/** What the stubbed upstream does for the next request. */
let failure: Error | null = null;
/** When set, the stream yields one chunk and THEN fails. */
let failAfterFirstChunk = false;

(AntigravityClient.prototype as any).generateContent = async () => {
  if (failure) throw failure;
  return { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
};
(AntigravityClient.prototype as any).streamGenerateContent = async () => {
  if (failure && !failAfterFirstChunk) throw failure;
  return (async function* () {
    yield { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
    if (failure) throw failure;
  })();
};

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

interface Reply {
  status: number;
  contentType: string;
  text: string;
  json: any;
}

async function post(path: string, stream: boolean): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.8-flash-tiered",
      max_tokens: 256,
      stream,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // an event stream is not JSON; callers that care look at `text`
  }
  return { status: res.status, contentType: res.headers.get("content-type") || "", text, json };
}

const OPENAI = "/v1/chat/completions";
const ANTHROPIC = "/v1/messages";

async function runTests() {
  console.log("=================================================");
  console.log(" An upstream 400 reaches the client as a 400");
  console.log("=================================================\n");

  console.log("[1/6] The Google client keeps the status as data, not only inside its message ...");
  const realFetch = globalThis.fetch;
  const googleReplies = (status: number, text: string) => {
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ error: { message: text } }), { status });
  };
  const payload: any = { model: "gemini-3.8-flash-tiered", request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } };
  const caught = async (fn: () => Promise<unknown>): Promise<any> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  try {
    const client = new AntigravityClient();
    expect("UpstreamError is exported", typeof UpstreamError, "function");

    googleReplies(400, "bad enum");
    const viaGenerate = await caught(() => realGenerate.call(client, payload));
    expect("generateContent: is an UpstreamError", Boolean(UpstreamError) && viaGenerate instanceof UpstreamError, true);
    expect("generateContent: status", viaGenerate?.status, 400);
    expect("generateContent: message format is unchanged", String(viaGenerate?.message).includes("(400): bad enum"), true);

    const viaStream = await caught(() => realStream.call(client, payload));
    expect("streamGenerateContent: is an UpstreamError", Boolean(UpstreamError) && viaStream instanceof UpstreamError, true);
    expect("streamGenerateContent: status", viaStream?.status, 400);
    expect("streamGenerateContent: message format is unchanged", String(viaStream?.message).includes("(400): bad enum"), true);

    googleReplies(503, "No capacity");
    const capacity = await caught(() => realGenerate.call(client, payload));
    expect("a 503 carries its own status, not 400", capacity?.status, 503);
  } finally {
    (globalThis as any).fetch = realFetch;
  }

  const server = new BridgeServer(TEST_PORT);
  await server.start();

  try {
    console.log("\n[2/6] A request Google rejects is a 400 on every path ...");
    failure = upstream(400, GOOGLE_400);
    const paths: Array<[string, string, boolean]> = [
      ["OpenAI non-stream", OPENAI, false],
      ["OpenAI STREAM (FCC)", OPENAI, true],
      ["Anthropic non-stream", ANTHROPIC, false],
      ["Anthropic stream", ANTHROPIC, true],
    ];
    const replies: Record<string, Reply> = {};
    for (const [label, path, stream] of paths) {
      const reply = await post(path, stream);
      replies[label] = reply;
      expect(`${label}: status`, reply.status, 400);
      expect(`${label}: error type`, reply.json?.error?.type, "invalid_request_error");
    }

    console.log("\n[3/6] ... carrying Google's own message, as plain JSON rather than a stream ...");
    for (const [label] of paths) {
      const reply = replies[label];
      expect(`${label}: names the cause`, String(reply.json?.error?.message).includes("TYPE_STRING"), true);
      expect(`${label}: is JSON, not an event stream`, reply.contentType.includes("application/json"), true);
    }
    expect("Anthropic clients get the Anthropic envelope", replies["Anthropic stream"].json?.type, "error");

    console.log("\n[4/6] Every other failure keeps the behaviour it had ...");
    failure = upstream(503, "No capacity available for model X on the server");
    expect("503, OpenAI non-stream: still 500", (await post(OPENAI, false)).status, 500);
    expect("503, Anthropic non-stream: still 500", (await post(ANTHROPIC, false)).status, 500);
    const anthropic503 = await post(ANTHROPIC, true);
    expect("503, Anthropic stream: still 500", anthropic503.status, 500);
    expect("503, Anthropic stream: still api_error", anthropic503.json?.error?.type, "api_error");

    const openai503 = await post(OPENAI, true);
    expect("503, OpenAI stream: still commits to 200", openai503.status, 200);
    expect("503, OpenAI stream: still an event stream", openai503.contentType.includes("text/event-stream"), true);
    expect("503, OpenAI stream: error is in-band", openai503.text.includes('"error"'), true);
    expect("503, OpenAI stream: still terminates", openai503.text.trim().endsWith("data: [DONE]"), true);

    failure = upstream(401, "credentials rejected");
    expect("401 is our credentials, not the caller's mistake: still 500", (await post(OPENAI, false)).status, 500);
    failure = new Error("All accounts in the pool are currently rate limited. Please wait for cooldown to reset.");
    expect("pool exhausted, OpenAI stream: still in-band", (await post(OPENAI, true)).status, 200);
    expect("pool exhausted, OpenAI non-stream: still 500", (await post(OPENAI, false)).status, 500);

    console.log("\n[5/6] A failure after streaming has begun cannot become a status, and must not crash ...");
    failure = upstream(400, GOOGLE_400);
    failAfterFirstChunk = true;
    const midOpenAI = await post(OPENAI, true);
    expect("OpenAI: already committed to 200", midOpenAI.status, 200);
    expect("OpenAI: the text that did arrive is kept", midOpenAI.text.includes("hello"), true);
    expect("OpenAI: the failure is reported in-band", midOpenAI.text.includes("TYPE_STRING"), true);
    expect("OpenAI: still terminates", midOpenAI.text.trim().endsWith("data: [DONE]"), true);
    const midAnthropic = await post(ANTHROPIC, true);
    expect("Anthropic: already committed to 200", midAnthropic.status, 200);
    expect("Anthropic: failure is an error event", midAnthropic.text.includes("event: error"), true);
    failAfterFirstChunk = false;

    console.log("\n[6/6] A healthy request is unaffected by when the 200 is written ...");
    failure = null;
    const okStream = await post(OPENAI, true);
    expect("OpenAI stream: 200", okStream.status, 200);
    expect("OpenAI stream: event stream", okStream.contentType.includes("text/event-stream"), true);
    expect("OpenAI stream: the text arrives", okStream.text.includes("hello"), true);
    expect("OpenAI stream: finishes normally", okStream.text.includes('"finish_reason":"stop"'), true);
    expect("OpenAI stream: terminates", okStream.text.trim().endsWith("data: [DONE]"), true);
    expect("OpenAI non-stream: 200", (await post(OPENAI, false)).status, 200);
    expect("Anthropic stream: 200", (await post(ANTHROPIC, true)).status, 200);
    expect("Anthropic non-stream: 200", (await post(ANTHROPIC, false)).status, 200);

    if (failures > 0) {
      throw new Error(`${failures} upstream error check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL UPSTREAM ERROR CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
