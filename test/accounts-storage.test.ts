/**
 * Regression guard for malformed accounts storage.
 *
 * deleteAccountByEmail() wrapped only JSON.parse in its try/catch, then
 * dereferenced `storage.accounts.length` unguarded. A file that parses as JSON
 * but carries no `accounts` array — a truncated write, or the
 * `{ provider: {} }` shape this codebase writes elsewhere — threw a TypeError
 * outside the catch, surfacing as a 500 from POST /api/pool/delete. saveAccount
 * and updateStoredAccount had the same hole, swallowed as a failure to persist.
 *
 * All three now read through readStorage(), which always returns a well-formed
 * shape.
 *
 * fs is patched to intercept the accounts path only, so the real
 * ~/.zcode/antigravity-accounts.json is never read or written.
 */
import fs from "node:fs";
import { OAuthManager } from "../src/oauth";
import { ACCOUNTS_STORAGE_PATH } from "../src/constants";

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;

/** What the fake accounts file currently contains. */
let storageContent = "{}";
/** Writes the code attempted against the accounts path. */
let writes: string[] = [];

function isAccountsPath(p: unknown): boolean {
  return String(p) === ACCOUNTS_STORAGE_PATH;
}

(fs as any).existsSync = (p: any) => (isAccountsPath(p) ? true : realExistsSync(p));
(fs as any).readFileSync = (p: any, ...rest: any[]) =>
  isAccountsPath(p) ? storageContent : (realReadFileSync as any)(p, ...rest);
(fs as any).writeFileSync = (p: any, data: any, ...rest: any[]) => {
  if (isAccountsPath(p)) {
    writes.push(String(data));
    return;
  }
  return (realWriteFileSync as any)(p, data, ...rest);
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

/** Run deleteAccountByEmail, reporting a throw instead of propagating it. */
function deleteAccount(oauth: OAuthManager, email: string): string {
  try {
    return String(oauth.deleteAccountByEmail(email));
  } catch (e: any) {
    return `THREW: ${e.message}`;
  }
}

function runTests() {
  console.log("=================================================");
  console.log(" Malformed accounts storage regression");
  console.log("=================================================\n");

  const oauth = OAuthManager.getInstance();

  try {
    console.log("[1/5] Empty object -> false, no throw, no write ...");
    storageContent = "{}";
    writes = [];
    expect("result", deleteAccount(oauth, "someone@example.com"), "false");
    expect("writes attempted", writes.length, 0);

    console.log("\n[2/5] Wrong-shaped file ({provider:{}}) -> false, no throw ...");
    storageContent = JSON.stringify({ provider: {} });
    writes = [];
    expect("result", deleteAccount(oauth, "someone@example.com"), "false");
    expect("writes attempted", writes.length, 0);

    console.log("\n[3/5] Unparseable file -> false, no throw ...");
    storageContent = "{ not json at all";
    writes = [];
    expect("result", deleteAccount(oauth, "someone@example.com"), "false");
    expect("writes attempted", writes.length, 0);

    console.log("\n[4/5] Valid file, no matching account -> false, no write ...");
    storageContent = JSON.stringify({
      accounts: [{ email: "alice@example.com", accessToken: "a", refreshToken: "ra", expiresAt: 0 }],
      activeAccountIndex: 0,
    });
    writes = [];
    expect("result", deleteAccount(oauth, "bob@example.com"), "false");
    expect("writes attempted", writes.length, 0);

    console.log("\n[5/5] Valid file, matching account -> true, persisted ...");
    storageContent = JSON.stringify({
      accounts: [
        { email: "alice@example.com", accessToken: "a", refreshToken: "ra", expiresAt: 0 },
        { email: "bob@example.com", accessToken: "b", refreshToken: "rb", expiresAt: 0 },
      ],
      activeAccountIndex: 0,
    });
    writes = [];
    expect("result", deleteAccount(oauth, "bob@example.com"), "true");
    expect("writes attempted", writes.length, 1);
    expect("bob removed from persisted file", writes[0]?.includes("bob@example.com"), false);
    expect("alice retained", writes[0]?.includes("alice@example.com"), true);

    if (failures > 0) {
      throw new Error(`${failures} accounts-storage check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL ACCOUNTS STORAGE CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    (fs as any).existsSync = realExistsSync;
    (fs as any).readFileSync = realReadFileSync;
    (fs as any).writeFileSync = realWriteFileSync;
    console.log("✓ fs restored.");
  }
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
