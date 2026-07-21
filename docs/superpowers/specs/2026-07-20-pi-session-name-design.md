# pi-session-name: 会话自动命名扩展

**Date:** 2026-07-20
**Status:** Draft — 待用户 review
**Package:** `packages/extensions/pi-session-name`（拟定发布名 `@fyeeme/pi-session-name`，沿用 `packages/extensions/` 现有 scope 约定，可在 review 时更改）

## 1. Context / 背景

pi 的 `--resume` 会话选择器默认用「首条用户消息」作为会话标识
（`SessionSelectorComponent` 渲染 `session.name ?? firstMessage`，
见 `session-selector.ts`）。首条消息往往是一句含糊的提问（如「帮我看看这个 bug」），
导致会话列表难以区分、定位困难。

pi 已提供人工改名入口（`/name`、`--name`、选择器 `Ctrl+R`、RPC `setSessionName`），
底层 `pi.setSessionName()` / `pi.getSessionName()` 也已作为扩展 API 暴露，
并会持久化到 `~/.pi/agent/sessions/.../<id>.jsonl` 的 `session_info` entry、
触发 `session_info_changed` 事件刷新 TUI 标题与选择器。但**当前没有任何自动命名逻辑**
（grep `autoName` / `generateSessionName` 无结果）。

本扩展在不改动 pi 核心的前提下，通过扩展钩子在合适时机用 LLM 生成简短标题并命名，
让 `--resume` 列表自带语义。

## 2. Goals

- 全新会话首轮 AI 处理结束后，自动生成简短标题并命名，无需用户干预。
- 名字跟随会话首条用户消息的语言（中文会话→中文名，英文会话→英文名）。
- 提供两种命名策略，可配置：`first`（默认，命名一次后不再改）/ `auto`（按内容可多次重命名）。
- 无论何种策略，**不覆盖用户手动设置的名字**（`/name`、`--name`、RPC、其他扩展）。
- 作为独立可发布 npm 包交付，符合 `packages/extensions/` 既有包骨架约定。

## 3. Non-Goals（YAGNI）

- 不做话题漂移的复杂启发式检测（auto 模式交由 LLM 判定 `KEEP`/改名）。
- 不做命名历史 / 多候选 / 撤销。
- 不提供改名 UI 弹窗（直接静默写入；用户若不满意可随时 `/name` 手改，手动名会锁定）。
- 不做跨会话去重或重名检测。
- 不针对非交互模式（`pi -p`）做特判——该模式下也会保存会话，命名对其无害。

## 4. Requirements

### 用户故事
1. 全新会话：用户提第一个问题 → AI 回答完毕 → 会话名自动变为对该话题的简短描述（同语言）。
2. resume 已命名会话：无论 `first` 还是 `auto` 模式，已存在的名字不被覆盖。
3. `first` 模式：命名一次后，话题继续深入也不再改名。
4. `auto` 模式：话题显著改变时，名字随之更新；话题没变则保持（由 LLM 判定）。
5. 手动干预：用户任何时候 `/name foo` 手改 → 名字锁定，扩展永不再动（即便 auto 模式）。
6. 失败静默：模型不可用 / 无 API key / 返回脏数据 → 不报错、不阻断会话，留待下轮再试或放弃。

### 成功标准
- `packages/extensions/pi-session-name/` 下产出可 `pi install` / `pi -e` 加载的扩展。
- `first` 模式：全新会话首轮 `agent_settled` 后 `getSessionName()` 非空且语义贴切。
- `auto` 模式：话题切换后名字在下一轮 `agent_settled` 更新；无切换时保持。
- 手动 `/name` 后再聊 N 轮，名字不变。
- 无 key 时扩展静默跳过，pi 正常运行。

## 5. Architecture & Components

单文件扩展 `index.ts`，职责内聚于一个 `agent_settled` 处理器 + 若干纯函数辅助。
无外部运行时依赖，仅 peerDep `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`
（复用 `complete()` / `getModel()`，与 `examples/extensions/summarize.ts` 一致）。

### 组件
- **事件订阅**：`pi.on("agent_settled", handler)`（主触发）、`pi.on("session_start", ...)`
  （重置 per-session 状态）、`pi.on("session_info_changed", ...)`（检测外部改名 → 锁定）。
