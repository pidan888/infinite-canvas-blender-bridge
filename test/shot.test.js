/**
 * 镜头描述层的纯函数测试。
 *
 * 重点不是覆盖率，是两组容易出错又难排查的语义：
 *  1. 首帧必须等于输入的起始位姿——不一致就等于用户选了预设之后画面突然跳一下
 *  2. 预设名描述的是「相机自己怎么动」——左环绕是相机往左移，不是主体往左移
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBlenderArgs } from "../lib.js";
import { PRESETS, deriveFrames, expandPreset, normalizePose, normalizeShot } from "../lib/shot.js";

/** 相机在 -Y 方向 10 米外看向原点，焦距 35mm。 */
const POSE = { pos: [0, -10, 0], target: [0, 0, 0], focal: 35 };

const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("预设目录的 id 唯一，且每个都能展开", () => {
  const ids = PRESETS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "预设 id 不能重复");
  for (const item of PRESETS) {
    const result = expandPreset({ preset: item.id, durationSec: 6, strength: 0.5, pose: POSE });
    assert.equal(result.ok, true, `${item.id} 应能展开：${result.message || ""}`);
    assert.equal(result.value.keys.length, 2, `${item.id} 应只出起点和终点两帧`);
  }
});

test("所有预设的首帧都等于输入位姿，不会跳帧", () => {
  for (const preset of PRESETS) {
    const { value } = expandPreset({ preset: preset.id, durationSec: 6, strength: 0.5, pose: POSE });
    const [first, last] = value.keys;
    assert.equal(first.t, 0, `${preset.id} 首帧应在 0 秒`);
    assert.equal(last.t, 6, `${preset.id} 末帧应等于时长`);
    assert.deepEqual(first.pos, POSE.pos, `${preset.id} 首帧位置必须等于起始位姿`);
    assert.deepEqual(first.target, POSE.target, `${preset.id} 首帧注视点必须等于起始位姿`);
    assert.equal(first.focal, 35, `${preset.id} 首帧焦距必须等于起始位姿`);
  }
});

test("推近：沿视线靠近主体，方向不变", () => {
  const { value } = expandPreset({ preset: "push_in", durationSec: 6, strength: 0.5, pose: POSE });
  const end = value.keys[1];
  assert.ok(end.pos[1] > POSE.pos[1], "相机应沿 +Y 靠近原点");
  assert.ok(distance(end.pos, POSE.target) < 10, "到主体距离应变小");
  assert.ok(near(end.pos[0], 0) && near(end.pos[2], 0), "不该横向或垂直漂移");
  assert.deepEqual(end.target, POSE.target, "推近不应该改注视点");
});

test("拉远：距离变大，方向相反", () => {
  const { value } = expandPreset({ preset: "pull_out", durationSec: 6, strength: 0.5, pose: POSE });
  const end = value.keys[1];
  assert.ok(distance(end.pos, POSE.target) > 10);
  assert.ok(end.pos[1] < POSE.pos[1]);
});

test("左环绕：相机往左（-X）移，半径与注视点不变", () => {
  const { value } = expandPreset({ preset: "orbit_left", durationSec: 6, strength: 0.5, pose: POSE });
  const end = value.keys[1];
  assert.ok(end.pos[0] < -0.5, `相机应移到 -X 侧，实际 x=${end.pos[0]}`);
  assert.ok(near(distance(end.pos, POSE.target), 10, 0.02), "环绕半径必须保持");
  assert.deepEqual(end.target, POSE.target, "注视点不该动");
});

