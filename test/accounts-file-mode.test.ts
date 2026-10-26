/**
 * Regression guard for who can read the accounts file.
 *
 * ~/.zcode/antigravity-accounts.json holds every pooled account's access token and refresh
 * token, and a refresh token does not expire. It was written with fs.writeFileSync and no
 * `mode`, so under the usual umask (022) it came out -rw-r--r--, readable by every other user
 * on the machine — observed on a file the bridge had just created, in a 0755 directory. Five
 * places wrote it, each with its own copy of the call.
 *
 * They now share OAuthManager.writeStorage(): the file is created 0600, and — because
 * writeFileSync's `mode` applies only when the call creates the file — one that already
 * exists (a 0644 file an older release left) is tightened BEFORE new tokens are written into
 * it. A directory the bridge creates for it is 0700; one that already exists is not the
 * bridge's to change.
 *
 * A mode belongs to the file system, not to a call, so this suite cannot stub fs the way its
 * neighbours do. It runs the real OAuthManager against a real temporary $HOME instead — set
 * before any bridge module loads, because USER_HOME is os.homedir() read once at load — and
 * refuses to run if the accounts path does not land inside it. The umask is pinned, so a
 * permissive environment cannot make the old code look right.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

// require(), not import: imports are hoisted above this assignment, and constants.ts reads
// the home directory the moment it loads.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-accounts-mode-"));
process.env.HOME = HOME;
const { OAuthManager } = require("../src/oauth") as typeof import("../src/oauth");
const { ACCOUNTS_STORAGE_PATH } = require("../src/constants") as typeof import("../src/constants");

const ACCOUNTS_DIR = path.dirname(ACCOUNTS_STORAGE_PATH);
/** In every token the fixtures hold; expect() prints values, so none is ever passed to it. */
const MARKER = "token-that-must-never-be-printed";
const REFRESHED = `access-${MARKER}-refreshed`;
const EACCES = `EACCES: permission denied, open '${ACCOUNTS_STORAGE_PATH}'`;

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

/** Everything the run printed, so a token that leaks into a log line is caught. */
const printed: string[] = [];
/** Off while a section expects the bridge to complain, so that warning does not read as a failure. */
let echo = true;
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    printed.push(args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4 }))).join(" "));
    if (echo) original(...args);
  };
}

const account = (name: string) => ({
  email: `${name}@example.com`,
  name,
  accessToken: `access-${MARKER}-${name}`,
  refreshToken: `refresh-${MARKER}-${name}`,
  expiresAt: 0,
  projectId: "p",
});

/** "0600"-style, so a failure reads without a calculator. */
const modeOf = (p: string) => (fs.statSync(p).mode & 0o777).toString(8).padStart(4, "0");
const stored = () => JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8"));

/** Deletes a directory, so it refuses anything that is not inside the temporary HOME. */
function reset(): void {
  if (!ACCOUNTS_DIR.startsWith(HOME + path.sep)) {
    throw new Error(`refusing to delete ${ACCOUNTS_DIR}: it is outside the temporary HOME ${HOME}`);
  }
  fs.rmSync(ACCOUNTS_DIR, { recursive: true, force: true });
}

/** A two-account pool as an older release left it: by default in a file every user can read. */
function plantOldFile(mode = 0o644): void {
  reset();
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(
    ACCOUNTS_STORAGE_PATH,
    JSON.stringify({ accounts: [account("a"), account("b")], activeAccountIndex: 0 }, null, 2)
  );
  fs.chmodSync(ACCOUNTS_STORAGE_PATH, mode);
}

/** What a call threw, or null. */
function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    return e.message;
  }
}

/** Run `fn` with fs.writeFileSync replaced for the accounts path only. */
async function withWriteStub(stub: (p: string) => void, fn: () => unknown): Promise<void> {
  const real = fs.writeFileSync;
  (fs as any).writeFileSync = (p: any, ...rest: any[]) => {
    if (String(p) === ACCOUNTS_STORAGE_PATH) stub(String(p));
    return (real as any)(p, ...rest);
  };
  try {
    await fn();
  } finally {
    (fs as any).writeFileSync = real;
  }
}

