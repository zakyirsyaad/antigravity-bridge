/**
 * Zero-dependency JSON and Tool Call Auto-Repair Engine.
 *
 * Handles common LLM output malformations:
 * 1. Markdown code fences.
 * 2. Leading/trailing prose or text surrounding JSON objects/arrays.
 * 3. Trailing commas before closing brackets or braces.
 * 4. Single-line and multi-line comments.
 * 5. Unclosed strings, brackets, or braces caused by token truncation (MAX_TOKENS).
 * 6. Single-quoted strings and keys.
 */

/**
 * Strips markdown code block wrappers (e.g. ```json ... ```).
 */
export function stripMarkdownCodeFences(text: string): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();

  // Match ```json ... ``` or ``` ... ```
  const fenceRegex = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/;
  const match = trimmed.match(fenceRegex);
  if (match) {
    return match[1].trim();
  }

  // If text starts with ```json or ``` but closing fence is missing (truncated)
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1) {
      const rest = trimmed.slice(firstNewline + 1);
      return rest.replace(/```$/, "").trim();
    }
  }

  return trimmed;
}

/**
 * Removes single-line and multi-line comments outside of valid string literals.
 */
function stripComments(text: string): string {
  let inString = false;
  let stringChar = "";
  let isEscaped = false;
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      continue;
    }

    // Single-line comment
    if (ch === "/" && next === "/") {
      const nextNewline = text.indexOf("\n", i + 2);
      if (nextNewline === -1) {
        break; // Reached end of text
      }
      i = nextNewline - 1;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && next === "*") {
      const closeComment = text.indexOf("*/", i + 2);
      if (closeComment === -1) {
        break;
      }
      i = closeComment + 1;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Removes trailing commas right before closing `}` or `]`.
 */
function removeTrailingCommas(text: string): string {
  let inString = false;
  let isEscaped = false;
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      // Look ahead for the next non-whitespace character
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j++;
      }
      if (j < text.length && (text[j] === "}" || text[j] === "]")) {
        // Skip this trailing comma
        continue;
      }
    }

    out += ch;
  }

  return out;
}

/**
 * Converts single-quoted JSON keys and string values to standard double quotes.
 */
function normalizeSingleQuotes(text: string): string {
  // Replace 'string' with "string", safely handling escaped single quotes
  let inDouble = false;
  let inSingle = false;
  let isEscaped = false;
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inDouble) {
      out += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (inSingle) {
      if (isEscaped) {
        isEscaped = false;
        out += ch;
      } else if (ch === "\\") {
        isEscaped = true;
        out += ch;
      } else if (ch === "'") {
        inSingle = false;
        out += '"';
      } else if (ch === '"') {
        out += '\\"';
      } else {
        out += ch;
      }
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      out += ch;
    } else if (ch === "'") {
      inSingle = true;
      out += '"';
    } else {
      out += ch;
    }
  }

  return out;
}

/**
 * Completes unclosed brackets, braces, and quotes if text was truncated (e.g. MAX_TOKENS).
 */
function balanceUnclosedStructures(text: string): string {
  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  let repaired = text;
  // If terminated inside an open string, close it
  if (inString) {
    repaired += '"';
  }

  // Close any unclosed braces/brackets in reverse order
  while (stack.length > 0) {
    const closing = stack.pop()!;
    // Clean trailing comma right before closing if needed
    repaired = repaired.trimEnd();
    if (repaired.endsWith(",")) {
      repaired = repaired.slice(0, -1);
    }
    repaired += closing;
  }

  return repaired;
}

/**
 * Extracts the first well-formed JSON object `{...}` or array `[...]` from surrounding text.
 */
export function extractJsonSubstring(text: string): string | null {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");

  let startIdx = -1;
  let isObject = true;

  if (firstBrace !== -1 && firstBracket !== -1) {
    if (firstBrace < firstBracket) {
      startIdx = firstBrace;
      isObject = true;
    } else {
      startIdx = firstBracket;
      isObject = false;
    }
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    isObject = false;
  }

  if (startIdx === -1) return null;

  const targetEnd = isObject ? "}" : "]";
  const lastIdx = text.lastIndexOf(targetEnd);
  if (lastIdx !== -1 && lastIdx > startIdx) {
    return text.slice(startIdx, lastIdx + 1);
  }

  // If no closing character found, return from startIdx to end for balancing
  return text.slice(startIdx);
}

/**
 * Main JSON repair function. Takes raw LLM text and returns clean, valid JSON string if possible.
 */
export function repairJsonString(text: string): string {
  if (!text || typeof text !== "string") return "{}";

  // 1. Fast path: check if text is already valid JSON
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue with repair attempts
  }

  // 2. Strip markdown fences
  let candidate = stripMarkdownCodeFences(trimmed);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {}

  // 3. Strip surrounding comments
  candidate = stripComments(candidate);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {}

  // 4. Remove trailing commas
  candidate = removeTrailingCommas(candidate);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {}

  // 5. Normalize single quotes
  if (candidate.includes("'")) {
    const withDoubleQuotes = normalizeSingleQuotes(candidate);
    try {
      JSON.parse(withDoubleQuotes);
      return withDoubleQuotes;
    } catch {
      // Keep candidate if single quote normalization helped remove raw single quotes
      candidate = withDoubleQuotes;
    }
  }

  // 6. Balance unclosed structures (truncated JSON)
  const balanced = balanceUnclosedStructures(candidate);
  try {
    JSON.parse(balanced);
    return balanced;
  } catch {}

  // 7. Extract JSON substring if surrounded by conversational prose
  const extracted = extractJsonSubstring(candidate);
  if (extracted && extracted !== candidate) {
    try {
      JSON.parse(extracted);
      return extracted;
    } catch {
      const balancedExtracted = balanceUnclosedStructures(removeTrailingCommas(stripComments(extracted)));
      try {
        JSON.parse(balancedExtracted);
        return balancedExtracted;
      } catch {}
    }
  }

  // If all repair attempts fail, return the best candidate string
  return candidate;
}

/**
 * Parses a JSON string with auto-repair fallback. Returns parsed object or fallback value.
 */
export function parseOrRepairJson<T = any>(raw: unknown, fallback: T = {} as T): T {
  if (raw && typeof raw === "object") return raw as T;
  if (typeof raw !== "string" || !raw.trim()) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    try {
      const repaired = repairJsonString(raw);
      return JSON.parse(repaired);
    } catch {
      return fallback;
    }
  }
}
