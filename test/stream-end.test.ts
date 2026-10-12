/**
 * Regression guard for what the bridge records when a stream ends badly.
 *
 * Google can end a response without anything the client can use — a function
 * call it judged malformed, a token limit, a safety filter, a dropped
 * connection — and the streaming handlers closed all of them the same way: a
 * normal `end_turn`/`stop`. OpenDesign then reported "Agent completed without
 * producing any output" and nothing on the bridge said why, because the
 * handlers never read `finishReason` at all.
 *
 * Now a stream that ends empty, or with anything but a clean STOP, or with no
 * finish reason at all, leaves one `[Stream End]` warning naming the reason, the
 * model's own explanation (`finishMessage`), a block reason, and how many text /
 * thinking / tool parts were actually delivered. A normal stream stays silent.
 *
 * Diagnostic only: what the client receives is exactly what it received before.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { UsageTracker } from "../src/usage-tracker";
import { BridgeServer } from "../src/server";
import { StreamEndTally } from "../src/stream-diagnostics";

const TEST_PORT = 52146;

// No real account, tracker file or usage file is touched.
(OAuthManager.prototype as any).loadSavedAccount = () => ({ email: "a@example.com", projectId: "p", refreshToken: "r" });
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => false;
(OAuthManager.prototype as any).selectNextAvailableAccount = () => null;
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {};
(UsageTracker.prototype as any).recordUsage = () => {};

/** What the stubbed upstream streams for the next request. */
let chunks: any[] = [];
(AntigravityClient.prototype as any).streamGenerateContent = async () =>
  (async function* () {
    for (const c of chunks) yield c;
  })();

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

const part = {
  text: (t: string) => ({ text: t }),
  thought: (t: string) => ({ text: t, thought: true }),
  call: (name: string) => ({ functionCall: { name, args: { a: 1 } } }),
};

function chunk(parts: any[], extra: any = {}, top: any = {}) {
  return { response: { candidates: [{ content: { parts }, ...extra }], ...top } };
}

const USAGE = { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 20 } };

/** Run one request and return the `[Stream End]` warnings it produced. */
async function run(route: "/v1/messages" | "/v1/chat/completions", upstream: any[]) {
  chunks = upstream;
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: any[]) => {
    warnings.push(a.map(String).join(" "));
  };
  let status = 0;
  let text = "";
  try {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash-tiered",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    });
    status = res.status;
    text = await res.text();
  } finally {
    console.warn = realWarn;
  }
  return { status, text, ended: warnings.filter((w) => w.includes("[Stream End]")) };
}

