/**
 * Offline test suite for Gemini Web Tool Prompt Bridge.
 *
 * Verifies:
 * 1. formatToolsForPrompt formats OpenAI function and Anthropic tool declarations cleanly.
 * 2. buildToolBridgePrompt injects JSON output schema and constraints.
 * 3. parseToolBridgeOutput correctly parses tool_calls JSON array.
 * 4. parseToolBridgeOutput correctly parses single function object format.
 * 5. parseToolBridgeOutput extracts JSON tool calls embedded inside surrounding prose.
 * 6. parseToolBridgeOutput handles standard content response (no tool called).
 * 7. tool_choice in both protocols' shapes; calls held to the declared tools, tool_choice and object arguments.
 * 8. Through the server on gemini-argon-4: both protocols, both stream modes, usage, failures, the pool fallback.
 */

import http from "node:http";
import { formatToolsForPrompt, buildToolBridgePrompt, parseToolBridgeOutput, normalizeToolChoice } from "../src/tool-bridge";
import { BridgeServer } from "../src/server";
import { OAuthManager } from "../src/oauth";
import { GeminiWebClient } from "../src/gemini-web-client";
import { UsageTracker } from "../src/usage-tracker";

const TEST_PORT = 52150;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

async function postJson(pathUrl: string, body: any): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${BASE_URL}${pathUrl}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data: any = {};
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode || 0, data, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log("=================================================");
  console.log(" Tool Prompt Bridge Offline Test Suite");
  console.log("=================================================\n");

  console.log("[1/7] Formatting tools for prompt ...");
  const mockTools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    },
  ];
  const formatted = formatToolsForPrompt(mockTools);
  expect("contains function name", formatted.includes("name: get_weather"), true);
  expect("contains description", formatted.includes("description: Get current weather"), true);
  expect("contains parameters schema", formatted.includes('"required":["location"]'), true);

  console.log("\n[2/7] Building tool bridge prompt with constraints ...");
  const prompt = buildToolBridgePrompt("What is the weather in Paris?", mockTools, "required");
  expect("instructs JSON only", prompt.includes("You MUST respond with valid JSON only"), true);
  expect("enforces tool call on required", prompt.includes("at least one tool call in the tool_calls array"), true);
  expect("includes tool list", prompt.includes("name: get_weather"), true);

  console.log("\n[3/7] Parsing tool_calls array from model output ...");
  const modelOutputJson = JSON.stringify({
    tool_calls: [
      {
        name: "get_weather",
        arguments: { location: "Paris, France", unit: "celsius" },
      },
    ],
  });
  const parsed1 = parseToolBridgeOutput(modelOutputJson, mockTools);
  expect("finish_reason is tool_calls", parsed1.finish_reason, "tool_calls");
  expect("tool name matches", parsed1.tool_calls[0]?.function?.name, "get_weather");
  const args1 = JSON.parse(parsed1.tool_calls[0]?.function?.arguments || "{}");
  expect("argument parsed correctly", args1.location, "Paris, France");

  console.log("\n[4/7] Parsing single function call format ...");
  const singleFuncOutput = JSON.stringify({
    name: "get_weather",
    arguments: { location: "Tokyo" },
  });
  const parsed2 = parseToolBridgeOutput(singleFuncOutput, mockTools);
  expect("finish_reason is tool_calls on single function", parsed2.finish_reason, "tool_calls");
  expect("function name matches", parsed2.tool_calls[0]?.function?.name, "get_weather");

  console.log("\n[5/7] Parsing embedded tool call in prose ...");
  const proseOutput = 'I will look up the weather for you:\n```json\n{"tool_calls": [{"name": "get_weather", "arguments": {"location": "London"}}]}\n```\nPlease wait.';
  const parsed3 = parseToolBridgeOutput(proseOutput, mockTools);
  expect("extracts tool call from prose", parsed3.finish_reason, "tool_calls");
  expect("extracted function name matches", parsed3.tool_calls[0]?.function?.name, "get_weather");

  console.log("\n[6/7] Both protocols' tool_choice shapes, and the rules held on the output ...");
  expect("Anthropic {type:any} is required", normalizeToolChoice({ type: "any" }).mode, "required");
  expect("Anthropic {type:tool} names the tool", normalizeToolChoice({ type: "tool", name: "get_weather" }).name, "get_weather");
  expect("Anthropic {type:none} is none", normalizeToolChoice({ type: "none" }).mode, "none");
  expect("OpenAI {function:{name}} names the tool", normalizeToolChoice({ type: "function", function: { name: "x" } }).name, "x");
  expect("OpenAI 'required' is required", normalizeToolChoice("required").mode, "required");
  expect("Anthropic forced tool reaches the prompt", buildToolBridgePrompt("hi", mockTools, { type: "tool", name: "get_weather" }).includes('name: "get_weather"'), true);
  const callTo = (name: string, args: unknown = { location: "Berlin" }) => JSON.stringify({ tool_calls: [{ name, arguments: args }] });
  const undeclared = parseToolBridgeOutput(callTo("delete_everything"), mockTools);
  expect("a call to an undeclared tool is not emitted", undeclared.tool_calls.length, 0);
  expect("and says why", undeclared.dropped[0], "delete_everything: not a declared tool");
  expect("tool_choice none emits no call", parseToolBridgeOutput(callTo("get_weather"), mockTools, "none").tool_calls.length, 0);
  expect("Anthropic {type:none} emits no call", parseToolBridgeOutput(callTo("get_weather"), mockTools, { type: "none" }).tool_calls.length, 0);
  const twoTools = [...mockTools, { name: "get_time", input_schema: { type: "object" } }];
  const forcedOut = parseToolBridgeOutput(
    JSON.stringify({ tool_calls: [{ name: "get_time", arguments: {} }, { name: "get_weather", arguments: { location: "Oslo" } }] }),
    twoTools,
    { type: "tool", name: "get_weather" }
  );
  expect("a forced tool keeps only that tool's calls", forcedOut.tool_calls.map((c) => c.function.name).join(","), "get_weather");
  expect("positional (array) arguments are not emitted", parseToolBridgeOutput(callTo("get_weather", ["a.txt"]), mockTools).tool_calls.length, 0);
  expect("a bare string argument is not emitted as {}", parseToolBridgeOutput(callTo("get_weather", "/etc/hosts"), mockTools).tool_calls.length, 0);
  const trailing = parseToolBridgeOutput('{"tool_calls":[{"name":"get_weather","arguments":"{\\"location\\": \\"Berlin\\",}"}]}', mockTools);
  expect("string arguments are repaired to valid JSON", trailing.tool_calls[0]?.function?.arguments, '{"location":"Berlin"}');
  const prose = "function f() { return { a: 1 }; }\n".repeat(4000);
  const started = Date.now();
  parseToolBridgeOutput(prose, mockTools);
  expect("a long brace-heavy reply parses in linear time", Date.now() - started < 1000, true);

  console.log("\n[7/7] End-to-end server route with Gemini Web tool bridge ...");
  const oauth = OAuthManager.getInstance();
  (oauth as any).listAccounts = () => ({
    accounts: [
      {
        email: "hybrid.test@example.com",
        projectId: "test",
        refreshToken: "mock",
        accessToken: "mock",
        expiresAt: Date.now() + 100000,
        webCookies: "__Secure-1PSID=mock-cookie",
      },
    ],
    activeIndex: 0,
  });
  (oauth as any).loadSavedAccount = () => (oauth as any).listAccounts().accounts[0];
  (oauth as any).getValidAccessToken = async () => "mock-token";

  const geminiWeb = GeminiWebClient.getInstance();
  // Stub GeminiWebClient to return tool calling JSON string
  let lastWebArgs: any[] = [];
  (geminiWeb as any).generateContent = async (...args: any[]) => (lastWebArgs = args, {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                tool_calls: [{ name: "get_weather", arguments: { location: "Berlin" } }],
              }),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 20, totalTokenCount: 1254 },
  });
  const recorded: any[][] = [];
  (UsageTracker.getInstance() as any).recordUsage = (...args: any[]) => recorded.push(args);

  const server = new BridgeServer(TEST_PORT);
  await server.start();

  try {
    const res = await postJson("/v1/chat/completions", {
      model: "gemini-argon-4",
      messages: [{ role: "user", content: "Check weather in Berlin" }],
      tools: mockTools,
    });

    expect("server responds with 200", res.status, 200);
    expect("finish_reason is tool_calls", res.data.choices?.[0]?.finish_reason, "tool_calls");
    const toolCall = res.data.choices?.[0]?.message?.tool_calls?.[0];
    expect("tool call name is get_weather", toolCall?.function?.name, "get_weather");
    const parsedArgs = JSON.parse(toolCall?.function?.arguments || "{}");
    expect("arguments location is Berlin", parsedArgs.location, "Berlin");

    // Claude Code always streams and always sends tools: the stream must bridge them too.
    const anth = await postJson("/v1/messages", {
      model: "gemini-argon-4",
      max_tokens: 1024,
      stream: true,
      system: "You are a weather bot.",
      messages: [{ role: "user", content: "Check weather in Berlin" }],
      tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { location: { type: "string" } } } }],
    });
    expect("Anthropic stream responds 200", anth.status, 200);
    expect("Anthropic stream emits a tool_use block", anth.raw.includes('"type":"tool_use"'), true);
    expect("Anthropic stream carries the arguments", anth.raw.includes('Berlin'), true);
    expect("Anthropic stream stops as tool_use", anth.raw.includes('"stop_reason":"tool_use"'), true);
    expect("Anthropic stream targets the requested model", lastWebArgs[1], "gemini-argon-4");
    expect("system prompt reaches Gemini Web", String(lastWebArgs[0]).includes("You are a weather bot."), true);
    // Claude Code sizes its context meter (and decides to compact) from this figure.
    expect("Anthropic stream reports the estimated prompt size", anth.raw.includes('"usage":{"input_tokens":1234,"output_tokens":20}'), true);
    expect("OpenAI non-stream reports the estimated usage", res.data.usage?.prompt_tokens, 1234);
    expect("both web requests are recorded", recorded.length, 2);
    expect("recorded under the web model id", recorded[1]?.[0], "gemini-argon-4");
    expect("recorded with the estimated prompt size", recorded[1]?.[1], 1234);

    const oaiStream = await postJson("/v1/chat/completions", {
      model: "gemini-argon-4",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Check weather in Berlin" }],
      tools: mockTools,
    });
    expect("OpenAI stream responds 200", oaiStream.status, 200);
    expect("OpenAI stream carries the tool call", oaiStream.raw.includes('"name":"get_weather"'), true);
    expect("OpenAI stream finishes as tool_calls", oaiStream.raw.includes('"finish_reason":"tool_calls"'), true);
    expect("OpenAI stream sends the usage chunk when asked", oaiStream.raw.includes('"prompt_tokens":1234'), true);
    expect("OpenAI stream targets the requested model", lastWebArgs[1], "gemini-argon-4");

    // A Gemini Web failure is a real status before any stream byte, on both protocols.
    (geminiWeb as any).generateContent = async () => {
      throw new Error("Gemini Web generation failed with HTTP 401: expired");
    };
    const anthFail = await postJson("/v1/messages", {
      model: "gemini-argon-4", max_tokens: 64, stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect("Anthropic stream failure is HTTP 500", anthFail.status, 500);
    expect("Anthropic stream failure is a JSON error, not SSE", anthFail.data?.error?.type, "api_error");
    const oaiFail = await postJson("/v1/chat/completions", {
      model: "gemini-argon-4", stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect("OpenAI stream failure is HTTP 500, not an event inside a 200", oaiFail.status, 500);
    expect("OpenAI stream failure is a JSON error, not SSE", oaiFail.raw.startsWith("data:"), false);

    // Whatever Gemini Web writes, the request's rules and Anthropic's input shape hold.
    const answerWith = (text: string) => async (...args: any[]) => (lastWebArgs = args, {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });
    (geminiWeb as any).generateContent = answerWith('{"tool_calls":[{"name":"get_weather","arguments":"{\\"location\\": \\"Berlin\\",}"}]}');
    const repaired = await postJson("/v1/chat/completions", {
      model: "gemini-argon-4",
      messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: "weather?" }],
      tools: mockTools,
    });
    expect("OpenAI tool arguments are repaired JSON", repaired.data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments, '{"location":"Berlin"}');
    expect("OpenAI non-stream targets the requested model", lastWebArgs[1], "gemini-argon-4");
    expect("OpenAI system message reaches Gemini Web", String(lastWebArgs[0]).includes("Answer briefly."), true);
    const anthJson = await postJson("/v1/messages", {
      model: "gemini-argon-4",
      max_tokens: 256,
      system: "Answer briefly.",
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: { location: { type: "string" } } } }],
    });
    expect("Anthropic non-stream emits tool_use", anthJson.data.content?.[0]?.type, "tool_use");
    expect("with an object input", anthJson.data.content?.[0]?.input?.location, "Berlin");
    expect("and stop_reason tool_use", anthJson.data.stop_reason, "tool_use");

    (geminiWeb as any).generateContent = answerWith('{"content": ""}');
    const emptied = await postJson("/v1/messages", {
      model: "gemini-argon-4", max_tokens: 64, stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    });
    expect("an answer the bridge empties is a 500, not an empty success", emptied.status, 500);
    (geminiWeb as any).generateContent = answerWith('{"tool_calls":[{"name":"get_weather","arguments":{"location":"Rome"}}]}');
    const forbidden = await postJson("/v1/chat/completions", {
      model: "gemini-argon-4",
      messages: [{ role: "user", content: "hi" }],
      tools: mockTools,
      tool_choice: "none",
    });
    expect("a call under tool_choice none is refused, not emitted", forbidden.status, 500);
    expect("and the error says why", String(forbidden.data?.error?.message).includes("tool_choice is none"), true);

    // The pool's fallback answer is recorded under its own id, not the CloudCode model's.
    const fallbackAnswer = {
      candidates: [{ content: { parts: [{ text: "from Gemini Web" }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      servedBy: "gemini-web-fallback",
    };
    const client = (server as any).client;
    const realGenerate = client.generateContent;
    const realStream = client.streamGenerateContent;
    client.generateContent = async () => fallbackAnswer;
    client.streamGenerateContent = async () => (async function* () { yield { response: fallbackAnswer }; })();
    recorded.length = 0;
    await postJson("/v1/messages", { model: "gemini-3.8-flash-tiered", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
    await postJson("/v1/messages", { model: "gemini-3.8-flash-tiered", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] });
    await postJson("/v1/chat/completions", { model: "gemini-3.8-flash-tiered", messages: [{ role: "user", content: "hi" }] });
    await postJson("/v1/chat/completions", { model: "gemini-3.8-flash-tiered", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect("all four CloudCode paths record a fallback answer under gemini-web-fallback", recorded.map((r) => r[0]).join(","), Array(4).fill("gemini-web-fallback").join(","));
    client.generateContent = realGenerate;
    client.streamGenerateContent = realStream;
  } finally {
    await server.stop();
  }

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All Tool Prompt Bridge assertions passed!");
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
