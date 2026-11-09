#!/usr/bin/env node
/**
 * Blender 白模渲染桥接。
 *
 * 画布的自定义模型脚本跑在 canvas-proxy 里，不能直接启动 Blender；
 * 这里提供一个本机 HTTP 服务：接收渲染任务、生成姿态人偶场景、回报进度与产物字节。
 * 渲染命令行由 `blender/render_clay.py` 决定；姿态关键点场景由独立脚本构建。
 *
 * 设计约束见 `交接/画布接入Blender-接入规范.md`：串行、可终止、只监听回环、不用字符串拼命令。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  buildBlenderArgs,
  authorizeOrigin,
  describeExitCode,
  findBlenderExe,
  listLanAddresses,
  listLanInterfaces,
  normalizeRenderParams,
  normalizeAuthorizedOrigin,
  parseBlenderLine,
  parseBlenderVersion,
  resolveNetwork,
  readSecurityConfig,
  validSecureToken,
} from "./lib.js";
import { PRESETS, deriveFrames, expandPreset, normalizeShot } from "./lib/shot.js";
import { safeSceneBaseName, validatePoseScenePayload } from "./pose-scene.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POSE_SCENE_SCRIPT = resolve(join(HERE, "blender", "create_pose_scene.py"));

/**
 * 监听配置在启动时才定，因为端口也从环境变量来。
 * 默认回环；`BLENDER_SHARED=1` 一键进集中模式，具体规则见 lib.js 的 resolveNetwork。
 */
let NET = resolveNetwork(process.env);
const RENDER_SCRIPT = resolve(process.env.BLENDER_RENDER_SCRIPT || join(HERE, "blender", "render_clay.py"));
const DEFAULT_SCENE = process.env.BLENDER_DEFAULT_SCENE || "";
/** 场景库根目录：面板的 `.blend` 下拉就从这里扫。浏览器拿不到本地文件路径，只能靠服务端列目录。 */
const SCENE_ROOT = resolve(
  process.env.BLENDER_SCENE_DIR ||
    join(process.env.LOCALAPPDATA || process.env.HOME || tmpdir(), "InfiniteCanvas", "blender-scenes"),
);
const DEFAULT_TIMEOUT_MS = Number(process.env.BLENDER_TIMEOUT_MS || 600000);
const KEEP_TEMP = process.env.BLENDER_KEEP_TEMP === "1";
const TASK_RETENTION_MS = Number(process.env.BLENDER_TASK_RETENTION_MS || 3600000);

/** 任务表与串行队列：Blender 吃满 CPU，同一时刻只允许一个渲染进程。 */
const tasks = new Map();
const queue = [];
let runningTask = null;
let poseSceneRunning = false;
let versionCache = { at: 0, version: "" };

/**
 * 启动一台 Blender 读版本号，结果缓存一分钟。
 * 只用于健康检查回显，失败不影响可用性。
 */
function readBlenderVersion(exe) {
  const now = Date.now();
  if (versionCache.version && now - versionCache.at < 60000) return Promise.resolve(versionCache.version);
  return new Promise((resolveVersion) => {
    let settled = false;
    const child = spawn(exe, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      versionCache = { at: Date.now(), version: value };
      resolveVersion(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("");
    }, 2000);
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(parseBlenderVersion(text));
    });
  });
}

/**
 * 探测结果缓存。同一个场景反复试运镜时不必每次都重启 Blender（一次约 1.5 秒），
 * 用 .blend 的 mtime 做失效依据，美术改了文件自然会重探。
 */
const probeCache = new Map();

/**
 * 跑一次 `--probe` 拿场景的相机与位姿。两处用得上：
 *  · 档二：列出有哪些机位、哪些已经做过运镜
 *  · 档一：展开预设时需要相机的起始位姿
 */
