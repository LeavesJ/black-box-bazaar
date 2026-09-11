// agents/test/model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInteger } from "../src/model.ts";

test("parser accepts bare, comma-grouped and sentence-wrapped integers", () => {
  assert.equal(parseInteger("517430"), 517430n);
  assert.equal(parseInteger("517,430"), 517430n);
  assert.equal(parseInteger("The answer is 517430."), 517430n);
  assert.equal(parseInteger("590 × 877 = 517430"), 517430n);
});

test("parser returns null when there is no integer", () => {
  assert.equal(parseInteger("I cannot help with that."), null);
});
