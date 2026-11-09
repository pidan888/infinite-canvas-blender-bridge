/**
 * Blender 桥接的纯函数层：探测可执行文件、校验参数、拼装命令行、解析渲染器输出。
 * 与 HTTP 服务分开，便于单测；这里不做任何 I/O 之外的状态维护。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 渲染器认定的引擎名，多一个少一个都会被它判成 ENGINE_UNSUPPORTED。 */
export const ENGINES = ["workbench", "eevee", "cycles"];

/** 渲染器默认背景色，传默认值时省略该参数，减少命令行噪声。 */
const DEFAULT_BACKGROUND = "#70747C";

/**
 * 按顺序收集候选 Blender 路径：环境变量优先，其次常见安装位置，最后是 PATH。
 * 只做存在性判断，不启动进程，因此可以在 1 秒内给出结论。
 */
export function collectBlenderCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  const push = (value, source) => {
    if (typeof value === "string" && value.trim()) candidates.push({ exe: value.trim(), source });
  };

  push(env.BLENDER_EXE, "env:BLENDER_EXE");

  if (platform === "win32") {
    for (const root of [env["ProgramFiles"], env["ProgramFiles(x86)"], "C:/Program Files", "D:/Program Files"]) {
      if (!root) continue;
      const foundation = join(root, "Blender Foundation");
      if (!existsSync(foundation)) continue;
      for (const name of safeReadDir(foundation)) {
        push(join(foundation, name, "blender.exe"), `glob:${foundation}`);
      }
    }
    // 便携版通常放在非标准目录，扫一层常见根目录即可，不写死具体版本号；
    // 自定义位置用 BLENDER_SEARCH_DIRS（分号分隔）追加
    const portableRoots = String(env.BLENDER_SEARCH_DIRS || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
    portableRoots.push(
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
      "C:/Blender",
      "D:/Blender",
    );
    for (const root of portableRoots) {
      if (!root || !existsSync(root)) continue;
      for (const name of safeReadDir(root)) {
        if (!/^blender/i.test(name)) continue;
        push(join(root, name, "blender.exe"), `portable:${root}`);
      }
    }
  } else if (platform === "darwin") {
    push("/Applications/Blender.app/Contents/MacOS/Blender", "known:app");
    push("/Applications/Blender/Blender.app/Contents/MacOS/Blender", "known:app");
  } else {
    push("/usr/bin/blender", "known:system");
    push("/usr/local/bin/blender", "known:system");
    push("/snap/bin/blender", "known:snap");
  }

  // PATH 兜底：手动查目录，避免依赖 which/where 这类外部命令
  const binary = platform === "win32" ? "blender.exe" : "blender";
  for (const dir of String(env.PATH || "").split(platform === "win32" ? ";" : ":")) {
    if (dir.trim()) push(join(dir.trim(), binary), "env:PATH");
  }

  return candidates;
}

