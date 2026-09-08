/**
 * Regression guard for streaming turn terminators.
 *
 * Both SSE handlers in src/server.ts are written by hand and, unlike the
 * non-streaming path in Transformer, used to hardcode their terminator:
 * Anthropic always sent `stop_reason: "end_turn"` and OpenAI always sent
 * `finish_reason: "stop"`, even after emitting a tool call. Agent loops branch
 * on those values, so tool calling silently dead-ended in streaming mode —
 * the default for Claude Code, Hermes and Cursor.
 *
 * Unlike bridge.test.ts, this suite stubs AntigravityClient, so it needs no
 * logged-in account and consumes no quota. Safe to run in CI.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { BridgeServer } from "../src/server";

const TEST_PORT = 52139;

type Part = Record<string, any>;

const TEXT_ONLY: Part[] = [{ text: "hello" }];
const WITH_TOOL: Part[] = [
  { text: "let me check" },
  { functionCall: { name: "get_weather", args: { location: "Tokyo" } } },
];

/** Parts the stubbed upstream yields for the next request. */
let nextParts: Part[] = [];

(AntigravityClient.prototype as any).streamGenerateContent = async () =>
  (async function* () {
    yield { candidates: [{ content: { parts: nextParts } }] };
  })();

async function collectSSE(path: string, model: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  return await res.text();
}

function eachEvent(sse: string): any[] {
  const events: any[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      // Ignore non-JSON frames
    }
  }
  return events;
}

/** stop_reason carried by the Anthropic message_delta event. */
function anthropicStopReason(sse: string): string {
  const ev = eachEvent(sse).find((e) => e.type === "message_delta");
  return String(ev?.delta?.stop_reason ?? "<none>");
}

/** finish_reason on the last OpenAI chunk that carries one. */
function openaiFinishReason(sse: string): string {
  let last = "<none>";
  for (const ev of eachEvent(sse)) {
    const reason = ev.choices?.[0]?.finish_reason;
    if (reason) last = String(reason);
  }
  return last;
}

let failures = 0;

function expect(label: string, actual: string, wanted: string) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${actual}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${wanted}, got ${actual}`);
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" Streaming stop_reason / finish_reason regression");
  console.log("=================================================\n");

  const server = new BridgeServer(TEST_PORT);
  await server.start();
  console.log(`✓ Server started on port ${TEST_PORT} (upstream stubbed)\n`);

  try {
    console.log("[1/4] Anthropic SSE, turn ending in a tool call ...");
    nextParts = WITH_TOOL;
    expect("stop_reason", anthropicStopReason(await collectSSE("/v1/messages", "gemini-3-flash")), "tool_use");

    console.log("\n[2/4] Anthropic SSE, text-only turn ...");
    nextParts = TEXT_ONLY;
    expect("stop_reason", anthropicStopReason(await collectSSE("/v1/messages", "gemini-3-flash")), "end_turn");

    console.log("\n[3/4] OpenAI SSE, turn ending in a tool call ...");
    nextParts = WITH_TOOL;
    expect("finish_reason", openaiFinishReason(await collectSSE("/v1/chat/completions", "gemini-3-flash")), "tool_calls");

    console.log("\n[4/4] OpenAI SSE, text-only turn ...");
    nextParts = TEXT_ONLY;
    expect("finish_reason", openaiFinishReason(await collectSSE("/v1/chat/completions", "gemini-3-flash")), "stop");

    if (failures > 0) {
      throw new Error(`${failures} streaming terminator check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL 4 STREAMING CHECKS PASSED!");
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