export function probeScene(scenePath, options = {}) {
  const exe = options.exe || findBlenderExe().exe;
  if (!exe) return Promise.resolve({ ok: false, code: "BLENDER_NOT_FOUND", message: "未找到 Blender，请设置 BLENDER_EXE。" });
  if (!existsSync(RENDER_SCRIPT)) {
    return Promise.resolve({ ok: false, code: "RENDER_SCRIPT_MISSING", message: `渲染脚本不存在：${RENDER_SCRIPT}` });
  }
  if (!existsSync(scenePath)) return Promise.resolve({ ok: false, code: "SCENE_NOT_FOUND", message: `找不到场景文件：${scenePath}` });

  let mtime = 0;
  try {
    mtime = statSync(scenePath).mtimeMs;
  } catch {
    /* 读不到就每次重探 */
  }
  const ttl = options.ttlMs ?? 60000;
  const cached = probeCache.get(scenePath);
  if (cached && cached.mtime === mtime && Date.now() - cached.at < ttl) return Promise.resolve(cached.value);

  return new Promise((resolveProbe) => {
    const args = ["-b", "-P", RENDER_SCRIPT, "--", "--scene", scenePath, "--probe"];
    const child = spawn(exe, args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value.ok) probeCache.set(scenePath, { at: Date.now(), mtime, value });
      resolveProbe(value);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ ok: false, code: "PROBE_TIMEOUT", message: "探测场景超过 30 秒，已终止进程树。" });
    }, options.timeoutMs ?? 30000);

    createInterface({ input: child.stdout }).on("line", (line) => {
      const parsed = parseBlenderLine(line);
      if (!parsed) return;
      if (parsed.prefix === "PROBE") finish({ ok: true, value: parsed.payload });
      else if (parsed.prefix === "ERROR") {
        finish({ ok: false, code: parsed.payload.code || "PROBE_FAILED", message: parsed.payload.message || "探测场景失败。" });
      }
    });
    child.on("error", (error) => finish({ ok: false, code: "BLENDER_SPAWN_FAILED", message: `启动 Blender 失败：${error.message}` }));
    child.on("close", () => finish({ ok: false, code: "PROBE_FAILED", message: "Blender 探测结束但没有输出结果，检查渲染脚本。" }));
  });
}

/**
 * 从探测结果里挑出目标相机的位姿。
 * 显式指定了相机名却找不到时返回 null，**不能**回退到活动相机——
 * 「填错了名字却渲出另一个机位」属于静默错误，比直接报错难查得多。
 */
export function findCameraPose(probePayload, cameraName) {
  const details = Array.isArray(probePayload?.cameraDetails) ? probePayload.cameraDetails : [];
  if (!details.length) return null;
  const wanted = String(cameraName || "").trim();
  if (wanted) {
    const hit = details.find((item) => item.name === wanted);
    return hit ? { name: hit.name, pose: { pos: hit.location, target: hit.target, focal: hit.lens } } : null;
  }
  const active = details.find((item) => item.active) || details[0];
  return { name: active.name, pose: { pos: active.location, target: active.target, focal: active.lens } };
}

/**
 * 把外部传来的镜头描述整理成可执行的形态。三种输入，语义完全不同，不能混：
 *  · 显式关键帧 → 直接用
 *  · 预设名     → 用相机起始位姿展开成关键帧（要探一次场景）
 *  · 都没给     → 沿用相机自带的动画，只按 durationSec 定帧范围
 * 第三种如果当成「固定机位」处理，会把美术 K 好的运镜直接覆盖掉。
 */