/** 读取目录并忽略无权限等异常，探测阶段不该因为一个目录读不了就整体失败。 */
function safeReadDir(dir) {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * 返回第一个真实存在的 Blender，同时带上探测过的完整路径清单。
 * 找不到时 exe 为 null，调用方据此立即报错，不要进入排队。
 */
export function findBlenderExe(env = process.env, platform = process.platform) {
  const candidates = collectBlenderCandidates(env, platform);
  const probed = candidates.map((item) => item.exe);
  const hit = candidates.find((item) => existsSync(item.exe));
  return { exe: hit?.exe || null, source: hit?.source || null, probed };
}

/** 从 `blender --version` 的首行提取版本号，解析不到返回空串。 */
export function parseBlenderVersion(text) {
  const match = String(text || "").match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : "";
}

/**
 * 校验并归一化一次渲染请求。所有字段都来自外部输入，必须逐项限制取值范围；
 * 返回 { ok: true, value } 或 { ok: false, code, message }。
 */
export function normalizeRenderParams(body, options = {}) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const fail = (code, message) => ({ ok: false, code, message });

  const scene = String(input.scene || options.defaultScene || "").trim();
  if (!scene) return fail("MISSING_SCENE", "缺少 scene（.blend 路径），请传 scene 或设置 BLENDER_DEFAULT_SCENE。");
  if (!/\.blend$/i.test(scene)) return fail("BAD_SCENE", "scene 必须是 .blend 文件路径。");
  if (!existsSync(scene)) return fail("SCENE_NOT_FOUND", `找不到场景文件：${scene}`);

  const engine = String(input.engine || "workbench").toLowerCase();
  if (!ENGINES.includes(engine)) return fail("BAD_ENGINE", `engine 只支持 ${ENGINES.join(" / ")}。`);

  const res = String(input.res || "").trim();
  if (res && !/^\d{2,5}x\d{2,5}$/i.test(res)) return fail("BAD_RESOLUTION", "res 形如 1280x720。");

  const background = String(input.background || DEFAULT_BACKGROUND).trim();
  if (!/^#[0-9a-f]{6}$/i.test(background)) return fail("BAD_BACKGROUND", "background 形如 #70747C。");

  const start = toInt(input.start, 0);
  const end = toInt(input.end, 0);
  if (start < 0 || end < 0) return fail("BAD_FRAME_RANGE", "帧号不能为负。");
  if (start > 0 && end > 0 && end < start) return fail("BAD_FRAME_RANGE", `结束帧 ${end} 小于起始帧 ${start}。`);

  const fps = toNumber(input.fps, 0);
  if (fps < 0) return fail("BAD_FPS", "fps 不能为负。");

  const percent = toInt(input.percent, 100);
  if (percent < 1 || percent > 100) return fail("BAD_PERCENT", "percent 取 1–100。");

  const samples = toInt(input.samples, 0);
  if (samples < 0) return fail("BAD_SAMPLES", "samples 不能为负。");

  const timeoutMs = toInt(input.timeoutMs, options.defaultTimeoutMs || 600000);
  if (timeoutMs < 1000 || timeoutMs > 3600000) return fail("BAD_TIMEOUT", "timeoutMs 取 1000–3600000。");

  return {
    ok: true,
    value: {
      scene,
      camera: String(input.camera || "").trim(),
      start,
      end,
      fps,
      res,
      percent,
      engine,
      samples,
      background,
      timeoutMs,
    },
  };
}

function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 拼装 Blender 命令行。**必须返回数组**：`.blend` 路径来自用户输入，
 * 任何字符串拼接都会留下命令注入口子，这是接入规范里的验收点之一。
 */
export function buildBlenderArgs(params, paths) {
  const args = ["-b", "-P", paths.renderScript, "--", "--scene", params.scene, "--out", paths.out];
  // 镜头描述走文件而不是命令行：关键帧 JSON 可能有几十 KB，塞进 argv 会撞 Windows 8191 字符上限
  if (paths.shotPath) args.push("--shot", paths.shotPath);
  if (params.camera) args.push("--camera", params.camera);
  if (params.start > 0) args.push("--start", String(params.start));
  if (params.end > 0) args.push("--end", String(params.end));
  if (params.fps > 0) args.push("--fps", String(params.fps));
  if (params.res) args.push("--res", params.res);
  if (params.percent !== 100) args.push("--percent", String(params.percent));
  if (params.engine !== "workbench") args.push("--engine", params.engine);
  if (params.samples > 0) args.push("--samples", String(params.samples));
  if (params.background !== DEFAULT_BACKGROUND) args.push("--background", params.background);
  return args;
}

/** 解析渲染器 stdout 的四个前缀；不匹配的行（Blender 自身日志）直接忽略。 */
export function parseBlenderLine(line) {
  const match = String(line || "").match(/^(PROGRESS|RESULT|ERROR|PROBE)\s+(\{.*\})\s*$/);
  if (!match) return null;
  try {
    return { prefix: match[1], payload: JSON.parse(match[2]) };
  } catch {
    return null;
  }
}

/** 回环地址的写法不止一种，全部认作「只有本机能访问」。 */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"];

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(String(host || "").trim().toLowerCase());
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * 解析监听配置。优先级：`BLENDER_BIND` 显式值 > `BLENDER_SHARED=1` > 默认回环。
 *
 * 设计取向：**集中模式要省事**。设一个 `BLENDER_SHARED=1` 就绑到全网卡，
 * 不强制配 token——多机共用一个渲染机是内网场景，强制 token 只会让人改用
 * 更不安全的方式绕过去。想收紧再设 `BLENDER_TOKEN`，服务端自动开始校验。
 *
 * 返回 { port, bind, loopback, shared, token, tokenEnforced, requireToken, urls, notes }。
 */
export function resolveNetwork(env = process.env, options = {}) {
  const port = Number(env.BLENDER_PORT || options.port || 13003);
  const explicitBind = String(env.BLENDER_BIND || "").trim();
  const wantShared = truthy(env.BLENDER_SHARED);
  const bind = explicitBind || (wantShared ? "0.0.0.0" : "127.0.0.1");
  const loopback = isLoopbackHost(bind);
  const token = String(env.BLENDER_TOKEN || "").trim();
  const requireToken = truthy(env.BLENDER_REQUIRE_TOKEN);

  const addresses = options.addresses || [];
  const urls = loopback ? [`http://127.0.0.1:${port}`] : addresses.map((address) => `http://${address}:${port}`);

  const notes = [];
  if (requireToken && !token) {
    notes.push("BLENDER_REQUIRE_TOKEN=1 但没有设置 BLENDER_TOKEN：启动会被拒绝，避免裸奔上线。");
  }
  if (!loopback && !token) {
    notes.push("集中模式未设 token：同网段任何人都能在这台机器上启动渲染。");
  }
  if (!loopback && bind !== "0.0.0.0" && bind !== "::") {
    notes.push(`已绑定到指定地址 ${bind}，只接受该网卡的连接。`);
  }

  return {
    port,
    bind,
    loopback,
    shared: !loopback,
    token,
    /** 配了 token 就校验；没配就不校验——不做「配了却不生效」这种反直觉设计。 */
    tokenEnforced: Boolean(token),
    requireToken,
    urls,
    notes,
  };
}

/** 虚拟网卡的关键词：这些网卡有地址，但同办公室的同事连不进来。 */
const VIRTUAL_IFACE = /vmware|virtualbox|hyper-?v|vethernet|tailscale|zerotier|hamachi|wsl|docker|loopback|tap|tun/i;

/**
 * 给一张网卡打分，用于决定「画布该填哪个地址」。
 * 顺序按真实可用性排：家用/办公常见的 192.168 最靠前，
 * CGNAT 与虚拟网卡垫底——它们能让本机自己连通，却最容易让人填错。
 */
function addressScore(address, name) {
  if (/^169\.254\./.test(address)) return 0; // APIPA，等于没配好
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 1; // CGNAT / Tailscale
  if (VIRTUAL_IFACE.test(String(name || ""))) return 2;
  if (/^192\.168\./.test(address)) return 6;
  if (/^10\./.test(address)) return 5;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 4;
  return 3; // 公网或未知网段，能用但不是内网首选
}

/**
 * 列出本机局域网地址，按「最可能被同事连上」的顺序排好，并带上网卡名便于回显。
 * 不排序会把 Tailscale 这类虚拟网卡排在前面，用户照着填必然连不上。
 */
export function listLanInterfaces(interfaces = {}) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const item of list || []) {
      if (!item || item.internal) continue;
      const family = typeof item.family === "string" ? item.family : `IPv${item.family}`;
      if (family !== "IPv4") continue;
      found.push({ address: item.address, name, score: addressScore(item.address, name) });
    }
  }
  // Array.prototype.sort 在 V8 上是稳定排序，同分时保留系统给出的网卡顺序
  return found.sort((a, b) => b.score - a.score).map(({ address, name }) => ({ address, name }));
}