async function runTests() {
  console.log("=================================================");
  console.log(" A stream that ends badly says why");
  console.log("=================================================\n");

  console.log("[1/6] The tally classifies a stream without a server ...");
  const t = new StreamEndTally();
  t.observe(chunk([part.thought("hm")]));
  t.observe(chunk([part.text("hi"), part.call("write")], { finishReason: "STOP" }, USAGE));
  expect("counts text parts", t.text, 1);
  expect("counts thinking parts", t.thinking, 1);
  expect("counts tool calls", t.tools, 1);
  expect("remembers the finish reason", t.finishReason, "STOP");
  expect("a clean stop with content is not abnormal", t.describe("/v1/messages", "m"), null);
  const flat = new StreamEndTally();
  flat.observe({ candidates: [{ content: { parts: [part.text("x")] }, finishReason: "STOP" }] });
  expect("reads the unwrapped chunk shape too", flat.text, 1);

  console.log("\n[2/6] A healthy stream leaves nothing behind, on both routes ...");
  for (const route of ["/v1/messages", "/v1/chat/completions"] as const) {
    const ok = await run(route, [chunk([part.text("hello")], { finishReason: "STOP" }, USAGE)]);
    expect(`${route}: 200`, ok.status, 200);
    expect(`${route}: silent`, ok.ended.length, 0);
    const tool = await run(route, [chunk([part.call("write")], { finishReason: "STOP" }, USAGE)]);
    expect(`${route}: a tool call with STOP is silent`, tool.ended.length, 0);
  }

  console.log("\n[3/6] An empty answer is recorded with the reason Google gave ...");
  for (const route of ["/v1/messages", "/v1/chat/completions"] as const) {
    const bad = await run(route, [
      chunk([], { finishReason: "MALFORMED_FUNCTION_CALL", finishMessage: "Malformed function call: write(" }, USAGE),
    ]);
    const line = bad.ended[0] || "";
    expect(`${route}: one warning`, bad.ended.length, 1);
    expect(`${route}: names the route`, line.includes(route), true);
    expect(`${route}: names the finish reason`, line.includes("finishReason=MALFORMED_FUNCTION_CALL"), true);
    expect(`${route}: carries Google's own explanation`, line.includes("Malformed function call: write("), true);
    expect(`${route}: says nothing usable was delivered`, line.includes("text=0") && line.includes("tools=0"), true);
    expect(`${route}: carries the token figures`, line.includes("prompt=100") && line.includes("thoughts=20"), true);
  }

  console.log("\n[4/6] Thinking with no answer is the same failure, even on a clean STOP ...");
  const thinkOnly = await run("/v1/messages", [chunk([part.thought("planning...")], { finishReason: "STOP" }, USAGE)]);
  const thinkLine = thinkOnly.ended[0] || "";
  expect("recorded", thinkOnly.ended.length, 1);
  expect("finish reason is STOP", thinkLine.includes("finishReason=STOP"), true);
  expect("thinking was delivered, text was not", thinkLine.includes("thinking=1") && thinkLine.includes("text=0"), true);

  console.log("\n[5/6] A cut stream and a cut-off answer are recorded too ...");
  const noReason = await run("/v1/messages", [chunk([part.text("half an ans")])]);
  expect("no finish reason: recorded", noReason.ended.length, 1);
  expect("no finish reason: says none", (noReason.ended[0] || "").includes("finishReason=none"), true);
  const capped = await run("/v1/chat/completions", [chunk([part.text("long")], { finishReason: "MAX_TOKENS" }, USAGE)]);
  expect("MAX_TOKENS: recorded", capped.ended.length, 1);
  expect("MAX_TOKENS: named", (capped.ended[0] || "").includes("finishReason=MAX_TOKENS"), true);
  const blocked = await run("/v1/messages", [
    { response: { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } },
  ]);
  expect("a blocked prompt: recorded", blocked.ended.length, 1);
  expect("a blocked prompt: names the block reason", (blocked.ended[0] || "").includes("blockReason=SAFETY"), true);

  console.log("\n[6/6] What the client receives is unchanged ...");
  expect("Anthropic empty answer: still 200", (await run("/v1/messages", [chunk([], { finishReason: "OTHER" })])).status, 200);
  const anthropic = await run("/v1/messages", [chunk([], { finishReason: "OTHER" }, USAGE)]);
  expect("Anthropic empty answer: still ends the turn", anthropic.text.includes('"stop_reason":"end_turn"'), true);
  expect("Anthropic empty answer: still terminates", anthropic.text.includes("message_stop"), true);
  const openai = await run("/v1/chat/completions", [chunk([], { finishReason: "OTHER" }, USAGE)]);
  expect("OpenAI empty answer: still finishes with stop", openai.text.includes('"finish_reason":"stop"'), true);
  expect("OpenAI empty answer: still terminates", openai.text.trim().endsWith("data: [DONE]"), true);
  expect("the answer text is never written to the log", (await run("/v1/messages", [chunk([part.text("SECRET-ANSWER")], { finishReason: "MAX_TOKENS" })])).ended.join("").includes("SECRET-ANSWER"), false);

  if (failures > 0) {
    throw new Error(`${failures} stream-end check(s) failed`);
  }
}

async function main() {
  const server = new BridgeServer(TEST_PORT);
  await server.start();
  try {
    await runTests();
    console.log("\n=================================================");
    console.log(" 🎉 ALL STREAM-END CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    await server.stop();
    console.log("✓ Test server closed.");
  }
}

main().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
