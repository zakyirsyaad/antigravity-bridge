/**
 * Regression guard for the one-command updater.
 *
 * Updating used to be undocumented: readers had to infer `git pull`, guess
 * whether dependencies changed, and work out for themselves which of three
 * restart paths applied to their install. `bridge:update` does it in one step —
 * which means it runs destructive-looking commands on someone else's checkout,
 * so its refusals matter more than its happy path:
 *
 *   - local changes are never discarded, and nothing is pulled when they exist;
 *   - a non-git install (a downloaded archive) is told so, not left with a
 *     cryptic git error;
 *   - the release check never throws and never blocks, because a laptop offline
 *     on a plane must still get `bridge:status`.
 *
 * The command runner and fetch are injected — no git, npm, network or disk.
 *
 * One failure mode only showed up in production. The committed package-lock.json
 * still said version 1.0.0 through the whole 2.x series, so `npm install` — which
 * the updater itself runs — rewrote two "version" lines and left the checkout
 * dirty. The second `bridge:update` then refused, forever, on a tree nobody had
 * touched. A lockfile whose ONLY change is its own version lines is npm's doing,
 * not the user's, and is restored; anything else in it is still the user's.
 */
import fs from "node:fs";
import path from "node:path";
import {
  compareSemver,
  performUpdate,
  checkForNewerRelease,
  CommandResult,
} from "../src/updater";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): CommandResult => ({ status: 1, stdout: "", stderr });

/** Records every command, answering from a table keyed by the command line. */
function runnerFor(table: Record<string, CommandResult>, log: string[]) {
  return (command: string, args: string[]) => {
    const line = [command, ...args].join(" ");
    log.push(line);
    return table[line] || ok();
  };
}

const CLEAN: Record<string, CommandResult> = {
  "git rev-parse --is-inside-work-tree": ok("true\n"),
  "git status --porcelain": ok(""),
  "git pull --ff-only": ok("Updating 9088fd7..a9765f3\n"),
  "npm install": ok(""),
};

