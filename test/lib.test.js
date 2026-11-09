/** 纯函数层单测：参数校验、命令拼装、输出解析、可执行文件探测。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBlenderArgs,
  collectBlenderCandidates,
  describeExitCode,
  findBlenderExe,
  isLoopbackHost,
  listLanAddresses,
  listLanInterfaces,
  normalizeRenderParams,
  parseBlenderLine,
  parseBlenderVersion,
  resolveNetwork,
} from "../lib.js";

const workDir = mkdtempSync(join(tmpdir(), "bridge-lib-test-"));
const scenePath = join(workDir, "场景 with space.blend");
writeFileSync(scenePath, "fake");

test("缺少 scene 时立即报 MISSING_SCENE，不进入排队", () => {
  const result = normalizeRenderParams({});
  assert.equal(result.ok, false);
  assert.equal(result.code, "MISSING_SCENE");
  assert.match(result.message, /BLENDER_DEFAULT_SCENE/);
});

test("scene 不是 .blend 或文件不存在时拒绝", () => {
  assert.equal(normalizeRenderParams({ scene: join(workDir, "x.txt") }).code, "BAD_SCENE");
  assert.equal(normalizeRenderParams({ scene: join(workDir, "nope.blend") }).code, "SCENE_NOT_FOUND");
});

test("合法请求被归一化，缺省值补齐", () => {
  const result = normalizeRenderParams({ scene: scenePath });
  assert.equal(result.ok, true);
  assert.equal(result.value.engine, "workbench");
  assert.equal(result.value.percent, 100);
  assert.equal(result.value.background, "#70747C");
  assert.equal(result.value.timeoutMs, 600000);
});

test("非法引擎 / 分辨率 / 背景 / 帧范围 / 百分比被逐项拒绝", () => {
  assert.equal(normalizeRenderParams({ scene: scenePath, engine: "mentalray" }).code, "BAD_ENGINE");
  assert.equal(normalizeRenderParams({ scene: scenePath, res: "1280*720" }).code, "BAD_RESOLUTION");
  assert.equal(normalizeRenderParams({ scene: scenePath, background: "black" }).code, "BAD_BACKGROUND");
  assert.equal(normalizeRenderParams({ scene: scenePath, start: 100, end: 10 }).code, "BAD_FRAME_RANGE");
  assert.equal(normalizeRenderParams({ scene: scenePath, percent: 0 }).code, "BAD_PERCENT");
});

test("命令行按数组拼装，空格与引号不会被当成参数分隔", () => {
  const params = normalizeRenderParams({ scene: scenePath, res: "1280x720", percent: 50 }).value;
  const args = buildBlenderArgs(params, { renderScript: "render_clay.py", out: "out.mp4" });
  assert.ok(Array.isArray(args));
  assert.ok(args.includes(scenePath), "带空格的场景路径必须整体作为一个元素");
  assert.ok(args.includes("--percent"));
  assert.ok(args.includes("50"));
  assert.equal(args.some((item) => item.includes(" && ") || item.includes("&")), false, "不允许出现 shell 连接符");
});

test("默认背景与默认引擎不写进命令行", () => {
  const params = normalizeRenderParams({ scene: scenePath }).value;
  const args = buildBlenderArgs(params, { renderScript: "r.py", out: "o.mp4" });
  assert.equal(args.includes("--background"), false);
  assert.equal(args.includes("--engine"), false);
});

test("解析四种前缀，忽略 Blender 自身日志与坏 JSON", () => {
  assert.deepEqual(parseBlenderLine('PROGRESS {"frame":12,"total":96,"percent":12.5}'), {
    prefix: "PROGRESS",
    payload: { frame: 12, total: 96, percent: 12.5 },
  });
  assert.equal(parseBlenderLine("PROBE {\"ok\":true,\"cameras\":[\"Camera\"]}").payload.ok, true);
  assert.equal(parseBlenderLine('ERROR {"ok":false,"code":"NO_CAMERA"}').payload.code, "NO_CAMERA");
  assert.equal(parseBlenderLine("Fra:12 Mem:12.3M | Time:00:00.07"), null);
  assert.equal(parseBlenderLine("PROGRESS {not json}"), null);
});

test("版本号与退出码翻译", () => {
  assert.equal(parseBlenderVersion("Blender 5.2.0\nbuild date"), "5.2.0");
  assert.equal(parseBlenderVersion("noise"), "");
  assert.match(describeExitCode(2), /参数或场景错误/);
  assert.match(describeExitCode(4), /产物缺失/);
});

test("BLENDER_EXE 指向真实文件时优先采用，并保留完整探测清单", () => {
  const fake = join(workDir, "blender-fake.exe");
  writeFileSync(fake, "");
  const found = findBlenderExe({ BLENDER_EXE: fake, PATH: "" });
  assert.equal(found.exe, fake);
  assert.equal(found.source, "env:BLENDER_EXE");
  assert.ok(found.probed.includes(fake));
});

test("找不到时 exe 为空但探测清单非空，便于回显给用户", () => {
  const missing = join(workDir, "missing.exe");
  const found = findBlenderExe({ BLENDER_EXE: missing, PATH: "" }, "win32");
  // 本机可能真装了 Blender（便携版会被自动探测到），因此只断言不变量：
  assert.ok(found.probed.length > 0);
  assert.equal(found.probed[0], missing, "环境变量指向的路径必须第一个被探测");
  if (found.exe) assert.ok(existsSync(found.exe), "返回的可执行文件必须真实存在");
});

test("候选清单里环境变量始终排在自动探测之前", () => {
  const candidates = collectBlenderCandidates({ BLENDER_EXE: "Z:/custom/blender.exe", PATH: "" }, "win32");
  assert.equal(candidates[0].source, "env:BLENDER_EXE");
});

/** ---------------- 监听配置：集中模式要「设一个开关就够」 ---------------- */

