/**
 * What a streamed response actually delivered, and why Google stopped.
 *
 * The streaming handlers wrote their closing event the same way whatever
 * happened upstream, so a malformed function call, a token limit, a safety
 * filter and a dropped connection all reached the client as a normal end of
 * turn. A client that then found nothing in it reported "empty output", and the
 * bridge's logs held no trace of the cause.
 *
 * This only observes. It never alters what is sent to the client, and it records
 * counts and Google's own words — never the text the model produced.
 */

/** The one finish reason that means the model finished of its own accord. */
const CLEAN_FINISH = "STOP";
/** Google's own explanation can be long; a prefix names the problem. */
const MAX_FINISH_MESSAGE = 300;

/** What a part is, without what it says. */
function partKind(part: any): string {
  if (part?.functionResponse) return "response";
  if (part?.functionCall) return "call";
  if (part?.thought) return "thought";
  if (typeof part?.text === "string") return "text";
  return "other";
}

const SHAPE_TURNS_SHOWN = 6;

/**
 * The roles and part kinds of a conversation, never its text:
 * `3 turns: model:thought×2+call > user:response > user:text`.
 *
 * Google answers a malformed history with a message that says what rule was broken but
 * not which turn broke it ("function call turn comes immediately after a user turn..."),
 * and the history itself is private. This is what the bridge logs on a 400, so the next
 * one can be read. A long history keeps its first and last turns and its true length.
 */
export function describeContentsShape(contents: unknown): string {
  if (!Array.isArray(contents) || contents.length === 0) return "0 turns";
  const turn = (content: any): string => {
    const runs: Array<{ kind: string; count: number }> = [];
    for (const part of content?.parts || []) {
      const kind = partKind(part);
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) last.count++;
      else runs.push({ kind, count: 1 });
    }
    const parts = runs.map((r) => (r.count > 1 ? `${r.kind}×${r.count}` : r.kind)).join("+");
    return `${content?.role ?? "?"}:${parts || "empty"}`;
  };
  const shown =
    contents.length > SHAPE_TURNS_SHOWN * 2
      ? `${contents.slice(0, SHAPE_TURNS_SHOWN).map(turn).join(" > ")} … ${contents.slice(-SHAPE_TURNS_SHOWN).map(turn).join(" > ")}`
      : contents.map(turn).join(" > ");
  return `${contents.length} ${contents.length === 1 ? "turn" : "turns"}: ${shown}`;
}

/** The slice of the request's generationConfig that explains a cut-off answer. */
export interface SentGenerationConfig {
  maxOutputTokens?: number;
  thinkingConfig?: { thinking_budget?: number };
}

export class StreamEndTally {
  text = 0;
  thinking = 0;
  tools = 0;
  finishReason: string | null = null;
  finishMessage: string | null = null;
  blockReason: string | null = null;
  private usage: any = null;

  /** Feed every chunk of the upstream stream, in order. Handles both chunk shapes. */
  observe(chunk: any): void {
    const usage = chunk?.response?.usageMetadata || chunk?.usageMetadata;
    if (usage) this.usage = usage;

    const feedback = chunk?.response?.promptFeedback || chunk?.promptFeedback;
    if (typeof feedback?.blockReason === "string") this.blockReason = feedback.blockReason;

    const candidate = chunk?.response?.candidates?.[0] || chunk?.candidates?.[0];
    if (typeof candidate?.finishReason === "string") this.finishReason = candidate.finishReason;
    if (typeof candidate?.finishMessage === "string") this.finishMessage = candidate.finishMessage;

    for (const part of candidate?.content?.parts || []) {
      if (part.thought) this.thinking++;
      else if (part.text) this.text++;
      else if (part.functionCall) this.tools++;
    }
  }

  /**
   * One line describing a stream that ended badly, or null for a healthy one.
   * Bad means: no finish reason at all (the stream may have been cut), any reason
   * other than a clean STOP, a blocked prompt, or nothing a client can use.
   */
  describe(route: string, model: string, sent?: SentGenerationConfig): string | null {
    const usable = this.text > 0 || this.tools > 0;
    const clean = this.finishReason === CLEAN_FINISH && !this.blockReason;
    if (clean && usable) return null;

    const figure = (n: unknown) => (typeof n === "number" ? String(n) : "?");
    const fields = [
      `[Stream End] ${route} model=${model}`,
      `finishReason=${this.finishReason ?? "none"}`,
      ...(this.blockReason ? [`blockReason=${this.blockReason}`] : []),
      `text=${this.text} thinking=${this.thinking} tools=${this.tools}`,
      `prompt=${figure(this.usage?.promptTokenCount)} candidates=${figure(this.usage?.candidatesTokenCount)} thoughts=${figure(this.usage?.thoughtsTokenCount)}`,
      // What the bridge asked for. A MAX_TOKENS turn only reads against the cap and
      // the thinking budget that were sent; "?" means the caller sent none.
      `maxOut=${figure(sent?.maxOutputTokens)} think=${figure(sent?.thinkingConfig?.thinking_budget)}`,
      ...(this.finishMessage
        ? [`finishMessage=${JSON.stringify(this.finishMessage.slice(0, MAX_FINISH_MESSAGE))}`]
        : []),
    ];
    return fields.join(" ");
  }

  /** Log the description as a warning when there is one. */
  warn(route: string, model: string, sent?: SentGenerationConfig): void {
    const line = this.describe(route, model, sent);
    if (line) console.warn(line);
  }
}