export async function prepareShot(shotInput, params) {
  const normalized = normalizeShot(shotInput);
  if (!normalized.ok) return { ok: false, code: normalized.code, message: normalized.message };
  const shot = normalized.value;
  let sceneFps = 0;

  if (!shot.keys && shot.preset) {
    const probe = await probeScene(params.scene);
    if (!probe.ok) return { ok: false, code: probe.code, message: `无法展开运镜：${probe.message}` };
    const found = findCameraPose(probe.value, shot.camera);
    if (!found) {
      const available = (probe.value.cameraDetails || []).map((item) => item.name);
      const message = shot.camera
        ? `场景里没有名为「${shot.camera}」的相机，可用：${available.join(" / ") || "（无）"}`
        : "场景里没有可用相机，无法按预设运镜。";
      return { ok: false, code: shot.camera ? "CAMERA_NOT_FOUND" : "NO_CAMERA", message };
    }
    const expanded = expandPreset({
      preset: shot.preset,
      durationSec: shot.durationSec,
      strength: shot.strength,
      easing: shot.easing,
      pose: found.pose,
    });
    if (!expanded.ok) return { ok: false, code: expanded.code, message: expanded.message };
    shot.keys = expanded.value.keys;
    shot.camera = found.name;
    shot.warnings.push(...expanded.value.warnings);
    sceneFps = Number(probe.value.fps) || 0;
  }

  const frames = deriveFrames(shot, params.fps || sceneFps);
  // 显式给了帧范围就以调用方为准，不能被 durationSec 悄悄改掉——调用方可能在刻意截取一段
  const start = params.start || frames.start;
  const end = params.end || start + frames.frames - 1;
  const patch = { camera: shot.camera || params.camera, fps: frames.fps, start, end };

  if (!shot.keys) {
    return { ok: true, patch: { ...patch, shot: { preset: "", camera: patch.camera, durationSec: shot.durationSec, warnings: shot.warnings } } };
  }
  return { ok: true, patch: { ...patch, shot } };
}

/** 健康检查里回显监听状态：多机部署时排查「为什么连不上」全靠这一块。 */
function networkView() {
  return {
    mode: NET.shared ? "shared" : "local",
    bind: NET.bind,
    urls: NET.urls,
    tokenEnforced: NET.tokenEnforced,
  };
}

/** 立即给出「这台机器能不能渲」的结论：找不到可执行文件时不做任何排队。 */
export async function buildHealth(options = {}) {
  const finder = options.findExe || findBlenderExe;
  const found = finder();
  const hasScript = existsSync(RENDER_SCRIPT);
  if (!found.exe) {
    return {
      status: 503,
      body: {
        ok: false,
        code: "BLENDER_NOT_FOUND",
        message: "未找到 Blender，请设置 BLENDER_EXE。",
        probed: found.probed,
        renderScript: { path: RENDER_SCRIPT, exists: hasScript },
        bridgeInstanceId: NET.bridgeInstanceId,
        secureLocal: Boolean(NET.security),
        network: networkView(),
        queue: queueSnapshot(),
      },
    };
  }
  const version = await readBlenderVersion(found.exe);
  const warnings = [];
  if (!version) warnings.push("无法读取 Blender 版本，请确认该文件可执行。");
  else if (!version.startsWith("5.2")) warnings.push(`当前 Blender ${version}，方案统一按 5.2.x LTS 验收；低版本打不开高版本 .blend。`);
  if (!hasScript) warnings.push(`渲染脚本缺失：${RENDER_SCRIPT}`);
  return {
    status: 200,
    body: {
      ok: true,
      exe: found.exe,
      source: found.source,
      version,
      probed: found.probed,
      renderScript: { path: RENDER_SCRIPT, exists: hasScript },
      defaultScene: DEFAULT_SCENE || null,
      concurrency: 1,
      bridgeInstanceId: NET.bridgeInstanceId,
      secureLocal: Boolean(NET.security),
      network: networkView(),
      queue: queueSnapshot(),
      warnings,
    },
  };
}

function queueSnapshot() {
  return {
    running: runningTask ? { taskId: runningTask.id, percent: runningTask.progress?.percent ?? 0 } : null,
    queued: queue.map((task) => task.id),
  };
}

/** 串行泵：一次只取一个任务，结束后自动取下一个。 */
function pump() {
  if (runningTask) return;
  const next = queue.shift();
  if (!next) return;
  runningTask = next;
  execute(next).catch((error) => {
    finalize(next, { state: "failed", error: { code: "BRIDGE_ERROR", message: String(error?.message || error) } });
  }).finally(() => {
    runningTask = null;
    pump();
  });
}

/**
 * 跑一次渲染。命令行按数组传递，超时后杀进程树——Windows 上只 kill 父进程会让
 * Blender 子进程残留，下次渲染直接卡死。
 */
