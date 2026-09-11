// agents/src/model.ts
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_ID, PROMPT } from "./config.ts";

let client: Anthropic | null = null;
function api() { return (client ??= new Anthropic()); }

export function parseInteger(text: string): bigint | null {
  const matches = text.replace(/,/g, "").match(/-?\d+/g);
  if (!matches) return null;
  return BigInt(matches[matches.length - 1]);
}

export async function askProduct(a: number, b: number): Promise<{ text: string; parsed: bigint | null }> {
  const res = await api().messages.create({
    model: MODEL_ID, max_tokens: 32, temperature: 0,
    messages: [{ role: "user", content: PROMPT(a, b) }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "";
  return { text, parsed: parseInteger(text) };
}

export async function modelIsWrong(a: number, b: number, runs: number, threshold: number) {
  const truth = BigInt(a) * BigInt(b);
  const answers: string[] = [];
  let wrong = 0;
  for (let i = 0; i < runs; i++) {
    const { text, parsed } = await askProduct(a, b);
    answers.push(text.trim());
    if (parsed === null || parsed !== truth) wrong++;
  }
  return { wrong, runs, verdict: wrong >= threshold, answers, truth: truth.toString() };
}
