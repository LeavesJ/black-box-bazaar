// agents/src/model.ts
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, MODEL_ID, PROMPT } from "./config.ts";

/// One request may wait 20 s and be retried twice by the SDK; after that the call throws. The
/// agents' own retry is bounded by the sale's on-chain window, never by a fixed strike count, so a
/// slow API stalls an adjudication for at most the window, never for a whole poll loop.
export const CLIENT_OPTIONS = { timeout: 20_000, maxRetries: 2 } as const;

let client: Anthropic | null = null;
function api() { return (client ??= new Anthropic(CLIENT_OPTIONS)); }

export type Reply = { kind: "answer"; value: bigint } | { kind: "malformed"; why: string };

/// The parse rule stated in CLAIM_SPEC: trim, strip one trailing period, remove commas, and the
/// remainder must be an integer in full. Everything else is malformed, which is a separate bucket
/// from wrong: "123.45", a sentence, an empty string and a refusal are not wrong multiplications.
export function classifyReply(text: string, stopReason?: string | null): Reply {
  if (stopReason === "max_tokens") return { kind: "malformed", why: "truncated" };
  let s = text.trim();
  if (s.endsWith(".")) s = s.slice(0, -1);
  s = s.replace(/,/g, "");
  if (!/^-?[0-9]+$/.test(s)) return { kind: "malformed", why: "not an integer" };
  return { kind: "answer", value: BigInt(s) };
}

/// Thin wrapper kept for callers that only want a number or nothing.
export function parseInteger(text: string): bigint | null {
  const r = classifyReply(text);
  return r.kind === "answer" ? r.value : null;
}

export type Ask = (a: number, b: number) => Promise<{ text: string; stopReason: string | null }>;

export const askProduct: Ask = async (a, b) => {
  const res = await api().messages.create({
    model: MODEL_ID, max_tokens: MAX_TOKENS, temperature: 0,
    messages: [{ role: "user", content: PROMPT(a, b) }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "";
  return { text, stopReason: res.stop_reason ?? null };
};

export type Verdict = { wrong: number; malformed: number; runs: number; verdict: boolean; answers: string[]; truth: string };

/// Runs the test `runs` times. Only a well-formed integer different from a*b counts as wrong;
/// malformed replies are counted beside it and never toward the threshold. `ask` is injectable so
/// the counting rule can be tested without the model. A timeout or API error is neither: it
/// propagates as a thrown error, so the caller's window-bounded retry runs the whole verdict again
/// and a dead API never reads as a model that answered badly.
export async function modelIsWrong(a: number, b: number, runs: number, threshold: number, ask: Ask = askProduct): Promise<Verdict> {
  const truth = BigInt(a) * BigInt(b);
  const answers: string[] = [];
  let wrong = 0, malformed = 0;
  for (let i = 0; i < runs; i++) {
    let text: string, stopReason: string | null;
    try { ({ text, stopReason } = await ask(a, b)); }
    catch (e) { throw new Error(`model call failed on run ${i + 1} of ${runs}: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
    const r = classifyReply(text, stopReason);
    answers.push(r.kind === "answer" ? text.trim() : `[malformed: ${r.why}] ${text.trim()}`);
    if (r.kind === "malformed") malformed++;
    else if (r.value !== truth) wrong++;
  }
  return { wrong, malformed, runs, verdict: wrong >= threshold, answers, truth: truth.toString() };
}
