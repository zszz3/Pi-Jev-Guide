# Pi Jev Guard

原版 Pi Coding Agent 插件：按时机配置规则，并自带风险检查、输出脱敏、重复失败和缺少验证提醒。

0.2.1 支持 `/jevguard login` 配置 API key，验证后立即生效。

支持交互添加规则：安装后运行 `/jevguard add`，依次选择 **检查时机 → 本地匹配或 Jev 判断 → 命中后的动作**。无需修改插件源码。

适配并测试：`@earendil-works/pi-coding-agent 0.85.1`，Node.js 22.19+。这是独立的实验性插件，不是 TypeSafe 或 Pi 官方产品。当前提供 Pi 适配器；DSH 适配器尚未实现，判断与追踪模块可复用。

## 可以做什么

| 场景 | 默认 guard 模式 |
| --- | --- |
| 凭据上传，例如 curl 上传 `.ssh/id_rsa` | 不设置专门的本地拦截或确认；走普通 Jev／自定义规则，未配置时放行 |
| 递归删除、丢弃 Git 修改、强制推送、非传输类凭据文件访问 | 确认这一次操作；没有交互界面时拦截 |
| 其他 shell、write、edit、自定义工具调用 | Jev 同时判断破坏性、未经授权的数据外传、偏离任务和规则冲突 |
| 疑似违反 AGENTS.md 或偏离要求 | 给 Agent 一条可见提醒，不自动回滚文件 |
| 相同参数产生三次相同错误 | 提示检查原因、换方法或说明阻塞，每种错误只在第三次提醒 |
| 观察到源码或配置写入，之后没有成功验证记录 | 收尾时提醒执行相关检查，或说明为什么不适用／未执行 |
| 工具结果包含已知凭据样式 | 本地替换文本及元数据中的凭据；可再用 Jev 判断残留凭据并隐藏结果 |

`read`、`grep`、`find`、`ls` 的执行前检查只运行本地凭据路径规则。它们的结果仍接受输出处理。一次 Jev 动作检查同时发送四个问题；默认额外检查一次非空文本输出。默认配置下，未配置 API key 时不发送网络请求，只有本地规则、脱敏与证据追踪生效。自定义语义规则会执行自己声明的 onError。

## 安装与试用

直接从 GitHub 安装：

```sh
pi install https://github.com/zszz3/Pi-Jev-Guide
```

已打开的 Pi 会话运行 `/reload`，然后运行 `/jevguard login` 配置 key，用 `/jevguard add` 添加规则。

在这个项目目录安装运行依赖，然后登记为本地 Pi 包：

```sh
npm install --omit=dev
pi install /absolute/path/to/pi-jev-guard
```

### 配置 API key

在 Pi 里输入一个命令：

```text
/jevguard login
```

在隐藏输入框粘贴 TypeSafe API key，按 Enter。插件用一条固定测试请求验证，成功后保存并立即启用 Jev，后续启动自动读取，不需要环境变量或重启。Esc 取消；验证或保存失败时保留原配置。

- `/jevguard status`：查看是否启用以及 key 来源，不显示 key。
- `/jevguard login`：也可用来更换 key。
- `/jevguard logout`：删除保存的 key，回到本地检查；自定义语义规则仍按 `onError` 处理。

Key 保存在 Pi 用户目录的 `jev-guard/auth.json`（通常为 `~/.pi/agent/jev-guard/auth.json`），是权限为 `0600` 的明文凭据文件，不在项目配置或会话记录中。输入框只显示星号；不要把 key 放在命令参数中。验证请求只包含固定测试文本，不包含项目内容；启用后，正常语义检查会将脱敏后的相关上下文发送到 TypeSafe。

无交互界面的自动化仍可使用 `TYPESAFE_API_KEY`。保存的 key 优先于环境变量；退出登录后，如环境变量仍存在，会回退到该 key 并明确提示。模型、超时和阈值环境变量的变更仍需重启 Pi。

只想临时加载、不登记全局包，可以在安装依赖后运行：

```sh
pi -e /absolute/path/to/pi-jev-guard/src/index.ts
```

可以先让 Agent 执行 `git status`，查看正常放行；再在专用临时测试目录中提出清理操作，观察确认提示。不要为了演示让它接触真实私钥或重要文件。

