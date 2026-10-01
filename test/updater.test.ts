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
 */
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

  console.log("[1/5] Version comparison orders releases, not strings ...");
  expect("2.0.10 is newer than 2.0.4", compareSemver("2.0.10", "2.0.4") > 0, true);
  expect("2.0.4 equals itself", compareSemver("2.0.4", "2.0.4"), 0);
  expect("3.0.0 beats 2.9.9", compareSemver("3.0.0", "2.9.9") > 0, true);
  expect("a v prefix is tolerated", compareSemver("v2.1.0", "2.0.9") > 0, true);

  console.log("\n[2/5] Local changes are never discarded ...");
  const dirtyLog: string[] = [];
  const dirty = performUpdate("/repo", runnerFor({ ...CLEAN, "git status --porcelain": ok(" M src/server.ts\n") }, dirtyLog), {
    readVersion: () => "2.0.4",
  });
  expect("refuses", dirty.ok, false);
  expect("says why", dirty.message.toLowerCase().includes("local change"), true);
  expect("never pulled", dirtyLog.includes("git pull --ff-only"), false);
  expect("never installed", dirtyLog.includes("npm install"), false);

  console.log("\n[3/5] A non-git install gets a human answer ...");
  const archiveLog: string[] = [];
  const archive = performUpdate("/repo", runnerFor({ "git rev-parse --is-inside-work-tree": fail("not a git repository") }, archiveLog), {
    readVersion: () => "2.0.4",
  });
  expect("refuses", archive.ok, false);
  expect("mentions git", archive.message.toLowerCase().includes("git"), true);
  expect("stopped immediately", archiveLog.length, 1);

  console.log("\n[4/5] The happy path, in order, and the service flag ...");
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

  console.log("\n[5/5] The release check is advisory and never fatal ...");
  const release = (tag: string) => async () =>
    ({ ok: true, json: async () => ({ tag_name: tag, html_url: "https://example.invalid/r" }) }) as any;
  expect("newer release is announced", (await checkForNewerRelease("2.0.4", release("v2.1.0")))?.includes("2.1.0"), true);
  expect("same version says nothing", await checkForNewerRelease("2.0.4", release("v2.0.4")), null);
  expect("older release says nothing", await checkForNewerRelease("2.0.4", release("v2.0.1")), null);

  const offline = async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); };
  expect("offline is silent, not fatal", await checkForNewerRelease("2.0.4", offline as any), null);

  const garbage = async () => ({ ok: true, json: async () => ({}) }) as any;
  expect("a shapeless response is silent", await checkForNewerRelease("2.0.4", garbage), null);

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
