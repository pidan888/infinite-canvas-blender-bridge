# blender-bridge · 白模渲染桥接

画布的自定义模型脚本跑在 `canvas-proxy` 里，不能直接启动 Blender。
这个服务负责 **Blender 渲染队列、任务状态与 MP4 回传**，并接收浏览器本地提取的姿态点来生成独立人偶场景。

渲染命令行和编码由 `blender/render_clay.py` 决定。
本服务不做视频模型推理，也不修改用户已有 `.blend`；人偶场景由 `blender/create_pose_scene.py` 从姿态点单独构建。

源码与问题反馈：<https://github.com/pidan888/infinite-canvas-blender-bridge>

---

## 各自电脑使用本机桥接

每位用户在自己的电脑安装 Node.js 18 或以上以及 Blender。桥接默认只监听
`127.0.0.1:13003`，场景库和 Blender 均在该电脑，不需要把桥接端口暴露到局域网。
在运行 Blender 的电脑上打开终端：

```powershell
npx infinite-canvas-blender-bridge@latest authorize http://画布地址:3000
```

把示例地址替换为浏览器地址栏的实际 Origin（协议、域名或 IP 及端口；不要路径和末尾斜杠）。
确认地址无误后输入 `yes`，将终端只显示一次的凭证粘贴到画布的「本机桥接授权 / 凭证」。
凭证保存在当前浏览器本地，不要发送给同事。然后在终端运行：

授权命令必须在本机交互式终端中运行，标准输入和输出都需要是终端；管道、CI 和部分
IDE 任务不满足此要求。请在普通终端中手动确认，不要通过自动化绕过确认。

```powershell
npx infinite-canvas-blender-bridge@latest
```

保持该窗口运行；更换画布 Origin 需重新授权，修改授权后需重启桥接。同事访问同一个画布时，
各自都需要在自己的电脑执行上述步骤。从源码运行时，可在源码目录分别运行
`node index.js authorize <网页Origin>` 和 `node index.js`。

默认场景库为 `%LOCALAPPDATA%\InfiniteCanvas\blender-scenes`，也可使用 `BLENDER_SCENE_DIR`
指定。桥接探测不到 Blender 时可用 `BLENDER_EXE` 指向本机 `blender.exe`。
目前验收使用 Blender 5.2.x；尚未确定经验证的最低版本，其他版本的兼容性不能保证。
安全本机模式的 `/health` 也需要已授权的 Origin 和凭证，直接用浏览器地址栏或不带鉴权的
`curl` 请求会被拒绝，并不代表服务未启动。

连接失败时，先确认桥接终端仍在运行，并在 PowerShell 执行
`Get-NetTCPConnection -LocalPort 13003 -State Listen`。没有监听记录表示桥接未启动或已退出；
有监听但网页仍无法连接时，核对授权的 Origin、浏览器中保存的凭证，以及浏览器的本地网络访问权限。
页面实际地址与授权地址必须完全一致，包括端口；不要把桥接地址改为同事电脑的地址。
HTTPS 页面访问本机 HTTP 桥接的浏览器限制因环境而异，需在实际使用的 Edge 环境中验证。

---

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `BLENDER_EXE` | 空，自动探测 | 各机安装位置不同，禁止硬编码 |
| `BLENDER_SEARCH_DIRS` | 空 | 便携版装在非常规目录时，用分号分隔追加探测根目录 |
| `BLENDER_PORT` | `13003` | 桥接端口 |
| `BLENDER_SHARED` | 关 | **置 `1` 即进集中模式**，自动绑 `0.0.0.0`，不用再算绑定地址 |
| `BLENDER_BIND` | 跟随模式 | 想只开某张网卡时显式指定，优先级高于 `BLENDER_SHARED` |
| `BLENDER_TOKEN` | 空 | 设了就校验 `Authorization: Bearer <token>`；不设就不校验 |
| `BLENDER_REQUIRE_TOKEN` | 关 | 置 `1` 表示「必须有 token」，没配时**直接拒绝启动**而不是裸奔 |
| `BLENDER_DEFAULT_SCENE` | 空 | 不传 `scene` 时用这个 `.blend` |
| `BLENDER_SCENE_DIR` | 用户数据目录下的 `InfiniteCanvas/blender-scenes` | 场景库根目录；重建场景保存在这里，面板也从这里列出 `.blend` |
| `BLENDER_TIMEOUT_MS` | `600000` | 单次渲染超时；超时杀进程树 |
| `BLENDER_KEEP_TEMP` | 关 | 置 `1` 保留临时产物，便于排查 |
| `BLENDER_TASK_RETENTION_MS` | `3600000` | 完成的任务记录与产物保留时长 |
| `BLENDER_SECURITY_DIR` | 用户数据目录下的 `InfiniteCanvas/blender-bridge-security` | 本机授权配置目录；应仅供当前用户访问 |