- **纯函数（可单测，无副作用）**：
  - `buildConversationText(entries, maxMessages)`：从 `sessionManager.getBranch()` 提取
    user/assistant 文本（复用 `summarize.ts` 的 `extractTextParts` / `extractToolCallLines` 思路），
    截断到最近 `maxMessages` 条以省 token。
  - `buildFirstPrompt(text, { maxLength })`：首次命名 prompt（指示跟随首条消息语言、≤N 词、无引号句号）。
  - `buildAutoPrompt(currentName, text, { maxLength })`：auto 模式 prompt（输出 `KEEP` 或新名）。
  - `cleanTitle(raw, { maxLength })`：清洗——去引号/换行/首尾空白、限长、`KEEP`/空 → 返回 `null`。
- **生成器**：`generateTitle(prompt, modelCtx)`：封装 `complete()` 调用，返回模型**原始文本响应**（不清洗）；清洗统一由调用方经 `cleanTitle` 完成（auto 模式需在清洗前先用正则判 `KEEP`）。
- **编排**：主 handler，串起 状态判定 → 取 branch → 生成 → setSessionName，含 `inFlight` 防重入
  与 `suppressChange` 防 session_info_changed 自触发。

## 6. Key Decisions & Trade-offs

| 决策 | 选择 | 理由 |
|---|---|---|
| 触发钩子 | `agent_settled` | 一次完整 agent 运行彻底结束（含工具调用/重试/压缩都已 settle）。`turn_end` 的首轮可能只是工具调用轮（会话尚未「说完」）；`session_shutdown` 不符合「首轮后」且退出写盘有竞态。`agent_settled` 最贴合「AI 理解会话后」。 |
| 命名策略 | 配置 `mode: first \| auto` | `first`=幂等一次（默认，零状态机可退化为 `!getSessionName()` 门槛）；`auto`=按内容多次，由 LLM 判 `KEEP`/改名避免无谓抖动。 |
| 手动锁定 | 订阅 `session_info_changed` 检测外部改名 | 统一兼容 `/name`、`--name`、RPC、其他扩展改名，无需对每种入口特判。 |
| 只命名一次的判定（first） | `!getSessionName()` 门槛 | 天然幂等、零持久状态、自动满足「不覆盖手动名」。 |
| 语言跟随 | prompt 指示跟随首条消息语言 | 不写语言检测逻辑，由模型判断。 |
| 命名格式 | ≤8 词、无引号/句号 | 选择器可读性优先。 |
| 模型来源优先级 | 用户配置 `model` → 当前会话模型（若 API 可得）→ 内置轻量默认 | 尊重用户配置与现有 key，无 key 静默跳过。具体「当前会话模型」能否获取见 §11 待确认接口。 |

## 7. State Machine & Lifecycle

per-session 内存状态，在 `session_start` 时初始化：

| 变量 | 含义 | `session_start` 初值 |
|---|---|---|
| `autoNamed` | 扩展本次会话内是否命名过 | `false` |
| `manuallyLocked` | 是否检测到外部（手动）改名，一旦 `true` 永不再动 | `!!pi.getSessionName()`（resume 已命名会话→保守锁定；全新空会话→`false`） |
| `inFlight` | 一次生成是否进行中（防 `agent_settled` 重入） | `false` |
| `suppressChange` | 扩展自己 `setSessionName` 时置位，避免被 `session_info_changed` 误判为外部改名 | `false` |

### 事件处理

```
pi.on("session_start", () => {
  autoNamed = false
  manuallyLocked = !!pi.getSessionName()
  inFlight = false
  suppressChange = false
})

pi.on("session_info_changed", () => {
  if (suppressChange) return      // 扩展自己触发的，忽略
  manuallyLocked = true           // 任何外部改名 → 永久锁定
})

pi.on("agent_settled", async (_e, ctx) => {
  if (!enabled || manuallyLocked || inFlight) return

  if (mode === "first") {
    if (autoNamed || pi.getSessionName()) return   // 已命名（任何来源）→ 不动
  }
  // mode === "auto": 不检查 autoNamed，每次都重新评估

  inFlight = true
  try {
    const entries = ctx.sessionManager.getBranch()          // ⚠ 待确认 event ctx 是否含 sessionManager（§11）
    const text = buildConversationText(entries, MAX_MESSAGES)
    if (!text.trim()) return

    const modelCtx = resolveModel(ctx)                       // ⚠ 待确认（§11）
    if (!modelCtx) return                                    // 无可用模型/key → 静默跳过

    let title: string | null
    if (mode === "first" || !pi.getSessionName()) {
      title = cleanTitle(await generateTitle(buildFirstPrompt(text, opts), modelCtx), opts)
    } else {
      const verdict = await generateTitle(buildAutoPrompt(pi.getSessionName()!, text, opts), modelCtx)
      title = /^keep$/i.test(verdict.trim()) ? null : cleanTitle(verdict, opts)
    }
    if (!title) return

    suppressChange = true
    pi.setSessionName(title)
    suppressChange = false
    autoNamed = true
  } catch {
    // 静默：first 模式失败→下轮再试；auto 模式失败→本轮放弃，下轮再试
  } finally {
    inFlight = false
  }
})
```

