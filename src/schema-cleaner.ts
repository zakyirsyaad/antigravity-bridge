/**
 * Schema Cleaner for Antigravity API compatibility.
 * Strips JSONSchema keywords ($schema, propertyNames, additionalProperties, title, pattern, etc.)
 * and converts them into description hints to satisfy Google Antigravity protobuf parser.
 */

const UNSUPPORTED_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "pattern",
  "minItems",
  "maxItems",
  "format",
  "default",
  "examples",
];

const UNSUPPORTED_KEYWORDS = [
  ...UNSUPPORTED_CONSTRAINTS,
  "$schema",
  "$defs",
  "definitions",
  "const",
  "$ref",
  "additionalProperties",
  "propertyNames",
  "title",
  "$id",
  "$comment",
];

function appendDescriptionHint(schema: any, hint: string): any {
  if (!schema || typeof schema !== "object") return schema;
  const existing = typeof schema.description === "string" ? schema.description : "";
  const newDescription = existing ? `${existing} (${hint})` : hint;
  return { ...schema, description: newDescription };
}

function convertRefsToHints(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(convertRefsToHints);

  if (typeof schema.$ref === "string") {
    const refVal = schema.$ref;
    const defName = refVal.includes("/") ? refVal.split("/").pop() : refVal;
    const hint = `See: ${defName}`;
    const existingDesc = typeof schema.description === "string" ? schema.description : "";
    const newDescription = existingDesc ? `${existingDesc} (${hint})` : hint;
    return { type: "object", description: newDescription };
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = convertRefsToHints(value);
  }
  return result;
}

function convertConstToEnum(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(convertConstToEnum);

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "const" && !schema.enum) {
      result.enum = [value];
    } else {
      result[key] = convertConstToEnum(value);
    }
  }
  return result;
}

function moveConstraintsToDescription(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(moveConstraintsToDescription);

  let result = { ...schema };
  for (const constraint of UNSUPPORTED_CONSTRAINTS) {
    if (result[constraint] !== undefined && typeof result[constraint] !== "object") {
      result = appendDescriptionHint(result, `${constraint}: ${result[constraint]}`);
    }
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = moveConstraintsToDescription(value);
    }
  }
  return result;
}

function mergeAllOf(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(mergeAllOf);

  let result = { ...schema };
  if (Array.isArray(result.allOf)) {
    const merged: any = {};
    const mergedRequired: string[] = [];
    for (const item of result.allOf) {
      if (!item || typeof item !== "object") continue;
      if (item.properties && typeof item.properties === "object") {
        merged.properties = { ...merged.properties, ...item.properties };
      }
      if (Array.isArray(item.required)) {
        for (const req of item.required) {
          if (!mergedRequired.includes(req)) {
            mergedRequired.push(req);
          }
        }
      }
      for (const [key, value] of Object.entries(item)) {
        if (key !== "properties" && key !== "required" && merged[key] === undefined) {
          merged[key] = value;
        }
      }
    }
    if (merged.properties) {
      result.properties = { ...result.properties, ...merged.properties };
    }
    if (mergedRequired.length > 0) {
      const existingRequired = Array.isArray(result.required) ? result.required : [];
      result.required = Array.from(new Set([...existingRequired, ...mergedRequired]));
    }
    delete result.allOf;
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = mergeAllOf(value);
    }
  }
  return result;
}

function flattenAnyOfOneOf(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(flattenAnyOfOneOf);

  let result = { ...schema };
  for (const unionKey of ["anyOf", "oneOf"]) {
    if (Array.isArray(result[unionKey]) && result[unionKey].length > 0) {
      const options = result[unionKey];
      // Check if enum pattern
      const enumValues: string[] = [];
      let isEnumPattern = true;
      for (const opt of options) {
        if (opt && typeof opt === "object") {
          if (opt.const !== undefined) {
            enumValues.push(String(opt.const));
          } else if (Array.isArray(opt.enum)) {
            enumValues.push(...opt.enum.map(String));
          } else {
            isEnumPattern = false;
            break;
          }
        } else {
          isEnumPattern = false;
          break;
        }
      }

      if (isEnumPattern && enumValues.length > 0) {
        const { [unionKey]: _, ...rest } = result;
        result = { ...rest, type: "string", enum: enumValues };
        continue;
      }

      // Pick first valid option
      const selected = flattenAnyOfOneOf(options[0]) || { type: "string" };
      const { [unionKey]: _, ...rest } = result;
      result = { ...rest, ...selected };
    }
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = flattenAnyOfOneOf(value);
    }
  }
  return result;
}

function flattenTypeArrays(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(flattenTypeArrays);

  let result = { ...schema };
  if (Array.isArray(result.type)) {
    const types = result.type;
    const nonNullTypes = types.filter((t: string) => t !== "null" && t);
    result.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
    if (types.includes("null")) {
      result.nullable = true;
    }
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = flattenTypeArrays(value);
    }
  }
  return result;
}

