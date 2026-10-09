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
 * A second family: Google's function-declaration `enum` is a list of STRINGS and
 * the request is refused outright if any element is not one:
 *
 *   Invalid value at '...parameters.properties[2].value.enum[0]' (TYPE_STRING), 10143
 *
 * `{"const": 10143, "type": "number"}` — how an MCP server declares a chain id —
 * was turned into `enum: [10143]` with the number intact, so one plugin with
 * three such tools made every request carrying them fail, for every client. The
 * `anyOf`-of-consts shape dodged the refusal by calling String() on the values
 * and retyping the parameter as a string, so the model sent "10143" where the
 * server wanted 10143. Both now keep the declared type and say the allowed
 * values in the description instead; a genuine string enum is untouched.
 *
 * Pure transformation — no server, no disk, no network, no quota.
 */
import { cleanJSONSchemaForAntigravity, cleanToolDeclarations } from "../src/schema-cleaner";
import { Transformer } from "../src/transformer";

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  if (actual === wanted) {
    console.log(`✓ ${label} -> ${String(actual)}`);
  } else {
    failures++;
    console.error(`✗ ${label} -> expected ${String(wanted)}, got ${String(actual)}`);
  }
}

/** Every `enum` array anywhere inside a value, with where it was found. */
function findEnums(node: any, path = "$"): Array<{ path: string; values: unknown[] }> {
  const found: Array<{ path: string; values: unknown[] }> = [];
  if (Array.isArray(node)) {
    node.forEach((item, i) => found.push(...findEnums(item, `${path}[${i}]`)));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) found.push({ path, values: value });
      else found.push(...findEnums(value, `${path}.${key}`));
    }
  }
  return found;
}

/** The enums Google would refuse: anything whose elements are not all strings. */
const nonStringEnums = (node: unknown) =>
  findEnums(node).filter((e) => !e.values.every((v) => typeof v === "string"));

// The nine tools of the monagent MCP plugin, trimmed to the properties that
// matter. These three chainId shapes are what a real client sent.
const SCHEMA_URL = "http://json-schema.org/draft-07/schema#";
const chainAny = (extra: Record<string, unknown> = {}) => ({
  anyOf: [{ const: 143, type: "number" }, { const: 10143, type: "number" }],
  description: "Monad chain ID: 143 (Mainnet) or 10143 (Testnet)",
  ...extra,
});
const chainTestnet = { const: 10143, type: "number", description: "Chain ID must be 10143 (Monad Testnet)" };
const idString = { type: "string", pattern: "^\\d+$", description: "numeric id" };
const mcpTool = (name: string, properties: Record<string, unknown>, required: string[]) => ({
  name: `mcp__plugin_monagent_monagent__${name}`,
  description: name,
  input_schema: { $schema: SCHEMA_URL, type: "object", properties, required },
});
const MONAGENT_TOOLS = [
  mcpTool("monad_identity_get", { agentId: idString, chainId: chainAny({ default: 10143 }) }, ["agentId"]),
  mcpTool("monad_identity_register", { name: { type: "string" }, chainId: chainAny() }, ["name", "chainId"]),
  mcpTool("monad_jobs_complete", { jobId: idString, resultURI: { type: "string" }, chainId: chainTestnet }, ["jobId", "chainId"]),
  mcpTool("monad_jobs_create", { workerAddress: { type: "string" }, deadlineHours: { type: "integer", minimum: 1, maximum: 168 }, chainId: chainTestnet }, ["workerAddress", "chainId"]),
  mcpTool("monad_jobs_refund", { jobId: idString, chainId: chainTestnet }, ["jobId", "chainId"]),
  mcpTool("monad_pay", { to: { type: "string" }, amount: { type: "string" }, chainId: chainAny() }, ["to", "amount", "chainId"]),
  mcpTool("monad_reputation_check", { agentId: idString, chainId: chainAny({ default: 10143 }) }, ["agentId"]),
  mcpTool("monad_reputation_give", { agentId: idString, value: { type: "integer", minimum: -100, maximum: 100 }, chainId: chainAny() }, ["agentId", "value", "chainId"]),
  mcpTool("monad_x402_pay", { url: { type: "string", format: "uri" }, method: { type: "string", enum: ["GET", "POST"], default: "GET" }, chainId: chainAny() }, ["url", "chainId"]),
];
const asOpenAITools = (tools: typeof MONAGENT_TOOLS) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