### 递归 / 重入安全性
- `setSessionName` → 触发 `session_info_changed`：被 `suppressChange` 抑制，不误设 `manuallyLocked`。
- `session_info_changed` handler 只置标志，不触发 `agent_settled`，无事件递归。
- `inFlight` 防同一会话内 `agent_settled` 在异步生成期间被再次进入。

## 8. Package Structure

仿 `packages/extensions/pi-hooks`、`pi-statusline`（独立可发布包，**不**进顶层 `workspaces`）：

```
packages/extensions/pi-session-name/
├── index.ts          # 扩展主入口（事件订阅 + 编排 + 纯函数）
├── package.json      # name/version/pi.extensions:["./index.ts"]/peerDeps/scripts/files
├── tsconfig.json     # extends ../../../tsconfig.base.json, noEmit, include *.ts
├── README.md         # 安装(pi install / pi -e)、配置项、行为说明、手测清单
├── CHANGELOG.md      # ## [Unreleased] + ## [1.0.0] - 2026-07-20
├── LICENSE           # MIT
├── .gitignore        # node_modules, *.js
└── test/
    └── session-name.test.ts   # vitest 纯函数单测（mock LLM，不真实调用）
```

### package.json 关键字段（参考 pi-hooks）
- `name`: `@fyeeme/pi-session-name`（待定）
- `type`: `module`
- `pi.extensions`: `["./index.ts"]`
- `peerDependencies`: `@earendil-works/pi-coding-agent >=0.77.0`、`@earendil-works/pi-ai >=0.77.0`
- `devDependencies`: 上述两者固定小版本 + `@types/node` + `typescript`（版本对齐 pi-hooks）
- `scripts`: `test: vitest --run`、`typecheck: tsc`
- `keywords`: 含 `pi-package`、`pi`、`session`、`auto-name` 等

## 9. Configuration

通过 pi 扩展配置读取（具体读取 API 见 §11 待确认；若 ExtensionAPI 无统一 settings 入口，
则退化为约定：读 `.pi/settings.json` 的 `pi-session-name` 段 或 env 变体）。

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `"first" \| "auto"` | `"first"` | 命名策略 |
| `model` | `{ provider, id }` | 内置轻量默认 | 生成标题所用模型；无 key 则静默跳过 |
| `enabled` | `boolean` | `true` | 总开关 |
| `maxLength` | `number` | `8`（词） | 标题上限，`cleanTitle` 据此截断 |

> `maxLength` 对中文（按字非按词）的处理：以「词」概念对中文不直观，实现时 `cleanTitle`
> 对中文采用字符上限（如 ≤30 字）、英文采用词上限（≤8 词），或统一用字符上限（≤40 字符）。
> **待 review 时定夺**：统一字符上限更简单，建议默认 ≤40 字符。

## 10. Failure Handling & Edge Cases

| 场景 | 行为 |
|---|---|
| 无 API key / 模型未注册 / `getApiKeyAndHeaders` 失败 | 静默跳过，不报错；first 下轮再试，auto 本轮放弃 |
| LLM 返回脏数据（空、超长、含代码块/引号） | `cleanTitle` 清洗；清洗后为空则不命名 |
| 首条消息无文本（纯图片/工具结果） | `buildConversationText` 为空 → 跳过本轮，下轮再试 |
| `agent_settled` 期间用户立刻退出 | 异步生成可能未完成，进程即退出 → 接受（名字未生成就未生成；resume 该会话续聊时若仍无名则可命名） |
| 扩展自己 `setSessionName` 触发的 `session_info_changed` | `suppressChange` 抑制，不误锁 |
| 用户 `/name` 后再聊 | `manuallyLocked=true`，永不再动（两模式均生效） |
| resume 已命名会话 | `session_start` 时 `manuallyLocked=true`，两模式均不动 |
| 其他扩展也调用 `setSessionName` | 视为外部改名 → 锁定（保守，宁可少改不乱改） |

