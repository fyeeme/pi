# pi-dynamic-workflows 综合代码审查报告

> 审查日期：2026-03-29
> 扩展路径：`packages/extensions/pi-dynamic-workflows`
> 审查方法：多 agent fan-out 工作流（7 个角度并行审查）

---

## 审查范围

- **源文件**：`src/types.ts`, `src/runner/`（index + stage-executor）, `src/cache/`（key + journal + index）, `src/determinism/ast-guard.ts`, `src/budget/`（pool + caps + index）, `src/state/`（names + index）, `src/lifecycle.ts`, `src/outcomes.ts`, `src/planner.ts`, `src/loader.ts`, `src/inspect.ts`, `src/index.ts`, `sessions/spawn.ts`, `index.ts`（扩展入口）
- **测试文件**：10 个文件（105 个测试用例）
- **行数**：约 2200 行 TypeScript

---

## 一、架构与模块设计

### 整体架构

```
index.ts                          # pi extension entry（run_workflow tool + wf-inspect）
src/
├── index.ts                      # Public API barrel
├── types.ts                      # 核心类型（7 step primitives + Budget + RunResult）
├── runner/
│   ├── index.ts                  # runWorkflow 入口
│   └── stage-executor.ts        # 步骤执行引擎
├── cache/
│   ├── key.ts                    # 缓存键（sha256）
│   ├── journal.ts                # 持久化 journal（JSONL）
│   └── index.ts
├── determinism/
│   └── ast-guard.ts              # AST 静态检查
├── budget/
│   ├── pool.ts                   # BudgetPool（track/reserve/remaining）
│   ├── caps.ts                   # 硬上限（MAX_BATCH, MAX_LIFETIME_AGENTS）
│   └── index.ts
├── state/
│   └── names.ts                  # generateRunId（纯函数）
├── lifecycle.ts                  # AgentLifecycleListeners
├── outcomes.ts                   # Outcome collectors（url/file_path/json）
├── planner.ts                    # Heuristic planner（实验性）
├── loader.ts                     # jiti workflow loader + AST guard
└── inspect.ts                    # WorkflowInspect TUI 组件
agent/
└── dispatch.ts                   # Agent dispatch 底层（子进程管理 + AbortController）
```

### 优点

1. **模块边界清晰** — `src/cache/`、`determinism/`、`budget/`、`runner/`、`state/` 五个目录正交性良好，职责划分明确
2. **7 种 step 原语分层合理** — 4 个核心原语（`agent/code/fan_out/loop_until`）+ 3 个复合扩展（`adversarial/tournament/classify_route`），复合步骤在 runner 中展开为对核心原语的调用
3. **依赖注入模式** — `AgentDispatch` 可注入接口有效解耦了生产环境（真实 `pi` 子进程）和测试环境（fake dispatch）
4. **CC fusion 集成恰当** — 五种 Claude Code 融合机制（deterministic sandbox、cache-key resume、per-agent abort、budget + caps、lifecycle）分属独立模块，集成松散但一致

### 问题与建议

| 问题 | 严重性 | 状态 |
|------|--------|------|
| `planner.ts` heuristic planner 是 keyword 脚手架，生产价值有限 | 低 | ✅ 已标记 `@deprecated` 实验性 |
| `sessions/spawn.ts` 位于 `src/` 外是结构异常 | 低 | ✅ 已移到 `src/agent/dispatch.ts` |
| `StepExecContext` 可变对象传递——有意识的选择，文档了权衡 | 信息 | 有意为之 |

---

## 二、类型系统

### 优点

- `StepDefinition` 的 discriminated union 完整且干净，7 种变体区分明确
- `defineWorkflow` 作为 typed identity helper 提供了精确的 step 类型推断
- TypeBox schema 与 TypeScript 类型的手动映射经过仔细设计

### 问题

| 问题 | 说明 | 建议 |
|------|------|------|
| `StepContext.step(id)` 返回 `{results: unknown, stats: StepStats}` | 丢失具体步骤的结果类型，下游需要手动 cast | 考虑泛型参数或类型映射表 |
| `RunResult.steps` 是 `readonly StepResult[]` | 类型参数 `T` 在聚合时被擦除 | 当前设计可接受，保持简单 |
| `normalizeSignature` 遇到 function 直接 throw | 正确但不友好的行为 | 在 `CacheKeyInput` 类型层面排除 function |
| TypeBox schema 与 TypeScript 类型手动同步 | 新增 step 类型时需同步两处 | 考虑 `ts-to-json-schema` 自动生成 |