function execute(task) {
  return new Promise((resolveRun) => {
    const found = findBlenderExe();
    if (!found.exe) {
      finalize(task, { state: "failed", error: { code: "BLENDER_NOT_FOUND", message: "未找到 Blender，请设置 BLENDER_EXE。", probed: found.probed } });
      resolveRun();
      return;
    }

    task.state = "running";
    task.startedAt = Date.now();
    task.workDir = mkdtempSync(join(tmpdir(), "blender-bridge-"));
    const out = join(task.workDir, `${task.id}.mp4`);
    // 关键帧走文件：几十 KB 的 JSON 塞进 argv 会撞 Windows 的 8191 字符上限
    let shotPath = null;
    if (task.params.shot) {
      shotPath = join(task.workDir, "shot.json");
      writeFileSync(shotPath, JSON.stringify(task.params.shot), "utf8");
    }
    const args = buildBlenderArgs(task.params, { renderScript: RENDER_SCRIPT, out, shotPath });

    const child = spawn(found.exe, args, {
      cwd: task.workDir,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    task.child = child;

    let stderrTail = "";
    let timeoutHit = false;
    const timer = setTimeout(() => {
      timeoutHit = true;
      killProcessTree(child);
    }, task.params.timeoutMs);

    createInterface({ input: child.stdout }).on("line", (line) => {
      const parsed = parseBlenderLine(line);
      if (!parsed) return;
      if (parsed.prefix === "PROGRESS") {
        task.progress = parsed.payload;
      } else if (parsed.prefix === "RESULT") {
        task.resultPayload = parsed.payload;
      } else if (parsed.prefix === "ERROR") {
        task.errorPayload = parsed.payload;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finalize(task, {
        state: "failed",
        error: { code: "BLENDER_SPAWN_FAILED", message: `启动 Blender 失败：${error.message}` },
        stderr: stderrTail,
      });
      resolveRun();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      task.exitCode = code;
      task.signal = signal || null;
      if (task.cancelRequested) {
        finalize(task, { state: "canceled", error: { code: "CANCELED", message: "任务已取消。" } });
        resolveRun();
        return;
      }
      if (timeoutHit) {
        finalize(task, {
          state: "failed",
          error: { code: "RENDER_TIMEOUT", message: `渲染超过 ${Math.round(task.params.timeoutMs / 1000)} 秒，已终止进程树。` },
          stderr: stderrTail,
        });
        resolveRun();
        return;
      }
      const produced = task.resultPayload?.out && existsSync(task.resultPayload.out) ? task.resultPayload : null;
      if (code === 0 && produced) {
        finalize(task, {
          state: "succeeded",
          mediaPath: produced.out,
          bytes: statSync(produced.out).size,
          meta: produced,
        });
      } else {
        const error = task.errorPayload || {
          code: "RENDER_FAILED",
          message: `${describeExitCode(code)}${signal ? `（信号 ${signal}）` : ""}`,
        };
        finalize(task, { state: "failed", error, stderr: stderrTail });
      }
      resolveRun();
    });
  });
}

/** Windows 上必须 taskkill /T 才能带走 Blender 的子进程；其他平台按进程组杀。 */
function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 进程已经退出 */
    }
  }
}

/** 收尾：写终态、清理临时目录（保留任务记录以便轮询取结果）。 */
function finalize(task, patch) {
  Object.assign(task, patch);
  task.finishedAt = Date.now();
  task.child = null;
  if (task.workDir && !KEEP_TEMP && (task.state !== "succeeded" || !task.mediaPath)) {
    rmSync(task.workDir, { recursive: true, force: true });
    task.workDir = null;
  }
}

function taskView(task) {
  return {
    ok: true,
    taskId: task.id,
    state: task.state,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
    progress: task.progress || null,
    shot: task.params?.shot
      ? {
          preset: task.params.shot.preset || "as_is",
          camera: task.params.shot.camera || null,
          keys: task.params.shot.keys?.length ?? 0,
          warnings: task.params.shot.warnings?.length ? task.params.shot.warnings : undefined,
        }
      : null,
    result: task.state === "succeeded"
      ? { bytes: task.bytes, frames: task.meta?.frames ?? null, fps: task.meta?.fps ?? null, mediaPath: `/render/${task.id}/media`, shot: task.meta?.shot ?? null }
      : null,
    error: task.error || null,
    stderr: task.stderr ? task.stderr.slice(-1200) : undefined,
  };
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length, "Cache-Control": "no-store" });
  res.end(payload);
}

