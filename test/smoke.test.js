/**
 * 端到端冒烟：真跑 Blender。本机没装 Blender 时整组跳过，不会让 CI 变红。
 * 覆盖接入规范第五节里能自动验证的四条：未安装快速报错、串行排队、超时可终止、只监听回环。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBlenderExe, listLanAddresses } from "../lib.js";
import { buildHealth, startBridge } from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const found = findBlenderExe();
const skip = found.exe ? false : "本机没有 Blender，跳过端到端";

/** 用渲染器自带的 demo 场景生成脚本造一个最小可渲场景。 */
function makeDemoScene(scenePath, frames) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(found.exe, ["-b", "-P", join(HERE, "..", "blender", "make_demo_scene.py"), "--", scenePath, String(frames)], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0 && existsSync(scenePath)) resolveRun();
      else rejectRun(new Error(`生成 demo 场景失败（退出码 ${code}）：${stderr.slice(-500)}`));
    });
  });
}

/** 起一个监听随机端口的桥接，返回 baseUrl 与关闭函数。 */
async function startTestBridge() {
  process.env.BLENDER_PORT = "0";
  const server = startBridge();
  await new Promise((resolveListen) => server.once("listening", resolveListen));
  const { port, address } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    address,
    close: () => new Promise((done) => server.close(done)),
  };
}

test("未安装 Blender 时 1 秒内明确报错，错误信息含设置指引", async () => {
  const startedAt = Date.now();
  const health = await buildHealth({
    findExe: () => ({ exe: null, source: null, probed: ["C:/nowhere/blender.exe"] }),
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(health.status, 503);
  assert.equal(health.body.code, "BLENDER_NOT_FOUND");
  assert.match(health.body.message, /未找到 Blender，请设置 BLENDER_EXE/);
  assert.deepEqual(health.body.probed, ["C:/nowhere/blender.exe"]);
  assert.ok(elapsed < 1000, `判定耗时 ${elapsed}ms，要求 1 秒内`);
});

test("端到端：提交 → 排队 → 渲染 → 取回 MP4 字节", { skip, timeout: 180000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-smoke-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 24);

  const bridge = await startTestBridge();
  assert.equal(bridge.address, "127.0.0.1", "只允许监听回环地址");
  try {
    const health = await (await fetch(`${bridge.baseUrl}/health`)).json();
    assert.equal(health.ok, true);
    assert.ok(health.version, "健康检查必须能报出版本号");
    assert.equal(health.probed.length > 0, true);

    const created = await fetch(`${bridge.baseUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: scenePath, res: "320x180" }),
    });
    assert.equal(created.status, 202);
    const { taskId } = await created.json();
    assert.ok(taskId);

    let view = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      view = await (await fetch(`${bridge.baseUrl}/render/${taskId}`)).json();
      if (view.state === "succeeded" || view.state === "failed") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(view.state, "succeeded", `渲染未成功：${JSON.stringify(view.error)}`);
    assert.ok(view.result.bytes > 10000, "产物体积异常");

    const media = await fetch(`${bridge.baseUrl}${view.result.mediaPath}`);
    assert.equal(media.headers.get("content-type"), "video/mp4");
    const bytes = Buffer.from(await media.arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp", "必须是 MP4 容器");
  } finally {
    await bridge.close();
  }
});

test("端到端：姿态数据生成可探测的 Blender 人偶场景", { skip, timeout: 180000 }, async () => {
  const bridge = await startTestBridge();
  const landmarks = Array.from({ length: 33 }, (_, index) => [0, index === 0 ? -1 : 0, 0, 1]);
  const response = await fetch(`${bridge.baseUrl}/scenes/from-pose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sceneName: "pose scene test",
      fps: 12,
      sampleRate: 4,
      frames: [
        { timeSec: 0, landmarks },
        { timeSec: 0.25, landmarks: landmarks.map(([x, y, z, visibility]) => [x + 0.02, y, z, visibility]) },
      ],
    }),
  });
  let scene = null;
  try {
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.ok, true);
    scene = body.scene;
    assert.ok(existsSync(scene.path));
    assert.ok(scene.bytes > 10000);

    const probe = await fetch(`${bridge.baseUrl}/probe?scene=${encodeURIComponent(scene.path)}`);
    assert.equal(probe.status, 200);
    const details = await probe.json();
    assert.ok(details.camera);
    assert.ok(details.objects >= 30);
  } finally {
    if (scene?.path) rmSync(scene.path, { force: true });
    await bridge.close();
  }
});

