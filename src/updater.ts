import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where the published releases live. Forks should point this at their own. */
const RELEASES_API = "https://api.github.com/repos/zakyirsyaad/antigravity-bridge/releases/latest";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd?: string) => CommandResult;

/**
 * Never throws: a non-zero exit is data here, not an exception, because every
 * caller below has something specific to say about each failure.
 */
export const defaultRunner: CommandRunner = (command, args, cwd) => {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout || "", stderr: "" };
  } catch (error: any) {
    return {
      status: typeof error?.status === "number" ? error.status : 1,
      stdout: error?.stdout?.toString?.() || "",
      stderr: error?.stderr?.toString?.() || error?.message || "",
    };
  }
};

/** Compares release numbers numerically. "2.0.10" is newer than "2.0.4". */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string) =>
    String(v || "")
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdateOptions {
  /** When true the caller reloads the LaunchAgent after a successful update. */
  serviceInstalled?: boolean;
  /** Overridable so tests never read a real package.json. */
  readVersion?: () => string;
  /** Test seam: the version on disk changes between the two reads. */
  afterPull?: () => void;
}

export interface UpdateOutcome {
  ok: boolean;
  message: string;
  reloadService: boolean;
  versionBefore?: string;
  versionAfter?: string;
}

function readPackageVersion(projectDir: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Pull, install, and tell the caller whether the daemon needs reloading.
 *
 * This runs on someone else's checkout, so it refuses far more readily than it
 * acts: uncommitted work is never discarded, and a fast-forward is the only
 * merge it will accept. The failures below are the point of the command.
 */
export function performUpdate(
  projectDir: string,
  run: CommandRunner = defaultRunner,
  opts: UpdateOptions = {}
): UpdateOutcome {
  const readVersion = opts.readVersion || (() => readPackageVersion(projectDir));
  const reloadService = Boolean(opts.serviceInstalled);

  const insideRepo = run("git", ["rev-parse", "--is-inside-work-tree"], projectDir);
  if (insideRepo.status !== 0) {
    return {
      ok: false,
      reloadService: false,
      message:
        "This install is not a git checkout, so there is nothing to pull.\n" +
        "  Download the latest release, or clone the repository to update with one command.",
    };
  }

  const dirty = run("git", ["status", "--porcelain"], projectDir);
  if (dirty.status === 0 && dirty.stdout.trim()) {
    return {
      ok: false,
      reloadService: false,
      message:
        "Local changes are present, so nothing was pulled — commit or stash them first:\n" +
        dirty.stdout.trim(),
    };
  }

  const versionBefore = readVersion();

  const pull = run("git", ["pull", "--ff-only"], projectDir);
  if (pull.status !== 0) {
    return {
      ok: false,
      reloadService: false,
      versionBefore,
      message:
        "git pull --ff-only failed, so the checkout is untouched:\n  " +
        (pull.stderr || pull.stdout).trim(),
    };
  }
  if (opts.afterPull) opts.afterPull();

  const install = run("npm", ["install"], projectDir);
  if (install.status !== 0) {
    return {
      ok: false,
      reloadService: false,
      versionBefore,
      versionAfter: readVersion(),
      message:
        "The code updated but `npm install` failed, so the bridge may not start:\n  " +
        (install.stderr || install.stdout).trim(),
    };
  }

  const versionAfter = readVersion();
  const moved = compareSemver(versionAfter, versionBefore) !== 0;

  return {
    ok: true,
    reloadService,
    versionBefore,
    versionAfter,
    message: moved
      ? `Updated ${versionBefore} -> ${versionAfter}.`
      : `Already on ${versionAfter} — nothing to update.`,
  };
}

/**
 * One line when a newer release exists, null otherwise.
 *
 * Advisory only, and deliberately silent on every failure: a laptop with no
 * network must still get `bridge:status` without an error or a wait.
 */
export async function checkForNewerRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response: any = await fetchImpl(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "antigravity-bridge" },
      signal: AbortSignal.timeout(3000),
    } as any);
    if (!response?.ok) return null;

    const body = await response.json();
    const tag = body?.tag_name;
    if (!tag) return null;

    if (compareSemver(tag, currentVersion) <= 0) return null;

    const latest = String(tag).replace(/^v/i, "");
    return `Update available: ${latest} (you have ${currentVersion}). Run \`npm run bridge:update\`.`;
  } catch {
    return null;
  }
}