/**
 * 判断 child 是否落在 parent 之内（含相等）。
 * Windows 的文件名不区分大小写，直接比字符串会误判，先统一小写。
 */
function isInsideDir(parent, child) {
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rel = relative(normalize(parent), normalize(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 扫一个目录下的 `.blend`，最多两层——美术工程一般是「项目/子目录/场景.blend」。
 * 按修改时间倒序，最近改动的排最前，符合「接着上次那个工程继续」的直觉。
 */
async function listScenes(rootDir, options = {}) {
  const limit = options.limit || 60;
  const maxDepth = options.depth ?? 2;
  const found = [];

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
        continue;
      }
      if (!/\.blend$/i.test(entry.name)) continue;
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        found.push({ name: entry.name, path: full, bytes: info.size, mtime: info.mtimeMs });
      } catch {
        // 单个文件读不到不该让整次列举失败（权限、正在被 Blender 写入都可能）
      }
    }
  }

  await walk(rootDir, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return { total: found.length, scenes: found.slice(0, limit) };
}


/** 读请求体并限制大小：这个端口只接受本机脚本调用，不需要处理大文件。 */
function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !tooLarge) {
        tooLarge = true;
        rejectBody(Object.assign(new Error("请求体过大。"), { status: 413, code: "BODY_TOO_LARGE" }));
        return;
      }
      if (tooLarge) return;
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(Object.assign(new Error("请求体不是合法 JSON。"), { status: 400, code: "BAD_JSON" }));
      }
    });
    req.on("error", (error) => rejectBody(error));
  });
}

function createPoseScene(data) {
  const found = findBlenderExe();
  if (!found.exe) {
    return Promise.reject(Object.assign(new Error("未找到 Blender，请设置 BLENDER_EXE。"), { status: 503, code: "BLENDER_NOT_FOUND" }));
  }
  if (!existsSync(POSE_SCENE_SCRIPT)) {
    return Promise.reject(Object.assign(new Error(`姿态场景脚本不存在：${POSE_SCENE_SCRIPT}`), { status: 500, code: "POSE_SCENE_SCRIPT_MISSING" }));
  }

  mkdirSync(SCENE_ROOT, { recursive: true });
  const baseName = safeSceneBaseName(data.sceneName);
  const fileName = `${baseName}_${Date.now()}_${randomUUID().slice(0, 8)}.blend`;
  const outputPath = join(SCENE_ROOT, fileName);
  const workDir = mkdtempSync(join(tmpdir(), "blender-pose-"));
  const inputPath = join(workDir, "pose.json");
  writeFileSync(inputPath, JSON.stringify(data), "utf8");

  return new Promise((resolveScene, rejectScene) => {
    let settled = false;
    let timedOut = false;
    let stderrTail = "";
    const child = spawn(
      found.exe,
      ["--background", "--python", POSE_SCENE_SCRIPT, "--", "--input", inputPath, "--output", outputPath],
      { cwd: workDir, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, 120000);
    const finish = (error, scene) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(workDir, { recursive: true, force: true });
      if (error) {
        rmSync(outputPath, { force: true });
        rejectScene(error);
      } else {
        resolveScene(scene);
      }
    };
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => {
      finish(Object.assign(new Error(`启动 Blender 失败：${error.message}`), { status: 500, code: "BLENDER_SPAWN_FAILED" }));
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(Object.assign(new Error("生成 Blender 场景超过 120 秒，已终止进程。"), { status: 504, code: "POSE_SCENE_TIMEOUT" }));
        return;
      }
      if (code !== 0 || !existsSync(outputPath)) {
        const detail = stderrTail.trim();
        finish(
          Object.assign(new Error(`Blender 生成人偶场景失败${detail ? `：${detail}` : `（退出码 ${code}）`}`), {
            status: 500,
            code: "POSE_SCENE_FAILED",
          }),
        );
        return;
      }
      const file = statSync(outputPath);
      finish(null, { name: fileName, path: outputPath, bytes: file.size, mtime: file.mtimeMs });
    });
  });
}