async function runTests() {
  console.log("=================================================");
  console.log(" The accounts file is private to its owner");
  console.log("=================================================\n");

  expect(
    "the accounts path is inside the temporary HOME",
    ACCOUNTS_STORAGE_PATH,
    path.join(HOME, ".zcode", "antigravity-accounts.json")
  );
  if (failures > 0) throw new Error("refusing to run against a HOME that is not the temporary one");

  const oauth = OAuthManager.getInstance();
  const previousUmask = process.umask(0o022);
  const realFetch = (globalThis as any).fetch;
  // The quota refresh of a non-active account asks Google for a token; answer it offline.
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: REFRESHED, expires_in: 3600 }),
  });

  try {
    console.log("[1/10] A file the bridge creates is 0600, in a 0700 directory ...");
    reset();
    oauth.saveAccount(account("a"));
    expect("directory", modeOf(ACCOUNTS_DIR), "0700");
    expect("file", modeOf(ACCOUNTS_STORAGE_PATH), "0600");
    expect("the account is in it", stored().accounts[0]?.email, "a@example.com");

    console.log("\n[2/10] ... whatever the umask says ...");
    reset();
    process.umask(0);
    try {
      oauth.saveAccount(account("a"));
    } finally {
      process.umask(0o022);
    }
    expect("directory", modeOf(ACCOUNTS_DIR), "0700");
    expect("file", modeOf(ACCOUNTS_STORAGE_PATH), "0600");

    console.log("\n[3/10] A directory the bridge did not create is left as it is ...");
    reset();
    fs.mkdirSync(ACCOUNTS_DIR);
    fs.chmodSync(ACCOUNTS_DIR, 0o755);
    oauth.saveAccount(account("a"));
    expect("directory", modeOf(ACCOUNTS_DIR), "0755");
    expect("file", modeOf(ACCOUNTS_STORAGE_PATH), "0600");

    console.log("\n[4/10] Each of the five writers tightens a 0644 file an older release left ...");
    // `landed` is a boolean on purpose: a write that never happened would leave the old mode
    // in place and read as "not tightened", so each row first proves its write took effect.
    const writers: Array<{ name: string; run: () => unknown; landed: () => boolean }> = [
      { name: "saveAccount", run: () => oauth.saveAccount(account("c")), landed: () => stored().accounts.length === 3 },
      { name: "switchAccount", run: () => oauth.switchAccount(1), landed: () => stored().activeAccountIndex === 1 },
      {
        name: "deleteAccountByEmail",
        run: () => oauth.deleteAccountByEmail("b@example.com"),
        landed: () => stored().accounts.length === 1,
      },
      {
        name: "selectNextAvailableAccount",
        run: () => oauth.selectNextAvailableAccount("a@example.com"),
        landed: () => stored().activeAccountIndex === 1,
      },
      {
        name: "the quota refresh (updateStoredAccount)",
        run: () => oauth.getValidAccessTokenForAccount(account("b")),
        landed: () => stored().accounts[1].accessToken === REFRESHED,
      },
    ];
    for (const writer of writers) {
      plantOldFile();
      expect(`${writer.name}: the file starts out`, modeOf(ACCOUNTS_STORAGE_PATH), "0644");
      await writer.run();
      expect(`${writer.name}: the write landed`, writer.landed(), true);
      expect(`${writer.name}: the file is now`, modeOf(ACCOUNTS_STORAGE_PATH), "0600");
    }

    console.log("\n[5/10] An old file is tightened before new tokens are written into it ...");
    plantOldFile();
    let modeWhenWriteBegan = "";
    await withWriteStub(
      (p) => {
        modeWhenWriteBegan = modeOf(p);
      },
      () => oauth.switchAccount(1)
    );
    expect("mode when the write began", modeWhenWriteBegan, "0600");

    console.log("\n[6/10] Only group and other access is taken away; the owner's bits are the owner's ...");
    const modes: Array<[planted: number, wanted: string]> = [
      [0o664, "0600"],
      [0o640, "0600"],
      [0o666, "0600"],
      [0o604, "0600"],
      [0o600, "0600"],
      [0o700, "0700"],
      [0o400, "0400"],
      [0o444, "0400"],
    ];
    for (const [planted, wanted] of modes) {
      plantOldFile(planted);
      // A file its owner made read-only may refuse the write; the mode is what is asked here.
      thrown(() => oauth.switchAccount(1));
      expect(`${planted.toString(8).padStart(4, "0")} becomes`, modeOf(ACCOUNTS_STORAGE_PATH), wanted);
    }

    console.log("\n[7/10] The content is written as before: two-space JSON, nothing lost ...");
    plantOldFile();
    oauth.switchAccount(1);
    const raw = fs.readFileSync(ACCOUNTS_STORAGE_PATH, "utf-8");
    expect("serialized as JSON.stringify(_, null, 2)", raw === JSON.stringify(JSON.parse(raw), null, 2), true);
    expect("both accounts survived", stored().accounts.length, 2);
    expect("the refresh token is intact", stored().accounts[1].refreshToken === account("b").refreshToken, true);

    console.log("\n[8/10] A failed write is still swallowed where it was, and thrown where it was ...");
    plantOldFile();
    const fail = () => {
      throw Object.assign(new Error(EACCES), { code: "EACCES" });
    };
    await withWriteStub(fail, () => {
      expect("failover still moves on", oauth.selectNextAvailableAccount("a@example.com")?.email, "b@example.com");
      // The warning is expected, so it is kept off the screen; the checks themselves stay on it.
      const printedBefore = printed.length;
      let saveOutcome: string | null;
      echo = false;
      try {
        saveOutcome = thrown(() => oauth.saveAccount(account("c")));
      } finally {
        echo = true;
      }
      const loggedBySave = printed.slice(printedBefore);
      expect("saveAccount still only warns", saveOutcome, null);
      expect("and does warn", loggedBySave.some((line) => line.includes("Failed to persist accounts")), true);
      expect("switchAccount still throws", thrown(() => oauth.switchAccount(1)), EACCES);
      expect("deleteAccountByEmail still throws", thrown(() => oauth.deleteAccountByEmail("b@example.com")), EACCES);
    });

    // A chmod that fails (for any reason but a missing file) counts as a failed write: better
    // to write nothing than to put tokens into a file that could not be locked down.
    plantOldFile();
    const realChmodSync = fs.chmodSync;
    const EPERM = `EPERM: operation not permitted, chmod '${ACCOUNTS_STORAGE_PATH}'`;
    (fs as any).chmodSync = (p: any, ...rest: any[]) => {
      if (String(p) === ACCOUNTS_STORAGE_PATH) throw Object.assign(new Error(EPERM), { code: "EPERM" });
      return (realChmodSync as any)(p, ...rest);
    };
    const printedBeforeChmod = printed.length;
    let chmodOutcome: string | null;
    echo = false;
    try {
      chmodOutcome = thrown(() => oauth.switchAccount(1));
    } finally {
      echo = true;
      (fs as any).chmodSync = realChmodSync;
    }
    // Taken before the expect() calls below, which print the very strings it looks for.
    const loggedByChmod = printed.slice(printedBeforeChmod);
    expect("a chmod that fails fails the write", chmodOutcome, EPERM);
    expect("and nothing was written", stored().activeAccountIndex, 0);
    expect(
      "and the log says which file and why",
      loggedByChmod.some((line) => line.includes(ACCOUNTS_STORAGE_PATH) && line.includes("EPERM")),
      true
    );

    console.log("\n[9/10] Nothing but writeStorage() writes the accounts file ...");
    // This is how the bug happened: five copies of one call. A sixth copy would not be caught by
    // the sections above unless it were also added to the table in [4/10].
    const root = path.join(__dirname, "..");
    const direct = ["src", "bin"]
      .flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((file) => path.join(dir, file)))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({
        file,
        calls: (fs.readFileSync(path.join(root, file), "utf-8").match(/writeFileSync\(\s*ACCOUNTS_STORAGE_PATH\b/g) || []).length,
      }))
      .filter((hit) => hit.calls > 0);
    expect("files that write it directly", direct.map((hit) => `${hit.file}:${hit.calls}`).join(" "), "src/oauth.ts:1");

    console.log("\n[10/10] No token reached the console ...");
    expect("anything printed that contains one", printed.some((line) => line.includes(MARKER)), false);

    if (failures > 0) {
      throw new Error(`${failures} accounts-file-mode check(s) failed`);
    }
  } finally {
    (globalThis as any).fetch = realFetch;
    process.umask(previousUmask);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

runTests()
  .then(() => {
    console.log("\n=================================================");
    console.log(" 🎉 ALL ACCOUNTS FILE MODE CHECKS PASSED!");
    console.log("=================================================\n");
  })
  .catch((e) => {
    console.error("Test failed with error:", e.message);
    process.exit(1);
  });