自动探测顺序：`BLENDER_EXE` → `Program Files/Blender Foundation/*` → 便携安装根目录（`blender*`）→ `PATH`。
便携根目录默认查 `%LOCALAPPDATA%/Programs`、`C:/Blender`、`D:/Blender`，其他位置用 `BLENDER_SEARCH_DIRS` 指定。

### 两种模式

```bash
node index.js                      # 安全本机模式：Origin 和凭证授权
node index.js --legacy-local       # 兼容旧渠道脚本：仅回环，但不提供网页来源保护
BLENDER_SHARED=1 node index.js     # 集中模式：绑全网卡，同网段都能用
```

集中模式**不强制 token**——多机共用一个渲染机本来就是内网信任场景，强制配置只会让人改用更不安全的绕法。启动日志会明确写出当前是否鉴权，想收紧再设 `BLENDER_TOKEN`。

启动时会直接打印该填的地址，并按可用性排好序（真实局域网段优先，Tailscale / WSL / VMware 之类虚拟网卡降级为「其他可选」并标注网卡名）：

```
[blender-bridge] 集中模式（局域网可访问） → 0.0.0.0:13003
[blender-bridge] 画布 Base URL 填：http://192.0.2.10:13003
[blender-bridge] 其他可选地址：198.51.100.10 (示例网卡)
[blender-bridge] 鉴权: 未开启，任何能访问该端口的人都能提交渲染
```

⚠️ 集中模式下 `scene` 必须是**渲染机上**的 `.blend` 路径，不是客户端本地路径。多台机器各自的本地文件，靠共享盘或先上传到渲染机解决，这套桥接不做文件同步。

`/health` 的 `network` 字段会回显 `mode` / `bind` / `urls` / `tokenEnforced`，连不上时先看它。

---

## 接口

主要路由如下。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/render` | 创建任务，返回 `202 { taskId, state, position }`；带 `shot` 即按运镜渲 |
| `GET` | `/render/:id` | 轮询状态：`queued` / `running` / `succeeded` / `failed` / `canceled` |
| `GET` | `/render/:id/media` | 取回 MP4 字节，支持 `Range` |
| `DELETE` | `/render/:id` | 取消（排队中直接移除，渲染中杀进程树） |
| `GET` | `/probe?scene=<路径>` | 列机位：相机名、有没有动画、位姿、注视点、场景中心 |
| `GET` | `/scenes?dir=<目录>` | 场景库：列 `.blend`（名称 / 大小 / 修改时间），供面板下拉 |
| `POST` | `/scenes/from-pose` | 接收浏览器已提取的姿态关键点，生成可编辑的人偶动画 `.blend` |
| `GET` | `/presets` | 运镜预设目录，供前端下拉框直接渲染 |
| `GET` | `/health` | 健康检查 |

`/scenes` 不带 `dir` 时用 `BLENDER_SCENE_DIR`（未配置时为用户数据目录），最多递归两层、按修改时间倒序、默认返回 60 条。
集中模式下带 `dir` 只能落在 `BLENDER_SCENE_DIR` 之内，否则 `403 DIR_FORBIDDEN`——能访问端口的人不该顺手列整台机器的文件树。

### 视频姿态重建 MVP

画布视频节点的「从视频生成人偶 3D 场景」先在浏览器本地运行 MediaPipe Pose Landmarker，原视频不会发送到桥接或模型服务；浏览器只向此接口发送最多 240 帧的姿态点。首次使用会从 Google 下载轻量姿态模型。桥接校验姿态数据，再由 Blender 后台脚本生成动画球节人偶场景并保存到场景库，现有白模面板可直接选中。

该低保真 MVP 面向单人、身体尽量完整、时长不超过 60 秒的视频。结果是由独立可编辑网格段组成的人偶动画，不是人物外观/衣物的重建，也不恢复准确的相机轨迹或世界空间位移；环绕拍摄视频仅作为估算动作的输入。

`POST /scenes/from-pose` 接受 `{ sceneName, fps, sampleRate, frames }`；每帧包含递增的 `timeSec` 和 33 个 `[x, y, z, visibility]` 姿态点。请求仅接受有限范围的数值和 2–240 帧，最大 JSON 请求体为 2 MiB。生成过程最多运行 120 秒。

安全本机模式仅允许已授权的 Origin，校验 Host 和凭证，预检不要求凭证。
旧兼容及集中模式使用 `Access-Control-Allow-Origin: *`；它们不提供安全本机模式的网页来源隔离。
远程桥接凭证必须通过 HTTPS 传输；不要在不可信网络使用未鉴权的集中模式。


以下示例针对未启用凭证的旧兼容模式；安全本机模式需要在请求中提供获授权的 Origin 和凭证。

```bash
curl -X POST http://127.0.0.1:13003/render \
  -H "Content-Type: application/json" \
  -d '{"scene":"E:/proj/demo.blend","res":"1280x720","percent":100}'

