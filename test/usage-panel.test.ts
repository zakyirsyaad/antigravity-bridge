/**
 * Offline suite for the dashboard's "Usage by Model" panel.
 *
 * Verifies:
 * 1. /api/usage reports the bridge's counters per model, labelled with the backend that
 *    served each one (Gemini Web rows marked estimated), sorted by requests, and nothing else.
 * 2. /api/usage is a management route: a foreign page cannot read it.
 * 3. The panel's markup: model ids escaped, CloudCode vs Gemini Web estimate chips, a "~" on
 *    estimated token counts, shares of tokens, the footnote only when a Gemini Web row exists,
 *    and an empty state.
 *
 * No account, no network: UsageTracker is stubbed and the page's functions run in Node.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { BridgeServer } from "../src/server";
import { UsageTracker } from "../src/usage-tracker";
import { pageFunctions, pageFunctionSource } from "./dashboard-functions";

const TEST_PORT = 52153;
let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function get(pathUrl: string, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${TEST_PORT}${pathUrl}`, { headers }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data: any = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode || 0, data });
        });
      })
      .on("error", reject);
  });
}


const NOW = Date.parse("2026-11-06T12:00:00Z");
const report = {
  totalRequests: 15,
  totalInputTokens: 61000,
  totalOutputTokens: 3500,
  totalThoughtsTokens: 1500,
  firstUsed: "2026-10-01T00:00:00.000Z",
  lastUsed: "2026-11-06T11:58:00.000Z",
  byModel: {
    "gemini-argon-4": { requests: 3, inputTokens: 9000, outputTokens: 600, thoughtsTokens: 0, lastUsed: "2026-11-06T11:58:00.000Z" },
    "gemini-3.8-flash-tiered": { requests: 10, inputTokens: 50000, outputTokens: 2500, thoughtsTokens: 1500, lastUsed: "2026-11-06T09:00:00.000Z" },
    "gemini-web-fallback": { requests: 1, inputTokens: 1000, outputTokens: 200, thoughtsTokens: 0, lastUsed: "2026-11-05T12:00:00.000Z" },
    '<img src=x onerror="alert(1)">': { requests: 1, inputTokens: 1000, outputTokens: 200, thoughtsTokens: 0, lastUsed: "2026-11-06T11:00:00.000Z" },
  },
};

async function runTests() {
  console.log("=================================================");
  console.log(" Usage by Model Panel Offline Suite");
  console.log("=================================================\n");

  (UsageTracker.getInstance() as any).getUsage = () => report;
  const server = new BridgeServer(TEST_PORT);
  await server.start();
  let api: any;
  try {
    console.log("[1/3] /api/usage reports the counters per model ...");
    const res = await get("/api/usage");
    api = res.data;
    expect("answers 200 from loopback", res.status, 200);
    const models: any[] = res.data.models || [];
    expect("one row per recorded model", models.length, 4);
    expect("sorted by requests, most first", models[0]?.id, "gemini-3.8-flash-tiered");
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect("a CloudCode model is cloudcode", byId["gemini-3.8-flash-tiered"]?.backend, "cloudcode");
    expect("Argon is gemini-web (the page marks those rows as estimates)", byId["gemini-argon-4"]?.backend, "gemini-web");
    expect("the pool fallback's own id is gemini-web too", byId["gemini-web-fallback"]?.backend, "gemini-web");
    expect("totals are passed through", res.data.totalRequests, 15);
    expect("reasoning is its own figure", byId["gemini-3.8-flash-tiered"]?.thoughtsTokens, 1500);
    const allowed = ["id", "backend", "requests", "inputTokens", "outputTokens", "thoughtsTokens", "lastUsed"];
    expect("a row carries nothing but counts and the id", models.every((m) => Object.keys(m).every((k) => allowed.includes(k))), true);

    console.log("\n[2/3] /api/usage is a management route ...");
    const foreign = await get("/api/usage", { Origin: "https://evil.example" });
    expect("a foreign page cannot read it", foreign.status === 200, false);
  } finally {
    await server.stop();
  }

  console.log("\n[3/3] The panel's markup ...");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
  const ledgerFunctions = [
    "escapeHtml", "formatCount", "formatAgo", "usageCellHtml", "usageHeadHtml", "usageModelRowHtml", "usageTotalRowHtml", "usageByModelHtml",
  ];
  const page = pageFunctions(html, ledgerFunctions);
  const markup: string = page.usageByModelHtml(api, NOW);
  expect("a client-chosen model id is escaped", markup.includes("<img"), false);
  expect("and shown as text", markup.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), true);
  expect("CloudCode rows say so", markup.includes(">CloudCode</span>"), true);
  expect("Gemini Web rows are marked as estimates", (markup.match(/Gemini Web · estimate/g) || []).length, 2);
  expect("an estimated count carries a ~", markup.includes(">~9.0K</div>"), true);
  expect("a counted figure carries none", markup.includes(">50K</div>"), true);
  // 54,000 of 66,000 tokens; Argon's 9,600 of them.
  expect("shares are of all tokens", markup.includes(">81.8%</span>"), true);
  expect("an estimated row has its share too", markup.includes(">14.5%</span>"), true);
  expect("last use is relative", markup.includes(">2m ago</div>"), true);
  expect("a totals row closes the table", markup.includes("All models"), true);
  expect("the footnote explains estimates and the separate limit", /Gemini Web rows are estimates[\s\S]*separate from the CloudCode quota/.test(markup), true);

  expect("the column says the id is the requested one", markup.includes(">Requested model</div>"), true);
  expect("the CloudCode chip does not claim every count is Google's", markup.includes("the bridge estimated its output"), true);
  const cloudOnly = page.usageByModelHtml({ ...api, models: api.models.filter((m: any) => m.backend !== "gemini-web") }, NOW);
  expect("no footnote without a Gemini Web row", cloudOnly.includes("usage-footnote"), false);
  expect("an empty report shows the empty state", page.usageByModelHtml({ models: [] }, NOW).includes("No requests recorded yet"), true);
  expect("a missing report too", page.usageByModelHtml(null, NOW).includes("No requests recorded yet"), true);
  expect("large counts are compact", page.formatCount(98765432), "99M");
  expect("small ones are exact", page.formatCount(742), "742");
  expect("just under 10K rounds to 10K, not 10.0K", page.formatCount(9999), "10K");
  expect("just under a million reads 1.0M, not 1000K", page.formatCount(999950), "1.0M");
  expect("just under a billion reads 1.0B", page.formatCount(999999999), "1.0B");

  // The note: no "since today" when nothing has been counted (the tracker reports now then).
  const els: Record<string, any> = { usageContainer: { innerHTML: "" }, usageNote: { textContent: "x" } };
  (globalThis as any).document = { getElementById: (id: string) => els[id] };
  try {
    const withRender = pageFunctions(html, [...ledgerFunctions, "renderUsage"]);
    withRender.renderUsage({ firstUsed: new Date().toISOString(), models: [] });
    expect("no 'counted since' note without counts", els.usageNote.textContent, "");
    withRender.renderUsage(api);
    expect("a note once something is counted", els.usageNote.textContent.startsWith("Counted by this bridge since"), true);
  } finally {
    delete (globalThis as any).document;
  }
  // The pool poll asks for a missing key; the usage poll must not, or a dismissed prompt returns every 15 s.
  expect("the usage poll never prompts for a key", pageFunctionSource(html, "fetchUsage").includes("apiFetch("), false);
  expect("a failed load says so instead of loading forever", pageFunctionSource(html, "showUsageProblem").includes("Usage could not be loaded"), true);
  expect("no time is a dash", page.formatAgo(null, NOW), "—");

  console.log("\n=================================================");
  if (failures > 0) {
    console.error(`FAILED: ${failures} assertions failed`);
    process.exit(1);
  }
  console.log("SUCCESS: All usage panel assertions passed!");
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
