/**
 * Regression guard for account failover on upstream capacity errors.
 *
 * Only 429 used to rotate the pool. A 503 — "No capacity available for model X
 * on the server" — fell straight through to the caller, and since
 * ANTIGRAVITY_ENDPOINTS holds a single endpoint there was no second attempt at
 * all. It was the single largest error class in production.
 *
 * Capacity is per project, so another account is a real second chance. What a
 * 503 must NOT do is write a quota cooldown: that would park a perfectly
 * healthy account for hours over a transient server condition.
 *
 * 400 stays non-retryable — a malformed request is malformed everywhere.
 *
 * Stubbed throughout — no disk, network, credential or quota.
 */
import { AntigravityClient } from "../src/antigravity-client";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";

const A = { email: "a@example.com", projectId: "p", refreshToken: "r" };
const B = { email: "b@example.com", projectId: "p", refreshToken: "r" };

let current: any = A;
let switched = 0;
let cooldownsRecorded = 0;
let attempts: string[] = [];
let respond: (account: any) => Response = () => new Response("{}", { status: 200 });

(OAuthManager.prototype as any).loadSavedAccount = () => current;
(OAuthManager.prototype as any).getValidAccessToken = async () => "token";
(OAuthManager.prototype as any).isAutoFailoverEnabled = () => true;
(OAuthManager.prototype as any).selectNextAvailableAccount = () => {
  switched++;
  current = B;
  return B;
};
(QuotaTracker.prototype as any).isAccountRateLimited = () => false;
(QuotaTracker.prototype as any).record429 = () => {
  cooldownsRecorded++;
};

(globalThis as any).fetch = async () => {
  attempts.push(current.email);
  return respond(current);
};

const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
const okStream = () =>
  new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })}\n\n`, {
    status: 200,
  });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

const CAPACITY = "No capacity available for model gemini-3.8-flash-tiered on the server";
const payload = {
  model: "gemini-3.8-flash-tiered",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
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

function reset(responder: (account: any) => Response) {
  current = A;
  switched = 0;
  cooldownsRecorded = 0;
  attempts = [];
  respond = responder;
}

async function runTests() {
  console.log("=================================================");
  console.log(" Failover on upstream capacity errors");
  console.log("=================================================\n");

  const client = new AntigravityClient();

  console.log("[1/4] A 503 rotates to another account instead of failing ...");
  reset((acct) => (acct === A ? fail(503, CAPACITY) : ok()));
  let text = "";
  try {
    const res: any = await client.generateContent(payload as any);
    text = res?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (e: any) {
    text = `THREW ${e.message}`;
  }
  expect("request ultimately succeeds", text, "ok");
  expect("rotated exactly once", switched, 1);
  expect("second attempt used the other account", attempts[attempts.length - 1], B.email);
  expect("no cooldown written for a 503", cooldownsRecorded, 0);

  console.log("\n[2/4] The streaming path rotates too ...");
  reset((acct) => (acct === A ? fail(503, CAPACITY) : okStream()));
  let streamed = "";
  try {
    const stream: any = await client.streamGenerateContent(payload as any);
    for await (const chunk of stream) {
      streamed = chunk?.candidates?.[0]?.content?.parts?.[0]?.text || streamed;
      break;
    }
  } catch (e: any) {
    streamed = `THREW ${e.message}`;
  }
  expect("stream ultimately succeeds", streamed, "ok");
  expect("rotated exactly once", switched, 1);
  expect("no cooldown written for a 503", cooldownsRecorded, 0);

  console.log("\n[3/4] 429 still rotates AND still records the cooldown ...");
  reset((acct) =>
    acct === A ? fail(429, "Individual quota reached. Resets in 3h55m50s.") : ok()
  );
  try {
    await client.generateContent(payload as any);
  } catch {}
  expect("rotated on 429", switched, 1);
  expect("cooldown recorded once", cooldownsRecorded, 1);

  console.log("\n[4/4] 400 is still refused on the spot ...");
  reset(() => fail(400, "Request contains an invalid argument."));
  let thrown = "";
  try {
    await client.generateContent(payload as any);
  } catch (e: any) {
    thrown = e.message.includes("(400)") ? "400" : e.message;
  }
  expect("threw a 400", thrown, "400");
  expect("never rotated the pool", switched, 0);
  expect("tried exactly one account", attempts.length, 1);

  if (failures > 0) {
    throw new Error(`${failures} capacity failover check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL CAPACITY FAILOVER CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