# 带运镜：6 秒，推近，幅度 0.7
curl -X POST http://127.0.0.1:13003/render \
  -H "Content-Type: application/json" \
  -d '{"scene":"E:/proj/demo.blend","res":"1280x720","shot":{"preset":"push_in","durationSec":6,"strength":0.7}}'
```

请求字段：`scene`（必填）、`res`、`percent`、`engine`、`samples`、`camera`、`start`、`end`、`fps`、`background`、`timeoutMs`、`shot`。

错误码与渲染器保持同名：`MISSING_SCENE`、`SCENE_NOT_FOUND`、`BAD_ENGINE`、`BAD_RESOLUTION`、
`BAD_FRAME_RANGE`、`BAD_PERCENT`、`BAD_BACKGROUND`、`BLENDER_NOT_FOUND`、`RENDER_TIMEOUT`、`RENDER_FAILED`。
运镜另有：`BAD_SHOT`、`BAD_PRESET`、`BAD_DURATION`、`BAD_KEYS`、`BAD_POSE`、`CAMERA_NOT_FOUND`、`NO_CAMERA`。

---

## 运镜（两档，都不用改前端）

`shot` 有三种语义，**不能混**：

| 传了什么 | 语义 | 用在哪 |
|---|---|---|
| `{ durationSec, camera? }` | 沿用相机自带动画，只按时长截取 | 档二 · 美术已经 K 好机位 |
| `{ preset, durationSec, strength? }` | 桥接按相机起始位姿展开成关键帧 | 档一 · 文字描述运镜 |
| `{ keys: [...] }` | 显式关键帧，直接插 | agent / 外部工具 |

**不传 `preset` 绝不等于「固定机位」。** 前者是把美术 K 好的运镜原样渲出来，后者会写两个相同
关键帧把它覆盖成静帧。要固定机位请显式传 `"preset":"static"`。

### 档一：预设运镜

`GET /presets` 返回 15 个：`push_in`、`pull_out`、`pan_left`、`pan_right`、`tilt_up`、`tilt_down`、
`truck_left`、`truck_right`、`crane_up`、`crane_down`、`orbit_left`、`orbit_right`、`zoom_in`、
`zoom_out`、`static`。

命名约定：**预设名描述的是相机自己怎么动**。`orbit_left` = 相机向左绕，不是主体向左移。
两个参数：`strength`（0–1，默认 0.5）控制幅度，`easing`（`linear` / `easeIn` / `easeOut` / `easeInOut`）。

所有预设都遵守一条规则：**动位置的只改位置，动朝向的只改朝向**。首帧永远等于传入的起始位姿，
所以选了预设不会先跳一下。唯一的例外是 `zoom_*`：只改焦距，机位和朝向都不动。

### 档二：选现成机位

`GET /probe?scene=...` 返回每个相机的 `animated` / `frameRange` / `location` / `target` / `lens`。
`animated: true` 就是美术已经 K 过运镜的机位，前端可以据此给不同的标记。

### 显式关键帧

```json
{"shot": {
  "durationSec": 6, "fps": 24, "camera": "Camera", "easing": "easeInOut",
  "keys": [
    {"t": 0, "pos": [0,-4,1.6],    "target": [0,0,1.2], "focal": 35},
    {"t": 6, "pos": [1.2,-2.2,2.4], "target": [0,0,1.3], "focal": 50}
  ]
}}
```

`t` 必须严格递增、落在 `0–durationSec` 内；首帧不在 0 秒会自动补一帧并给 warning；
相邻帧位移超过 50 单位会提示「画面可能瞬移」。

### 几条实现约定

- **帧数 = `durationSec × fps`**。一秒 24fps 就是 24 帧，不会多渲一帧。
- **显式 `start` / `end` 优先于 `durationSec`**。调用方要截取一段时不会被悄悄改掉。
- **关键帧走文件不走命令行**：几十 KB 的 JSON 塞进 argv 会撞 Windows 的 8191 字符上限。
- **复制相机再插关键帧**：原相机上美术的动画会和新写的打架，表现为画面来回跳。
- **用四元数插值**：环绕 90° 时欧拉角会翻轴。
- 集中模式下 `scene` 是**渲染机上**的路径，这套桥接不做文件同步。

---

## 接到画布上

1. 启动桥接：`node index.js`
2. 画布 → 渠道 → 新增**视频**能力模型，Base URL 填 `http://127.0.0.1:13003`（集中模式填启动日志打印的局域网地址）
3. 打开「调用脚本」，粘贴画布项目提供的 `blender-clay-channel-script.js`
4. 场景文件两种给法：渠道里模型名直接写 `.blend` 路径，或在桥接上设 `BLENDER_DEFAULT_SCENE`
5. 画布正常生成即可，白模 MP4 会作为视频结果落到节点，可继续连给 Seedance 当参考视频

