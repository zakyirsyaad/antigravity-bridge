import fs from "node:fs";
import path from "node:path";

export function getDashboardHtml(): string {
  const htmlPath = path.join(__dirname, "dashboard.html");
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, "utf-8");
  }
  return "<h1>Antigravity Bridge Dashboard</h1><p>dashboard.html not found</p>";
}
