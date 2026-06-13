# pi-thinking-ui 代码审计报告

## 元信息

| 项 | 值 |
|---|---|
| 审计目标 | `packages/extensions/pi-thinking-ui` |
| 审计日期 | 2026-06-13 |
| 规则源 | 仓库根 `AGENTS.md`（唯一审计标准，未引入其他规则） |
| 方法 | adversarial：每个文件派发 1 个 fresh-context 审计 Agent，系统提示词唯一定向 `AGENTS.md`、仅配只读工具；synthesize：汇总过滤空结果 |
| 负责人归属依据 | `package.json` 的 `author` 为空、仓库无 `CODEOWNERS`；`git log` 显示该目录唯一提交者为 `liuyang <fyeeme@gmail.com>`。故全部文件负责人统一归属 **`liuyang (fyeeme)`** |
| 排除文件 | `LICENSE`、`.gitignore`、`CHANGELOG.md`（非代码/不可审计） |

## 摘要

- 审计文件 **9** 个（7×`.ts` + `package.json` + `tsconfig.json`）
- **CLEAN**：3 个 → `persistence.ts`、`types.ts`、`tsconfig.json`
- **有违规**：6 个
- 正式违规计数：**blocker 0 / major 2 / minor 7 / nit 4**（共 **13** 项）
- 附加观察（`AGENTS.md` 无对应明文条款，不计正式违规）：1 项（死代码）

### 按严重程度

| 级别 | 数量 | 涉及文件 |
|---|---|---|
| major | 2 | `internal-patch.ts`（`as any`）、`state.ts`（向后兼容迁移代码） |
| minor | 7 | `internal-patch.ts`、`parse.ts`×2、`render.ts`×2、`state.ts`、`package.json` |
| nit | 4 | `index.ts`×4 |
| 附加观察 | 1 | `internal-patch.ts`（死代码） |

---

## 按文件分组（负责人：`liuyang (fyeeme)`）

### `packages/extensions/pi-thinking-ui/index.ts`
负责人：`liuyang (fyeeme)` · 职责：扩展入口，注册 `/thinking-ui` 命令、`Alt+T` 快捷键与会话生命周期事件，管理 thinking 内容的折叠/摘要/展开三模式。

- **[nit]** Inline single-line helpers（单行 + 单调用点）— `index.ts:20` `modeStatusText`（调用点 `:85`）— 单行 `return` 模板字符串、全文件仅 1 处调用，应内联。建议：在 `:85` 调用处直接展开。
- **[nit]** Inline single-line helpers — `index.ts:32` `invalidUsageMessage`（调用点 `:223`）— 单行 `return` 字符串字面量、仅 1 处调用，应内联。
- **[nit]** Inline single-line helpers — `index.ts:50` `persistMode`（调用点 `:97`）— 单行函数体 `pi.appendEntry(...)`、仅 1 处调用，应内联。
- **[nit]** Inline single-line helpers — `index.ts:118` `isClearCommand`（调用点 `:139`）— 单行 `return`、仅 1 处调用，应内联。

### `packages/extensions/pi-thinking-ui/internal-patch.ts`
负责人：`liuyang (fyeeme)` · 职责：运行时 monkey-patch pi-coding-agent 内部 dist 模块的原型方法，将 thinking 块替换为自定义 `ThinkingUIComponent`，带引用计数化的安装/卸载与失败回退。

- **[major]** No `any` — `internal-patch.ts:296` — `new Markdown(content.text.trim(), 1, 0, this.markdownTheme as any)` 用 `any` 绕过类型。`markdownTheme` 在接口里声明为 `unknown`（`:24`）。建议：查阅 `@earendil-works/pi-tui` 的 `Markdown` 构造函数第 4 参数实际类型，用显式断言（如 `as MarkdownThemeType`）替换 `as any`。
- **[minor]** No inline imports — `internal-patch.ts:103` — `(await import(moduleUrl)) as TModule` 为动态 `import()`。`moduleUrl` 由 `import.meta.resolve` + `pathToFileURL` 运行时解析另一包内部 dist 路径，无法写成静态 import，**可能属设计必要**。建议：保留并与维护者确认，或评估静态 import 内部 dist 的代价。
- _附加观察（非正式违规）_ — `internal-patch.ts:133` `hasVisibleThinkingContent` 在全包零调用点（孤儿函数）。`AGENTS.md` 无明确「禁止死代码」条款，仅提示可清理。

