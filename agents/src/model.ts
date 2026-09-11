// agents/src/model.ts
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, MODEL_ID, PROMPT } from "./config.ts";

let client: Anthropic | null = null;
function api() { return (client ??= new Anthropic()); }

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
/// the counting rule can be tested without the model.
export async function modelIsWrong(a: number, b: number, runs: number, threshold: number, ask: Ask = askProduct): Promise<Verdict> {
  const truth = BigInt(a) * BigInt(b);
  const answers: string[] = [];
  let wrong = 0, malformed = 0;
  for (let i = 0; i < runs; i++) {
    const { text, stopReason } = await ask(a, b);
    const r = classifyReply(text, stopReason);
    answers.push(r.kind === "answer" ? text.trim() : `[malformed: ${r.why}] ${text.trim()}`);
    if (r.kind === "malformed") malformed++;
    else if (r.value !== truth) wrong++;
  }
  return { wrong, malformed, runs, verdict: wrong >= threshold, answers, truth: truth.toString() };
}
