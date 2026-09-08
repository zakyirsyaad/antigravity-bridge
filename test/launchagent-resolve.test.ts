/**
 * Regression guard for LaunchAgent project-root resolution.
 *
 * The `switch` command used to resolve the project root by hand as
 * `__dirname/../../..`, the vendored-copy layout, while `service:install` had
 * already been taught to detect a standalone clone. On a standalone install
 * that pointed at the grandparent of the repo, so `npm run bridge:switch`
 * unloaded the working agent and loaded a plist referencing files that do not
 * exist — and the `launchctl` error was swallowed, so the user was told the
 * service had "reloaded and active" while it was in fact dead.
 *
 * Both commands now go through LaunchAgentService.resolveProjectDir(), and
 * install() validates its inputs before touching anything.
 *
 * This suite only ever calls install() with a deliberately bogus directory, so
 * it returns before writing a plist or invoking launchctl. It asserts the real
 * LaunchAgent plist is left untouched. No network, no quota.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaunchAgentService } from "../src/launchagent";
import { LAUNCH_AGENT_PLIST_PATH } from "../src/constants";

const REPO_ROOT = path.resolve(__dirname, "..");

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

/** Snapshot just enough to prove we did not touch the user's real plist. */
function plistFingerprint(): string {
  try {
    const stat = fs.statSync(LAUNCH_AGENT_PLIST_PATH);
    return `exists:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

function runTests() {
  console.log("=================================================");
  console.log(" LaunchAgent project-root resolution regression");
  console.log("=================================================\n");

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-launchagent-"));
  const plistBefore = plistFingerprint();

  try {
    console.log("[1/4] Standalone layout resolves to the package root ...");
    const standalone = path.join(scratch, "proj");
    fs.mkdirSync(path.join(standalone, "bin"), { recursive: true });
    fs.writeFileSync(path.join(standalone, "package.json"), "{}");
    expect("resolved root", LaunchAgentService.resolveProjectDir(path.join(standalone, "bin")), standalone);

    console.log("\n[2/4] Vendored layout with hoisted deps resolves to the host root ...");
    const host = path.join(scratch, "host");
    const vendored = path.join(host, "modules", "antigravity-bridge");
    fs.mkdirSync(path.join(vendored, "bin"), { recursive: true });
    // No package.json beside bin/ => dependencies live at the host root.
    expect("resolved root", LaunchAgentService.resolveProjectDir(path.join(vendored, "bin")), host);

    console.log("\n[3/4] This repo resolves to its own root, not its grandparent ...");
    const resolved = LaunchAgentService.resolveProjectDir(path.join(REPO_ROOT, "bin"));
    const oldBuggyResolution = path.resolve(REPO_ROOT, "bin", "..", "..", "..");
    expect("resolved root", resolved, REPO_ROOT);
    expect("differs from the old hardcoded expression", resolved === oldBuggyResolution, false);

    console.log("\n[4/4] install() rejects a bad root without touching anything ...");
    const bogus = path.join(scratch, "does-not-exist");
    const result = LaunchAgentService.install(bogus);
    expect("success", result.success, false);
    expect("message names the bad root", result.message.includes(bogus), true);
    expect("real plist untouched", plistFingerprint(), plistBefore);

    if (failures > 0) {
      throw new Error(`${failures} LaunchAgent resolution check(s) failed`);
    }

    console.log("\n=================================================");
    console.log(" 🎉 ALL LAUNCHAGENT CHECKS PASSED!");
    console.log("=================================================\n");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log("✓ Scratch directories removed.");
  }
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