---

## 三、确定性系统

### 机制链

```
source → ast-guard.ts（静态检查）→ loader.ts（jiti import 前）→ runWorkflow（generateRunId 纯函数）
→ dispatchAgentCall（computeCacheKey 排除 runId）→ journal（缓存命中 → 不 dispatch）
```

### 优点

- AST guard 覆盖了四种主要的非确定性 API（`Date.now` / `Math.random` / `new Date()` / `Date()`）
- `assertDeterministic` 在 jiti import 前执行——设计时机正确
- `generateRunId` 是纯函数——同 `(timestamp, sequence)` 产生相同 id
- `computeCacheKey` 排除 `runId`——同一 workflow 跨 run 可共享缓存

### 问题

| 问题 | 严重性 | 说明 |
|------|--------|------|
| 非确定性 API 覆盖不全 | 中 | `performance.now()`、`crypto.randomUUID()`、`setTimeout`、`process.hrtime()` 等未被 AST guard 捕获 |
| ast-guard 只检查入口文件 | 中 | helper 模块中的非确定性调用可绕过检查 |
| 引擎代码中的 `Date.now()` | 低 | stage-executor.ts 中 `Date.now()` 用于 stats duration，注释声明的设计决策可接受 |

---

## 四、预算与安全

### BudgetPool 设计

```
track（记录 token 消耗）
  → remaining（查询各维度剩余配额）
    → isExhausted（任一维度为 0）
      → reserve（同步预留 agent slot）
```

### 双层检查策略

```
guardBatch（fan_out/composite 预先检查整批）→ assertBatchSize + pool.reserve
guardSpawn（每 agent 逐个检查）→ assertLifetimeAgents + pool.isExhausted + pool.reserve
```

### 优点

- `BudgetExceededError` throw（不静默截断）——正确设计
- `scaleBatchByBudget` 作为声明式替代 imperative budget loop——范式转换清晰
- 双层 guard 减少了竞态窗口

### 问题

| 问题 | 严重性 | 说明 |
|------|--------|------|
| **cache-resume 跳过 budget 检查** | **高** | cached 分支不更新 `BudgetPool`，`maxTokens` 保护在重放占主导的工作流中可能形同虚设 |
| `MAX_LIFETIME_AGENTS=1000` 和 `MAX_BATCH=4096` 不可配置 | 低 | 建议改为可通过 budget 配置 |
| `BudgetExceededError` 错误消息不够结构化 | 低 | 改为可通过代码检查的 error code |

---

## 五、运行时

### 核心执行链路

```
dispatchAgentCall:
  ① signal.aborted 检查（早期短路）
  ② computeCacheKey + journal.lookup（缓存命中 → 返回）
  ③ guardSpawn（budget + lifetime 检查 + 预留 slot）
  ④ notifyStart（lifecycle 回调）
  ⑤ journal.append('started')
  ⑥ timed(dispatch)（真实 / fake 调度）
     ├─ 成功 → applyOutcome（track tokens + spawned++）
     └─ 失败 → releaseSpawn（归还 slot）+ journal.append('result', failed)
  ⑦ journal.append('result')
  ⑧ notifyEnd（lifecycle 回调）
```

### 优点

- 所有 7 种 step 类型执行逻辑正确
- 复合步骤的 LLM 输出 lenient 解析（`parsePassBool`、`parseCategoryStr`、`parseWinnerNum`）充分考虑了 LLM 输出的不稳定性
- `mapWithConcurrencyLimit` 的工作窃取模式实现正确
- `AbortController → SIGTERM → 5s SIGKILL` 升级策略安全
- 父 signal 的 `addEventListener` 在 `finally` 中正确 `remove`

### 问题

| 问题 | 严重性 | 说明 |
|------|--------|------|
| cache-resume budget 问题 | 高 | 与第四节相同——缓存的 agent 不消耗配额 |
| `runWithRetry` stats 累积语义 | 低 | 重试时 stats 是追加而非替换，如第一次成功但资源耗尽，stats 显示双倍消耗 |
| `classify_route` 递归深度 `MAX_ROUTE_DEPTH=8` 不可配置 | 低 | 合理但无配置选项 |

---

## 六、测试

### 测试基础设施

- **Fake AgentDispatch** — 不需要 `pi` binary 和 provider API，真正的单元测试友好设计
- 105 个测试用例，10 个测试文件

### 覆盖度统计