## 11. Interfaces to Confirm Against `types.d.ts`（实现前必须查证）

权威来源：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
及同包 `docs/extensions.md`。

1. **`pi.on("agent_settled", handler)`**：handler 第二参数（ctx）类型，是否含
   `sessionManager` / `modelRegistry` / `ui` / `hasUI`？（`summarize.ts` 用的是
   `ExtensionCommandContext`，event handler 的 ctx 需确认是否同构。）
2. **`pi.on("session_info_changed", handler)`**：payload 是否带 `name`？是否区分触发源？（预期不区分，故用 `suppressChange`。）
3. **ExtensionAPI 是否能拿到「当前会话模型」**：若有 `pi.getModel()` / `ctx.model` 之类，
   `resolveModel` 优先用之；否则退化为「配置 > 内置默认」。影响 §6 模型优先级行。
4. **扩展配置读取入口**：`pi.getConfig()` / `pi.settings` / 命名约定？决定 §9 配置读取实现。
5. **`pi.on("session_start", handler)`** payload 的 `reason` 字段：确认 `new/resume/fork/...` 枚举，
   便于调试日志（不改变锁定逻辑——锁定仅依据 `getSessionName()`）。

> 上述任一接口若与预期不符，仅影响实现细节（取 ctx 路径、模型来源、配置读取），
> 不影响整体架构与状态机设计。

## 12. Testing Strategy

- **纯函数单测（vitest，无真实 LLM）**：
  - `buildConversationText`：多角色/混合内容/截断长度/空输入。
  - `buildFirstPrompt` / `buildAutoPrompt`：含语言跟随指示、长度约束。
  - `cleanTitle`：去引号/换行/代码块、中英文限长、`KEEP`/空 → `null`。
  - `mode` 分支与状态机：用桩 `pi` 对象模拟 `agent_settled`/`session_info_changed`/`session_start`，
    断言 `setSessionName` 调用次数与时机（first 命名一次后不再调；auto 话题变才调；
    手动锁定后永不再调；resume 已命名不动）。
- **`generateTitle` 用 mock** `complete()`：不发起真实网络请求。
- **手测清单（写入 README）**：
  1. 全新会话首轮后自动命名（中/英各一）。
  2. resume 已命名会话不改名。
  3. `/name` 手动设名后再聊 N 轮不覆盖。
  4. `auto` 模式话题切换后名字更新、不切换则保持。
  5. 无 key 时静默跳过、pi 正常。
  6. `pi -e ./index.ts` 临时加载验证。

## 13. Risks & Open Questions

- **模型选择**：内置默认模型若硬编码某 provider，用户未配该 provider key 时无效。
  缓解：优先用「当前会话模型」（若 §11.3 可得），并允许 `model` 配置覆盖。
- **auto 模式成本**：每次 `agent_settled` 调一次轻量 LLM（短输入短输出），成本可控但非零。
  用户嫌频繁可未来加 `autoInterval`（每 N 轮评估一次）——当前 YAGNI 不加。
- **手动锁定的边界**：其他扩展自动改名也会触发锁定（保守）。可接受——宁可少改不乱改。
- **包名/scope**：当前拟定 `@fyeeme/pi-session-name`，需确认是否沿用 `@fyeeme/` scope 或改用无 scope。
- **maxLength 语义**：中文按字 vs 英文按词 vs 统一字符上限（§9 建议 ≤40 字符统一）。

## 14. Implementation Constraints（遵循 pi AGENTS.md）

- 仅使用 erasable TypeScript 语法（无 `enum`/`namespace`/参数属性/`import =` 等）。
- 无 `any`、无 inline imports（`await import()`/动态类型导入），顶层 import。
- 顶层 `npm run check`（biome + tsgo）须通过（本包独立，check 时在包目录跑 `tsc` 与 `vitest`）。
- 不自动提交；spec/代码提交均需用户批准。
