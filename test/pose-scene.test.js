import { test } from "node:test";
import assert from "node:assert/strict";

import { safeSceneBaseName, validatePoseScenePayload } from "../pose-scene.js";

function validPayload(overrides = {}) {
  const landmarks = Array.from({ length: 33 }, (_, index) => [
    0,
    index === 0 ? -1 : 0,
    0,
    1,
  ]);
  return {
    sceneName: "walking sample",
    fps: 12,
    sampleRate: 4,
    frames: [
      { timeSec: 0, landmarks },
      { timeSec: 0.25, landmarks },
    ],
    ...overrides,
  };
}

test("validates a bounded pose-scene request", () => {
  const result = validatePoseScenePayload(validPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.frames.length, 2);
    assert.equal(result.value.sceneName, "walking sample");
  }
});

test("rejects malformed or oversized pose data", () => {
  assert.equal(validatePoseScenePayload(null).code, "BAD_POSE_DATA");
  assert.equal(
    validatePoseScenePayload(validPayload({ fps: 0 })).code,
    "BAD_FPS",
  );
  assert.equal(
    validatePoseScenePayload(validPayload({ frames: [] })).code,
    "BAD_FRAME_COUNT",
  );
  assert.equal(
    validatePoseScenePayload(
      validPayload({ frames: Array(241).fill({ landmarks: [] }) }),
    ).code,
    "BAD_FRAME_COUNT",
  );
  assert.equal(
    validatePoseScenePayload(
      validPayload({
        frames: [
          { timeSec: 0, landmarks: [] },
          { timeSec: 0.25, landmarks: [] },
        ],
      }),
    ).code,
    "BAD_LANDMARKS",
  );
});

test("rejects non-finite, out-of-range landmark values", () => {
  const payload = validPayload();
  payload.frames[1].landmarks[4] = [Number.NaN, 0, 0, 1];
  assert.equal(validatePoseScenePayload(payload).code, "BAD_LANDMARK");

  const tooFar = validPayload();
  tooFar.frames[1].landmarks[4] = [5.1, 0, 0, 1];
  assert.equal(validatePoseScenePayload(tooFar).code, "BAD_LANDMARK");
});

test("requires strictly increasing frame timestamps", () => {
  const payload = validPayload();
  payload.frames[1].timeSec = 0;
  assert.equal(validatePoseScenePayload(payload).code, "BAD_FRAME_TIMESTAMPS");
});

test("sanitizes output scene names without allowing path separators", () => {
  assert.equal(
    safeSceneBaseName("  test/../人物?.blend  "),
    "test_.._人物_.blend",
  );
  assert.equal(safeSceneBaseName("..."), "pose_reconstruction");
});