| 模块 | 覆盖情况 |
|------|----------|
| `ast-guard`（15 个测试） | ✅ 四种非确定性 API 检查 |
| `key`（12 个测试） | ✅ 缓存键计算、signature 归一化 |
| `journal`（7 个测试） | ✅ 读写、持久化 |
| `budget`（25 个测试） | ✅ BudgetPool、caps、scaleBatchByBudget |
| `names`（7 个测试） | ✅ generateRunId、runIdTimestamp |
| `abort`（8 个测试） | ✅ abortAgent、skipAgent、retryAgent |
| `outcomes-planner`（10 个测试） | ✅ url/json/file_path 收集、heuristic planner |
| `loader`（5 个测试） | ✅ 加载、确定性检查 |
| `e2e/scenarios`（7 个测试） | ✅ 两阶段、fanOut、budget 超限、持久化、abort、cache-resume、per-agent skip |
| `e2e/composites`（9 个测试） | ✅ adversarial、tournament、classify_route、coercion、regression |

### 空白区域

| 未覆盖场景 | 说明 |
|------------|------|
| `loop_until` 的 `maxIterations` 边界测试 | 超出迭代次数后的行为 |
| `classify_route` 深度递归保护测试 | `MAX_ROUTE_DEPTH=8` 是否正确生效 |
| `adversarial` 平局场景（`passCount = minPass`） | 精确等于阈值时的边界 |
| `tournament` 的 `tallyWinner` 平局文档 | 平局时返回第一个 max，行为应显式文档化 |

---

## 七、扩展入口（index.ts）

### 桥接设计

```
pi agent（run_workflow tool）
  → JSON args（TypeBox validated）
    → buildWorkflow（转换为 WorkflowDefinition）
      → runWorkflow（engine dispatch）
        → Progress Widget（TUI 实时状态）
          → RunResult（返回给 agent）

wf-inspect command（TUI 交互检查）
  → WorkflowInspect class（↑↓/enter/esc）
    → 展示 run summary + step 详情
```

### 优点

- `buildWorkflow` 将 JSON schema 转换为代码 `WorkflowDefinition` 的适配逻辑正确
- TypeBox schema 只暴露可 JSON 序列化的 5 种 step 类型，`code`/`loop_until` 被有意识地排除（因为函数不可 JSON 序列化）
- Progress Widget TUI 状态更新及时，资源清理正确
- Templates（`{{input}}` / `{{step.<id>}}` / `{{item}}`）覆盖了基本用例

### 问题

| 问题 | 说明 | 建议 |
|------|------|------|
| `fan_out` item 中 `throwStep` 限制未充分文档化 | `{{step.<id>}}` 在 fan_out item 中不可用 | 在 promptSnippet 和 JSDoc 中说明 |
| Tool schema 中 `now` 参数为 `Optional` | 与"确定性必须"的文档矛盾；默认 `Date.now()` 削弱了确定性保证 | 改为 required 或在 doc 中强调风险 |

---

## 综合评分

| 维度 | 评分 | 关键改进 |
|------|------|----------|
| 架构 | **A-** | ✅ `planner.ts` 已标记实验性；✅ `dispatch.ts` 已重定位 |
| 类型 | **A-** | 类型擦除为有意设计；TypeBox 同步需关注 |
| 确定性 | **B+** | AST guard 覆盖不全；loader 只检查入口文件 |
| 预算 | **B+** | ⚠️ cache-resume 不扣预算（关键问题）；caps 不可配置 |
| 运行时 | **A-** | cache-resume 预算问题；retry stats 累积语义 |
| 测试 | **A-** | 覆盖良好，边缘场景略有缺失 |
| 扩展入口 | **B+** | `now` 默认值与确定性矛盾；fan_out 限制未充分文档化 |

---

## 最重要的待修复问题

### P0：cache-resume 跳过 budget 检查

**位置**：`src/runner/stage-executor.ts` → `dispatchAgentCall`

**问题**：cached 分支直接返回，不调用 `guardSpawn` 也不更新 `BudgetPool`。意味着：

- `spentTokens` 可能远低于实际消耗
- `maxTokens` 保护在重放占主导的工作流中形同虚设
- `reservedAgents` 不会被标记，`maxAgents` 保护同样失效

**建议**：在 cached 分支中仍然调用 `pool.track()` 累积 token 统计，或用单独的机制追踪重放消耗。

---

*报告由 pi-dynamic-workflows 多 agent fan-out 审查工作流自动生成*