/** 产物下载支持 Range，浏览器预览视频时会先发 range 请求。 */
function sendMedia(req, res, task) {
  const size = task.bytes;
  const range = req.headers.range;
  const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(task.mediaPath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  createReadStream(task.mediaPath).pipe(res);
}

async function handle(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (NET.security) {
    const origin = req.headers.origin;
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || !origin || !Object.hasOwn(NET.security.origins, origin)) {
      sendJson(res, 403, { ok: false, code: "ORIGIN_FORBIDDEN", message: "Host 或网页 Origin 未获本机授权。" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!validSecureToken(NET.security, origin, req.headers.authorization)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "桥接凭证缺失或错误，请在本机重新授权该网页并粘贴凭证。" });
      return;
    }
  } else {
  // 画布面板在浏览器里直连本服务，缺了跨域头连 /health 都读不到
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
  // 预检请求不带 Authorization，必须排在鉴权之前，否则一配 token 浏览器就连不上
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (NET.tokenEnforced && req.headers.authorization !== `Bearer ${NET.token}`) {
    sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", message: "缺少或错误的 Bearer token（本实例设置了 BLENDER_TOKEN）。" });
    return;
  }
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    const health = await buildHealth();
    sendJson(res, health.status, health.body);
    return;
  }

  // 预设目录：前端面板的下拉框直接读这里，避免前后端各维护一份运镜文案
  if (req.method === "GET" && path === "/presets") {
    sendJson(res, 200, { ok: true, presets: PRESETS });
    return;
  }

  // 场景库：浏览器拿不到本地 .blend 的磁盘路径，只能由服务端列目录给面板选
  if (req.method === "GET" && path === "/scenes") {
    const requested = String(url.searchParams.get("dir") || "").trim();
    const root = requested || SCENE_ROOT;
    if (!root) {
      sendJson(res, 200, { ok: true, dir: "", total: 0, scenes: [], hint: "未配置 BLENDER_SCENE_DIR，可用 ?dir= 指定一个绝对路径。" });
      return;
    }
    const absolute = resolve(root);
    // 集中模式下能访问端口的任何人都能发请求，不该让人顺手列整台机器的文件树
    if (requested && NET.shared) {
      if (!SCENE_ROOT) {
        sendJson(res, 403, { ok: false, code: "DIR_FORBIDDEN", message: "集中模式下请先配置 BLENDER_SCENE_DIR，再用 ?dir= 在其内部浏览。" });
        return;
      }
      if (!isInsideDir(resolve(SCENE_ROOT), absolute)) {
        sendJson(res, 403, { ok: false, code: "DIR_FORBIDDEN", message: `集中模式下只能列举 ${resolve(SCENE_ROOT)} 之内的目录。` });
        return;
      }
    }
    if (!existsSync(absolute)) {
      sendJson(res, 404, { ok: false, code: "DIR_NOT_FOUND", message: `目录不存在：${absolute}` });
      return;
    }
    const listed = await listScenes(absolute);
    sendJson(res, 200, { ok: true, dir: absolute, total: listed.total, scenes: listed.scenes });
    return;
  }

  if (req.method === "POST" && path === "/scenes/from-pose") {
    if (poseSceneRunning) {
      sendJson(res, 429, { ok: false, code: "POSE_SCENE_BUSY", message: "已有一个姿态场景正在生成，请稍后重试。" });
      return;
    }
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    const validation = validatePoseScenePayload(body);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, code: validation.code, message: validation.message });
      return;
    }
    if (poseSceneRunning) {
      sendJson(res, 429, { ok: false, code: "POSE_SCENE_BUSY", message: "已有一个姿态场景正在生成，请稍后重试。" });
      return;
    }
    poseSceneRunning = true;
    try {
      const scene = await createPoseScene(validation.value);
      sendJson(res, 201, { ok: true, scene });
    } finally {
      poseSceneRunning = false;
    }
    return;
  }

  // 机位列表：档二的数据源。主动探测不吃缓存，用户点「刷新」时应该真的重读文件
  if (req.method === "GET" && path === "/probe") {
    const scene = String(url.searchParams.get("scene") || DEFAULT_SCENE || "").trim();
    if (!scene) {
      sendJson(res, 400, { ok: false, code: "MISSING_SCENE", message: "请用 ?scene= 指定 .blend 路径。" });
      return;
    }
    if (!/\.blend$/i.test(scene)) {
      sendJson(res, 400, { ok: false, code: "BAD_SCENE", message: "scene 必须是 .blend 文件路径。" });
      return;
    }
    const probe = await probeScene(scene, { ttlMs: 0 });
    if (!probe.ok) {
      sendJson(res, probe.code === "SCENE_NOT_FOUND" ? 404 : 503, { ok: false, code: probe.code, message: probe.message });
      return;
    }
    sendJson(res, 200, probe.value);
    return;
  }

  if (req.method === "POST" && path === "/render") {
    const found = findBlenderExe();
    if (!found.exe) {
      sendJson(res, 503, { ok: false, code: "BLENDER_NOT_FOUND", message: "未找到 Blender，请设置 BLENDER_EXE。", probed: found.probed });
      return;
    }
    if (!existsSync(RENDER_SCRIPT)) {
      sendJson(res, 500, { ok: false, code: "RENDER_SCRIPT_MISSING", message: `渲染脚本不存在：${RENDER_SCRIPT}` });
      return;
    }
    const body = await readJsonBody(req);
    const normalized = normalizeRenderParams(body, { defaultScene: DEFAULT_SCENE, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
    if (!normalized.ok) {
      sendJson(res, 400, { ok: false, code: normalized.code, message: normalized.message });
      return;
    }
    const params = normalized.value;

    // 带 shot 就走运镜：这里做展开与校验，让参数错误在提交时就返回 400，而不是排队失败
    if (body && body.shot !== undefined && body.shot !== null) {
      const prepared = await prepareShot(body.shot, params);
      if (!prepared.ok) {
        sendJson(res, 400, { ok: false, code: prepared.code, message: prepared.message });
        return;
      }
      Object.assign(params, prepared.patch);
    }

    const task = {
      id: randomUUID(),
      state: "queued",
      createdAt: Date.now(),
      params,
      progress: null,
    };
    tasks.set(task.id, task);
    queue.push(task);
    // 先回任务号再开始渲染：画布脚本的 create 阶段不允许阻塞等待
    sendJson(res, 202, { ok: true, taskId: task.id, state: task.state, position: queue.length });
    setImmediate(pump);
    return;
  }

  const match = /^\/render\/([A-Za-z0-9-]+)(\/media)?$/.exec(path);
  if (match) {
    const task = tasks.get(match[1]);
    if (!task) {
      sendJson(res, 404, { ok: false, code: "TASK_NOT_FOUND", message: "没有这个任务。" });
      return;
    }
    if (match[2]) {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", message: "只支持 GET。" });
        return;
      }
      if (task.state !== "succeeded" || !task.mediaPath || !existsSync(task.mediaPath)) {
        sendJson(res, 409, { ok: false, code: "MEDIA_NOT_READY", state: task.state, message: "产物还没就绪。" });
        return;
      }
      sendMedia(req, res, task);
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, taskView(task));
      return;
    }
    if (req.method === "DELETE") {
      if (task.state === "queued") {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        finalize(task, { state: "canceled", error: { code: "CANCELED", message: "任务在排队中被取消。" } });
      } else if (task.state === "running") {
        task.cancelRequested = true;
        killProcessTree(task.child);
      }
      sendJson(res, 200, taskView(task));
      return;
    }
  }

  sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: `没有这个路由：${req.method} ${path}` });
}