test("默认只绑回环，且不校验 token", () => {
  const net = resolveNetwork({});
  assert.equal(net.bind, "127.0.0.1");
  assert.equal(net.loopback, true);
  assert.equal(net.shared, false);
  assert.equal(net.tokenEnforced, false);
  assert.equal(net.port, 13003);
  assert.deepEqual(net.urls, ["http://127.0.0.1:13003"]);
  assert.equal(net.notes.length, 0, "本机模式不该有噪音提示");
});

test("BLENDER_SHARED=1 一键进集中模式，绑全零地址并给出局域网 URL", () => {
  const net = resolveNetwork({ BLENDER_SHARED: "1", BLENDER_PORT: "13003" }, { addresses: ["192.168.1.7", "10.0.0.3"] });
  assert.equal(net.bind, "0.0.0.0");
  assert.equal(net.shared, true);
  assert.deepEqual(net.urls, ["http://192.168.1.7:13003", "http://10.0.0.3:13003"]);
  assert.equal(net.tokenEnforced, false, "集中模式默认不强制 token");
  assert.match(net.notes.join(), /未设 token/);
});

test("集中模式配了 token 就自动校验，提示也随之消失", () => {
  const net = resolveNetwork({ BLENDER_SHARED: "true", BLENDER_TOKEN: "abc123" });
  assert.equal(net.tokenEnforced, true);
  assert.equal(net.token, "abc123");
  assert.doesNotMatch(net.notes.join(), /未设 token/);
});

test("BLENDER_BIND 显式值优先于 BLENDER_SHARED", () => {
  const net = resolveNetwork({ BLENDER_BIND: "192.168.1.7", BLENDER_SHARED: "1" });
  assert.equal(net.bind, "192.168.1.7");
  assert.equal(net.shared, true);
});

test("要求鉴权却没给 token：明确标记出来，由调用方中止启动", () => {
  const net = resolveNetwork({ BLENDER_SHARED: "1", BLENDER_REQUIRE_TOKEN: "1" });
  assert.equal(net.requireToken, true);
  assert.equal(net.tokenEnforced, false);
  assert.match(net.notes.join(), /中止启动|拒绝/);
});

test("回环地址的多种写法都认", () => {
  for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, `${host} 应判为回环`);
  }
  for (const host of ["0.0.0.0", "192.168.1.7", "::", ""]) {
    assert.equal(isLoopbackHost(host), false, `${host} 不应判为回环`);
  }
});

test("局域网地址只取非内部 IPv4", () => {
  const addresses = listLanAddresses({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.1.7", family: "IPv4", internal: false }],
    wifi: [{ address: "fe80::1", family: "IPv6", internal: false }],
    mock: [{ address: "10.0.0.3", family: 4, internal: false }],
  });
  assert.deepEqual(addresses, ["192.168.1.7", "10.0.0.3"]);
});

test("局域网地址按「最可能被同事连上」排序，虚拟网卡与 CGNAT 垫底", () => {
  const ordered = listLanAddresses({
    tailscale0: [{ address: "100.75.158.74", family: "IPv4", internal: false }],
    "VMware Network Adapter VMnet8": [{ address: "192.168.224.1", family: "IPv4", internal: false }],
    "以太网": [{ address: "192.168.2.32", family: "IPv4", internal: false }],
    "Tailscale": [{ address: "172.20.0.9", family: "IPv4", internal: false }],
    apipa: [{ address: "169.254.10.3", family: "IPv4", internal: false }],
  });
  // 真实办公室网段必须排第一，否则用户照着日志填 API 地址会连不上
  assert.equal(ordered[0], "192.168.2.32");
  assert.equal(ordered.at(-1), "169.254.10.3", "APIPA 是不可用地址，必须垫底");
  assert.ok(ordered.indexOf("100.75.158.74") > ordered.indexOf("192.168.2.32"));
});

test("网卡名一并回显，方便用户分辨自己该填哪个", () => {
  const items = listLanInterfaces({ "以太网": [{ address: "192.168.2.32", family: "IPv4", internal: false }] });
  assert.deepEqual(items, [{ address: "192.168.2.32", name: "以太网" }]);
});
