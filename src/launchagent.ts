import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { LAUNCH_AGENT_PLIST_PATH, USER_HOME } from "./constants";

export class LaunchAgentService {
  /**
   * Resolve the project root from the CLI's own directory.
   *
   * Two layouts are supported: a standalone clone, where `bin/` sits next to
   * package.json, and a vendored copy whose dependencies are hoisted to a host
   * project root. Every caller must go through this — resolving the path by
   * hand is how `switch` came to install a plist pointing at nothing.
   */
  public static resolveProjectDir(binDir: string): string {
    const standalone = path.resolve(binDir, "..");
    if (fs.existsSync(path.join(standalone, "package.json"))) {
      return standalone;
    }
    return path.resolve(binDir, "..", "..", "..");
  }

  public static install(projectDir: string): { success: boolean; message: string } {
    try {
      const nodeBin = process.execPath;
      let tsxCliMjs = path.join(projectDir, "node_modules", "tsx", "dist", "cli.mjs");
      if (!fs.existsSync(tsxCliMjs)) {
        const nestedTsx = path.join(projectDir, "modules", "antigravity-bridge", "node_modules", "tsx", "dist", "cli.mjs");
        if (fs.existsSync(nestedTsx)) tsxCliMjs = nestedTsx;
      }

      let cliScript = path.join(projectDir, "bin", "cli.ts");
      if (!fs.existsSync(cliScript)) {
        const nestedCli = path.join(projectDir, "modules", "antigravity-bridge", "bin", "cli.ts");
        if (fs.existsSync(nestedCli)) cliScript = nestedCli;
      }

      // Bail out before touching anything. Writing a plist that points at
      // missing files and then unloading the running agent would leave the user
      // with no bridge — and `launchctl load` failing on the broken plist is
      // swallowed below, so they would never be told.
      const missing = [tsxCliMjs, cliScript].filter((p) => !fs.existsSync(p));
      if (missing.length > 0) {
        return {
          success: false,
          message: `Cannot install LaunchAgent from ${projectDir} — not found: ${missing.join(", ")}`,
        };
      }

      const plistDir = path.dirname(LAUNCH_AGENT_PLIST_PATH);
      if (!fs.existsSync(plistDir)) {
        fs.mkdirSync(plistDir, { recursive: true });
      }

      const logDir = path.join(USER_HOME, ".zcode", "logs");

      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const stdOutLog = path.join(logDir, "antigravity-bridge.log");
      const stdErrLog = path.join(logDir, "antigravity-bridge.err.log");

      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.antigravity.zcode-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${tsxCliMjs}</string>
        <string>${cliScript}</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdOutLog}</string>
    <key>StandardErrorPath</key>
    <string>${stdErrLog}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${path.dirname(nodeBin)}</string>
    </dict>
</dict>
</plist>`;

      fs.writeFileSync(LAUNCH_AGENT_PLIST_PATH, plistContent, "utf-8");

      try {
        execSync(`launchctl unload "${LAUNCH_AGENT_PLIST_PATH}" 2>/dev/null || true`);
        execSync(`launchctl load "${LAUNCH_AGENT_PLIST_PATH}"`);
      } catch (e) {
        // ignore load errors
      }

      return {
        success: true,
        message: `LaunchAgent installed and loaded successfully at ${LAUNCH_AGENT_PLIST_PATH}`,
      };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  public static uninstall(): { success: boolean; message: string } {
    try {
      if (fs.existsSync(LAUNCH_AGENT_PLIST_PATH)) {
        try {
          execSync(`launchctl unload "${LAUNCH_AGENT_PLIST_PATH}" 2>/dev/null || true`);
        } catch {}
        fs.unlinkSync(LAUNCH_AGENT_PLIST_PATH);
      }
      return { success: true, message: "LaunchAgent uninstalled successfully." };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }
}