/** 定期清理过期任务与临时产物，避免长时间运行后目录里堆满几百 MB 的 mp4。 */
function startJanitor() {
  setInterval(() => {
    const now = Date.now();
    for (const [id, task] of tasks) {
      if (!task.finishedAt || now - task.finishedAt < TASK_RETENTION_MS) continue;
      if (task.workDir) rmSync(task.workDir, { recursive: true, force: true });
      if (task.mediaPath && existsSync(task.mediaPath)) rmSync(task.mediaPath, { force: true });
      tasks.delete(id);
    }
  }, 300000).unref();
}

export function startBridge({ secureLocal = process.env.BLENDER_LOCAL_SECURE === "1" } = {}) {
  // 端口与监听地址都在启动时读取，测试与多实例场景可以传 0 交给系统分配
  const addresses = listLanAddresses(networkInterfaces());
  NET = resolveNetwork(process.env, { port: Number(process.env.BLENDER_PORT || 13003), addresses });
  NET.bridgeInstanceId = randomUUID();
  if (secureLocal) {
    if (NET.bind !== "127.0.0.1" || NET.shared) throw new Error("安全本机模式只能监听 127.0.0.1，不能与共享模式或其他绑定地址一起使用。");
    NET.security = readSecurityConfig();
    NET.tokenEnforced = true;
  }
  mkdirSync(SCENE_ROOT, { recursive: true });

  // 要求鉴权却没给 token：直接拒绝启动，比启动后静默拒绝所有请求好排查
  if (NET.requireToken && !NET.token) {
    console.error("[blender-bridge] BLENDER_REQUIRE_TOKEN=1 但未设置 BLENDER_TOKEN，已中止启动。");
    process.exit(1);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, error?.status || 500, { ok: false, code: error?.code || "BRIDGE_ERROR", message: String(error?.message || error) });
    });
  });

  server.listen(NET.port, NET.bind, () => {
    const found = findBlenderExe();
    const actual = server.address()?.port ?? NET.port;
    const primary = NET.shared ? (NET.urls[0] || `http://${NET.bind}:${actual}`) : `http://127.0.0.1:${actual}`;
    console.log(`[blender-bridge] ${NET.shared ? "集中模式（局域网可访问）" : "本机模式（仅回环）"} → ${NET.bind}:${actual}`);
    console.log(`[blender-bridge] 画布 Base URL 填：${primary}`);
    if (NET.shared) {
      const others = listLanInterfaces(networkInterfaces()).filter((item) => `http://${item.address}:${actual}` !== primary);
      if (others.length) {
        console.log(`[blender-bridge] 其他可选地址：${others.map((item) => `${item.address} (${item.name})`).join("  ")}`);
      }
      console.log("[blender-bridge] 注意：scene 必须是运行本服务的这台机器上的 .blend 路径，不是客户端本地路径。");
    }
    console.log(`[blender-bridge] blender: ${found.exe || "未找到（请设置 BLENDER_EXE）"}`);
    console.log(`[blender-bridge] renderer: ${RENDER_SCRIPT}`);
    console.log(`[blender-bridge] 场景库: ${SCENE_ROOT ? resolve(SCENE_ROOT) : "未配置（面板将无法列 .blend，可设 BLENDER_SCENE_DIR）"}`);
    console.log(`[blender-bridge] 鉴权: ${NET.tokenEnforced ? "已开启（Bearer token）" : "未开启，任何能访问该端口的人都能提交渲染"}`);
    if (NET.security) console.log("[blender-bridge] 安全本机模式：请先运行 authorize <网页Origin>，完成后重启本服务。");
    for (const note of NET.notes) console.warn(`[blender-bridge] 提示：${note}`);
  });
  startJanitor();
  return server;
}

async function main() {
  if (process.argv[2] === "authorize") {
    const origin = normalizeAuthorizedOrigin(process.argv[3]);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("授权必须在本机交互式终端中确认。");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolveAnswer) => rl.question(`允许网页 ${origin} 操作本机 Blender？输入 yes 确认：`, resolveAnswer));
    rl.close();
    if (answer.trim() !== "yes") throw new Error("未确认，未授权。");
    const token = authorizeOrigin(origin);
    console.log(`仅显示一次的凭证（粘贴到该网页的 Blender 连接设置）：\n${token}\n请重启安全模式桥接；不要分享此凭证。`);
    return;
  }
  const arg = process.argv[2];
  if (arg && arg !== "--secure-local" && arg !== "--legacy-local") throw new Error("用法：infinite-canvas-blender-bridge [--secure-local | --legacy-local | authorize <网页Origin>]");
  const network = resolveNetwork(process.env);
  const secureLocal = arg === "--secure-local" || (arg !== "--legacy-local" && !network.shared);
  startBridge({ secureLocal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[blender-bridge] ${error.message}`); process.exitCode = 1; });
}
