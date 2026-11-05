/**
 * Offline test suite for JSON & Tool Call Auto-Repair.
 *
 * Verifies:
 * 1. Markdown code fences are stripped from JSON strings.
 * 2. Conversational prose around JSON objects is extracted cleanly.
 * 3. Trailing commas before closing braces/brackets are removed.
 * 4. Single-line and multi-line comments are stripped.
 * 5. Single-quoted keys/strings are normalized to valid JSON.
 * 6. Truncated JSON structures (unclosed quotes/braces/brackets) are balanced.
 * 7. Malformed tool_call arguments in incoming requests and outgoing stream/non-stream
 *    responses are repaired into valid JSON objects without crashing.
 * 8. response_format ({ type: "json_object" } / { type: "json_schema" }) triggers
 *    generationConfig.responseMimeType = "application/json" and schema sanitization.
 */

import { repairJsonString, parseOrRepairJson, stripMarkdownCodeFences, extractJsonSubstring } from "../src/json-repair";
import { Transformer } from "../src/transformer";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function expectJsonEqual(label: string, actualJson: string, expectedObj: any) {
  try {
    const parsed = JSON.parse(actualJson);
    const actualStr = JSON.stringify(parsed);
    const wantedStr = JSON.stringify(expectedObj);
    if (actualStr === wantedStr) {
      console.log(`✓ ${label}`);
    } else {
      failures++;
      console.error(`✗ ${label} -> expected ${wantedStr}, got ${actualStr}`);
    }
  } catch (err: any) {
    failures++;
    console.error(`✗ ${label} -> JSON.parse failed on "${actualJson}": ${err.message}`);
  }
}

function runTests() {
  console.log("=================================================");
  console.log(" JSON & Tool Call Auto-Repair Offline Suite");
  console.log("=================================================\n");

  console.log("[1/8] Stripping markdown code fences ...");
  const fenced = "```json\n{\n  \"status\": \"ok\",\n  \"code\": 200\n}\n```";
  expectJsonEqual("strips ```json ... ``` wrapper", repairJsonString(fenced), { status: "ok", code: 200 });

  const unclosedFence = "```json\n{\"action\": \"run\"}";
  expectJsonEqual("strips unclosed leading code fence", repairJsonString(unclosedFence), { action: "run" });

  console.log("\n[2/8] Removing trailing commas ...");
  const withTrailingCommas = '{\n  "name": "bridge",\n  "version": "2.6.4",\n  "tags": ["proxy", "ai",],\n}';
  expectJsonEqual("removes object and array trailing commas", repairJsonString(withTrailingCommas), {
    name: "bridge",
    version: "2.6.4",
    tags: ["proxy", "ai"],
  });

  console.log("\n[3/8] Stripping JS / C-style comments ...");
  const withComments = `
  {
    // This is the active model
    "model": "claude-sonnet-4-6",
    /* multi-line
       note */
    "enabled": true
  }
  `;
  expectJsonEqual("removes single-line and multi-line comments", repairJsonString(withComments), {
    model: "claude-sonnet-4-6",
    enabled: true,
  });

  console.log("\n[4/8] Normalizing single-quoted JSON ...");
  const singleQuoted = "{'key': 'value', 'nested': {'count': 42}}";
  expectJsonEqual("converts single quotes to valid JSON double quotes", repairJsonString(singleQuoted), {
    key: "value",
    nested: { count: 42 },
  });

  console.log("\n[5/8] Balancing truncated JSON structures (MAX_TOKENS simulation) ...");
  const truncatedString = '{"user": "alice", "bio": "developer working on';
  expectJsonEqual("balances unclosed string and brace", repairJsonString(truncatedString), {
    user: "alice",
    bio: "developer working on",
  });

  const truncatedArray = '{"items": [1, 2, {"id": "item-1"}, {"id": "item-2"';
  expectJsonEqual("balances unclosed nested array and parent object", repairJsonString(truncatedArray), {
    items: [1, 2, { id: "item-1" }, { id: "item-2" }],
  });

  console.log("\n[6/8] Extracting JSON from surrounding conversational text ...");
  const proseJson = 'Here is your requested configuration:\n```json\n{"host": "127.0.0.1", "port": 52130}\n```\nLet me know if you need changes.';
  expectJsonEqual("extracts JSON block surrounded by prose", repairJsonString(proseJson), {
    host: "127.0.0.1",
    port: 52130,
  });

  console.log("\n[7/8] Tool call arguments auto-repair in Transformer ...");
  // Simulating incoming malformed tool_call arguments from client
  const incomingOpenAIPayload = {
    model: "claude-sonnet-4-6",
    messages: [
      {
        role: "user",
        content: "read the file",
      },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "read_file",
              arguments: "```json\n{'file_path': '/path/to/file',}\n```", // single quotes + trailing comma + code fence
            },
          },
        ],
      },
    ],
  };

  const antigravityPayload = Transformer.openaiToAntigravity(incomingOpenAIPayload);
  const contents = antigravityPayload.request.contents || [];
  const modelTurn = contents.find((c: any) => c.role === "model");
  const funcCall = modelTurn?.parts?.find((p: any) => p.functionCall)?.functionCall;
  expect("repairs incoming OpenAI tool_call arguments", funcCall?.args?.file_path, "/path/to/file");

  // Simulating outgoing response transformation with malformed args string in functionCall
  const mockAntigravityResp = {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: "execute_cmd",
                args: "{'cmd': 'ls -la', 'timeout': 5000,}", // string with single quotes & trailing comma
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };

  const outOpenAI = Transformer.antigravityToOpenAI(mockAntigravityResp, "claude-sonnet-4-6");
  const outTc = outOpenAI.choices[0].message.tool_calls[0];
  const parsedArgs = JSON.parse(outTc.function.arguments);
  expect("repairs outgoing OpenAI tool_call arguments string", parsedArgs.cmd, "ls -la");
  expect("parses number correctly in repaired tool_call arguments", parsedArgs.timeout, 5000);

  const outAnthropic = Transformer.antigravityToAnthropic(mockAntigravityResp, "claude-sonnet-4-6");
  const outBlock = outAnthropic.content.find((b: any) => b.type === "tool_use");
  expect("repairs outgoing Anthropic tool_use input object", outBlock.input.cmd, "ls -la");

  console.log("\n[8/8] OpenAI response_format translation & auto-repair ...");
  const rfRequest = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "give me json" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test_schema",
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
          },
          required: ["success"],
        },
      },
    },
  };

  const convertedRf = Transformer.openaiToAntigravity(rfRequest);
  expect(
    "sets responseMimeType to application/json",
    convertedRf.request.generationConfig.responseMimeType,
    "application/json"
  );
  expect(
    "sets cleaned responseSchema",
    convertedRf.request.generationConfig.responseSchema.properties.success.type,
    "boolean"
  );

  // Test antigravityToOpenAI with response_format json_object repairing markdown-fenced text
  const rawJsonResp = {
    candidates: [
      {
        content: {
          parts: [{ text: "```json\n{\n  'success': true,\n}\n```" }],
        },
        finishReason: "STOP",
      },
    ],
  };

  const formattedJsonResp = Transformer.antigravityToOpenAI(rawJsonResp, "claude-sonnet-4-6", { type: "json_object" });
  expectJsonEqual(
    "auto-repairs text field when response_format is json_object",
    formattedJsonResp.choices[0].message.content,
    { success: true }
  );

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All JSON Auto-Repair assertions passed!");
  }
}

runTests();
