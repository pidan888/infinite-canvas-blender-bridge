/**
 * 镜头描述（Shot Spec）层：把「推近 / 环绕 / 摇镜」这类人话翻成相机关键帧。
 *
 * 为什么关键帧数学在 JS 而不在 bpy 脚本里：
 *  · 需要能单测——运镜算错在画布上表现为「镜头怪怪的」，很难归因
 *  · 需要能被前端复用——面板要画轨迹预览，不能只存在 Blender 那一侧
 *  · 渲染器保持笨——它只负责「把给定关键帧插进去再渲」，不参与运动设计
 *
 * 一条硬规则，所有预设都遵守：**动位置的只改位置，动朝向的只改朝向**。
 * 两者同时变会让第一帧就跳，用户看到的第一个画面和预设选之前的预览对不上。
 */

const DEG = Math.PI / 180;
const UP = Object.freeze([0, 0, 1]);

/** 预设目录。前端面板直接拿它渲染下拉框，别在 UI 里再维护一份文案。 */
export const PRESETS = [
    { id: "push_in", label: "推近", hint: "沿视线靠近主体，构图不变、主体变大", axis: "position" },
    { id: "pull_out", label: "拉远", hint: "沿视线后退，逐渐露出环境", axis: "position" },
    { id: "pan_left", label: "左摇", hint: "机位不动，镜头向左转", axis: "target" },
    { id: "pan_right", label: "右摇", hint: "机位不动，镜头向右转", axis: "target" },
    { id: "tilt_up", label: "上摇", hint: "机位不动，镜头向上抬", axis: "target" },
    { id: "tilt_down", label: "下摇", hint: "机位不动，镜头向下压", axis: "target" },
    { id: "truck_left", label: "左移", hint: "平行向左平移，透视会变、适合交代纵深", axis: "position" },
    { id: "truck_right", label: "右移", hint: "平行向右平移", axis: "position" },
    { id: "crane_up", label: "升镜", hint: "垂直上升并俯视主体，适合交代空间", axis: "position" },
    { id: "crane_down", label: "降镜", hint: "垂直下降并仰视主体", axis: "position" },
    { id: "orbit_left", label: "左环绕", hint: "绕主体转四分之一圈以内，主体始终在画面中央", axis: "position" },
    { id: "orbit_right", label: "右环绕", hint: "反向环绕", axis: "position" },
    { id: "zoom_in", label: "变焦推", hint: "机位不动只改焦距，景深会一起变", axis: "lens" },
    { id: "zoom_out", label: "变焦拉", hint: "机位不动只改焦距", axis: "lens" },
    { id: "static", label: "固定机位", hint: "不运镜，只把当前机位拍满整段", axis: "none" },
];

const PRESET_IDS = new Set(PRESETS.map((item) => item.id));
const EASINGS = new Set(["linear", "easeIn", "easeOut", "easeInOut"]);