### `packages/extensions/pi-thinking-ui/parse.ts`
负责人：`liuyang (fyeeme)` · 职责：纯文本思考内容的解析与摘要引擎，切分步骤、提取语义角色/图标，用 baseline + challenger 双路打分生成摘要与事件标签（1160 行）。

- **[minor]** Simplicity First（推测性/死代码）— `parse.ts:56` `firstMeaningfulLine` — 已定义但全文件零调用点且未 `export`。建议：删除，或确认应导出供外部使用。
- **[minor]** Simplicity First（推测性/死代码）— `parse.ts:64` `firstSentence` — 同上，零调用点、未导出。建议：删除或导出。

> 其余逐条排查无违规：无 `any`、无动态/内联 import、无 `enum`/`namespace`/`import =`/`export =` 等需 emit 语法、单行 helper 均多处调用。

### `packages/extensions/pi-thinking-ui/render.ts`
负责人：`liuyang (fyeeme)` · 职责：将派生步骤渲染为 TUI 文本行，支持 collapsed/summary/expanded 三模式，含 inline markdown 解析、ANSI 换行截断与带缓存的 `ThinkingUIComponent`。

- **[minor]** Code Quality（零调用点死代码）— `render.ts:90` `stepHeader` — 全包零调用点（渲染实际用的是 `wrapStepHeader`）。建议：按「Always ask before removing code that appears intentional」先确认，再移除。
- **[minor]** Code Quality（零调用点死代码）— `render.ts:195` `stripInlineFormattingMarkers` — 全包零调用点。建议：同上，确认后移除。

> 注：仓库根 `AGENTS.md` 无独立「禁止死代码」条款，以上按 Code Quality 最小化/单调用点内联规则的延伸归类为 minor；若严格仅按显式命名条款判，则不构成 blocker/major。

### `packages/extensions/pi-thinking-ui/state.ts`
负责人：`liuyang (fyeeme)` · 职责：管理扩展全局状态（按 scope 的 UI 模式、活跃思考状态、消息归属、patch 引用计数），通过 `Symbol.for` 在模块重载间持久化。

- **[major]** Do not preserve backward compatibility unless the user asks for it — `state.ts:31`（`LegacyThinkingUIGlobalState` 接口）、`:110`（`ensureGlobalStateShape`，约 80 行）、`:172`（调用）— 专门用于从旧全局状态结构迁移（旧顶层 `mode`/`active`、旧 `patchReleases` 扁平等）。无证据表明用户要求保留兼容。建议：删除 `LegacyThinkingUIGlobalState`，将 `ensureGlobalStateShape` 简化为直接构造默认状态或仅保留字段补全。
  - _归类提示（需维护者确认）_：该迁移逻辑针对**磁盘上的旧状态文件**，可能是有意的运行时健壮性处理，而非 API/代码兼容。`AGENTS.md` 该条规则原文语境偏 API/代码兼容，此项归类偏主观，建议维护者确认后再决定去留。
- **[minor]** Simplicity First（死字段）— `state.ts:24` `ThinkingUIGlobalState.patchReleases` — 被赋值（`:159` 写、`:183` 初始化、`:129` 仅在 legacy 迁移中读），但导出函数 `registerThinkingPatchRelease`/`takeThinkingPatchRelease` 只操作 `patchReleasesByScope`，新代码路径从不读取 `patchReleases`。建议：删除该字段及相关赋值/迁移逻辑（与上一项联动）。

### `packages/extensions/pi-thinking-ui/package.json`
负责人：`liuyang (fyeeme)` · 职责：npm 包清单。

