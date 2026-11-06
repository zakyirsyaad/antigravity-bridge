/**
 * Reading the dashboard's inline script from the offline suites, shared by the ones that
 * test the page (pool-status, usage-panel) so a fix here reaches both.
 */

/** The source of one named top-level `function` in the page. */
export function pageFunctionSource(html: string, name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`dashboard.html has no function ${name}()`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`could not read function ${name}()`);
}

/**
 * Lift named top-level `function` declarations out of the dashboard's inline script and
 * evaluate them together, so their behaviour can be checked without a browser.
 */
export function pageFunctions(html: string, names: string[]): Record<string, (...args: any[]) => any> {
  const sources = names.map((name) => pageFunctionSource(html, name));
  return new Function(`${sources.join("\n")}\nreturn { ${names.join(", ")} };`)();
}