async function runTests() {
  console.log("=================================================");
  console.log(" One-command updater");
  console.log("=================================================\n");

  console.log("[1/8] Version comparison orders releases, not strings ...");
  expect("2.0.10 is newer than 2.0.4", compareSemver("2.0.10", "2.0.4") > 0, true);
  expect("2.0.4 equals itself", compareSemver("2.0.4", "2.0.4"), 0);
  expect("3.0.0 beats 2.9.9", compareSemver("3.0.0", "2.9.9") > 0, true);
  expect("a v prefix is tolerated", compareSemver("v2.1.0", "2.0.9") > 0, true);

  console.log("\n[2/8] Local changes are never discarded ...");
  const dirtyLog: string[] = [];
  const dirty = performUpdate("/repo", runnerFor({ ...CLEAN, "git status --porcelain": ok(" M src/server.ts\n") }, dirtyLog), {
    readVersion: () => "2.0.4",
  });
  expect("refuses", dirty.ok, false);
  expect("says why", dirty.message.toLowerCase().includes("local change"), true);
  expect("never pulled", dirtyLog.includes("git pull --ff-only"), false);
  expect("never installed", dirtyLog.includes("npm install"), false);

  console.log("\n[3/8] A non-git install gets a human answer ...");
  const archiveLog: string[] = [];
  const archive = performUpdate("/repo", runnerFor({ "git rev-parse --is-inside-work-tree": fail("not a git repository") }, archiveLog), {
    readVersion: () => "2.0.4",
  });
  expect("refuses", archive.ok, false);
  expect("mentions git", archive.message.toLowerCase().includes("git"), true);
  expect("stopped immediately", archiveLog.length, 1);

  console.log("\n[4/8] The happy path, in order, and the service flag ...");
  const log: string[] = [];
  let version = "2.0.3";
  const result = performUpdate("/repo", runnerFor(CLEAN, log), {
    serviceInstalled: true,
    readVersion: () => version,
    afterPull: () => { version = "2.0.4"; },
  });
  expect("succeeded", result.ok, true);
  expect("checked the worktree first", log[0], "git rev-parse --is-inside-work-tree");
  expect("pulled before installing", log.indexOf("git pull --ff-only") < log.indexOf("npm install"), true);
  expect("reports the version it left", result.versionBefore, "2.0.3");
  expect("reports the version it reached", result.versionAfter, "2.0.4");
  expect("asks the caller to reload the daemon", result.reloadService, true);

  const noService = performUpdate("/repo", runnerFor(CLEAN, []), { serviceInstalled: false, readVersion: () => "2.0.4" });
  expect("no daemon, no reload", noService.reloadService, false);
  expect("already current is not a failure", noService.ok, true);

  console.log("\n[5/8] The release check is advisory and never fatal ...");
  const release = (tag: string) => async () =>
    ({ ok: true, json: async () => ({ tag_name: tag, html_url: "https://example.invalid/r" }) }) as any;
  expect("newer release is announced", (await checkForNewerRelease("2.0.4", release("v2.1.0")))?.includes("2.1.0"), true);
  expect("same version says nothing", await checkForNewerRelease("2.0.4", release("v2.0.4")), null);
  expect("older release says nothing", await checkForNewerRelease("2.0.4", release("v2.0.1")), null);

  const offline = async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); };
  expect("offline is silent, not fatal", await checkForNewerRelease("2.0.4", offline as any), null);

  const garbage = async () => ({ ok: true, json: async () => ({}) }) as any;
  expect("a shapeless response is silent", await checkForNewerRelease("2.0.4", garbage), null);

  const VERSION_ONLY_DIFF =
    "--- a/package-lock.json\n+++ b/package-lock.json\n@@ -3 +3 @@\n" +
    '-  "version": "1.0.0",\n+  "version": "2.1.1",\n@@ -9 +9 @@\n' +
    '-      "version": "1.0.0",\n+      "version": "2.1.1",\n';
  const DEPENDENCY_DIFF =
    VERSION_ONLY_DIFF + '@@ -40 +40 @@\n-      "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz",\n' +
    '+      "resolved": "https://registry.invalid/x/-/x-9.9.9.tgz",\n';
  const LOCK_ONLY = " M package-lock.json\n";
  const RESTORE = "git checkout -- package-lock.json";
  const DIFF = "git diff -U0 -- package-lock.json";

  console.log("\n[6/8] A tree dirty only with npm's own version rewrite is restored, then updated ...");
  const log6: string[] = [];
  const r6 = performUpdate(
    "/repo",
    runnerFor({ ...CLEAN, "git status --porcelain": ok(LOCK_ONLY), [DIFF]: ok(VERSION_ONLY_DIFF) }, log6),
    { readVersion: () => "2.1.1" }
  );
  expect("proceeds instead of refusing", r6.ok, true);
  expect("restored the lockfile", log6.includes(RESTORE), true);
  expect("restored before pulling", log6.indexOf(RESTORE) < log6.indexOf("git pull --ff-only"), true);

  console.log("\n[7/8] Anything beyond those version lines is still the user's, and still refused ...");
  const log7a: string[] = [];
  const r7a = performUpdate(
    "/repo",
    runnerFor({ ...CLEAN, "git status --porcelain": ok(LOCK_ONLY), [DIFF]: ok(DEPENDENCY_DIFF) }, log7a),
    { readVersion: () => "2.1.1" }
  );
  expect("a real dependency change refuses", r7a.ok, false);
  expect("and is never discarded", log7a.includes(RESTORE), false);
  expect("and nothing was pulled", log7a.includes("git pull --ff-only"), false);

  const log7b: string[] = [];
  const r7b = performUpdate(
    "/repo",
    runnerFor({ ...CLEAN, "git status --porcelain": ok(LOCK_ONLY + " M src/server.ts\n"), [DIFF]: ok(VERSION_ONLY_DIFF) }, log7b),
    { readVersion: () => "2.1.1" }
  );
  expect("the lockfile plus another file refuses", r7b.ok, false);
  expect("and the lockfile is left alone", log7b.includes(RESTORE), false);

  console.log("\n[8/8] npm rewriting the lockfile during the update must not poison the next one ...");
  let installed = false;
  const log8: string[] = [];
  const r8 = performUpdate(
    "/repo",
    (command, args) => {
      const line = [command, ...args].join(" ");
      log8.push(line);
      if (line === "npm install") installed = true;
      if (line === DIFF) return ok(installed ? VERSION_ONLY_DIFF : "");
      if (line === "git status --porcelain") return ok("");
      if (line === "git rev-parse --is-inside-work-tree") return ok("true\n");
      return ok();
    },
    { readVersion: () => "2.1.1" }
  );
  expect("update succeeds", r8.ok, true);
  expect("lockfile restored after npm touched it", log8.lastIndexOf(RESTORE) > log8.indexOf("npm install"), true);

  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf-8"));
  expect("committed lockfile version matches package.json", lock.version, pkg.version);
  expect("and so does its root package entry", lock.packages?.[""]?.version, pkg.version);

  if (failures > 0) {
    throw new Error(`${failures} updater check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL UPDATER CHECKS PASSED!");
  console.log("=================================================\n");
}

runTests().catch((e) => {
  console.error("Test failed with error:", e.message);
  process.exit(1);
});