function removeUnsupportedKeywords(schema: any, insideProperties = false): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => removeUnsupportedKeywords(item, false));
  }

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!insideProperties && UNSUPPORTED_KEYWORDS.includes(key)) {
      continue;
    }
    if (typeof value === "object" && value !== null) {
      if (key === "properties") {
        const propertiesResult: any = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          propertiesResult[propName] = removeUnsupportedKeywords(propSchema, false);
        }
        result[key] = propertiesResult;
      } else {
        result[key] = removeUnsupportedKeywords(value, false);
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function cleanupRequiredFields(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanupRequiredFields);

  let result = { ...schema };
  if (Array.isArray(result.required) && result.properties && typeof result.properties === "object") {
    const validRequired = result.required.filter((req: string) =>
      Object.prototype.hasOwnProperty.call(result.properties, req)
    );
    if (validRequired.length === 0) {
      delete result.required;
    } else {
      result.required = validRequired;
    }
  }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "object" && value !== null) {
      result[key] = cleanupRequiredFields(value);
    }
  }
  return result;
}

function fixSchemaTypesAndItems(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map(fixSchemaTypesAndItems);
  }

  let result = { ...schema };

  // If items is an array (tuple validation), take the first element
  if (Array.isArray(result.items)) {
    result.items = result.items.length > 0 ? result.items[0] : { type: "string" };
  }

  // If items exists, ensure type is array
  if (result.items !== undefined) {
    result.type = "array";
  }

  // If type is array, ensure items is an object with valid type
  if (result.type === "array") {
    if (!result.items || typeof result.items !== "object" || Array.isArray(result.items)) {
      result.items = { type: "string" };
    }
  }

  // If properties exist, ensure type is object unless it's already an array
  if (result.properties && typeof result.properties === "object") {
    if (result.type !== "array") {
      result.type = "object";
    }
  }

  // Ensure default type if missing
  if (!result.type) {
    if (result.properties) {
      result.type = "object";
    } else if (result.items) {
      result.type = "array";
    } else if (result.enum) {
      result.type = "string";
    } else {
      result.type = "string";
    }
  }

  // Recursively process properties
  if (result.properties && typeof result.properties === "object") {
    const cleanProps: any = {};
    for (const [k, v] of Object.entries(result.properties)) {
      cleanProps[k] = fixSchemaTypesAndItems(v);
    }
    result.properties = cleanProps;
  }

  // Recursively process items
  if (result.items && typeof result.items === "object") {
    result.items = fixSchemaTypesAndItems(result.items);
    if (!result.items.type) {
      result.items.type = result.items.properties ? "object" : "string";
    }
  }

  return result;
}

const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
]);

function strictSanitizeSchemaKeys(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(strictSanitizeSchemaKeys);

  const result: any = {};
  const extraProperties: any = {};

  for (const [key, value] of Object.entries(schema)) {
    if (ALLOWED_SCHEMA_KEYS.has(key)) {
      if (key === "properties" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        const cleanProps: any = {};
        for (const [pk, pv] of Object.entries(value)) {
          cleanProps[pk] = strictSanitizeSchemaKeys(pv);
        }
        result.properties = cleanProps;
      } else if (key === "items" && typeof value === "object" && value !== null) {
        result.items = strictSanitizeSchemaKeys(value);
      } else {
        result[key] = value;
      }
    } else {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        extraProperties[key] = strictSanitizeSchemaKeys(value);
      }
    }
  }

  if (Object.keys(extraProperties).length > 0) {
    result.properties = { ...(result.properties || {}), ...extraProperties };
    if (!result.type || result.type !== "array") {
      result.type = "object";
    }
  }

  return result;
}

function sanitizeToolName(name: string): string {
  // Function names must only contain alphanumeric characters and underscores
  return String(name || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function cleanJSONSchemaForAntigravity(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  let result = schema;
  result = convertRefsToHints(result);
  result = convertConstToEnum(result);
  result = moveConstraintsToDescription(result);
  result = mergeAllOf(result);
  result = flattenAnyOfOneOf(result);
  result = flattenTypeArrays(result);
  result = removeUnsupportedKeywords(result);
  result = cleanupRequiredFields(result);
  result = strictSanitizeSchemaKeys(result);
  result = fixSchemaTypesAndItems(result);

  if (!result.type) {
    result.type = "object";
  }
  if (result.type === "object" && !result.properties) {
    result.properties = {};
  }

  return result;
}

export function cleanToolDeclarations(tools: any[]): any[] {
  if (!Array.isArray(tools)) return [];

  const functionDeclarations: any[] = [];
  for (const tool of tools) {
    if (!tool) continue;

    // Anthropic tool format
    if (tool.name && (tool.input_schema || !tool.type)) {
      const name = sanitizeToolName(tool.name);
      const description = tool.description || "";
      const parameters = cleanJSONSchemaForAntigravity(tool.input_schema || tool.parameters || {});
      functionDeclarations.push({ name, description, parameters });
      continue;
    }

    // OpenAI tool format
    if (tool.type === "function" && tool.function) {
      const name = sanitizeToolName(tool.function.name);
      const description = tool.function.description || "";
      const parameters = cleanJSONSchemaForAntigravity(tool.function.parameters || {});
      functionDeclarations.push({ name, description, parameters });
      continue;
    }

    // Direct functionDeclaration format
    if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
      for (const fd of tool.functionDeclarations) {
        functionDeclarations.push({
          name: sanitizeToolName(fd.name),
          description: fd.description || "",
          parameters: cleanJSONSchemaForAntigravity(fd.parameters || {}),
        });
      }
    }
  }

  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
}
