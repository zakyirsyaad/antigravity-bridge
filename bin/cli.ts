import { BridgeServer } from "../src/server";
import { OAuthManager } from "../src/oauth";
import { syncZCodeConfig } from "../src/zcode-sync";
import { LaunchAgentService } from "../src/launchagent";
import { checkModelDrift } from "../src/model-sync";
import { UsageTracker } from "../src/usage-tracker";
import { BRIDGE_DEFAULT_PORT, SUPPORTED_MODELS } from "../src/constants";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "start";
  const oauth = OAuthManager.getInstance();

  console.log("┌────────────────────────────────────────────────────────┐");
  console.log("│         Antigravity OAuth Bridge for ZCode             │");
  console.log("└────────────────────────────────────────────────────────┘");

  switch (command) {
    case "usage": {
      const usage = UsageTracker.getInstance().getUsage();
      const acc = oauth.loadSavedAccount();

      console.log(`\n📊 Antigravity Usage Statistics:`);
      console.log(`  Connected Account : ${acc?.name ? `${acc.name} (${acc.email})` : (acc?.email || "Google Account")}`);
      console.log(`  Total Requests    : ${usage.totalRequests.toLocaleString()}`);
      console.log(`  Total Input Tokens: ${usage.totalInputTokens.toLocaleString()}`);
      console.log(`  Total Output Tokens: ${usage.totalOutputTokens.toLocaleString()}`);
      console.log(`  Last Active       : ${usage.lastUsed || "Never"}\n`);

      const modelKeys = Object.keys(usage.byModel);
      if (modelKeys.length > 0) {
        console.log(`  Usage Breakdown by Model:`);
        console.log(`  ┌─────────────────────────────────┬──────────┬──────────────┬──────────────┐`);
        console.log(`  │ Model                           │ Requests │ Input Tokens │ Output Tokens│`);
        console.log(`  ├─────────────────────────────────┼──────────┼──────────────┼──────────────┤`);
        for (const [model, stats] of Object.entries(usage.byModel)) {
          const modelPadded = model.padEnd(31);
          const reqPadded = String(stats.requests).padStart(8);
          const inPadded = String(stats.inputTokens).padStart(12);
          const outPadded = String(stats.outputTokens).padStart(13);
          console.log(`  │ ${modelPadded} │ ${reqPadded} │ ${inPadded} │ ${outPadded}│`);
        }
        console.log(`  └─────────────────────────────────┴──────────┴──────────────┴──────────────┘\n`);
      } else {
        console.log(`  (No model requests recorded yet. Start prompting in ZCode to record usage.)\n`);
      }
      break;
    }

    case "login": {
      try {
        console.log("\nInitiating Google OAuth login flow...");
        console.log("You can log in with your primary Google account or switch to a new account.\n");
        const acc = await oauth.loginInteractive();
        console.log(`\n✓ Login successful!`);
        console.log(`  Name      : ${acc.name || "-"}`);
        console.log(`  Email     : ${acc.email || "Google Account"}`);
        console.log(`  Project ID: ${acc.projectId}`);
        const syncResult = syncZCodeConfig();
        if (syncResult.success) {
          console.log(`✓ Synchronized models with ZCode at: ${syncResult.configPath}`);
        }
      } catch (err: any) {
        console.error(`✗ Login failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "accounts":
    case "list-accounts": {
      const { accounts, activeIndex } = oauth.listAccounts();
      if (accounts.length === 0) {
        console.log("No saved accounts found. Run `npm run bridge:login` to connect an account.");
        break;
      }

      console.log("\n📋 Saved Google Accounts:");
      accounts.forEach((acc, idx) => {
        const isActive = idx === activeIndex;
        const prefix = isActive ? "▶ [ACTIVE]" : "  [      ]";
        console.log(`  ${prefix} #${idx}: ${acc.email || "Google User"} ${acc.name ? `(${acc.name})` : ""}`);
      });
      console.log(`\n💡 To switch active account, run: npm run bridge:switch <index_or_email>`);
      break;
    }

    case "switch": {
      const target = args[1];
      if (!target) {
        console.error("Usage: npm run bridge:switch <index_or_email>");
        const { accounts, activeIndex } = oauth.listAccounts();
        console.log("\nAvailable accounts:");
        accounts.forEach((a, idx) => console.log(`  [${idx}] ${a.email} ${idx === activeIndex ? "(ACTIVE)" : ""}`));
        process.exit(1);
      }

      try {
        const switched = oauth.switchAccount(target);
        console.log(`\n✓ Successfully switched active account to: ${switched.email || "Google Account"}`);

        // Reload the daemon so it picks up the new active account. Report what
        // actually happened: silently assuming success here is how a failed
        // reload used to look identical to a working one.
        const result = LaunchAgentService.install(LaunchAgentService.resolveProjectDir(__dirname));
        if (result.success) {
          console.log(`✓ Background service reloaded and active.`);
        } else {
          console.warn(`! Account switched, but the background service was NOT reloaded: ${result.message}`);
          console.warn(`  Restart it yourself so the new account takes effect.`);
        }
      } catch (err: any) {
        console.error(`✗ Failed to switch account: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "models": {
      try {
        console.log("\nComparing the model table against what Google serves...\n");
        const drift = await checkModelDrift();

        console.log(`Exposed by this bridge : ${SUPPORTED_MODELS.length}`);
        console.log(`Offered by Google      : ${drift.totalUpstream}`);
        console.log(`Google's default agent : ${drift.defaultAgentModelId || "-"}\n`);

        if (drift.missing.length) {
          console.log("✗ BROKEN — exposed here but no longer served. Requests to these fail:");
          drift.missing.forEach((m) => console.log(`    ${m.id}  (${m.name})`));
          console.log("");
        }
        if (drift.changed.length) {
          console.log("! Metadata drifted from Google's:");
          drift.changed.forEach((c) => console.log(`    ${c.id}  ${c.field}: ours=${c.ours} theirs=${c.theirs}`));
          console.log("");
        }
        if (drift.unexposed.length) {
          console.log("+ Thinking-capable models Google offers that this bridge does not expose:");
          drift.unexposed.forEach((m) =>
            console.log(`    ${m.id.padEnd(30)} budget=${String(m.thinkingBudget).padEnd(7)} ${m.displayName}`)
          );
          console.log("");
        }
        if (!drift.missing.length && !drift.changed.length && !drift.unexposed.length) {
          console.log("✓ The model table matches Google exactly.\n");
        } else {
          console.log("Edit SUPPORTED_MODELS in src/constants.ts to reconcile.\n");
        }
      } catch (err: any) {
        console.error(`✗ Could not check models: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "sync":
    case "sync-zcode": {
      const result = syncZCodeConfig();
      if (result.success) {
        console.log(`✓ Successfully updated ZCode config: ${result.configPath}`);
        console.log(`\nRegistered models:`);
        SUPPORTED_MODELS.forEach((m) => console.log(`  - ${m.name} (${m.id})`));
      } else {
        console.error(`✗ Failed to update ZCode config: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case "service:install": {
      const result = LaunchAgentService.install(LaunchAgentService.resolveProjectDir(__dirname));
      if (result.success) {
        console.log(`✓ ${result.message}`);
      } else {
        console.error(`✗ Failed to install service: ${result.message}`);
        process.exit(1);
      }
      break;
    }

    case "service:uninstall": {
      const result = LaunchAgentService.uninstall();
      console.log(`✓ ${result.message}`);
      break;
    }

    case "status":
    case "info":
    case "account": {
      let acc = oauth.loadSavedAccount();
      if (acc && acc.refreshToken) {
        try {
          await oauth.getValidAccessToken();
          acc = oauth.loadSavedAccount();
        } catch {}

        const usage = UsageTracker.getInstance().getUsage();

        console.log(`✓ Account Status  : Connected`);
        if (acc?.name) console.log(`  Name            : ${acc.name}`);
        console.log(`  Email           : ${acc?.email || "Google Account"}`);
        console.log(`  Google Project  : ${acc?.projectId || "rising-fact-p41fc"}`);
        console.log(`  Total Requests  : ${usage.totalRequests.toLocaleString()}`);
        console.log(`  Total Tokens    : ${(usage.totalInputTokens + usage.totalOutputTokens).toLocaleString()}`);
        console.log(`\n💡 To switch Google account, run: npm run bridge:login`);
        console.log(`💡 To see full usage details, run:  npm run bridge:usage\n`);
      } else {
        console.log(`! No account currently connected. Run \`npm run bridge:login\` to authenticate.`);
      }
      break;
    }

    case "start":
    default: {
      const port = Number(process.env.PORT) || BRIDGE_DEFAULT_PORT;
      const server = new BridgeServer(port);

      // Auto-sync ZCode configuration
      const syncResult = syncZCodeConfig();
      if (syncResult.success) {
        console.log(`✓ ZCode config synchronized at: ${syncResult.configPath}`);
      }

      // Check account
      const acc = oauth.loadSavedAccount();
      if (acc) {
        console.log(`✓ Connected account: ${acc.email || "Google Account"}`);
      } else {
        console.log(`! Warning: No saved Google account found.`);
        console.log(`  Run \`npm run bridge:login\` in another terminal to authenticate.`);
      }

      try {
        await server.start();
        console.log(`\n🚀 Server is running on: http://127.0.0.1:${port}`);
        console.log(`   - Anthropic endpoint: http://127.0.0.1:${port}/v1/messages`);
        console.log(`   - OpenAI endpoint:    http://127.0.0.1:${port}/v1/chat/completions`);
        console.log(`   - Health check:       http://127.0.0.1:${port}/health`);
        console.log(`\nReady to accept requests from ZCode. Press Ctrl+C to stop.`);
      } catch (err: any) {
        console.error(`✗ Failed to start server: ${err.message}`);
        process.exit(1);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