/** 只要地址字符串的简版，给配置层用。 */
export function listLanAddresses(interfaces = {}) {
  return listLanInterfaces(interfaces).map((item) => item.address);
}

/** 把渲染器的退出码翻成可读原因，供失败任务直接回显给用户。 */
export function describeExitCode(code) {
  switch (code) {
    case 0:
      return "渲染完成";
    case 2:
      return "参数或场景错误";
    case 3:
      return "渲染失败";
    case 4:
      return "产物缺失";
    default:
      return code === null ? "进程被终止" : `Blender 退出码 ${code}`;
  }
}
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

/** 安全模式只接受明确的网页 Origin，不接受路径、通配符或 opaque origin。 */
export function normalizeAuthorizedOrigin(value) {
  const raw = String(value || "").trim();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || raw !== url.origin) {
    throw new Error("请输入完整的网页 Origin（例如 https://canvas.example.com:8443），不要包含路径或末尾斜杠。");
  }
  return url.origin;
}

export function securityDirectory(env = process.env) {
  return env.BLENDER_SECURITY_DIR || join(env.LOCALAPPDATA || homedir(), "InfiniteCanvas", "blender-bridge-security");
}

function protectSecurityDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("安全配置目录不能是符号链接。");
  if (process.platform === "win32") {
    const identity = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
    execFileSync("icacls.exe", [dir, "/reset"], { stdio: "ignore", windowsHide: true });
    execFileSync("icacls.exe", [dir, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
  } else {
    chmodSync(dir, 0o700);
  }
}

export function readSecurityConfig(env = process.env) {
  const file = join(securityDirectory(env), "authorized-origins.json");
  if (!existsSync(file)) return { origins: {} };
  if (lstatSync(file).isSymbolicLink()) throw new Error("安全配置文件不能是符号链接。");
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data || typeof data.origins !== "object" || !data.origins || Array.isArray(data.origins)) throw new Error("安全配置格式无效。");
  for (const [origin, token] of Object.entries(data.origins)) {
    if (normalizeAuthorizedOrigin(origin) !== origin || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("安全配置格式无效。");
  }
  return data;
}

/** 每次显式授权轮换该 Origin 的凭证，终端只显示新凭证一次。 */
export function authorizeOrigin(origin, env = process.env) {
  origin = normalizeAuthorizedOrigin(origin);
  const dir = securityDirectory(env);
  protectSecurityDirectory(dir);
  const file = join(dir, "authorized-origins.json");
  const config = readSecurityConfig(env);
  const token = randomBytes(32).toString("hex");
  config.origins[origin] = token;
  if (existsSync(file) && process.platform === "win32") {
    execFileSync("icacls.exe", [file, "/reset"], { stdio: "ignore", windowsHide: true });
  } else if (existsSync(file)) chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return token;
}

export function validSecureToken(config, origin, authorization) {
  const token = origin ? config.origins[origin] : null;
  const candidate = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(candidate));
}
