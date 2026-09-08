/**
 * Regression guard for tool-schema sanitisation.
 *
 * strictSanitizeSchemaKeys() hoists any unrecognized object-valued key into
 * `properties`, on the assumption it is a property written in shorthand. That
 * leniency used to apply to JSON Schema keywords too, so a schema carrying
 * `if` / `then` / `not` / `patternProperties` — all common in
 * zod-to-json-schema output, and none of them stripped earlier in the pipeline
 * — advertised parameters literally named `if` and `not` to the model. The
 * model would sometimes emit them, producing tool calls the client cannot
 * dispatch.
 *
 * The distinction that has to hold: a keyword at schema level is dropped, but a
 * property genuinely *named* `if` inside `properties` is preserved.
 *
 * Pure transformation — no server, no disk, no network, no quota.
 */
import { cleanJSONSchemaForAntigravity, cleanToolDeclarations } from "../src/schema-cleaner";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

function runTests() {
  console.log("=================================================");
  console.log(" Tool schema sanitisation regression");
  console.log("=================================================\n");

  console.log("[1/5] Schema keywords must not become tool parameters ...");
  const withKeywords = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    if: { properties: { city: { const: "Tokyo" } } },
    then: { required: ["zone"] },
    else: { required: ["other"] },
    not: { required: ["x"] },
    patternProperties: { "^a": { type: "string" } },
    dependentSchemas: { city: { required: ["country"] } },
  });
  const params = Object.keys(withKeywords.properties || {});
  expect("parameter count", params.length, 1);
  expect("only the real parameter survives", params.join(","), "city");
  for (const keyword of ["if", "then", "else", "not", "patternProperties", "dependentSchemas"]) {
    expect(`"${keyword}" absent from properties`, keyword in (withKeywords.properties || {}), false);
  }

  console.log("\n[2/5] A property genuinely named after a keyword is preserved ...");
  const namedIf = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: {
      if: { type: "string", description: "a real parameter" },
      not: { type: "string" },
    },
  });
  expect("'if' kept as a parameter", "if" in (namedIf.properties || {}), true);
  expect("'not' kept as a parameter", "not" in (namedIf.properties || {}), true);
  expect("'if' keeps its type", namedIf.properties?.if?.type, "string");

  console.log("\n[3/5] Shorthand property hoisting still works ...");
  const shorthand = cleanJSONSchemaForAntigravity({ type: "object", location: { type: "string" } });
  expect("hoisted into properties", "location" in (shorthand.properties || {}), true);
  expect("hoisted value keeps its type", shorthand.properties?.location?.type, "string");

  console.log("\n[4/5] A plain schema is passed through intact ...");
  const plain = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { location: { type: "string", description: "City name" }, unit: { type: "string", enum: ["c", "f"] } },
    required: ["location"],
  });
  expect("parameter count", Object.keys(plain.properties || {}).length, 2);
  expect("required preserved", (plain.required || []).join(","), "location");
  expect("enum preserved", (plain.properties?.unit?.enum || []).join(","), "c,f");

  console.log("\n[5/5] End to end through cleanToolDeclarations ...");
  const declarations = cleanToolDeclarations([
    {
      name: "get_weather",
      description: "Get weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        not: { required: ["nope"] },
      },
    },
  ]);
  const fn = declarations[0]?.functionDeclarations?.[0];
  expect("tool name", fn?.name, "get_weather");
  expect("parameter count", Object.keys(fn?.parameters?.properties || {}).length, 1);
  expect("'not' absent", "not" in (fn?.parameters?.properties || {}), false);

  if (failures > 0) {
    throw new Error(`${failures} schema sanitisation check(s) failed`);
  }

  console.log("\n=================================================");
  console.log(" 🎉 ALL SCHEMA CLEANER CHECKS PASSED!");
  console.log("=================================================\n");
}

try {
  runTests();
} catch (e: any) {
  console.error("Test failed with error:", e.message);
  process.exit(1);
}
