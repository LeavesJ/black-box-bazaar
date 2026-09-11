// agents/test/model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply, modelIsWrong, parseInteger, type Ask } from "../src/model.ts";

test("classifyReply accepts a bare integer, with thousands commas, one trailing period, whitespace, or a sign", () => {
  assert.deepEqual(classifyReply("517430"), { kind: "answer", value: 517430n });
  assert.deepEqual(classifyReply("517,430"), { kind: "answer", value: 517430n });
  assert.deepEqual(classifyReply("517430."), { kind: "answer", value: 517430n });
  assert.deepEqual(classifyReply("  517430\n"), { kind: "answer", value: 517430n });
  assert.deepEqual(classifyReply("-5"), { kind: "answer", value: -5n });
  assert.deepEqual(classifyReply("517430", "end_turn"), { kind: "answer", value: 517430n });
});

test("classifyReply calls everything else malformed, never a wrong number", () => {
  for (const text of ["123.45", "The answer is 517430.", "590 × 877 = 517430", "", "   ", "I cannot help with that.", "517430..", "5 17430", "0x1f"]) {
    const r = classifyReply(text);
    assert.equal(r.kind, "malformed", JSON.stringify(text));
  }
});

test("classifyReply treats a max_tokens cutoff as malformed even when the text looks like an integer", () => {
  assert.deepEqual(classifyReply("517430", "max_tokens"), { kind: "malformed", why: "truncated" });
});

test("parseInteger is the thin wrapper: number or null", () => {
  assert.equal(parseInteger("517,430."), 517430n);
  assert.equal(parseInteger("The answer is 5"), null);
  assert.equal(parseInteger(""), null);
});

const scripted = (replies: Array<string | [string, string]>): Ask => {
  let i = 0;
  return async () => {
    const r = replies[i++ % replies.length]!;
    return typeof r === "string" ? { text: r, stopReason: "end_turn" } : { text: r[0], stopReason: r[1] };
  };
};

test("modelIsWrong counts only well-formed wrong integers toward the threshold", async () => {
  // 590 * 877 = 517430
  const r = await modelIsWrong(590, 877, 3, 2, scripted(["517430", "517431", "The answer is 5"]));
  assert.equal(r.truth, "517430");
  assert.equal(r.wrong, 1);
  assert.equal(r.malformed, 1);
  assert.equal(r.runs, 3);
  assert.equal(r.verdict, false);
  assert.equal(r.answers.length, 3);
});

test("modelIsWrong: all malformed never reaches any threshold", async () => {
  const r = await modelIsWrong(590, 877, 3, 1, scripted(["", "123.45", ["517430", "max_tokens"]]));
  assert.equal(r.wrong, 0);
  assert.equal(r.malformed, 3);
  assert.equal(r.verdict, false);
});

test("modelIsWrong: two well-formed wrong answers of three meet the buyer threshold", async () => {
  const r = await modelIsWrong(590, 877, 3, 2, scripted(["517,431", "517430", "1."]));
  assert.equal(r.wrong, 2);
  assert.equal(r.malformed, 0);
  assert.equal(r.verdict, true);
});
