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
 * 7. Live bridge route /v1/chat/completions with tools translates to tool_calls finish_reason.
 */

import http from "node:http";
import { formatToolsForPrompt, buildToolBridgePrompt, parseToolBridgeOutput, normalizeToolChoice } from "../src/tool-bridge";
import { BridgeServer } from "../src/server";
import { OAuthManager } from "../src/oauth";
import { GeminiWebClient } from "../src/gemini-web-client";

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

  console.log("[1/6] Formatting tools for prompt ...");
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

  console.log("\n[2/6] Building tool bridge prompt with constraints ...");
  const prompt = buildToolBridgePrompt("What is the weather in Paris?", mockTools, "required");
  expect("instructs JSON only", prompt.includes("You MUST respond with valid JSON only"), true);
  expect("enforces tool call on required", prompt.includes("at least one tool call in the tool_calls array"), true);
  expect("includes tool list", prompt.includes("name: get_weather"), true);

  console.log("\n[3/6] Parsing tool_calls array from model output ...");
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

  console.log("\n[4/6] Parsing single function call format ...");
  const singleFuncOutput = JSON.stringify({
    name: "get_weather",
    arguments: { location: "Tokyo" },
  });
  const parsed2 = parseToolBridgeOutput(singleFuncOutput, mockTools);
  expect("finish_reason is tool_calls on single function", parsed2.finish_reason, "tool_calls");
  expect("function name matches", parsed2.tool_calls[0]?.function?.name, "get_weather");

  console.log("\n[5/6] Parsing embedded tool call in prose ...");
  const proseOutput = 'I will look up the weather for you:\n```json\n{"tool_calls": [{"name": "get_weather", "arguments": {"location": "London"}}]}\n```\nPlease wait.';
  const parsed3 = parseToolBridgeOutput(proseOutput, mockTools);
  expect("extracts tool call from prose", parsed3.finish_reason, "tool_calls");
  expect("extracted function name matches", parsed3.tool_calls[0]?.function?.name, "get_weather");

  console.log("\n[5b] Both protocols' tool_choice shapes ...");
  expect("Anthropic {type:any} is required", normalizeToolChoice({ type: "any" }).mode, "required");
  expect("Anthropic {type:tool} names the tool", normalizeToolChoice({ type: "tool", name: "get_weather" }).name, "get_weather");
  expect("Anthropic {type:none} is none", normalizeToolChoice({ type: "none" }).mode, "none");
  expect("OpenAI {function:{name}} names the tool", normalizeToolChoice({ type: "function", function: { name: "x" } }).name, "x");
  expect("OpenAI 'required' is required", normalizeToolChoice("required").mode, "required");
  expect("Anthropic forced tool reaches the prompt", buildToolBridgePrompt("hi", mockTools, { type: "tool", name: "get_weather" }).includes('name: "get_weather"'), true);

  console.log("\n[6/6] End-to-end server route with Gemini Web tool bridge ...");
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
  });

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
