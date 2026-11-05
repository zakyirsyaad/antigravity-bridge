/**
 * Offline test suite for OpenAI Image Generations endpoint: POST /v1/images/generations.
 *
 * Verifies:
 * 1. Missing or empty prompt returns HTTP 400.
 * 2. Default request returns array of { url, revised_prompt } with HTTP 200.
 * 3. response_format: "b64_json" returns base64-encoded image payloads.
 * 4. n parameter bounds output array size (e.g. n=2 returns 2 items).
 * 5. Route alias /images/generations works identically to /v1/images/generations.
 */

import http from "node:http";
import { BridgeServer } from "../src/server";
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";

const TEST_PORT = 52148;
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
  console.log(" OpenAI Image Generations Offline Suite");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();
  const server = new BridgeServer(TEST_PORT);

  (oauth as any).listAccounts = () => ({
    accounts: [{ email: "test@example.com", projectId: "test-proj", refreshToken: "mock", accessToken: "mock", expiresAt: Date.now() + 10000 }],
    activeIndex: 0,
  });
  (oauth as any).loadSavedAccount = () => ({ email: "test@example.com", projectId: "test-proj", refreshToken: "mock", accessToken: "mock", expiresAt: Date.now() + 10000 });
  (oauth as any).getValidAccessToken = async () => "mock-token";

  // Stub AntigravityClient.generateContent on server's client instance
  (server as any).client.generateContent = async () => ({
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  });

  await server.start();

  try {
    console.log("[1/5] Missing prompt rejected with 400 ...");
    const resEmpty = await postJson("/v1/images/generations", {});
    expect("rejects empty prompt with 400", resEmpty.status, 400);
    expect("error message identifies prompt", resEmpty.data.error?.message, "prompt is required");

    console.log("\n[2/5] Standard image generation returns URL ...");
    const resUrl = await postJson("/v1/images/generations", {
      prompt: "A futuristic city in watercolor style",
    });
    expect("answers 200 on valid prompt", resUrl.status, 200);
    expect("contains created timestamp", typeof resUrl.data.created, "number");
    expect("contains data array of length 1", resUrl.data.data?.length, 1);
    expect("data item contains url", typeof resUrl.data.data?.[0]?.url, "string");
    expect("revised_prompt matches input prompt", resUrl.data.data?.[0]?.revised_prompt, "A futuristic city in watercolor style");

    console.log("\n[3/5] Base64 JSON output mode (b64_json) ...");
    const resB64 = await postJson("/v1/images/generations", {
      prompt: "Cyberpunk robot head",
      response_format: "b64_json",
    });
    expect("answers 200 with b64_json", resB64.status, 200);
    expect("b64_json field is present", typeof resB64.data.data?.[0]?.b64_json, "string");
    expect("b64_json contains valid base64 data", resB64.data.data?.[0]?.b64_json?.startsWith("iVBORw0"), true);

    console.log("\n[4/5] Multi-image count request (n=2) ...");
    const resMulti = await postJson("/v1/images/generations", {
      prompt: "Neon landscape",
      n: 2,
      response_format: "b64_json",
    });
    expect("answers 200 with n=2", resMulti.status, 200);
    expect("data array contains 2 images", resMulti.data.data?.length, 2);

    console.log("\n[5/5] Endpoint alias /images/generations ...");
    const resAlias = await postJson("/images/generations", {
      prompt: "Abstract digital art",
    });
    expect("alias answers 200", resAlias.status, 200);
    expect("alias returns data item", resAlias.data.data?.length, 1);

  } finally {
    await server.stop();
  }

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  } else {
    console.log("SUCCESS: All OpenAI Image Generations assertions passed!");
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