## 命令

```text
/jevguard login
/jevguard logout
/jevguard add
/jevguard rules
/jevguard config
/jevguard reload
/jevguard disable completion-check
/jevguard enable completion-check
/jevguard status
/jevguard trace
/jevguard mode guard
/jevguard mode observe
```

`trace` 展示最近 20 次判定的类型和来源，不记录完整命令、文件内容或凭据。`observe` 将规则的输入／工具拦截与确认降为观察提示；已启用的输出脱敏与隐藏仍执行。配置无效、取消或流程异常仍可能停止调用。模式切换只影响当前 Pi 进程，不修改用户配置。建议日常使用默认 `guard`。

卸载：`pi remove /absolute/path/to/pi-jev-guard`，然后 `/reload`。

## 配置

规则默认保存在 Pi 用户目录的 `jev-guard.json`（通常是 `~/.pi/agent/jev-guard.json`，遵循 `PI_CODING_AGENT_DIR`）。`add`、`config`、`enable`、`disable` 保存后立即生效，并在后续启动时加载；取消编辑不保存。也可以设置 `JEV_GUARD_CONFIG=/absolute/path/rules.json` 指定配置文件。不会自动读取仓库中的同名配置。

`config` 打开完整 JSON 编辑器，`reload` 重新读取文件。规则变更需要 Agent 空闲。新配置先完整校验，再写入临时文件并原子替换；校验失败保留旧配置。启动时配置无效会显示错误并暂停输入和工具调用，可通过配置命令修复。

API key 通过 `/jevguard login` 保存；模型、超时和自带 Jev 检查的默认阈值由环境变量提供；AGENTS.md 只是待检查的规则内容，不会变更插件配置。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 未设置 | 自动化备用方式；优先使用 login 保存的 key |
| `JEV_GUARD_MODEL` | `jev-latest` | 比较不同运行时建议固定服务支持的模型版本 |
| `JEV_GUARD_MODE` | `guard` | `guard` 或 `observe` |
| `JEV_GUARD_TIMEOUT_MS` | `2500` | 单次请求超时；不自动重试 |
| `JEV_GUARD_DESTRUCTIVE_THRESHOLD` | `0.90` | 触发确认的破坏性概率阈值 |
| `JEV_GUARD_LEAK_THRESHOLD` | `0.90` | 数据外传拦截／输出隐藏阈值 |
| `JEV_GUARD_WARNING_THRESHOLD` | `0.85` | 偏离任务／规则冲突提醒阈值 |
| `JEV_GUARD_SCAN_OUTPUT` | `true` | 是否进行额外 Jev 输出检查；本地脱敏由 redact-output 开关控制 |

阈值是未经真实会话校准的初始设置，不代表可靠性保证。Jev 不可用或返回无效结果时，待审动作转为单次人工确认；无 UI 则拦截。输出检查失败时保留本地脱敏并告知用户，输出处理本身异常时隐藏该结果。按 Esc 或切换会话会取消等待中的检查，不会把取消视为同意。

为避免意外将凭据发给代理地址，这个版本固定访问 `https://api.typesafe.ai`，忽略 SDK 的 `TYPESAFE_BASE_URL`；请求日志关闭。

## 选择时机与规则

| `when` | 可选动作 | 能力边界 |
| --- | --- | --- |
| `input` | `warn` / `confirm` / `block` | 检查原始文字输入；拦截后不交给 Agent。扩展命令由 Pi 优先处理，不经过此事件 |
| `tool_call` | `warn` / `confirm` / `block` | 工具执行前提醒、单次确认或拦截 |
| `tool_result` | `warn` / `hide` | 工具已经执行，只能提醒或隐藏返回内容及元数据 |
| `turn_end` | `warn` | 仅处理没有工具调用的正常结束回答；不能撤回已经显示的回答，也不自动强制继续一轮 |

新增的运行时阶段：

| `when` | 可选动作 | 检查内容 |
| --- | --- | --- |
| `turn_start` | `warn` | 每轮开始时的任务、轮次和验证记录 |
| `tool_execution_start` | `warn` | 工具已经开始运行时的参数 |
| `tool_execution_update` | `warn` | 工具主动提供的中间输出，如重试、异常进度 |
| `tool_execution_end` | `warn` | 执行结果与错误状态 |
| `agent_end` | `warn` | 一次 Agent loop 的消息；不保证没有后续重试或续跑 |