function runTests() {
  console.log("=================================================");
  console.log(" Tool schema sanitisation regression");
  console.log("=================================================\n");

  console.log("[1/10] Schema keywords must not become tool parameters ...");
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

  console.log("\n[2/10] A property genuinely named after a keyword is preserved ...");
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

  console.log("\n[3/10] Shorthand property hoisting still works ...");
  const shorthand = cleanJSONSchemaForAntigravity({ type: "object", location: { type: "string" } });
  expect("hoisted into properties", "location" in (shorthand.properties || {}), true);
  expect("hoisted value keeps its type", shorthand.properties?.location?.type, "string");

  console.log("\n[4/10] A plain schema is passed through intact ...");
  const plain = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { location: { type: "string", description: "City name" }, unit: { type: "string", enum: ["c", "f"] } },
    required: ["location"],
  });
  expect("parameter count", Object.keys(plain.properties || {}).length, 2);
  expect("required preserved", (plain.required || []).join(","), "location");
  expect("enum preserved", (plain.properties?.unit?.enum || []).join(","), "c,f");

  console.log("\n[5/10] End to end through cleanToolDeclarations ...");
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

  console.log("\n[6/10] A numeric const keeps its type, and says its value instead of an enum ...");
  const constNumber = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { chainId: { const: 10143, type: "number", description: "Chain ID must be 10143 (Monad Testnet)" } },
    required: ["chainId"],
  });
  const constChain = constNumber.properties?.chainId;
  expect("no enum Google would refuse", nonStringEnums(constNumber).length, 0);
  expect("type stays number", constChain?.type, "number");
  expect("original description kept", String(constChain?.description).includes("Monad Testnet"), true);
  expect("the value is stated in it", String(constChain?.description).includes("must equal 10143"), true);
  expect("still required", (constNumber.required || []).join(","), "chainId");

  console.log("\n[7/10] An anyOf of numeric consts is not retyped as a string ...");
  const union = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { chainId: chainAny({ default: 10143 }) },
  });
  const unionChain = union.properties?.chainId;
  expect("no enum Google would refuse", nonStringEnums(union).length, 0);
  expect("type stays number, not string", unionChain?.type, "number");
  expect("both values are stated", String(unionChain?.description).includes("one of: 143, 10143"), true);
  expect("no union left behind", "anyOf" in (unionChain || {}), false);

  console.log("\n[8/10] Every other non-string enum is handled the same way ...");
  const misc = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: {
      level: { type: "integer", enum: [1, 2, 3] },
      flag: { const: true },
      mixed: { enum: [1, "a"] },
      ratio: { enum: [0.5, 1.5] },
    },
  });
  expect("no enum Google would refuse", nonStringEnums(misc).length, 0);
  expect("declared integer is kept", misc.properties?.level?.type, "integer");
  expect("its values are stated", String(misc.properties?.level?.description).includes("one of: 1, 2, 3"), true);
  expect("untyped boolean const is typed boolean", misc.properties?.flag?.type, "boolean");
  expect("untyped integers are typed integer", cleanJSONSchemaForAntigravity({ type: "object", properties: { n: { enum: [4, 5] } } }).properties?.n?.type, "integer");
  expect("untyped fractions are typed number", misc.properties?.ratio?.type, "number");

  console.log("\n[9/10] A genuine string enum is untouched ...");
  const strings = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: {
      city: { const: "Tokyo" },
      mode: { anyOf: [{ const: "fast" }, { const: "slow" }] },
      unit: { type: "string", enum: ["c", "f"] },
    },
  });
  expect("string const becomes a string enum", (strings.properties?.city?.enum || []).join(","), "Tokyo");
  expect("string const is typed string", strings.properties?.city?.type, "string");
  expect("string anyOf becomes one enum", (strings.properties?.mode?.enum || []).join(","), "fast,slow");
  expect("string anyOf is typed string", strings.properties?.mode?.type, "string");
  expect("declared string enum survives", (strings.properties?.unit?.enum || []).join(","), "c,f");
  expect("no hint is added to a string enum", "description" in (strings.properties?.unit || {}), false);

  console.log("\n[10/10] The real nine-tool set clears every entry point ...");
  const cleaned = cleanToolDeclarations(MONAGENT_TOOLS);
  const declared = cleaned[0]?.functionDeclarations || [];
  expect("all nine declarations survive", declared.length, 9);
  expect("no enum Google would refuse", nonStringEnums(cleaned).length, 0);
  expect(
    "chainId is a number in every tool",
    declared.filter((d: any) => d.parameters?.properties?.chainId?.type === "number").length,
    9
  );
  const x402 = declared.find((d: any) => String(d.name).endsWith("monad_x402_pay"));
  expect("a real string enum still survives", (x402?.parameters?.properties?.method?.enum || []).join(","), "GET,POST");

  const request = { model: "gemini-3.8-flash-tiered", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] };
  const viaAnthropic: any = Transformer.anthropicToAntigravity({ ...request, tools: MONAGENT_TOOLS });
  expect("Anthropic path: nothing Google would refuse", nonStringEnums(viaAnthropic.request.tools).length, 0);
  const viaOpenAI: any = Transformer.openaiToAntigravity({ ...request, tools: asOpenAITools(MONAGENT_TOOLS) });
  expect("OpenAI path (FCC): nothing Google would refuse", nonStringEnums(viaOpenAI.request.tools).length, 0);

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