- **[minor]** Dependency and Install Security / manifest 正确性 — `package.json` 的 `files` 字段（`:22-33`）— 列出 `README.md`，但该文件在包目录中**实际不存在**（其余三个同类扩展 pi-hooks/pi-statusline/pi-mermaid-viewer 均实际包含 README.md，唯独本包缺失）。`npm pack` 会告警，tarball 字段与实际内容不一致。建议：补建 `README.md`，或从 `files` 移除该条目。

> 其余无违规：devDependencies 全部精确锁定（`0.77.0`/`22.19.19`/`5.9.3`）；peerDependencies 用 `>=0.77.0` 范围属 peer 标准用法；本包非 `packages/coding-agent`，shrinkwrap 规则不适用；版本基线与同类扩展一致。

---

## CLEAN 文件（已过滤）

- `packages/extensions/pi-thinking-ui/persistence.ts` — 无 `any`、无内联 import、无可擦除语法问题、错误处理针对真实文件 IO 场景。
- `packages/extensions/pi-thinking-ui/types.ts` — 纯类型定义，全合规。
- `packages/extensions/pi-thinking-ui/tsconfig.json` — `erasableSyntaxOnly: true` 已落实 strip-only 精神；erasable TS 规则路径不覆盖本扩展，且配置本身无冲突。

---

## 跨文件共性

1. **死代码/死字段频现**：`parse.ts`(2)、`render.ts`(2)、`state.ts`(1) 共 5 处零调用点函数/字段，外加 `internal-patch.ts` 1 处孤儿函数。`AGENTS.md` 无明文「禁止死代码」条款，但与 Simplicity First / 单调用点内联精神相悖，建议集中清理（清理前按规则先确认是否 intentional）。
2. **单调用点单行 helper 未内联**：集中在 `index.ts`（4 处 nit）。
3. **运行时 monkey-patch 的代价集中在 `internal-patch.ts`**：`as any` + 动态 `import()` 均出自对另一包内部 dist 的运行时访问，是本扩展最需要类型与依赖治理的文件。

## 建议处理优先级

1. **修 `internal-patch.ts:296` 的 `as any`** — 唯一接近硬规则违规级别的 major，查 `pi-tui` 的 `Markdown` 类型后替换。
2. **清理死代码/死字段**（`parse.ts`/`render.ts`/`state.ts`）— 直接降复杂度，低风险（先确认 intentional）。
3. **确认 `state.ts` Legacy 迁移代码去留** — 维护者判断是否为有意的旧状态文件兼容。
4. **`package.json` 补建或移除 `README.md` 条目** — 影响 `npm pack` 正确性。
5. **内联 `index.ts` 单行 helper**（nit，可选）。

---

## 附录：方法论与验证说明

- **编排**：扫描目录得 9 个待审计文件 → 为每个文件派发 1 个 fresh-context 审计 Agent（系统提示词 `replace` 模式、唯一定向仓库根 `AGENTS.md`、仅 `read/grep/find` 只读工具）→ 并行返回 → 主协调者收集并过滤 CLEAN 结果。
- **synthesize 事实核对**：所有 major 项与「死代码/死字段」项均已用 `rg`/`read` 复核（`as any`、`LegacyThinkingUIGlobalState`、`firstMeaningfulLine`/`firstSentence`、`stepHeader`/`stripInlineFormattingMarkers`、`patchReleases` 读写点、`README.md` 缺失）；`index.ts` 4 个 nit 已核实均为单调用点，并抽查其中 3 个确为单行函数体。审计 Agent 原始行号存在偏移，本报告改用核实后的准确行号。
- **负责人**：因无 `CODEOWNERS` 且 `author` 为空，依据 `git log` 唯一提交者统一归属 `liuyang (fyeeme)`；如需按模块/职能二次切分负责人，请补充归属规则。
- **临时审计 Agent**：已在本审计结束后删除，未遗留 agent 配置。