/* ------------------------------ 向量小工具 ------------------------------ */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a) => Math.sqrt(dot(a, a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize(a) {
    const len = length(a);
    return len < 1e-9 ? [0, 0, 0] : scale(a, 1 / len);
}

/** 罗德里格旋转公式：绕单位轴转 angle 弧度。不引入矩阵库，够用且好测。 */
function rotateAround(vector, axis, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return add(add(scale(vector, cos), scale(cross(axis, vector), sin)), scale(axis, dot(axis, vector) * (1 - cos)));
}

const round3 = (a) => a.map((value) => Math.round(value * 1000) / 1000);

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function asVector(input) {
    if (!Array.isArray(input) || input.length !== 3) return null;
    const numbers = input.map(Number);
    return numbers.every((value) => Number.isFinite(value)) ? numbers : null;
}

/* ------------------------------ 位姿与预设 ------------------------------ */

/** 归一化相机起始位姿。focal 缺失时按 35mm 处理，和 Blender 默认一致。 */
export function normalizePose(input) {
    if (!input || typeof input !== "object") return null;
    const pos = asVector(input.pos);
    const target = asVector(input.target);
    if (!pos || !target) return null;
    const focal = Number(input.focal);
    return { pos, target, focal: Number.isFinite(focal) && focal > 0 ? Math.min(300, Math.max(8, focal)) : 35 };
}

/**
 * 把一个预设展开成两个关键帧（起点 + 终点）。
 * 只出两帧是刻意的：中间插值交给 Blender 的曲线，帧数越少越不会有奇怪的顿挫。
 */
export function expandPreset(options = {}) {
    const preset = String(options.preset || "").trim();
    if (!PRESET_IDS.has(preset)) {
        return { ok: false, code: "BAD_PRESET", message: `未知运镜「${preset}」，可用：${PRESETS.map((item) => item.id).join(" / ")}` };
    }
    const pose = normalizePose(options.pose);
    if (!pose) return { ok: false, code: "BAD_POSE", message: "缺少相机起始位姿（pos / target 需为三元数组）。" };

    const durationSec = clampNumber(options.durationSec, 0.5, 120, 6);
    const strength = clampNumber(options.strength, 0, 1, 0.5);
    const easing = normalizeEasing(options.easing);

    const offset = sub(pose.target, pose.pos);
    const distance = length(offset);
    if (distance < 1e-4) {
        return { ok: false, code: "DEGENERATE_POSE", message: "相机位置与注视点重合，无法推算运镜方向。" };
    }
    const forward = normalize(offset);
    let right = normalize(cross(forward, UP));
    // 镜头几乎垂直朝上/下时 cross 会退化成零向量，换一个参考轴重建右手系
    if (length(right) < 1e-6) right = normalize(cross(forward, [0, 1, 0]));

    const end = { pos: [...pose.pos], target: [...pose.target], focal: pose.focal };

    switch (preset) {
        case "push_in":
            end.pos = add(pose.pos, scale(forward, distance * 0.5 * strength));
            break;
        case "pull_out":
            end.pos = add(pose.pos, scale(forward, -distance * 0.5 * strength));
            break;
        case "pan_left":
            end.target = add(pose.pos, rotateAround(offset, UP, Math.max(0.05, strength) * 45 * DEG));
            break;
        case "pan_right":
            end.target = add(pose.pos, rotateAround(offset, UP, -Math.max(0.05, strength) * 45 * DEG));
            break;
        case "tilt_up":
            end.target = add(pose.pos, rotateAround(offset, right, Math.max(0.05, strength) * 30 * DEG));
            break;
        case "tilt_down":
            end.target = add(pose.pos, rotateAround(offset, right, -Math.max(0.05, strength) * 30 * DEG));
            break;
        case "truck_left":
            end.pos = add(pose.pos, scale(right, -distance * 0.4 * strength));
            break;
        case "truck_right":
            end.pos = add(pose.pos, scale(right, distance * 0.4 * strength));
            break;
        case "crane_up":
            end.pos = add(pose.pos, scale(UP, distance * 0.4 * strength));
            break;
        case "crane_down":
            end.pos = add(pose.pos, scale(UP, -distance * 0.4 * strength));
            break;
        case "orbit_left":
        case "orbit_right": {
            // 绕注视点转，注视点保持不动——这样第一帧和预览完全一致，不会跳。
            // 半径向量是 (相机 - 目标)，方向与视线相反，所以「相机向左」要取负角，
            // 不能照搬 pan 的正负号，否则预设名和实际运动方向正好相反。
            const radius = sub(pose.pos, pose.target);
            const angle = (preset === "orbit_left" ? -1 : 1) * Math.max(0.05, strength) * 90 * DEG;
            end.pos = add(pose.target, rotateAround(radius, UP, angle));
            break;
        }
        case "zoom_in":
            end.focal = Math.min(300, pose.focal * (1 + 0.5 * strength));
            break;
        case "zoom_out":
            end.focal = Math.max(8, pose.focal / (1 + 0.5 * strength));
            break;
        case "static":
        default:
            break;
    }

    const keyAt = (t, value) => ({ t, pos: round3(value.pos), target: round3(value.target), focal: Math.round(value.focal * 100) / 100 });
    const warnings = [];
    if (preset === "orbit_left" || preset === "orbit_right") {
        if (strength >= 1) warnings.push("环绕 90° 已接近侧后方视角，若主体背面没做，会看到穿帮。");
    }
    if (preset === "push_in" && strength >= 0.9) warnings.push("推近幅度较大，可能穿进主体几何内部。");

    return { ok: true, value: { preset, durationSec, strength, easing, keys: [keyAt(0, pose), keyAt(durationSec, end)], warnings } };
}

function normalizeEasing(value) {
    const text = String(value || "easeInOut").trim();
    return EASINGS.has(text) ? text : "easeInOut";
}

/* ------------------------------ 校验 ------------------------------ */

const fail = (code, message) => ({ ok: false, code, message });

/**
 * 校验外部传入的镜头描述。返回 { ok, value } 或 { ok:false, code, message }。
 * 三种合法输入：preset（桥接自己展开）、keys（已展开的显式关键帧）、都没有则视为固定机位。
 */
export function normalizeShot(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return fail("BAD_SHOT", "shot 必须是对象。");
    }

    const durationSec = clampNumber(input.durationSec, 0.5, 120, 6);
    if (Number(input.durationSec) !== undefined && Number.isFinite(Number(input.durationSec))) {
        const raw = Number(input.durationSec);
        if (raw < 0.5 || raw > 120) return fail("BAD_DURATION", "durationSec 取 0.5–120 秒。");
    }

    const rawFps = Number(input.fps);
    if (Number.isFinite(rawFps) && rawFps !== 0 && (rawFps < 6 || rawFps > 60)) {
        return fail("BAD_FPS", "shot.fps 取 6–60，或留空沿用渲染帧率。");
    }
    const fps = Number.isFinite(rawFps) && rawFps > 0 ? rawFps : 0;

    const strength = clampNumber(input.strength, 0, 1, 0.5);
    const easing = normalizeEasing(input.easing);
    const camera = String(input.camera || "").trim();
    const preset = String(input.preset || "").trim();
    const warnings = [];

    let presetValue = preset;
    if (presetValue && !PRESET_IDS.has(presetValue)) {
        return fail("BAD_PRESET", `未知运镜「${presetValue}」，可用：${PRESETS.map((item) => item.id).join(" / ")}`);
    }

    let keys = null;
    if (Array.isArray(input.keys) && input.keys.length) {
        const checked = normalizeKeys(input.keys, durationSec);
        if (!checked.ok) return checked;
        keys = checked.value;
        warnings.push(...checked.warnings);
        // 显式关键帧优先于预设，预设名只作为标签回显
    }
    // 既不传 keys 也不传 preset 时 preset 保持空串，语义是「沿用相机自带的动画」。
    // 这和「固定机位」是两件事：后者会覆盖掉美术 K 好的运镜，不能当默认值。

    return {
        ok: true,
        value: { preset: presetValue, camera, durationSec, fps, strength, easing, keys, warnings },
    };
}

function normalizeKeys(rawKeys, durationSec) {
    if (rawKeys.length < 2) return fail("BAD_KEYS", "显式关键帧至少要有 2 个，否则没有运动。");
    if (rawKeys.length > 64) return fail("BAD_KEYS", "显式关键帧最多 64 个，再多请用预设或拆镜头。");

    const keys = [];
    for (let index = 0; index < rawKeys.length; index += 1) {
        const item = rawKeys[index];
        if (!item || typeof item !== "object") return fail("BAD_KEYS", `第 ${index + 1} 个关键帧不是对象。`);
        const t = Number(item.t);
        if (!Number.isFinite(t)) return fail("BAD_KEYS", `第 ${index + 1} 个关键帧缺少 t（秒）。`);
        if (t < 0 || t > durationSec + 1e-6) return fail("BAD_KEYS", `第 ${index + 1} 个关键帧的 t=${t} 超出 0–${durationSec} 秒。`);
        const pos = asVector(item.pos);
        const target = asVector(item.target);
        if (!pos || !target) return fail("BAD_KEYS", `第 ${index + 1} 个关键帧的 pos / target 需为三元数组。`);
        const focal = clampNumber(item.focal, 8, 300, 35);
        if (index > 0 && t <= keys[index - 1].t) return fail("BAD_KEYS", `关键帧时间必须严格递增（第 ${index + 1} 个 t=${t}）。`);
        keys.push({ t, pos: round3(pos), target: round3(target), focal: Math.round(focal * 100) / 100 });
    }

    const warnings = [];
    if (keys[0].t > 1e-6) {
        keys.unshift({ ...keys[0], t: 0 });
        warnings.push("首个关键帧不在 0 秒，已复制一份到 0 秒，避免开头静止。");
    }
    const last = keys[keys.length - 1];
    if (Math.abs(last.t - durationSec) > 0.25) {
        warnings.push(`最后关键帧在 ${last.t} 秒，与时长 ${durationSec} 秒不一致；末端会保持最后一帧。`);
    }
    for (let index = 1; index < keys.length; index += 1) {
        const jump = length(sub(keys[index].pos, keys[index - 1].pos));
        if (jump > 50) warnings.push(`第 ${index} 到 ${index + 1} 个关键帧位移 ${Math.round(jump)} 单位，画面可能瞬移。`);
    }
    return { ok: true, value: keys, warnings };
}

/** 由镜头时长推帧范围。帧率优先级：镜头自带 > 渲染参数 > 场景默认。 */
export function deriveFrames(shot, renderFps) {
    const fps = shot.fps || renderFps || 24;
    const frames = Math.max(2, Math.round(shot.durationSec * fps));
    return { fps, frames, start: 1, end: frames };
}
