const LANDMARK_COUNT = 33;
const MAX_FRAMES = 240;

export function validatePoseScenePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      code: "BAD_POSE_DATA",
      message: "请求必须是 JSON 对象。",
    };
  }

  const { sceneName, fps, sampleRate, frames } = value;
  if (
    typeof sceneName !== "string" ||
    !sceneName.trim() ||
    sceneName.length > 100
  ) {
    return {
      ok: false,
      code: "BAD_SCENE_NAME",
      message: "场景名称不能为空且不能超过 100 个字符。",
    };
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) {
    return {
      ok: false,
      code: "BAD_FPS",
      message: "输出帧率必须是 1 到 30 之间的整数。",
    };
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > fps) {
    return {
      ok: false,
      code: "BAD_SAMPLE_RATE",
      message: "采样帧率必须是 1 到输出帧率之间的整数。",
    };
  }
  if (
    !Array.isArray(frames) ||
    frames.length < 2 ||
    frames.length > MAX_FRAMES
  ) {
    return {
      ok: false,
      code: "BAD_FRAME_COUNT",
      message: `姿态帧数必须在 2 到 ${MAX_FRAMES} 之间。`,
    };
  }

  for (const [frameIndex, frame] of frames.entries()) {
    if (
      !frame ||
      !Number.isFinite(frame.timeSec) ||
      frame.timeSec < 0 ||
      frame.timeSec > 60
    ) {
      return {
        ok: false,
        code: "BAD_FRAME_TIMESTAMPS",
        message: `第 ${frameIndex + 1} 帧的时间无效。`,
      };
    }
    if (
      !Array.isArray(frame.landmarks) ||
      frame.landmarks.length !== LANDMARK_COUNT
    ) {
      return {
        ok: false,
        code: "BAD_LANDMARKS",
        message: `第 ${frameIndex + 1} 帧必须包含 ${LANDMARK_COUNT} 个姿态点。`,
      };
    }
    if (frameIndex > 0 && frame.timeSec <= frames[frameIndex - 1].timeSec) {
      return {
        ok: false,
        code: "BAD_FRAME_TIMESTAMPS",
        message: "姿态帧时间必须严格递增。",
      };
    }
    for (const [landmarkIndex, landmark] of frame.landmarks.entries()) {
      if (
        !Array.isArray(landmark) ||
        landmark.length !== 4 ||
        !landmark.every(Number.isFinite) ||
        landmark.slice(0, 3).some((coordinate) => Math.abs(coordinate) > 5) ||
        landmark[3] < 0 ||
        landmark[3] > 1
      ) {
        return {
          ok: false,
          code: "BAD_LANDMARK",
          message: `第 ${frameIndex + 1} 帧的第 ${landmarkIndex + 1} 个姿态点无效。`,
        };
      }
    }
  }

  return {
    ok: true,
    value: {
      sceneName: sceneName.trim(),
      fps,
      sampleRate,
      frames,
    },
  };
}

export function safeSceneBaseName(value) {
  const base = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 64);
  return base || "pose_reconstruction";
}