这五个阶段仅在配置规则后检查。提醒显示给用户，无 UI 时写入普通扩展消息；不会发送 steering 消息、自动启动下一轮或停止正在运行的命令。要阻止执行用 `tool_call`，要隐藏结果用 `tool_result`。

运行时检查同时最多一项；忙碌时新事件跳过，不排队。进度检查每个工具调用间隔至少 2 秒、最多 3 次。同阶段同工具调用同规则仅提醒一次，每次 Agent loop 最多 20 条提醒。没有中间输出的工具不触发进度检查。文本最多取前 8,000 字符并标注截断，整个上下文超限按 `onError: warn` 处理。这是抽样观察，不是完整审计。`tool_execution_end` 没有原始参数，不能按 `pathPrefix` 匹配，可按工具名匹配。

使用 `/jevguard add` 选择阶段，或参考 [运行时规则示例](examples/runtime-rules.json)。

原有四个阶段的 `warn` 不暂停原动作；提醒进入 Agent 上下文，最多每次用户请求四条。`hide` 隐藏整份结果（不是任意字符串替换）。自定义规则没有 `allow` 动作，因此不能覆盖另一项检查的拦截。多个自定义规则同时命中时，拦截优先，其次合并确认；自带检查仍独立生效。

配置示例（完整示例见 [examples/jev-guard.json](examples/jev-guard.json)）：

```json
{
  "version": 1,
  "builtins": { "completion-check": true },
  "rules": [
    {
      "id": "review-release",
      "when": "tool_call",
      "match": { "tools": ["bash"], "contains": "npm publish" },
      "action": "confirm",
      "message": "这次操作会发布包，请确认版本和目标。"
    }
  ]
}
```

- `match.tools`：精确工具名称，仅用于工具事件。
- `match.contains`：区分大小写的文字包含；输入／回答用文字，工具调用用参数 JSON，工具结果用经过已启用本地脱敏的文本。
- `match.pathPrefix`：限定 `input.path` 的目录或文件路径，按工作目录解析，检查路径边界；不推断 shell 命令中的路径，也不解析符号链接。
- 多个匹配条件需要全部满足。没有 `question` 时，匹配即触发本地规则。
- `question`：交给 Jev 的是／否判断问题。先做本地筛选，再将同一时机命中的自定义问题合并为一次请求。达到 `threshold`（默认 0.9）才触发。
- `onError`：无 key、超时、无效响应或上下文超过限制时的动作，必须受该时机能力限制。默认输入／执行前为 `block`，结果为 `hide`，收尾为 `warn`。缺少 key 不会让显式配置的语义规则静默失效。
- `enabled` 默认 true。ID 唯一，最多 32 条；不支持任意脚本、正则或 shell 回调。

六项自带检查默认开启，可用 `/jevguard rules` 查看并按 ID 开关：`local-risk`、`semantic-action`、`redact-output`、`semantic-output`、`repeated-failure`、`completion-check`。它们有各自固定适用时机，用户自定义规则在支持的四个时机内自由配置。关闭相应检查会移除其保护。

## 数据与行为边界