test("右环绕与左环绕方向相反，半径相同", () => {
  const left = expandPreset({ preset: "orbit_left", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  const right = expandPreset({ preset: "orbit_right", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  assert.ok(left.pos[0] < 0 && right.pos[0] > 0, "左右环绕应在 X 轴两侧");
  assert.ok(near(distance(left.pos, POSE.target), distance(right.pos, POSE.target), 0.02));
});

test("左摇：机位不动，只把注视点往左转，距离保持", () => {
  const { value } = expandPreset({ preset: "pan_left", durationSec: 6, strength: 0.5, pose: POSE });
  const end = value.keys[1];
  assert.deepEqual(end.pos, POSE.pos, "摇镜不该移动机位");
  assert.ok(end.target[0] < -0.5, "注视点应转向 -X");
  assert.ok(near(distance(end.pos, end.target), 10, 0.02), "摇镜不该改变到主体的距离");
});

test("上摇 / 下摇：注视点沿垂直方向反向移动", () => {
  const up = expandPreset({ preset: "tilt_up", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  const down = expandPreset({ preset: "tilt_down", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  assert.ok(up.target[2] > 0.5, "上摇注视点应升高");
  assert.ok(down.target[2] < -0.5, "下摇注视点应降低");
  assert.deepEqual(up.pos, POSE.pos);
  assert.deepEqual(down.pos, POSE.pos);
});

test("左移 / 右移：机位平移，注视点不动（透视会变）", () => {
  const left = expandPreset({ preset: "truck_left", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  const right = expandPreset({ preset: "truck_right", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  assert.ok(left.pos[0] < 0 && right.pos[0] > 0);
  assert.deepEqual(left.target, POSE.target);
  assert.deepEqual(right.target, POSE.target);
});

test("升镜 / 降镜：只改高度", () => {
  const up = expandPreset({ preset: "crane_up", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  const down = expandPreset({ preset: "crane_down", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  assert.ok(up.pos[2] > 0.5);
  assert.ok(down.pos[2] < -0.5);
  assert.deepEqual(up.target, POSE.target);
});

test("变焦：机位和注视点都不动，只改焦距", () => {
  const zoomIn = expandPreset({ preset: "zoom_in", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  const zoomOut = expandPreset({ preset: "zoom_out", durationSec: 6, strength: 0.5, pose: POSE }).value.keys[1];
  assert.ok(zoomIn.focal > 35, "变焦推应增大焦距");
  assert.ok(zoomOut.focal < 35, "变焦拉应减小焦距");
  assert.deepEqual(zoomIn.pos, POSE.pos);
  assert.deepEqual(zoomIn.target, POSE.target);
});

test("固定机位：两帧完全一致", () => {
  const { value } = expandPreset({ preset: "static", durationSec: 6, strength: 1, pose: POSE });
  assert.deepEqual(value.keys[0].pos, value.keys[1].pos);
  assert.deepEqual(value.keys[0].target, value.keys[1].target);
  assert.equal(value.keys[0].focal, value.keys[1].focal);
});

test("幅度越大位移越大，且 strength=0 时几乎不动", () => {
  const small = expandPreset({ preset: "push_in", durationSec: 6, strength: 0.2, pose: POSE }).value.keys[1];
  const large = expandPreset({ preset: "push_in", durationSec: 6, strength: 0.9, pose: POSE }).value.keys[1];
  const zero = expandPreset({ preset: "push_in", durationSec: 6, strength: 0, pose: POSE }).value.keys[1];
  assert.ok(distance(large.pos, POSE.target) < distance(small.pos, POSE.target));
  assert.ok(distance(zero.pos, POSE.pos) < 0.01, "strength=0 应该基本不动");
});

test("未知预设与退化位姿都要明确报错，不能静默出一段静止画面", () => {
  const unknown = expandPreset({ preset: "fly_to_moon", durationSec: 6, pose: POSE });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "BAD_PRESET");

  const degenerate = expandPreset({ preset: "push_in", durationSec: 6, pose: { pos: [0, 0, 0], target: [0, 0, 0] } });
  assert.equal(degenerate.ok, false);
  assert.equal(degenerate.code, "DEGENERATE_POSE");
});

test("相机几乎垂直朝上时仍能算出「右」方向，不会退化成零向量", () => {
  const nearVertical = { pos: [0, 0, 10], target: [0, 0, 0], focal: 35 };
  const { value } = expandPreset({ preset: "truck_right", durationSec: 6, strength: 0.5, pose: nearVertical });
  const end = value.keys[1];
  assert.ok(Number.isFinite(end.pos[0]) && Number.isFinite(end.pos[1]));
  assert.ok(distance(end.pos, nearVertical.pos) > 0.1, "垂直俯视时平移仍应生效");
});

/** ------------------------------ 校验层 ------------------------------ */

test("normalizeShot：三种输入语义分开，省略 preset 不等于固定机位", () => {
  const asIs = normalizeShot({ durationSec: 6, camera: "Camera" });
  assert.equal(asIs.ok, true);
  assert.equal(asIs.value.preset, "", "不传 preset 应留空，表示沿用相机自带动画");
  assert.equal(asIs.value.keys, null);

  const preset = normalizeShot({ preset: "orbit_left", durationSec: 4 });
  assert.equal(preset.value.preset, "orbit_left");
  assert.equal(preset.value.keys, null);

  const keys = normalizeShot({
    durationSec: 6,
    keys: [
      { t: 0, pos: [0, -10, 0], target: [0, 0, 0], focal: 35 },
      { t: 6, pos: [0, -5, 0], target: [0, 0, 0], focal: 35 },
    ],
  });
  assert.equal(keys.ok, true);
  assert.equal(keys.value.keys.length, 2);
});

test("normalizeShot：越界参数逐个拦下", () => {
  assert.equal(normalizeShot({ durationSec: 0.1 }).code, "BAD_DURATION");
  assert.equal(normalizeShot({ durationSec: 999 }).code, "BAD_DURATION");
  assert.equal(normalizeShot({ fps: 120 }).code, "BAD_FPS");
  assert.equal(normalizeShot({ preset: "nope" }).code, "BAD_PRESET");
  assert.equal(normalizeShot("不是对象").code, "BAD_SHOT");
});

test("显式关键帧：时间必须严格递增", () => {
  const result = normalizeShot({
    durationSec: 6,
    keys: [
      { t: 0, pos: [0, -10, 0], target: [0, 0, 0] },
      { t: 3, pos: [0, -8, 0], target: [0, 0, 0] },
      { t: 3, pos: [0, -5, 0], target: [0, 0, 0] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "BAD_KEYS");
});

test("显式关键帧：首帧不在 0 秒时自动补一帧并给出提示", () => {
  const result = normalizeShot({
    durationSec: 6,
    keys: [
      { t: 1, pos: [0, -10, 0], target: [0, 0, 0] },
      { t: 6, pos: [0, -5, 0], target: [0, 0, 0] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.keys[0].t, 0);
  assert.match(result.value.warnings.join(), /0 秒/);
});

test("显式关键帧：超出时长的 t 要报错", () => {
  const result = normalizeShot({
    durationSec: 6,
    keys: [
      { t: 0, pos: [0, -10, 0], target: [0, 0, 0] },
      { t: 9, pos: [0, -5, 0], target: [0, 0, 0] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "BAD_KEYS");
});

test("deriveFrames：时长×帧率，帧率优先级从高到低", () => {
  const base = deriveFrames({ durationSec: 6, fps: 0 }, 24);
  assert.deepEqual(base, { fps: 24, frames: 144, start: 1, end: 144 });

  const override = deriveFrames({ durationSec: 6, fps: 30 }, 24);
  assert.equal(override.fps, 30);
  assert.equal(override.frames, 180);

  const minTwo = deriveFrames({ durationSec: 0.5, fps: 6 }, 24);
  assert.ok(minTwo.frames >= 2, "至少两帧，否则构不成视频");
});

test("normalizePose：缺字段返回 null，焦距越界被夹紧", () => {
  assert.equal(normalizePose(null), null);
  assert.equal(normalizePose({ pos: [0, 0, 0] }), null);
  assert.equal(normalizePose({ pos: [0, 0], target: [0, 0] }), null);
  const clamped = normalizePose({ pos: [0, 0, 0], target: [0, 1, 0], focal: 9999 });
  assert.equal(clamped.focal, 300);
});

test("命令行里镜头文件是独立参数，且含空格的场景路径不被拆开", () => {
  const args = buildBlenderArgs(
    { scene: "E:/我的 项目/shot 01.blend", camera: "", start: 0, end: 0, fps: 24, res: "", percent: 100, engine: "workbench", samples: 0, background: "#70747C" },
    { renderScript: "render_clay.py", out: "out.mp4", shotPath: "E:/tmp/任务/shot.json" },
  );
  assert.equal(args[args.indexOf("--shot") + 1], "E:/tmp/任务/shot.json");
  assert.ok(args.includes("E:/我的 项目/shot 01.blend"), "含空格的路径必须整体作为一个参数");
  assert.ok(!args.join(" ").includes("&&"), "不允许出现 shell 连接符");
});

test("没有镜头文件时命令行不带 --shot，保持原有行为", () => {
  const args = buildBlenderArgs(
    { scene: "a.blend", camera: "Camera", start: 0, end: 0, fps: 0, res: "", percent: 100, engine: "workbench", samples: 0, background: "#70747C" },
    { renderScript: "render_clay.py", out: "out.mp4" },
  );
  assert.ok(!args.includes("--shot"));
  assert.equal(args[args.indexOf("--camera") + 1], "Camera");
});
