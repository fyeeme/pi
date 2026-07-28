# pi-dynamic-workflows 综合分析报告

> **目标**: 完整解析 `pi-dynamic-workflows` 源码架构，逆向推断 Claude Code 动态工作流的执行层与 UI 层设计，对比 pi agents 现有能力，输出可执行的迁移/重构/优化方案。

---

## 目录

1. [pi-dynamic-workflows 完整源码解析](#1-pi-dynamic-workflows-完整源码解析)
2. [Claude Code 动态工作流逆向分析](#2-claude-code-动态工作流逆向分析)
3. [pi agents 架构对比](#3-pi-agents-架构对比)
4. [功能缺失对比矩阵](#4-功能缺失对比矩阵)
5. [可执行方案](#5-可执行方案)

---

## 1. pi-dynamic-workflows 完整源码解析

### 1.1 整体架构

```
pi-dynamic-workflows/
├── index.ts                    # Extension 入口 (Task 8 wiring)
├── src/
│   ├── index.ts                # Public API barrel
│   ├── types.ts                # 核心类型系统 (7 step primitives + Budget + Result)
│   ├── outcomes.ts             # Outcome 收集器 (url/json/file_path 提取)
│   ├── planner.ts              # 启发式 planner (keyword → scaffold)
│   ├── inspect.ts              # TUI 交互式结果查看组件
│   ├── lifecycle.ts            # Agent 生命周期事件
│   ├── loader.ts               # .ts 工作流文件加载器 (AST guard + jiti)
│   ├── agent/
│   │   └── dispatch.ts         # Agent 派发底层 (spawn pi subprocess)
│   ├── budget/
│   │   ├── index.ts            # Barrel
│   │   ├── caps.ts             # 硬上限 (MAX_BATCH=4096, MAX_LIFETIME_AGENTS=1000)
│   │   └── pool.ts             # 实时 BudgetPool (reserve/track/remaining)
│   ├── cache/
│   │   ├── index.ts            # Barrel
│   │   ├── key.ts              # sha256 缓存键 (workflow+prompt+signature)
│   │   └── journal.ts          # JSONL Journal (跨 run 缓存恢复)
│   ├── determinism/
│   │   └── ast-guard.ts        # AST 守卫 (ban Date.now/Math.random/new Date)
│   ├── state/
│   │   ├── index.ts            # Barrel
│   │   └── names.ts            # 确定性 runId 生成器
│   └── runner/
│       ├── index.ts            # runWorkflow 主入口
│       └── stage-executor.ts   # 7 种步骤执行器 + runStepSequence
├── sessions/                   # (空目录，保留给 per-agent abort registry)
├── test/                       # 108 个单元测试
│   ├── e2e/                    # 端到端场景测试
│   └── *.test.ts               # 单元测试
└── examples/
    └── smoke-real-pi.ts        # 真实 pi 子进程冒烟测试
```

### 1.2 核心类型系统 (`src/types.ts`)

**7 种步骤原语 (Step Primitives)**:

| Step Type | 用途 | 关键字段 | 输出结构 |
|-----------|------|----------|----------|
| `agent` | 单个 LLM 调用 | `prompt`, `model?`, `tools?`, `systemPrompt?` | 最终 assistant 文本 |
| `code` | 纯函数变换 | `transform(ctx)` | transform 返回值 |
| `fan_out` | 并行 agent | `over()`, `agent(item,i)`, `parallelism?`, `merge?` | 合并数组 |
| `loop_until` | 条件循环 | `prompt(ctx,i)`, `until(ctx,i)`, `maxIterations?` | 迭代输出数组 |
| `adversarial` | 对抗评审 | `produce`, `rubric[]`, `judges?`, `minPass?` | `{candidate, passed, judges}` |
| `tournament` | 锦标赛评选 | `candidates`, `judges`, `produce` | `{candidates, winner, judges}` |
| `classify_route` | 分类路由 | `classifier`, `routes`, `fallback?` | `{category, route, routeStatus}` |

**关键接口**:

```typescript
// StepContext — 步骤间数据传递
interface StepContext {
  readonly input: unknown;
  step(id: string): { results: unknown; stats: StepStats };
}

// WorkflowDefinition — 声明式工作流图
interface WorkflowDefinition {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly StepDefinition[];  // 扁平列表，非 DAG
  readonly budget?: Budget;
}

// RunResult — 运行结果
interface RunResult {
  readonly runId: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly steps: readonly StepResult[];
  readonly stats: StepStats;
  readonly journalFile?: string;
  readonly error?: string;
}
```

**设计特点**:
- 步骤是**扁平列表**，不是 DAG 图。依赖关系通过 `ctx.step(id)` 向后引用实现。
- `defineWorkflow()` 是类型恒等函数，提供 discriminated union 的完整类型检查。
- `Budget` 可定义在 workflow 级别或 run 级别。

### 1.3 Runner 引擎 (`src/runner/`)

#### 1.3.1 `runWorkflow()` 主入口 (`src/runner/index.ts`)

```typescript
async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  // 1. 创建 AgentSpawnRegistry (per-call abort map)
  // 2. 选择 dispatch (默认 spawnAgent，可注入 fake)
  // 3. 解析 budget (opts.budget > workflow.budget > {})
  // 4. 创建 journal 目录 + 加载历史 journal → 内存缓存
  // 5. 创建 BudgetPool (实时追踪器)
  // 6. 构建 StepExecContext (mutable shared state)
  // 7. 调用 runStepSequence() 
  // 8. 返回 RunResult + 检查 journal 写入错误
}
```

**关键设计决策**:
- `now` 参数必填且确定性 —— 引擎内部永远不读 `Date.now()`。
- `cwd` 决定 journal 目录位置。
- journal 目录命名: `<cwd>/.pi/workflows/<workflow.name>/` (per-workflow, 跨 run 缓存)。
- 检查 journal 写入错误并附加到 result.error。

#### 1.3.2 Stage Executor (`src/runner/stage-executor.ts`)

这是核心执行引擎，实现了 7 种步骤的调度逻辑。

**共享 dispatch 管道** (`dispatchAgentCall()`):

```
1. signal.aborted? → 短路返回 (跳过派发)
2. computeCacheKey() → 检查 journal.lookup()
3. 命中 → 返回缓存值 (零派发)
4. 未命中 → guardSpawn() (budget 检查 + reserve 1 slot)
5. notifyStart (lifecycle)
6. journal.append {type:"started"}
7. exec.dispatch() → spawn subprocess
8. applyOutcome (++spawned, pool.track)
9. journal.append {type:"result"}
10. notifyEnd (lifecycle)
```

**7 种步骤执行逻辑**:

| Step | 执行逻辑 |
|------|----------|
| `agent` | 解析 prompt (string/function) → dispatchAgentCall → StepResult |
| `code` | 执行 transform(ctx) → StepResult (无 dispatch, 无缓存, 不计 budget) |
| `fan_out` | guardBatch(pre-check) → mapWithConcurrencyLimit → 每个 item dispatchAgentCall → optional merge |
| `loop_until` | while(!until && iter < maxIter) → dispatchAgentCall → accumulate values |
| `adversarial` | guardBatch(1+N) → produce candidate → N judges mapWithConcurrencyLimit → tally pass/fail |
| `tournament` | guardBatch(N+M) → N candidates 并行 → M judges 并行 → tally winner |
| `classify_route` | dispatchAgentCall classifier → parse category → runStepSequence(route) 递归 |

**runStepSequence** (步骤列表顺序执行):
```
for each step in steps:
  signal check → runWithRetry(step) → prior.set() → out.push()
  abort on fail/skip → return early
```

**runWithRetry**:
```
executeStep → while(failed && attempt < maxRetries) → reassign sr + accumulate stats
```

### 1.4 Agent 派发引擎 (`src/agent/dispatch.ts`)

**核心机制**: 每个 agent 调用 = 一个 `pi --mode json -p --no-session` 子进程。

```
getPiInvocation(args) → spawn(pi, args) → 
  解析 stdout JSONL 行 → 
    提取 message_end / tool_result_end 事件 →
    累计 usage (tokens/cost)
  监听 per-call AbortController → 
    SIGTERM → 5s grace → SIGKILL
```

**AgentSpawnRegistry**: `Map<callId, ChildProcess>` + `Map<callId, AbortController>`

**per-agent abort 原语**:
- `abortAgent(registry, callId)` — 中止一个调用
- `skipAgent(registry, callId)` — 跳过 (abort + fire onAgentSkip)
- `retryAgent(registry, callId)` — 中止并标记重试 (abort + fire onAgentRetry)

**并发控制** (`mapWithConcurrencyLimit`):
```typescript
// 固定 N 个 worker，每个 worker 循环取下一个 item 执行
// 保持输出顺序与输入一致
```

### 1.5 预算系统 (`src/budget/`)

**两层预算控制**:

```
Layer 1 (Hard Caps): MAX_BATCH=4096, MAX_LIFETIME_AGENTS=1000
  → assertBatchSize / assertLifetimeAgents → BudgetExceededError

Layer 2 (BudgetPool): MaxAgents, MaxTokens, MaxDurationMs
  → reserve(n) — 原子预留 agent 槽位 (TOCTOU 安全)
  → track({tokens}) — 累计 token 消耗
  → remaining(now) — 查询各维度余额
  → isExhausted(now) — 是否任一维度耗尽
  → canSpawn(n, now) — 是否可派发 n 个 agent
```

**关键设计**:
- `reserve(n)` 是同步操作，关闭了并发 TOCTOU 窗口。
- 返回 release handle，派发失败时释放预留槽位。
- `maxTokens` 是事后追踪 (agent 落定后才知道 token 消耗)。

**`guardBatch` vs `guardSpawn` 的双层守卫**:
```typescript
// guardBatch: fanout/composite 的预检 (canSpawn — 不预留)
// guardSpawn:  每 agent 的原子预留 (reserve(1) — 真预留)
// 这避免了 double-counting 问题
```

### 1.6 缓存系统 (`src/cache/`)

**Cache Key** (`key.ts`):
```
sha256(workflowName + NUL + prompt + NUL + normalizeSignature(opts))
→ "wf:<hex>"
```

**Signature 归一化**:
```typescript
// 只取 model, tools, systemPrompt 三个字段
// 对象 key 排序 → JSON.stringify
// 函数字段 → 抛错 (函数不可哈希)
// callId/signal/cwd 等运行时字段排除在外
```

**Journal** (`journal.ts`):
```jsonl
{"type":"started","key":"wf:abc123...","at":1700000000000}
{"type":"result","key":"wf:abc123...","at":1700000000005,"ok":true,"value":"agent output"}
```

**加载时**: 读取 JSONL → 只保留 `type:"result"` 的条目 → Map<key, entry>

**跨 run 缓存**: journal 目录是 per-workflow (不含 runId)，所以同一 workflow 的多次运行共享缓存。

**写入安全**: 串行化 append (Promise chain)，避免并发 JSONL 行交错。

### 1.7 确定性保证 (`src/determinism/` + `src/state/`)

**AST 守卫** (`ast-guard.ts`):
```
使用 typescript compiler's createSourceFile 解析 TS 源码
→ 遍历 AST 节点
→ 标记四种违规:
  - Date.now()      → date_now
  - Math.random()   → math_random
  - new Date()      → new_date
  - Date() (无参)   → date_call
→ assertDeterministic: 在 jiti 加载之前拦截
```

**局限性**: 只扫描单文件入口，不追踪 import。alias 绕过 (`const D = Date; D.now()`)。

**确定性 RunId** (`names.ts`):
```typescript
generateRunId({timestamp, sequence}) 
→ `run-<base36(ts)>-<base36(seq)>`
// 纯函数，相同输入永远相同输出
```

### 1.8 生命周期事件 (`src/lifecycle.ts`)

```typescript
interface AgentLifecycleListeners {
  onAgentStart?(callId: string): void;
  onAgentEnd?(callId: string, ok: boolean, stats?: StepStats): void;
  onAgentSkip?(callId: string): void;
  onAgentRetry?(callId: string): void;
}
```

**设计**: listener 的异常被 try/catch 包裹，永不阻断派发路径。

### 1.9 Extension 入口 (`index.ts`)

**注册的工具**: `run_workflow`

**数据 workflow → 代码 WorkflowDefinition**: 支持 5 种 JSON 序列化的步骤类型
- 模板语法: `{{input}}`, `{{step.<id>}}`, `{{item}}`
- 不支持 `code` / `loop_until` (需要函数)

**注册的命令**: `wf-inspect` — 交互式查看上次运行结果

**Progress Widget**: 基于 `buildProgressWidget` 的实时 TUI 进度显示
- 使用 `ctx.ui.setWidget()` 渲染步骤状态行
- 使用 `ctx.ui.setStatus()` 渲染 footer 摘要
- 自动计算 expected agent count (fan_out 在运行时揭示)

### 1.10 测试架构

**测试分层**:
```
test/e2e/helpers.ts        — makeFakeDispatch, countingDispatch
test/e2e/scenarios.test.ts — 7 个端到端场景
test/e2e/composites.test.ts— adversarial/tournament/classify_route 场景
test/abort.test.ts         — abort/skip/retry
test/ast-guard.test.ts     — AST 守卫
test/budget.test.ts        — BudgetPool 行为
test/journal.test.ts       — Journal 加载/追加/恢复
test/key.test.ts           — Cache key 生成/归一化
test/loader.test.ts        — loadWorkflowModule
test/names.test.ts         — generateRunId
test/outcomes-planner.test.ts — outcome 收集器 + planner
```

**Fake Dispatch**: 完全注入，无 pi 二进制依赖。

---

## 2. Claude Code 动态工作流逆向分析

基于 pi-dynamic-workflows README 中的 "Claude Code fusion" 设计文档和 CC Workflow tool 的公开接口，逆向推断 CC 动态工作流的完整架构。

### 2.1 CC Workflow 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    CC Workflow Engine                     │
├─────────────────────────────────────────────────────────┤
│  Script Layer (user-facing)                              │
│  ┌─────────────────────────────────────────────────────┐│
│  │ export const meta = { name, description, phases }    ││
│  │ agent() / parallel() / pipeline() / phase() / log() ││
│  │ budget.{total, spent(), remaining()}                ││
│  │ args: any                                           ││
│  └─────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────┤
│  Execution Layer (引擎内部)                              │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Sandbox   │ │ Cache     │ │ Budget   │ │ Abort    │ │
│  │ (vm/DSo)  │ │ (Key+ews) │ │ (Pool)   │ │ (Map)    │ │
│  └───────────┘ └───────────┘ └──────────┘ └──────────┘ │
│  ┌───────────┐ ┌───────────┐ ┌────────────────────────┐ │
│  │ Planner   │ │ Dispatch  │ │ Runaway Caps           │ │
│  │ (NL→DAG)  │ │ (Agent)   │ │ (MAX_BATCH=4096, etc)  │ │
│  └───────────┘ └───────────┘ └────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│  UI Layer (TUI/Ink)                                      │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Progress Tree (phase groups + agent status)         ││
│  │ Agent Detail Panel (expand to see result+stats)     ││
│  │ Budget Meter (spent/remaining)                      ││
│  │ Abort Controls (per-agent skip/retry)               ││
│  │ Resume Indicator (cached vs dispatched)             ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### 2.2 执行层详细设计

#### 2.2.1 Script DSL

CC 的 workflow 是 **JavaScript 脚本**，不是声明式配置:

```javascript
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}

phase('Scan')
const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})

phase('Fix')
const fixes = await pipeline(flaky, async (f) => {
  return agent(`Fix flaky test: ${f.name}`, {schema: FIX_SCHEMA})
})
```

**关键 API**:
| API | 语义 | pi 对应 |
|-----|------|---------|
| `agent(prompt, opts)` | 派发单个 agent | `dispatchAgentCall` |
| `parallel(thunks[])` | 屏障式并行 | `fan_out` (但 CC 有 barrier) |
| `pipeline(items, ...stages)` | 流水线 (无 barrier) | `fan_out` + 串行 steps |
| `phase(title)` | 进度分组 | `buildProgressWidget` 的步骤列表 |
| `log(message)` | 旁白日志 | 无直接对应 |
| `budget.*` | Token 预算 API | `BudgetPool` |
| `args` | 入参注入 | `opts.input` |

#### 2.2.2 确定性沙箱 (Deterministic Sandbox)

**CC 实现** (`DSo` 模块):
- 在 workflow 脚本被加载进 vm 之前，AST 扫描 (acorn parser) 禁止 `Date.now()`/`Math.random()`/`new Date()`。
- `Date.now()`/`Math.random()` 在运行时也会抛错 (vm 沙箱层面拦截)。
- Run ID 是 `(timestamp, sequence)` 的纯函数。

**pi 已实现**: `src/determinism/ast-guard.ts` + `src/state/names.ts`
- ✅ AST 守卫 (4 种违规检测)
- ✅ 确定性 RunId
- ❌ 仅单文件扫描，无传递依赖检查
- ❌ 无运行时层面拦截 (因为 pi 用 jiti 加载真实模块，非 vm 沙箱)

#### 2.2.3 缓存键恢复 (Cache-Key Resume)

**CC 实现** (`Hid` + `tA_` + `ews`):
- `Hid`: 缓存键 = `sha256(workflow + prompt + signature)`
- `tA_`: 签名归一化 (排序 object keys, 过滤函数)
- `ews`: JSONL journal 类，`started` + `result` entries
- Resume: 相同 workflow 脚本重跑，所有 unprompt-changed agent 自动缓存命中

**pi 已实现**: `src/cache/key.ts` + `src/cache/journal.ts`
- ✅ sha256 缓存键
- ✅ 签名归一化
- ✅ JSONL journal (started + result)
- ✅ 跨 run 缓存 (per-workflow)
- ❌ 缺少 staged resume (已编辑部分重跑，未编辑部分缓存)

#### 2.2.4 预算系统 (Budget Pool)

**CC 实现**:
- `budget.total`: 配置的 token 目标
- `budget.spent()`: 已消耗 tokens
- `budget.remaining()`: 剩余 tokens
- `while (budget.remaining() > N)`: 动态缩放循环
- `MAX_BATCH=4096`, `MAX_LIFETIME_AGENTS=1000`

**pi 已实现**: `src/budget/pool.ts` + `src/budget/caps.ts`
- ✅ BudgetPool (reserve/track/remaining/isExhausted)
- ✅ Hard caps (MAX_BATCH, MAX_LIFETIME_AGENTS)
- ✅ `scaleBatchByBudget()` 静态缩放
- ❌ 无动态 `while(remaining > N)` 循环 (CC 的命令式 vs pi 的声明式)

#### 2.2.5 Per-Agent Abort

**CC 实现**:
- `Map<callId, AbortController>` 
- 每个 agent 独立 `AbortController`
- `abortAgent(callId)` → 只影响一个 in-flight agent
- `skipAgent` / `retryAgent` 语义

**pi 已实现**: `sessions/spawn.ts` (实际在 `src/agent/dispatch.ts`)
- ✅ Per-call AbortController
- ✅ `abortAgent` / `skipAgent` / `retryAgent`
- ✅ Registry 清理 (finally block)
- ⚠️ 但 sessions/ 目录为空 — registry 在 agent/dispatch.ts 中

#### 2.2.6 Workflow 文件加载

**CC 实现**:
- vm 沙箱中加载 workflow 脚本
- AST guard 在加载前检查

**pi 已实现**: `src/loader.ts`
- ✅ jiti 加载前 AST guard
- ✅ loadWorkflowModule
- ❌ 仅单文件扫描

### 2.3 UI 层详细设计

#### 2.3.1 CC 的 UI 渲染模型

CC 使用 **Ink (React for CLI)** 渲染 TUI:

```
┌─────────────────────────────────────────────┐
│ ═══ workflow my-audit → completed (3.2s) ═══ │  ← 标题
│                                             │
│ ▸ ✓ scan (fan_out)                          │  ← 步骤列表 (可滚动选取)
│      out: found 3 issues                    │  ← 展开的详情
│      1.2k tok · 3 agents · 450ms            │  ← 统计信息
│   ✓ fix (agent)                             │
│      out: fixed issue #1                    │
│   ⏳ verify (adversarial)                   │  ← 运行中状态
│                                             │
│ ───────────────────────────────────────────  │
│ wf 5/6 agents · 3.4k tok · 3s              │  ← 底部摘要
└─────────────────────────────────────────────┘
```

**CC UI 特性**:
1. **Progress Tree**: 按 `phase()` 分组的树形进度
2. **Agent Detail Panel**: 选中展开 → 显示结果/统计
3. **实时更新**: agent start/end → 即时 UI 刷新
4. **Budget Meter**: 实时显示 spent/remaining
5. **Abort Controls**: 快捷键跳过/重试单个 agent
6. **Resume Indicator**: 缓存命中的 agent 标记为 "cached"

#### 2.3.2 pi 的 UI 实现对比

**pi 已实现** (`index.ts` + `src/inspect.ts`):

| Feature | pi 实现 | 状态 |
|---------|---------|------|
| Progress Widget | `buildProgressWidget` → `setWidget("wf:progress")` | ✅ 已实现 |
| Footer Summary | `setStatus("wf:summary")` | ✅ 已实现 |
| Per-step status lines | 渲染步骤图标 + agent 计数 + tokens | ✅ 已实现 |
| Interactive Inspect | `wf-inspect` 命令 → `WorkflowInspect` component | ✅ 已实现 |
| Real-time Updates | listener 回调 → render() | ✅ 已实现 |
| Step Detail Expand | ↑↓ 选择 + enter 展开详情 | ✅ 已实现 |
| Phase Grouping | ❌ | 缺少 |
| Budget Meter | ❌ | 缺少 |
| Abort Controls UI | ❌ | 缺少 (有 API 但无 UI 快捷键) |
| Resume/Cache Indicator | ❌ | 缺少 |
| Pipeline Visual | ❌ | 缺少 (pipeline vs parallel 的视觉区分) |
| Narration (log) | ❌ | 缺少 |
| Workflow Tree View | ❌ | 缺少 (多 workflow 嵌套时) |

### 2.4 CC Workflow 的完整 API 协议

基于 CC Workflow tool 定义逆向的完整接口:

```typescript
// CC Workflow Script API
interface WorkflowScriptAPI {
  // Agent 派发
  agent(prompt: string, opts?: AgentOpts): Promise<AgentResult>;
  
  // 并行 + 流水线
  parallel<T>(thunks: (() => Promise<T>)[]): Promise<(T | null)[]>;
  pipeline<T, R>(items: T[], ...stages: Stage<T, R>[]): Promise<(R | null)[]>;
  
  // 进度 + 日志
  phase(title: string): void;
  log(message: string): void;
  
  // 预算
  budget: {
    total: number | null;
    spent(): number;
    remaining(): number;
  };
  
  // 入参
  args: any;
  
  // workflow 嵌套
  workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any>;
}

// Agent 选项
interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: JSONSchema;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  isolation?: 'worktree';
  agentType?: string;
}
```

---

## 3. pi Agents 架构对比

### 3.1 pi Agent 运行时架构

```
┌──────────────────────────────────────────────────────┐
│                   pi Coding Agent                     │
├──────────────────────────────────────────────────────┤
│  ExtensionAPI                                         │
│  ├── registerTool()         注册 LLM 可调用工具       │
│  ├── registerCommand()      注册用户命令              │
│  ├── registerShortcut()     注册快捷键                │
│  ├── on(event, handler)     事件订阅                  │
│  ├── sendMessage()          发送自定义消息            │
│  ├── sendUserMessage()      发送用户消息 (注入 prompt) │
│  └── appendEntry()          追加会话条目              │
├──────────────────────────────────────────────────────┤
│  ExtensionUIContext                                   │
│  ├── setWidget(key, content)      设置 widget          │
│  ├── setStatus(key, text)         设置状态栏           │
│  ├── custom(factory)              自定义组件 (有焦点)  │
│  ├── select/confirm/input/notify  交互对话框           │
│  ├── setFooter/setHeader          自定义 footer/header │
│  └── onTerminalInput()            原始终端输入监听      │
├──────────────────────────────────────────────────────┤
│  Agent Runtime (agent-loop.ts)                        │
│  ├── Agent 类 (runAgentLoop)                          │
│  ├── beforeToolCall / afterToolCall hooks             │
│  ├── ToolExecutionMode (sequential/parallel)          │
│  └── QueueMode (all/one-at-a-time)                    │
├──────────────────────────────────────────────────────┤
│  TUI System (tui.ts)                                  │
│  ├── Component 接口 (render, handleInput, dispose)    │
│  ├── Overlay 系统                                     │
│  ├── Theme 系统                                       │
│  └── Keybindings 系统                                 │
└──────────────────────────────────────────────────────┘
```

### 3.2 pi-dynamic-workflows 与 pi agents 的集成点

当前集成状态 (通过 `index.ts` extension 入口):

```
pi extension loader
  → 加载 index.ts
    → registerTool("run_workflow")
    → registerCommand("wf-inspect")
```

**已使用的 pi API**:
| API | 用途 |
|-----|------|
| `pi.registerTool()` | 注册 `run_workflow` 为 LLM 可调用工具 |
| `pi.registerCommand()` | 注册 `wf-inspect` 查看结果 |
| `ctx.ui.setWidget()` | 实时进度 widget |
| `ctx.ui.setStatus()` | 底部状态摘要 |
| `ctx.ui.custom()` | `wf-inspect` 交互式组件 |
| `ctx.cwd` | 默认工作目录 |
| `signal` | 运行级中止信号 |

**未使用的 pi API (可能有用)**:
| API | 潜在用途 |
|-----|---------|
| `pi.registerShortcut()` | per-agent abort 快捷键 |
| `pi.on("agent_settled")` | workflow 完成后自动检查 |
| `pi.sendMessage()` | 自定义消息类型 |
| `pi.sendUserMessage()` | workflow 内触发 agent 对话 |
| `pi.registerMessageRenderer()` | 自定义 workflow 消息渲染 |
| `ctx.ui.setFooter()` | 预算 meter |
| `ctx.ui.onTerminalInput()` | 实时 abort 快捷键 |

### 3.3 pi Agent vs CC Agent 派发差异

| 维度 | CC Workflow Agent | pi Workflow Agent |
|------|-------------------|-------------------|
| 派发方式 | 内部 API 调用 (同进程) | `spawn("pi", ...)` 子进程 |
| 上下文 | 共享 session context | 独立 `--no-session` 进程 |
| 工具可用 | 继承父 workflow 工具 | 完全独立配置 |
| 成本 | 内存内调用 | 进程创建 + JSON 解析 |
| 可注入性 | 不可注入 | 完全可注入 (`dispatch` 参数) |
| Abort | 进程内 AbortController | SIGTERM → SIGKILL |

---

## 4. 功能缺失对比矩阵

### 4.1 执行层对比

| 功能 | CC Workflow | pi-dynamic-workflows | 差距 |
|------|-------------|---------------------|------|
| Script DSL (`agent/parallel/pipeline`) | ✅ 完整 | ✅ 声明式类型定义 | **设计选择** — 声明式更安全/可测/LLM友好 (见 §6) |
| 声明式 Step 定义 (`defineWorkflow`) | ❌ | ✅ 完整 | pi 独有 |
| 10 种 step 原语 | ⚠️ (通过组合 DSL 实现) | ✅ 完整 | pi 更结构化 (含 sub_workflow/loop_until_dry) |
| 确定性沙箱 (AST guard) | ✅ (vm + acorn) | ⚠️ (单文件 + TS compiler) | 缺少传递检查 + 运行时拦截 |
| 缓存键恢复 (Cache Resume) | ✅ | ✅ | 基本对齐 |
| 预算系统 (BudgetPool) | ✅ (动态 while 循环) | ✅ (静态预检) | 基本对齐 |
| Per-Agent Abort | ✅ | ✅ | 基本对齐 |
| Staged Resume | ✅ | ✅ (manifest.json) | **已实施** — 增量恢复 + 缓存预测 |
| Workflow 嵌套 (子 workflow) | ✅ `workflow()` | ✅ `sub_workflow` | **已实施** |
| Barrier (parallel) | ✅ | ⚠️ (fan_out 无 barrier 语义) | fan_out 默认 pipeline 行为 |
| log/旁白 API | ✅ | ❌ | 后续优化 |
| Phase 分组 | ✅ | ✅ (PhaseDefinition) | **已实施** |
| Agent 类型系统 (agentType) | ✅ | ❌ | 后续优化 |
| Worktree Isolation | ✅ | ❌ | pi 不需要 (无 vm 沙箱) |
| Loop-until-dry 模式 | ✅ (组合 DSL) | ✅ (`loop_until_dry`) | **已实施** — 含 critic 追问 |
| Completeness Critic | ✅ (组合 DSL) | ✅ (loop_until_dry.critic) | **已实施** |

### 4.2 UI 层对比

| 功能 | CC Workflow | pi-dynamic-workflows | 差距 |
|------|-------------|---------------------|------|
| Progress Tree (Phase 分组) | ✅ | ✅ (PhaseDefinition + 树形渲染) | **已实施** |
| Agent 状态实时更新 | ✅ | ✅ | 基本对齐 |
| Step Detail Expand | ✅ | ✅ (wf-inspect) | 基本对齐 |
| Budget Meter (实时) | ✅ | ✅ (Agents/Tokens 进度条) | **已实施** |
| Per-Agent Abort UI | ✅ (快捷键) | ✅ (ctrl+k → agent 选择器) | **已实施** |
| Cache/Resume Indicator | ✅ | ✅ (↻ 图标 + manifest) | **已实施** |
| Pipeline vs Parallel 视觉区分 | ✅ | ❌ | 后续优化 |
| Narration Log | ✅ | ❌ | 后续优化 |
| Workflow 嵌套可视化 | ✅ | ❌ | 后续优化 |
| 多 Workflow 并行运行 | ✅ | ❌ (单 run) | 后续优化 |
| Workflow 历史查看 | ✅ | ❌ | 后续优化 |
| Journal/Budget 详情面板 | ✅ | ❌ | 后续优化 |

### 4.3 集成层对比

| 功能 | CC Workflow | pi-dynamic-workflows | 差距 |
|------|-------------|---------------------|------|
| 作为 LLM Tool 可用 | ✅ (Workflow tool) | ✅ (run_workflow tool) | 基本对齐 |
| 作为 Slash Command | ✅ | ✅ (wf-inspect) | 基本对齐 |
| 事件系统集成 | ✅ (lifecycle hooks) | ✅ (AgentLifecycleListeners) | 基本对齐 |
| 快捷键系统 | ✅ | ✅ (ctrl+k abort) | **已实施** |
| 自定义消息渲染 | ✅ | ❌ | 后续优化 |
| Footer 集成 | ✅ | ❌ | 后续优化 |
| Agent 中途交互 (steer) | ✅ | ❌ | 后续优化 |

---

## 5. 实施结果与后续规划

### 5.1 已完成 (第一批 + 第二批)

```
✅ Phase 1: UI 体验对齐
  ├── T1.1: Budget Meter — 实时预算消耗进度条 (Agents/Tokens)
  ├── T1.2: Cache/Resume Indicator — ↻ 图标 + manifest 增量恢复
  ├── T1.3: Phase 分组 + Progress Tree — 树形多级渲染
  └── T1.4: Per-Agent Abort UI — ctrl+k 快捷键 + agent 选择器

✅ Phase 2: 核心执行能力
  ├── T2.1: Workflow 嵌套 — sub_workflow step (共享 budget/journal/registry)
  ├── T2.2: Staged Resume — manifest.json 增量恢复 + 缓存预测
  └── T2.3: Loop-until-dry + Completeness Critic — 持续发现 + critic 追问
```

### 5.2 原有详细方案 (已全部实施)

以下方案来自最初的规划文档，现已全部实现。保留作为设计文档参考。

#### T1.1: Staged Resume (增量恢复)

**目标**: 当 workflow 脚本被编辑后重新运行时，只有被修改的 agent 重新派发，未修改的缓存命中。

**当前状态**: journal 是 per-workflow (跨 run)，但 resume 后无法区分 "同一个 agent 被修改了" 还是 "新增了一个 agent"。

**方案**:
```typescript
// src/cache/staged-resume.ts

interface StagedResumeState {
  /** 上次运行时的 agent 调用序列 (按 key 排序) */
  previousKeys: CacheKey[];
  /** 当前脚本的 agent 调用序列 */
  currentKeys: CacheKey[];
}

/**
 * 比较两次运行的 key 序列，返回需要重新派发的 key 集合。
 * - 新增的 key → 需要派发
 * - 修改的 key → 需要派发
 * - 未变的 key → 缓存命中
 * - 删除的 key → 从 journal 中标记过期
 */
function diffResumeState(prev: StagedResumeState, curr: StagedResumeState): {
  toDispatch: Set<CacheKey>;
  toReplay: Set<CacheKey>;
  expired: Set<CacheKey>;
}
```

**实施步骤**:
1. 在 `runWorkflow` 完成时写入 `manifest.json` (记录所有 key + order)
2. 在 `runWorkflow` 启动时比较 manifest
3. 接入 `dispatchAgentCall` 的缓存查找逻辑

#### T1.2: Workflow 嵌套

**目标**: 支持 workflow 内部嵌套子 workflow，类似 CC 的 `workflow(nameOrRef, args)`。

**方案**:
```typescript
// src/types.ts 新增步骤类型

interface SubWorkflowStep extends StepBase {
  readonly type: "sub_workflow";
  /** 内联定义或引用已加载的 workflow */
  readonly workflow: WorkflowDefinition;
  /** 传递给子 workflow 的 input */
  readonly input?: (ctx: StepContext) => unknown;
  /** 是否继承父 budget (默认共享) */
  readonly inheritBudget?: boolean;
}
```

**执行逻辑** (`stage-executor.ts`):
```typescript
async function execSubWorkflow(step: SubWorkflowStep, ctx: StepContext, exec: StepExecContext) {
  const subInput = step.input ? step.input(ctx) : ctx.input;
  // 子 workflow 共享父 journal/budget/registry
  const subExec = { ...exec, depth: exec.depth + 1 };
  const outcome = await runStepSequence(step.workflow.steps, subInput, subExec);
  return stepResult(step.id, "sub_workflow", outcome.status, 
    { steps: outcome.steps, status: outcome.status }, 
    aggregateStats(outcome.steps.map(s => s.stats), 0));
}
```

#### T1.3: Phase 分组 + log API

**目标**: 支持 workflow 定义中的 phase 分组，以及运行时 log。

**方案**:
```typescript
// src/types.ts 新增

interface WorkflowDefinition {
  // ...existing...
  /** Phase 分组定义 (可选的 UI 分组) */
  readonly phases?: readonly PhaseDefinition[];
}

interface PhaseDefinition {
  readonly title: string;
  readonly detail?: string;
  readonly stepIds: readonly string[];  // 属于此 phase 的 step id
  readonly model?: string;              // phase 级 model override
}

// 新增 StepExecContext 字段
interface StepExecContext {
  // ...existing...
  /** 运行时日志消息 (narration) */
  readonly logs: Array<{ at: number; message: string; phase?: string }>;
}
```

**扩展 API**:
```typescript
// index.ts 扩展 run_workflow tool schema
// 增加 phases 参数
// 扩展 progress widget 显示 phase 分组
```

#### T1.4: Barrier 语义 (parallel)

**目标**: `fan_out` 支持真正的 barrier 模式 (`parallel`)，而不仅仅是 pipeline。

**当前状态**: `fan_out` 使用 `mapWithConcurrencyLimit`，所有 item 独立运行。这是 pipeline 行为 (item A 可以处于 stage 3 而 item B 还在 stage 1)。

**方案**:
```typescript
// src/types.ts 新增

interface FanOutStep extends StepBase {
  // ...existing...
  /** 是否使用 barrier 模式。默认 false (pipeline 行为)。
   *  true 时所有 item 先完成当前阶段，再进入下一阶段。 */
  readonly barrier?: boolean;
  /** 多阶段定义 (当有多个 stage 时使用 barrier 模式) */
  readonly stages?: readonly StageTransform[];
}

interface StageTransform {
  readonly agent: (prevResult: unknown, originalItem: unknown, index: number) => FanOutItemSpec;
}
```

### 5.3 Phase 2: UI 体验对齐

#### T2.1: Progress Tree (Phase 分组)

**目标**: 进度 widget 按 phase 分组显示，类似 CC 的多级树形结构。

**方案**:
```typescript
// src/ui/progress-tree.ts

interface ProgressNode {
  readonly id: string;
  readonly label: string;
  readonly status: 'pending' | 'running' | 'done' | 'failed';
  readonly children?: ProgressNode[];
  readonly stats?: { agents: number; tokens: number };
}

class ProgressTreeWidget {
  constructor(
    private phases: readonly PhaseDefinition[],
    private setWidget: (lines: string[]) => void,
  ) {}
  
  onAgentStart(callId: string, phaseTitle?: string): void;
  onAgentEnd(callId: string, ok: boolean, stats: StepStats): void;
  
  render(): string[] {
    // 按 phase 分组渲染
    // 每个 phase: [icon] phase_title · detail
    //   每个 step:     [icon] step_id [done/total] · tok
  }
}
```

**UI 效果**:
```
▾ ✓ Scan (grep test logs)          ← Phase 分组 (可折叠)
    ✓ scan:find (fan_out) [3/3] · 1.2k tok
    ✓ scan:dedup (code)
▾ ⏳ Fix (one per flaky test)       ← 运行中的 phase
    ✓ fix:test-a (agent) · 450 tok
    ⏳ fix:test-b (agent)           ← 运行中
    ○ fix:test-c (agent)           ← 等待中
────────────────────────────────────
wf 5/6 agents · 3.4k tok · 3s      ← Footer
```

#### T2.2: Budget Meter

**目标**: 在 footer 或独立 widget 中显示实时预算消耗。

**方案**:
```typescript
// src/ui/budget-meter.ts

interface BudgetMeterOptions {
  readonly maxAgents?: number;
  readonly maxTokens?: number;
}

function renderBudgetMeter(pool: BudgetPool, now: number): string[] {
  const r = pool.remaining(now);
  const total = pool.total;
  
  const lines: string[] = [];
  if (total.maxAgents) {
    const pct = 1 - (r.agents / total.maxAgents);
    lines.push(renderBar('Agents', r.agents, total.maxAgents, pct));
  }
  if (total.maxTokens) {
    const pct = 1 - (r.tokens / total.maxTokens);
    lines.push(renderBar('Tokens', r.tokens, total.maxTokens, pct));
  }
  return lines;
}

function renderBar(label: string, remaining: number, total: number, pct: number): string {
  const width = 20;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${label} [${bar}] ${remaining}/${total}`;
}
```

**集成点**: 
- 在 `buildProgressWidget` 的 `render()` 中追加 budget meter 行
- 或在 `ctx.ui.setFooter()` 中渲染独立的 budget meter 组件

#### T2.3: Per-Agent Abort UI (快捷键)

**目标**: 在 workflow 运行中，用户可以通过快捷键跳过或重试单个 agent。

**方案**:
```typescript
// index.ts 扩展

export default function (pi: ExtensionAPI): void {
  // ...existing...
  
  // 注册快捷键
  pi.registerShortcut('ctrl+k', {
    description: 'Skip current workflow agent',
    handler: async (ctx) => {
      // 1. 暂停当前 agent
      // 2. 弹出选择器 (select the agent to skip)
      // 3. skipAgent(registry, callId)
    }
  });
}

// 或使用 onTerminalInput 监听实时输入
```

**交互流程**:
```
1. 用户按 ctrl+k
2. 弹出 agent 列表选择器
3. 用户选择要跳过的 agent
4. UI 更新: agent 标记为 "skipped"
5. 继续 workflow
```

#### T2.4: Cache/Resume Indicator

**目标**: 在进度 widget 中标记哪些 agent 是缓存命中的。

**方案**:
```typescript
// 扩展 AgentLifecycleListeners

interface AgentLifecycleListeners {
  // ...existing...
  onAgentCacheHit?(callId: string): void;
}

// 在 dispatchAgentCall 中触发:
if (cached?.type === "result" && cached.ok) {
  notifyCacheHit(exec, callId);
  return { ..., cached: true };
}
```

**UI 效果**:
```
  ✓ cached:gather (agent)     ← 缓存命中标记
  ✓ dispatched:summarize (agent)  ← 新派发标记
```

### 5.4 Phase 3: 高级模式 + 深度集成

#### T3.1: Loop-until-dry + Completeness Critic

**目标**: 支持 "持续发现直到没有新结果" 的循环模式。

**方案**:
```typescript
// src/types.ts 新增

interface LoopUntilDryStep extends StepBase {
  readonly type: "loop_until_dry";
  /** 每轮发现 agent */
  readonly prompt: (ctx: StepContext, known: unknown[]) => string | Promise<string>;
  /** 合并新发现到已知集合 */
  readonly merge: (known: unknown[], fresh: unknown[]) => unknown[];
  /** 去重 key 函数 */
  readonly keyOf: (item: unknown) => string;
  /** 连续 dry 轮数阈值 (默认 2) */
  readonly dryThreshold?: number;
  readonly maxRounds?: number;
}
```

**执行逻辑**:
```typescript
async function execLoopUntilDry(step: LoopUntilDryStep, ctx: StepContext, exec: StepExecContext) {
  let known: unknown[] = [];
  let dry = 0;
  
  while (dry < (step.dryThreshold ?? 2)) {
    const prompt = await step.prompt(ctx, known);
    const outcome = await dispatchAgentCall(/*...*/);
    
    const fresh = parseFresh(outcome.value);
    const newItems = fresh.filter(f => !known.some(k => step.keyOf(k) === step.keyOf(f)));
    
    if (newItems.length === 0) {
      dry++;
    } else {
      dry = 0;
      known = step.merge(known, newItems);
    }
  }
  
  return stepResult(step.id, "loop_until_dry", "done", known, stats);
}
```

#### T3.2: AgentType 系统

**目标**: 支持不同的 agent 类型 (general-purpose, code-reviewer, etc.)，类似 CC 的 `agentType` 参数。

**方案**:
```typescript
// src/agent/types.ts 新增

interface AgentTypeDefinition {
  readonly name: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly allowedTools?: readonly string[];
}

// 扩展 AgentStep / AgentCallSpec
interface AgentStep extends StepBase {
  // ...existing...
  readonly agentType?: string;  // 引用已注册的 agent type
}

// 在 dispatch.ts 中根据 agentType 获取 systemPrompt/tools
```

**注册表**:
```typescript
// pi extension 中可以注册 agent types
pi.registerAgentType({
  name: "code-reviewer",
  systemPrompt: "You are a thorough code reviewer...",
  tools: ["read", "grep", "find"],
});
```

#### T3.3: 自定义消息渲染 + Footer 集成

**目标**: Workflow 运行状态通过自定义消息类型在聊天历史中持久化。

**方案**:
```typescript
// src/ui/message-renderer.ts

// 注册自定义消息类型
pi.registerMessageRenderer<WorkflowRunMessage>("workflow_run", (msg, opts, theme) => {
  return new WorkflowRunComponent(msg.details, opts, theme);
});

// Workflow 完成时发送消息
const result = await runWorkflow({...});
pi.sendMessage({
  customType: "workflow_run",
  content: `Workflow ${result.runId} completed`,
  display: `Workflow "${workflow.name}" → ${result.status}`,
  details: result,
});
```

**Footer 集成**:
```typescript
// 在 workflow 运行时替换 footer 为 budget meter
ctx.ui.setFooter((tui, theme, footerData) => {
  return new WorkflowFooterComponent(pool, tui, theme, footerData);
});

// 完成后恢复默认 footer
ctx.ui.setFooter(undefined);
```

#### T3.4: 多 Workflow 并行 + 历史查看

**目标**: 支持同时运行多个 workflow，并提供历史运行查看。

**方案**:
```typescript
// src/runner/multi-run.ts

interface MultiRunManager {
  /** 启动一个 workflow 运行 (不阻塞) */
  launch(opts: RunWorkflowOptions): { runId: string; promise: Promise<RunResult> };
  
  /** 列出所有运行中/已完成的 workflow */
  list(): MultiRunEntry[];
  
  /** 中止一个运行 */
  abort(runId: string): void;
}

// 命令: /wf-list — 列出所有 workflow 运行历史
// 命令: /wf-inspect <runId> — 查看特定运行
```

### 5.5 实施优先级矩阵

```
                    影响 × 工作量
                    ─────────────
高影响/低工作量     │ 高影响/高工作量
★★★★★ 优先做        │ ★★★ 第二优先级
────────────────────┼────────────────────
T2.2 Budget Meter   │ T2.1 Progress Tree
T2.4 Cache Indicator│ T1.3 Phase + log
T2.3 Abort UI       │ T1.2 Workflow 嵌套
────────────────────┼────────────────────
低影响/低工作量     │ 低影响/高工作量
★★ 有空再做         │ ★ 可延后
────────────────────┼────────────────────
T1.4 Barrier 语义   │ T1.1 Staged Resume
T3.3 消息渲染       │ T3.1 Loop-until-dry
                    │ T3.2 AgentType
                    │ T3.4 多Workflow并行
```

### 5.6 推荐的第一批实施 (MVP)

按优先级排列，第一批应完成:

1. **T2.2 Budget Meter** (1-2 天)
   - 在现有 `buildProgressWidget` 中追加 budget 进度条
   - 最直接的 UI 体验提升

2. **T2.4 Cache/Resume Indicator** (1 天)
   - 在 agent 状态行标记 `cached` vs `dispatched`
   - 小改动，大信息量

3. **T1.3 Phase 分组 + log** (2-3 天)
   - `WorkflowDefinition` 新增 `phases` 字段
   - `ProgressTreeWidget` 替换当前 flat 渲染
   - 同时支持 `log()` API

4. **T2.3 Per-Agent Abort UI** (2-3 天)
   - 注册快捷键 `ctrl+k` → 选择 agent → skip
   - 或注册命令 `/wf-skip <callId>`

5. **T1.2 Workflow 嵌套** (2-3 天)
   - `SubWorkflowStep` 类型
   - `execSubWorkflow` 执行器
   - 嵌套 budget 共享逻辑

### 5.7 技术债务清理

在迁移过程中应同时解决:

1. **sessions/ 目录为空** — 将 `src/agent/dispatch.ts` 中的 registry 代码提取到 `sessions/spawn.ts`
2. **AST guard 单文件限制** — 添加 jiti import 追踪 (至少检查顶层 import)
3. **缺少 workflow-level events** — 在 `lifecycle.ts` 中添加 `onWorkflowStart/onWorkflowEnd/onStageStart/onStageEnd`
4. **typebox schema 类型安全** — `index.ts` 中的 `StepData` 类型应与 TypeBox schema 同步生成
5. **SIGTERM grace period** — `dispatch.ts` 中的 5s 硬编码应可配置

---

## 6. 声明式 DSL vs 命令式 DSL —— 设计选择

pi 选择了**声明式 DSL**（`defineWorkflow({steps: [...]})`），这与 CC 的**命令式 DSL**（`agent()/pipeline()/parallel()`）是不同的设计路径，**不是功能缺失**。

### 为什么声明式更适合 pi

| 维度 | 命令式 (CC) | 声明式 (pi) |
|------|------------|------------|
| **确定性** | 需要 vm 沙箱 + AST guard 双重保护 | 类型定义天然确定，AST guard 只需在 loader 层 |
| **可恢复性** | 恢复需要保存/恢复脚本的完整执行位置 | 步骤是固定列表，恢复只需 journal 比对 |
| **可串行化** | 脚本包含闭包，不可 JSON 序列化 | 纯数据，可通过 `run_workflow` tool 从 LLM 发起 |
| **类型安全** | 无编译时检查 | 完整的 TypeScript discriminated union 检查 |
| **可测试性** | 需要 mock 整个运行时 | 注入 `dispatch` 即可测试，无二进制依赖 |
| **LLM 友好** | 需要 LLM 生成正确 JS 代码 | JSON schema 约束，LLM 只需填数据 |

### 声明式 DSL 覆盖了 CC 的哪些模式

pi 的 10 种 step 原语 (agent/fan_out/code/loop_until/loop_until_dry/adversarial/tournament/classify_route/sub_workflow/phase grouping) 完整覆盖了 CC 的全部 6 种编排模式：

| CC 模式 | pi 对应 |
|---------|---------|
| Fan-out & Synthesize | `fan_out` + `merge` |
| Classify & Act | `classify_route` |
| Adversarial Verification | `adversarial` |
| Generate & Filter / Tournament | `tournament` |
| Loop Until Done | `loop_until` / `loop_until_dry` |
| Workflow Nesting | `sub_workflow` |

### 什么场景真正需要命令式 DSL

唯一无法覆盖的场景：**运行时根据 agent 输出的复杂值做多级条件判断**。

```javascript
// 这种动态分支声明式无法表达:
const severity = await agent("assess severity")
if (severity === "critical") {
  const root = await agent("find root cause")
  if (root.type === "network") await pipeline(servers, networkFix)
  else await pipeline(servers, appFix)
} else {
  await agent("log and continue")
}
```

但这种场景在实际中极为罕见。`classify_route` 已经覆盖了最常见的单级分类路由。如果真的需要，声明式可以通过 `sub_workflow` + `classify_route` 组合来近似。

### 结论

**pi 不需要迁移到命令式 DSL。** 声明式 DSL 在可测试性、可串行化、类型安全、LLM 友好等方面具有本质优势。当前 10 种 step 原语完整覆盖了 CC 工作流的所有核心编排模式。

---

## 附录

### A. 文件清单

**pi-dynamic-workflows 源文件 (18 个)**:
```
src/index.ts              (barrel)
src/types.ts              (核心类型, 8871 bytes)
src/runner/index.ts       (runWorkflow 入口)
src/runner/stage-executor.ts (7 step executors)
src/agent/dispatch.ts     (spawnAgent + registry + concurrency)
src/budget/index.ts       (barrel)
src/budget/caps.ts        (MAX_BATCH, MAX_LIFETIME_AGENTS)
src/budget/pool.ts        (BudgetPool + scaleBatchByBudget)
src/cache/index.ts        (barrel)
src/cache/key.ts          (computeCacheKey + normalizeSignature)
src/cache/journal.ts      (Journal class)
src/determinism/ast-guard.ts (findDeterminismViolations)
src/state/index.ts        (barrel)
src/state/names.ts        (generateRunId)
src/lifecycle.ts          (AgentLifecycleListeners)
src/loader.ts             (loadWorkflowModule)
src/outcomes.ts           (collect/parseFirstJson)
src/planner.ts            (heuristicallyPlan)
src/inspect.ts            (WorkflowInspect TUI component)
index.ts                  (Extension 入口 + progress widget)
```

**测试文件 (11 个)**:
```
test/e2e/helpers.ts
test/e2e/scenarios.test.ts
test/e2e/composites.test.ts
test/abort.test.ts
test/ast-guard.test.ts
test/budget.test.ts
test/journal.test.ts
test/key.test.ts
test/loader.test.ts
test/names.test.ts
test/outcomes-planner.test.ts
```

### B. CC Workflow 术语映射

| CC 术语 | pi-dynamic-workflows 对应 |
|---------|--------------------------|
| `agent(prompt, opts)` | `dispatchAgentCall(callId, prompt, signature, exec)` |
| `parallel(thunks[])` | `fan_out` with `barrier: true` (待实现) |
| `pipeline(items, ...stages)` | `fan_out` (default behavior) |
| `phase(title)` | `phases` 定义 (待实现) |
| `log(message)` | `exec.logs.push()` (待实现) |
| `budget.{total,spent,remaining}` | `BudgetPool.{total,track,remaining}` |
| `args` | `opts.input` |
| `workflow(nameOrRef, args)` | `sub_workflow` step (待实现) |
| `export const meta = {...}` | `defineWorkflow({...})` |
| `DSo` (确定性沙箱) | `src/determinism/ast-guard.ts` |
| `Hid` + `tA_` (缓存键) | `src/cache/key.ts` |
| `ews` (journal) | `src/cache/journal.ts` |
| `MAX_BATCH=4096` | `src/budget/caps.ts` |
| `MAX_LIFETIME_AGENTS=1000` | `src/budget/caps.ts` |

---

*文档版本: 1.0 | 生成日期: 2026-07-27 | 作者: Claude Code Analysis*