- 启用 Jev 后，会发送脱敏后的当前请求、最近少量用户请求、适用的 AGENTS.md 和工具参数。启用输出检查时，也会发送脱敏后的部分工具文本输出。脱敏不是匿名化；不应在不能发往 TypeSafe 的项目中开启在线检查。
- 凭据检测覆盖常见 token、私钥、密码赋值、认证头和带密码 URL，也替换当前进程中凭据类环境变量的已知值。未知格式、编码、分段输出和图片里的秘密可能漏检。
- `tool_result` 能修改最终工具结果，但**不能撤回工具已发送的数据，不能保证清理之前的流式显示、其他扩展的日志、原始工具参数或磁盘文件**。这不是沙箱，也不是数据外泄防护系统。
- 本地命令判断是启发式规则，不完整解析 shell，也不分析任意脚本内部操作。解释器包装、PowerShell、脚本内隐藏操作等依赖 Jev 语义检查，仍可能漏报。其他扩展还可能在本插件之后修改工具参数或结果。
- 完成检查追踪通过 `write`／`edit` 发起的已知源码与配置文件写入。不能完整识别任意 shell／自定义工具造成的文件修改。成功的相关命令只是观测到的验证记录，不证明功能正确。流水线、掩盖退出码的命令和与写入并行的检查不会被计为修改后的成功验证。
- 收尾提醒每次用户输入最多一次；全部自动纠偏提醒每次输入最多四次。不会在已经空闲时主动开启新任务。重复失败计数是同参数、同错误的匹配，不声称理解了所有语义相似的失败。
- 当前读取 Pi 已加载的 AGENTS.md、工作目录及目标文件父目录的 AGENTS.md；规则总文本、历史输入和输出均有长度上限及截断标记。规则提醒不虚构具体条款编号。长上下文与跨目录命令可能无法完整评估。
- 验证状态以不含原始内容的版本化记录保存到 Pi 当前会话分支，恢复／切换分支时重建。提醒不会回滚已有改动。确认只对当前一次工具调用有效。

## 开发与验证

```sh
npm install
npm run check
```

测试不访问真实 Jev，不执行危险示例命令。覆盖真实 Pi 扩展加载与事件分发、单次确认、无 UI 拦截、取消／会话关闭、SDK 请求及无效响应、超时、递归脱敏、规则刷新、重复失败、并行写入与验证、会话恢复。当前尚未进行真实 Jev 端到端效果评估。

代码结构：

```text
src/index.ts     Pi 事件、确认界面与提醒
src/policy.ts    本地规则和 Jev 判定策略
src/judge.ts     TypeSafe 官方 SDK 接入
src/redact.ts    本地文本与元数据脱敏
src/tracker.ts   验证证据、失败计数、恢复状态
src/rules.ts     AGENTS.md 加载
src/auth.ts     隐藏输入与凭据保存／读取／删除
src/config.ts   环境配置
src/settings.ts 规则结构、能力校验与持久化
src/engine.ts   不依赖 Pi 的匹配与语义规则执行器
```

接口依据：[Pi 扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[TypeSafe SDK](https://github.com/typesafe-ai/typesafe-sdk-js)。

结构与同类源码对比见 [ARCHITECTURE.md](ARCHITECTURE.md)。


## 异常停止后自动续跑

默认关闭，在 Pi 中运行 `/jevguard recovery on` 开启。`/jevguard recovery pause` 立即取消待执行检查并关闭；`resume` 重新开启，`status` 查看状态。设置会保存到插件配置文件，不自动补跑此前已停止的任务。

插件等待 Pi 的 `agent_settled`（内置重试、压缩和排队续跑结束），仅考虑明确的网络、超时、临时服务错误或输出长度上限。首次等待 3 秒，之后按 20、40 秒退避；每次用户任务最多自动续跑 3 次（配置上限 5 次）。次数写入会话，重新加载不会清零；新的用户输入才重置。

Jev 同时判断“现有授权内是否有明确下一步”和“是否必须等待用户”。前者至少 0.9、后者不超过 0.2 才发出续跑消息。这些是初始阈值，仅做了少量真实样例验证，不是准确率保证。续跑检查使用独立的至少 10 秒超时预算，工具拦截仍用原配置。API 超时、检查失败或不确定时保持停止。用户取消、正常完成、权限／凭据／余额／上下文错误、Guard 已拦截的动作不续跑。宿主重新开始、新用户输入、会话切换或关闭会取消等待；有排队消息时不插队。等待期间请用 `recovery pause` 取消，不依赖空闲状态下的 Esc。

续跑消息会要求先检查上次工具是否已执行，不盲目重放可能有副作用的操作。这是给 Agent 的指令，不是外部操作的事务或幂等保证。此版本不主动打断运行中的循环，也不在进程重启时扫描旧任务。

```json
{
  "version": 1,
  "recovery": {
    "enabled": true,
    "graceMs": 3000,
    "cooldownMs": 20000,
    "maxConsecutive": 3
  }
}
```

该功能参考 [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) 的有限重试、退避和工具状态核对设计，按 Pi 的生命周期独立实现。