脚本协议与画布一致：create 只交任务号，poll 逐次查询，完成后上传 OSS 拿公网 URL。
上传失败且桥接在本机时回退本机地址（同机可见，跨机不可见），跨机桥接则直接报错不隐瞒。

**时长**现在真的生效了：脚本把画布滑块的 `params.seconds` 转成 `shot.durationSec`，
以前完全没读，滑块拉 6 秒仍然按场景自带的 30 秒渲。

**运镜**通过两个可选参数逐步放开（现在还没有对应 UI，等面板做好就是两个下拉框）：

| 参数 | 取值 | 效果 |
|---|---|---|
| `params.shotPreset` | `orbit_left` 等 15 个预设 | 按预设运镜；不传就沿用机位自带动画 |
| `params.shotStrength` | 0–1，默认 0.5 | 运镜幅度 |
| `params.shotCamera` | 相机名 | 指定机位；写错直接报 `CAMERA_NOT_FOUND`，不会偷偷换一个 |
| `params.shotEasing` | `linear` / `easeIn` / `easeOut` / `easeInOut` | 加减速 |

⚠️ 画布的 `params` 目前只透传固定几个键（`seconds`、`size`、`resolution` …），
`shotPreset` 这些要等前端面板或参数通道打通后才会真正传下来。在那之前，
**时长已经可用、预设运镜只能走 API 或直接调 `/render`**。

---

## 验收对照（接入规范第五节）

| 要求 | 实现 | 验证 |
|---|---|---|
| 未安装 → 1 秒内明确报错 | `/health` 只做存在性判断，不做进程探测 | `test/smoke.test.js` 实测 **1.7 ms** 返回 503 |
| 串行队列 | 单例队列，硬编码并发 1 | 并发提交两个任务，第二个 `state=queued` |
| 超时真正终止 | Windows `taskkill /pid <pid> /T /F`，POSIX 杀进程组 | 超时用例返回 `RENDER_TIMEOUT` |
| 禁止字符串拼命令 | `spawn(exe, args[])`，`buildBlenderArgs` 返回数组 | 含空格路径整体作为一个参数，断言无 shell 连接符 |
| 只监听 127.0.0.1 | 默认 bind 回环，集中模式须显式 `BLENDER_SHARED=1` | 断言默认 `server.address().address === "127.0.0.1"` |
| 统一 Blender 5.2.x | 版本不符只告警不拦截 | `/health` 的 `warnings` 字段 |

```bash
node --test test/lib.test.js    # 纯函数（探测、参数、监听），20 项
node --test test/shot.test.js   # 运镜几何与校验，24 项
node --test test/smoke.test.js  # 真跑 Blender（没装 Blender 自动跳过）
node --test                     # 全量测试
```

本机实测（Windows / Blender 5.2.0 LTS / Workbench，不需要 GPU）：
24 帧 320x180 从提交到可取回 **约 12 秒**（含 Blender 启动），产物 10 KB。
运镜渲染另验：1 秒 24fps 预设环绕，24 帧成片，首末帧画面确实不同（相机真的转了）。

集中模式另有一项真连测试：启动后直接用本机局域网 IP（`192.168.x.x`）请求 `/health`，而不是只断言配置值。

---

## 明确不做

- 不修改用户已有 `.blend` 的**几何**；仅从姿态点新建低保真人偶场景，不做通用 3D 编辑器
- 不做排队 UI，进度只通过 `GET /render/:id` 暴露
- 不做多机调度：集中模式只是「一台渲染机 + 多个画布客户端共用」，没有负载均衡，也没有跨机文件同步
- 不承诺「精确复现几何」，白模只提供构图与运镜参考
- **不做自然语言运镜**：桥接只认预设名与显式关键帧。把「从地面仰拍慢慢升起绕到背后」
  翻成关键帧是 agent 的活，桥接不参与，否则它就得带一个模型，也没法单测
- **不做视频反解运镜**：从参考视频解相机轨迹属于 Blender 的 motion tracking，属于另一条链路
