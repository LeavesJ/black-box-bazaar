// agents/test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIM_SPEC, HI, LO, MODEL_ID, SUPPORTED_SPEC, claimIsSupported } from "../src/config.ts";

test("claimIsSupported is exact equality on modelId and spec", () => {
  assert.equal(claimIsSupported({ modelId: SUPPORTED_SPEC.modelId, spec: SUPPORTED_SPEC.spec }), true);
  assert.equal(claimIsSupported({ modelId: MODEL_ID, spec: CLAIM_SPEC }), true);
  assert.equal(claimIsSupported({ modelId: MODEL_ID + "x", spec: CLAIM_SPEC }), false, "model id differs");
  assert.equal(claimIsSupported({ modelId: MODEL_ID, spec: CLAIM_SPEC + " " }), false, "trailing space in spec");
  assert.equal(claimIsSupported({ modelId: MODEL_ID.toUpperCase(), spec: CLAIM_SPEC }), false, "case differs");
  assert.equal(claimIsSupported({ modelId: "", spec: "" }), false);
});

test("the spec states the parser rule, the malformed rule and the digit range", () => {
  assert.match(CLAIM_SPEC, /\^-\?\[0-9\]\+\$/);
  assert.match(CLAIM_SPEC, /malformed replies never count/i);
  assert.match(CLAIM_SPEC, /max_tokens/);
  assert.ok(CLAIM_SPEC.includes(`${LO}..${HI}`));
  assert.ok(CLAIM_SPEC.includes(MODEL_ID));
});
