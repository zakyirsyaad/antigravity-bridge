/**
 * Regression guard for cooldowns that are scoped to a model family.
 *
 * A 429 was recorded against the account and nothing else. But Antigravity
 * meters Claude (served through Vertex) and Gemini out of different buckets, so
 * one exhausted Claude weekly quota marked the whole account rate limited — for
 * every model. One test request to claude-sonnet-4-6 rang the failover loop
 * through all six pooled accounts in three seconds and parked every one of them
 * for up to 134 hours, while Google's own meters still reported ~100% of the
 * Gemini quota available. Failover had nothing left to fail over to.
 *
 * Cooldowns are now keyed by (account, family). The display path, which has no
 * model in hand, still reports an account as cooling if any family is.
 *
 * fs is patched to intercept the accounts and quota paths only, so the real
 * ~/.zcode files are never read or written.
 */
import fs from "node:fs";
import path from "node:path";
import { OAuthManager } from "../src/oauth";
import { QuotaTracker } from "../src/quota-tracker";
import { ACCOUNTS_STORAGE_PATH, USER_HOME } from "../src/constants";

const QUOTA_PATH = path.join(USER_HOME, ".zcode", "antigravity-quota.json");

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;

let quotaContent = '{"perAccount":{}}';
let accountsContent = JSON.stringify({
  activeAccountIndex: 0,
  accounts: [
    { email: "a@example.com", refreshToken: "r" },
    { email: "b@example.com", refreshToken: "r" },
  ],
});

const isQuota = (p: unknown) => String(p) === QUOTA_PATH;
const isAccounts = (p: unknown) => String(p) === ACCOUNTS_STORAGE_PATH;

(fs as any).existsSync = (p: any) => (isQuota(p) || isAccounts(p) ? true : realExistsSync(p));
(fs as any).readFileSync = (p: any, ...rest: any[]) => {
  if (isQuota(p)) return quotaContent;
  if (isAccounts(p)) return accountsContent;
  return (realReadFileSync as any)(p, ...rest);
};
(fs as any).writeFileSync = (p: any, data: any, ...rest: any[]) => {
  if (isQuota(p)) {
    quotaContent = String(data);
    return;
  }
  if (isAccounts(p)) {
    accountsContent = String(data);
    return;
  }
  return (realWriteFileSync as any)(p, data, ...rest);
};

const CLAUDE = "claude-sonnet-4-6";
const GEMINI = "gemini-3.8-flash-tiered";
const WEEKLY = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 130h5m0s.";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function runTests() {
  console.log("=================================================");
  console.log(" Cooldowns are scoped to a model family");
  console.log("=================================================\n");

  const tracker = QuotaTracker.getInstance();

  console.log("[1/4] A Claude 429 parks Claude, not the account ...");
  quotaContent = '{"perAccount":{}}';
  tracker.record429("a@example.com", WEEKLY, CLAUDE);
  expect("claude is limited", tracker.isAccountRateLimited("a@example.com", CLAUDE), true);
  expect("gemini is NOT limited", tracker.isAccountRateLimited("a@example.com", GEMINI), false);

  console.log("\n[2/4] The dashboard has no model in hand and still sees it ...");
  expect("account reads as cooling", tracker.isAccountRateLimited("a@example.com"), true);
  const cooldown: any = tracker.getAccountCooldownRemaining("a@example.com");
  expect("a cooldown is reported", Boolean(cooldown), true);
  expect("it names the family", cooldown?.family, "claude");

  console.log("\n[3/4] State written before this change still limits everything ...");
  quotaContent = JSON.stringify({
    perAccount: {
      "a@example.com": {
        lastUpdated: new Date().toISOString(),
        weekly: {
          type: "weekly",
          hitAt: new Date().toISOString(),
          resetsAt: new Date(Date.now() + 3600_000).toISOString(),
          percentRemaining: 0,
          resetMessage: "Resets in 1h0m0s",
        },
      },
    },
  });
  expect("legacy window still limits gemini", tracker.isAccountRateLimited("a@example.com", GEMINI), true);
  expect("legacy window still limits claude", tracker.isAccountRateLimited("a@example.com", CLAUDE), true);

  console.log("\n[4/4] Pool selection skips an account only for the family it exhausted ...");
  const oauth = OAuthManager.getInstance();
  quotaContent = '{"perAccount":{}}';
  tracker.record429("b@example.com", WEEKLY, CLAUDE);
  expect(
    "gemini request still gets b",
    oauth.selectNextAvailableAccount("a@example.com", GEMINI)?.email,
    "b@example.com"
  );
  expect(
    "claude request refuses b",
    oauth.selectNextAvailableAccount("a@example.com", CLAUDE),
    null
  );

  if (failures > 0) {
    throw new Error(`${failures} quota family check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL QUOTA FAMILY CHECKS PASSED!");
  console.log("=================================================\n");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