test("两个任务同时提交时第二个进入排队，不并行渲染", { skip, timeout: 180000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-serial-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 24);

  const bridge = await startTestBridge();
  try {
    const submit = () =>
      fetch(`${bridge.baseUrl}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: scenePath, res: "320x180" }),
      }).then((res) => res.json());
    const first = await submit();
    const second = await submit();
    const secondView = await (await fetch(`${bridge.baseUrl}/render/${second.taskId}`)).json();
    assert.equal(secondView.state, "queued", "第二个任务必须排队");

    const health = await (await fetch(`${bridge.baseUrl}/health`)).json();
    assert.equal(health.concurrency, 1);
    assert.equal(health.queue.queued.includes(second.taskId), true);

    await fetch(`${bridge.baseUrl}/render/${first.taskId}`, { method: "DELETE" });
    await fetch(`${bridge.baseUrl}/render/${second.taskId}`, { method: "DELETE" });
  } finally {
    await bridge.close();
  }
});

test("超时会终止渲染并给出可读原因", { skip, timeout: 120000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-timeout-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 96);

  const bridge = await startTestBridge();
  try {
    const created = await fetch(`${bridge.baseUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: scenePath, res: "640x360", timeoutMs: 1200 }),
    });
    const { taskId } = await created.json();
    let view = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      view = await (await fetch(`${bridge.baseUrl}/render/${taskId}`)).json();
      if (view.state === "failed" || view.state === "succeeded") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(view.state, "failed", "应被超时终止");
    assert.equal(view.error.code, "RENDER_TIMEOUT");
    assert.match(view.error.message, /已终止进程树/);
  } finally {
    await bridge.close();
  }
});

test("集中模式：一个开关就绑全网卡，局域网地址可直接访问", { skip, timeout: 60000 }, async () => {
  const saved = { port: process.env.BLENDER_PORT, shared: process.env.BLENDER_SHARED, bind: process.env.BLENDER_BIND, token: process.env.BLENDER_TOKEN };
  process.env.BLENDER_PORT = "0";
  process.env.BLENDER_SHARED = "1";
  delete process.env.BLENDER_BIND;
  delete process.env.BLENDER_TOKEN;

  const server = startBridge();
  await new Promise((resolveListen) => server.once("listening", resolveListen));
  try {
    const { port, address } = server.address();
    assert.equal(address, "0.0.0.0", "集中模式必须绑全零地址");

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.network.mode, "shared");
    assert.equal(health.network.tokenEnforced, false, "集中模式默认不强制 token，否则就不省事了");
    assert.equal(health.network.bind, "0.0.0.0");

    const lan = listLanAddresses(networkInterfaces());
    if (lan.length) {
      // 真正从局域网地址连一次：只断言配置不叫「能用」
      const viaLan = await fetch(`http://${lan[0]}:${port}/health`);
      assert.equal(viaLan.status, 200, `局域网地址 ${lan[0]} 访问失败`);
      const lanHealth = await viaLan.json();
      assert.equal(lanHealth.ok, true);
    }
  } finally {
    await new Promise((done) => server.close(done));
    if (saved.port === undefined) delete process.env.BLENDER_PORT; else process.env.BLENDER_PORT = saved.port;
    if (saved.shared === undefined) delete process.env.BLENDER_SHARED; else process.env.BLENDER_SHARED = saved.shared;
    if (saved.bind === undefined) delete process.env.BLENDER_BIND; else process.env.BLENDER_BIND = saved.bind;
    if (saved.token === undefined) delete process.env.BLENDER_TOKEN; else process.env.BLENDER_TOKEN = saved.token;
  }
});

/** ------------------------- 两档运镜的端到端验收 ------------------------- */

