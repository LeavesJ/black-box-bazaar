// agents/test/model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_OPTIONS, apiRefused, classifyReply, modelIsWrong, parseInteger, type Ask } from "../src/model.ts";

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

test("the Anthropic client is built with a 20 s timeout and two SDK retries", () => {
  assert.deepEqual({ ...CLIENT_OPTIONS }, { timeout: 20000, maxRetries: 2 });
});

test("modelIsWrong: a timeout or API error throws and never counts as malformed", async () => {
  let calls = 0;
  const flaky: Ask = async () => { calls++; if (calls === 2) throw new Error("Request timed out."); return { text: "517431", stopReason: "end_turn" }; };
  await assert.rejects(modelIsWrong(590, 877, 3, 2, flaky), (e: any) => {
    assert.match(e.message, /model call failed on run 2 of 3: Request timed out\./);
    assert.equal(e.cause?.message, "Request timed out.");
    return true;
  });
  assert.equal(calls, 2, "the run stops at the failure; nothing after it is asked");
});

test("apiRefused: a failed model call no retry can fix (no key, 400, 401, 403, 404), and nothing else", async () => {
  const thrown = async (err: unknown) => {
    try { await modelIsWrong(590, 877, 3, 2, async () => { throw err; }); } catch (e) { return e; }
    throw new Error("modelIsWrong did not throw");
  };
  const api = (status: number) => Object.assign(new Error(`${status} {"type":"error"}`), { status });
  for (const s of [400, 401, 403, 404]) assert.equal(apiRefused(await thrown(api(s))), true, `status ${s}`);
  assert.equal(apiRefused(await thrown(new Error("Could not resolve authentication method. Expected either apiKey or authToken to be set."))), true, "no key at all");
  for (const s of [408, 429, 500, 529]) assert.equal(apiRefused(await thrown(api(s))), false, `status ${s} may pass next time`);
  assert.equal(apiRefused(await thrown(new Error("Request timed out."))), false, "a timeout");
  assert.equal(apiRefused(await thrown(new Error("Connection error."))), false, "a dropped connection");
  assert.equal(apiRefused(Object.assign(new Error("HTTP request failed. Status: 404"), { status: 404 })), false, "a failed RPC is not a model call");
  assert.equal(apiRefused("401"), false, "not an error at all");
});