test("预设目录与场景探测：档二需要的机位信息齐备", { skip, timeout: 180000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-probe-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 24);

  const bridge = await startTestBridge();
  try {
    const presets = await (await fetch(`${bridge.baseUrl}/presets`)).json();
    assert.equal(presets.ok, true);
    const ids = presets.presets.map((item) => item.id);
    for (const required of ["push_in", "orbit_left", "pan_left", "crane_up", "zoom_in", "static"]) {
      assert.ok(ids.includes(required), `预设缺 ${required}`);
    }

    const response = await fetch(`${bridge.baseUrl}/probe?scene=${encodeURIComponent(scenePath)}`);
    assert.equal(response.status, 200);
    const probe = await response.json();
    assert.ok(probe.cameras.length > 0, "必须列出相机");
    const first = probe.cameraDetails[0];
    // 档二的列表要能区分「静止机位」和「美术已经 K 了运镜的机位」
    assert.equal(typeof first.animated, "boolean");
    assert.equal(first.location.length, 3);
    assert.equal(first.target.length, 3, "必须带注视点，否则前端算不出运镜幅度");
    assert.ok(probe.pivot.length === 3);
  } finally {
    await bridge.close();
  }
});

test("档一：预设运镜真渲，帧数等于时长×帧率", { skip, timeout: 240000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-shot-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 96);

  const bridge = await startTestBridge();
  try {
    const created = await fetch(`${bridge.baseUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: scenePath, res: "320x180", shot: { preset: "orbit_left", durationSec: 1, strength: 0.8 } }),
    });
    assert.equal(created.status, 202, "运镜请求应被接受");
    const { taskId } = await created.json();

    let view = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      view = await (await fetch(`${bridge.baseUrl}/render/${taskId}`)).json();
      if (view.state === "succeeded" || view.state === "failed") break;
      await new Promise((r) => setTimeout(r, 300));
    }

    assert.equal(view.state, "succeeded", `运镜渲染失败：${JSON.stringify(view.error)}`);
    // 1 秒 24fps 就该是 24 帧；多一帧会让成片时长变成 1.04 秒
    assert.equal(view.result.frames, 24, "帧数必须等于时长×帧率");
    assert.equal(view.shot.preset, "orbit_left");
    assert.equal(view.result.shot.keys, 2, "预设应展开成起点和终点两帧");
    assert.ok(view.result.bytes > 5000, "产物体积异常");

    const bytes = Buffer.from(await (await fetch(`${bridge.baseUrl}${view.result.mediaPath}`)).arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp");
  } finally {
    await bridge.close();
  }
});

test("档二：沿用相机自带动画，不被静帧覆盖", { skip, timeout: 180000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-as-is-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 24);

  const bridge = await startTestBridge();
  try {
    const created = await fetch(`${bridge.baseUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: scenePath, res: "320x180", shot: { durationSec: 1 } }),
    });
    assert.equal(created.status, 202);
    const { taskId } = await created.json();
    assert.ok(taskId);
    const view = await (await fetch(`${bridge.baseUrl}/render/${taskId}`)).json();

    // 不传 preset 时不该生成 keyframes——生成了就等于把美术 K 好的运镜换成静帧
    assert.equal(view.shot.keys, 0, "沿用原动画时不应有关键帧");
    assert.equal(view.shot.preset, "as_is");
  } finally {
    await bridge.close();
  }
});

test("相机名写错时明确报错，不偷偷换成别的机位", { skip, timeout: 120000 }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), "bridge-badcam-"));
  const scenePath = join(workDir, "demo_clay.blend");
  await makeDemoScene(scenePath, 24);

  const bridge = await startTestBridge();
  try {
    const response = await fetch(`${bridge.baseUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: scenePath, res: "320x180", shot: { preset: "push_in", durationSec: 1, camera: "__不存在的相机__" } }),
    });
    assert.equal(response.status, 400, "参数错误应当在提交时就拒绝，而不是排队后失败");
    const payload = await response.json();
    assert.equal(payload.code, "CAMERA_NOT_FOUND");
    assert.match(payload.message, /可用/);
  } finally {
    await bridge.close();
  }
});
