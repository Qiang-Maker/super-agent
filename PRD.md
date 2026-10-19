# PRD · Super Agent（全项目）

> 从零搭一个 production-ready 的 AI Agent 框架。
> 分层演进，每一层解决一个真实的工程问题，最终成为一个能跑在服务器上、能接飞书、能定时执行、能派子 Agent 的完整实现。

---

## 1. 项目定位

### 1.1 一句话

**一个不依赖任何 Agent 框架、自己写出来的 Agent。** Agent Loop、工具系统、上下文工程、记忆、RAG、权限、定时任务、多 Agent 调度——全部是仓库里可读可改的源码，而不是某个库的黑盒。

### 1.2 为什么不用现成框架

用 LangChain / CrewAI 能更快跑出 demo，但遇到问题时你面对的是别人的抽象。这个项目走另一条路：**把每一层都摊开写一遍**，理解成本换来了完全的可控性——想知道模型看到的上下文长什么样，打开 Prompt Pipe；想知道工具为什么没被选中，看 Registry 的 `shouldDefer` 与 `searchHint`。

### 1.3 技术底座

| 关注点 | 选型 | 理由 |
|---|---|---|
| 模型接入 | Vercel AI SDK v7（`streamText` / `generateText`） | 抹平厂商差异；Provider 适配器模式，自研 Mock 模型也能直接塞进去 |
| 工具执行 | 交给 AI SDK | 循环只消费 `response.messages`，不自己拼 `tool-call` / `tool-result` |
| 工具协议 | 自研 JSON-RPC 2.0 over stdio | MCP 协议本身不复杂，手写一遍比接 SDK 更清楚 pending Map 与超时怎么处理 |
| 持久化 | 本地文件 + better-sqlite3 | 记忆 / 会话 / RAG 索引都用文件，零外部依赖 |
| 向量检索 | 云端 embedding + 本地 BM25 混合 | 云端不可用时自动降级为 mock 向量，关键词路径照常工作 |
| Channel | 飞书长连接（WebSocket） | 不需要公网域名，本地就能跑 |
| 运行时 | Node.js 20+ / TypeScript 严格模式 | `tsc --noEmit` 零报错是硬门槛 |

---

## 2. 目标用户与使用场景

| 用户 | 场景 |
|---|---|
| 学习者 | 按模块顺序读代码，理解一个 Agent 框架的每一层是怎么长出来的 |
| 开发者 | 拿它当起点改：换掉工具、换掉 Channel、换掉模型，接自己的业务 |
| 运维 | 通过 `super-agent.config.json` 调参，不改代码 |

**典型场景**：终端里交互式对话 / 飞书群里 @机器人 / Cron 定时跑任务 / 子 Agent 并行处理一个复杂请求。

---

## 3. 系统架构

### 3.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 入口层    index.ts (CLI 路由)  main.ts (装配)  飞书 Channel    │
├──────────────────────────────────────────────────────────────┤
│ 调度层    Agent Loop · Sub-Agent Registry · Cron Service      │
├──────────────────────────────────────────────────────────────┤
│ 能力层    Tool Registry · Memory · RAG · Skills · Plugins     │
├──────────────────────────────────────────────────────────────┤
│ 上下文层  Prompt Pipe · Compressor · 三层防线 · Usage/Cache   │
├──────────────────────────────────────────────────────────────┤
│ 治理层    Roles · Bash 分级 · Hook 管线 · Trace               │
├──────────────────────────────────────────────────────────────┤
│ 底座层    Session Store · 配置系统 · Model Chain              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 一次请求的完整流转

```
用户输入
  → 预算守门员核验（跨轮累计，超限直接拒绝）
  → 命令分发器（/memory、/skill、/cron … 命中则短路，不进模型）
  → Prompt Pipe 组装 system（coreRules → toolGuide → deferredTools → memory → rag → skills → session）
  → Agent Loop（最多 15 步）
      ├─ 指数退避调用模型（429 / 5xx / 网络抖动）
      ├─ 模型不可用 → 模型降级链切下一个候选
      ├─ 循环检测（指纹哈希滑动窗口：重复 / 乒乓 / 无进展）
      ├─ 工具执行（读锁并发 / 写锁串行 / Head-Tail 60:40 截断）
      └─ 上下文防线（Token 估算 → 动态截断 → TTL 修剪 → 必要时压缩）
  → 输出回复 + 记账（Token / 成本 / 缓存命中）
  → 全程写入 JSONL Trace
```

---

## 4. 能力矩阵

按能力模块展开。**状态全部为「已跑通」**，跑通标准是本机可复现对应现象。

### 基础：对话与 Agent Loop

| 节 | 能力 | 落点 |
|---|---|---|
| 1-1 | 流式对话主循环、打字机输出、Mock/真实模型无缝切换、客户端上下文维护 | `src/main.ts` · `src/mock-model.ts` |
| 1-2 | while 循环 + 工具调用：从"能聊天"到"能干活" | `src/agent/loop.ts` · `src/tools/registry.ts` |
| 1-3 | 三层保险丝：循环检测 / 指数退避重试 / 全局 Token 预算 | `src/agent/loop-detection.ts` · `src/agent/retry.ts` · `src/usage/tracker.ts` |

### 工具系统

| 节 | 能力 | 落点 |
|---|---|---|
| 2-1 | Tool 注册表、读写锁并发、Head/Tail 60:40 截断、角色过滤 | `src/tools/registry.ts` |
| 2-2 | 补齐内置工具：`edit_file` / `glob` / `grep` / `bash` | `src/tools/built-in-tools.ts` |
| 2-3 | 把工具组装成应用：`fetch_url`（HTML→文本）+ `start_preview`（本地静态服务） | `src/tools/built-in-tools.ts` · `app/` · `sample-project/` |
| 2-4 | Search 工具：`web_search` 双引擎（Tavily / Serper）+ `web_fetch` | `src/tools/search-tools.ts` |
| 2-5 | MCP 接入：手写 JSON-RPC over stdio，GitHub Server 26 个工具，三层降级 | `src/tools/mcp-client.ts` |
| 2-6 | ToolSearch 延迟加载：工具太多时按需发现，省 prompt | `src/tools/registry.ts`（`shouldDefer` / `searchHint`）· `tool_search` |

### 上下文工程

| 节 | 能力 | 落点 |
|---|---|---|
| 3-1 | Session 持久化 + Prompt Pipe 模块化组装 | `src/session/store.ts` · `src/context/prompt-builder.ts` · `src/context/prompt-pipes.ts` |
| 3-2 | 压缩：Microcompact（无 LLM）+ LLM 摘要压缩 | `src/context/compressor.ts` |
| 3-3 | 三层即时防线：Token 估算 / 动态截断 / TTL 修剪 | `src/context/defense.ts` · `src/context/tool-result-output.ts` |
| 3-4 | Prompt Cache 与成本追踪：价格表、缓存命中统计 | `src/usage/tracker.ts` |

### 记忆与知识库

| 节 | 能力 | 落点 |
|---|---|---|
| 4-1 | 持久化记忆：MEMORY.md 索引 + 分文件，200 行索引上限 / 4000 字符文件上限 | `src/memory/store.ts` |
| 4-2 | RAG：递归分块 → 向量化 → BM25+向量混合（70/30）→ MMR 去重 → 注入 | `src/rag/` |
| 4-3 | 记忆维护：lint 体检、按类型 TTL 分级、`/dream` 批量整理 | `src/memory/validator.ts` · `/lint` · `/dream` |

### 技能、插件与通道

| 节 | 能力 | 落点 |
|---|---|---|
| 5-1 | Skills：写一个 md 就加一种专业能力，渐进式加载（先给名字，需要才读全文） | `src/skills/loader.ts` · `.skills/` |
| 5-2 | Plugin 架构：PluginApi 隔离、`pluginName__` 命名空间、生命周期 | `src/plugins/` |
| 5-3 | Channel 抽象：飞书长连接 Bot + 会话隔离（`channel:sender`）+ Dashboard | `src/channels/` |

### 治理、定时与多 Agent

| 节 | 能力 | 落点 |
|---|---|---|
| 6-1 | 角色（owner / collaborator / guest）+ Bash 命令分级（正则，不可绕过）+ Hook 管线 | `src/security/` |
| 6-2 | Cron：interval / cron / once 三种调度，持久化，连续失败自动停用 | `src/cron/` |
| 6-3 | Sub-Agent：独立上下文、深度与并发限制、AbortController 取消 | `src/agents/` |

### 配置、部署与可观测

| 节 | 能力 | 落点 |
|---|---|---|
| 7-1 | 配置系统（Zod 校验 + `${ENV_VAR}` 替换 + 默认值合并）、CLI init 向导、部署 | `src/config/` · `src/index.ts` |
| 8-1 | 本地 Trace：一次任务一个 JSONL，Step 输入快照 + 输出 + usage + 耗时，脱敏，`trace:inspect` 复盘 | `src/trace/` |

### 另外补的三件

| 能力 | 落点 | 为什么加 |
|---|---|---|
| 模型降级链 | `src/model/chain.ts` | 免费额度按模型给、还会到期；主模型不可用时不该整个 Agent 停摆 |
| Embedding 候选链 | `src/rag/embedder.ts` | 主 embedding 模型不可用时换下一个，全失败才降级 mock |
| 崩溃修复 | `src/channels/gateway.ts` | 发送失败不该带走整个进程 |

---

## 5. 功能需求详述

### 5.1 Agent Loop（`src/agent/loop.ts`）

- **FR-1.1** 使用 `streamText` + `fullStream`，工具执行交给 AI SDK，循环消费 `response.messages`
- **FR-1.2** 单轮最多 `MAX_STEPS = 15` 步，超限优雅退出
- **FR-1.3** 每步重建工具集（`buildTools()`），使 ToolSearch 当步发现的工具下一步可用
- **FR-1.4** 三层保险丝：
  - 短路保护：指纹哈希滑动窗口（窗口 30），重复 / 乒乓 / 无进展三类检测器，阈值 warn 5 / critical 8 / breaker 10
  - 过载保护：指数退避（1s / 2s / 4s），只对可重试错误（429 / 5xx / 网络）生效
  - 漏电保护：跨轮累计 Token 预算（默认 25000），超限拒绝新请求
- **FR-1.5** 错误识别必须穿透 AI SDK 的包装对象（`onError` 给的是 `{ error }`，`APICallError` 未必是标准 Error，信息藏在 `responseBody` / `data`）

### 5.2 工具系统（`src/tools/`）

- **FR-2.1** `ToolDefinition` 分两组字段：**定义**（`name` / `description` / `parameters`）给模型看；**执行策略**（`isConcurrencySafe` / `isReadOnly` / `maxResultChars` / `shouldDefer` / `searchHint`）给框架用
- **FR-2.2** 并发控制：只读工具拿共享锁并行，写工具拿独占锁串行
- **FR-2.3** 结果截断：超限时 Head/Tail 60:40 保留，中间折叠并给出省略提示
- **FR-2.4** MCP：`mcp__server__tool` 前缀命名，pending Map + id 匹配，initialize 超时 120s，其余 15s；连不上自动降级 Mock
- **FR-2.5** 延迟加载：`shouldDefer` 的工具不进 prompt，靠 `tool_search` 按需发现

### 5.3 上下文工程（`src/context/`）

- **FR-3.1** Prompt Pipe 七个插槽按序拼接，任一可关
- **FR-3.2** 压缩两级：Microcompact 不花 token；超过阈值才走 LLM 摘要
- **FR-3.3** 三层防线按代价从低到高依次触发：估算 → 截断 → 修剪 → 压缩
- **FR-3.4** 成本追踪：价格表 + 缓存命中统计，`/usage` 查看

### 5.4 记忆与知识库（`src/memory/` · `src/rag/`）

- **FR-4.1** 记忆存本地文件，索引与内容分离，索引有行数上限、内容有字符上限
- **FR-4.2** RAG 支持增量导入，检索走 BM25 + 向量混合，MMR 去重
- **FR-4.3** 记忆体检：lint 查格式与 TTL 违规，`/dream` 交给完整 Agent Loop 整理

### 5.5 权限与治理（`src/security/`）

- **FR-5.1** 三种角色，工具按角色过滤（`owner` 18 个 / `collaborator` / `guest` 递减）
- **FR-5.2** Bash 命令分级用正则实现，**不给模型绕过的机会**（不是让模型自己判断）
- **FR-5.3** Hook 管线支持 pre / post，可 allow / block / modify；**只在启动时注册**，运行期不可改

### 5.6 多入口（`src/channels/` · `src/agents/` · `src/cron/`）

- **FR-6.1** Channel 统一抽象，Gateway 按 `channel:sender` 隔离会话
- **FR-6.2** 发送失败只丢这一条回复并打日志，**不得影响进程存活**
- **FR-6.3** Sub-Agent 有独立 messages 数组，受深度与并发上限约束
- **FR-6.4** Cron 任务持久化，连续失败自动停用

### 5.7 配置与可观测（`src/config/` · `src/trace/`）

- **FR-7.1** 配置读取顺序：JSON → 替换 `${ENV_VAR}` → Zod 校验 + 默认值合并；配置最小化（只写跟默认不一样的）
- **FR-7.2** `pnpm run init` 交互式生成 `super-agent.config.json` 与 `.env`
- **FR-7.3** Trace 事件：`trace_started` / `step_started` / `step_attempt_failed` / `step_completed` / `trace_finished`；字段名命中 `api_key|token|secret|password|authorization` 递归脱敏；写入失败不影响主任务

---

## 6. 非功能需求

| 类别 | 要求 |
|---|---|
| 类型安全 | `pnpm run typecheck` 零报错（TypeScript 严格模式） |
| 测试 | `pnpm test` 全绿（当前 74 例），覆盖循环检测 / 重试 / 预算 / 工具锁 / 截断 / MCP / 权限 |
| 优雅降级 | 任一外部依赖（模型 / embedding / MCP Server / Channel）不可用，Agent 仍能启动并工作 |
| 崩溃隔离 | 单条消息、单个工具、单个 Channel 的失败不得终止进程 |
| 密钥安全 | 密钥只存在于 `.env`，配置文件用 `${ENV_VAR}` 引用；Trace 自动脱敏 |
| 离线可用 | `USE_MOCK_MODEL=true` 时零网络请求跑通全部主链路 |

---

## 7. 验收标准

### 7.1 工程验收

1. `pnpm install` → `pnpm run typecheck` → `pnpm test` 三步全绿
2. `pnpm start` 能在无任何 API Key 的情况下启动（走 Mock 模型）
3. `pnpm run init` 能生成合法配置，`loadConfig` 能正确替换环境变量并通过 Zod 校验

### 7.2 功能验收（每节一个可复现现象）

| 节 | 验收现象 |
|---|---|
| 1-1 | 输入「你好」看到逐字打字机输出 |
| 1-2 | 输入一个需要读文件的问题，看到 `[调用工具]` 并拿到答案 |
| 1-3 | `测试死循环` 触发熔断；`测试重试` 真的 429 后成功；`测试预算` 被拒绝 |
| 2-1 | `测试并发` 三个只读工具并行；`测试截断` 触发 Head/Tail |
| 2-2 | `测试编辑` 让模型自己改文件 |
| 2-3 | 「找出项目里所有 TODO」；「做一个待办清单的网页应用」并打开 `localhost:8080` |
| 2-4 | 让 Agent 搜一个实时问题并给出带来源的回答 |
| 2-5 | 启动时打印「已注册 26 个 MCP 工具」，能查真实 GitHub issue |
| 2-6 | 工具数 40+ 时 prompt 只带常驻工具，`tool_search` 能找到延迟工具 |
| 3-1 | 退出再 `pnpm run continue`，对话接得上 |
| 3-2 | 长对话后 `/context` 看到压缩生效 |
| 3-3 | 读大文件后结果被截断而不是撑爆上下文 |
| 3-4 | `/usage` 显示 token、成本、缓存命中 |
| 4-1 | 告诉 Agent 一件事，重启后它还知道 |
| 4-2 | 往 `docs/` 放文档，提问能基于文档回答 |
| 4-3 | `/lint` 报告记忆体检结果；`/dream` 完成整理 |
| 5-1 | `/skill` 列出技能；触发技能时 Agent 按 md 里的流程走 |
| 5-2 | `/plugin` 看到插件加载结果与命名空间前缀 |
| 5-3 | 飞书群里 @机器人 能对话；`localhost:3000` Dashboard 可用 |
| 6-1 | guest 角色下写操作被拦截；`/hooks` 看到管线 |
| 6-2 | `/cron` 建一个任务，到点自动执行 |
| 6-3 | 让 Agent 并行读多个文件，看到子 Agent 调度 |
| 7-1 | 改 `super-agent.config.json` 的 `maxConcurrent` 重启后生效 |
| 8-1 | 任务结束打印 Trace 路径，`pnpm trace:inspect <file>` 打印执行路径 |

### 7.3 真实环境验收（已完成）

- **飞书**：自建应用已发布；长连接后台显示「连接成功」；实测发消息 → Agent Loop 调 `read_file` + `bash` 两步 → 回复落到飞书聊天窗口
- **GitHub MCP**：真实 Server，26 个工具
- **模型降级链**：主模型故意写错 → 自动切到 `qwen3.8-flash`

---

## 8. 范围外 / 已知限制

| 项 | 说明 |
|---|---|
| 多用户鉴权 | 角色是本地配置，不是账号体系；生产要接自己的 SSO |
| 向量库 | 本地 sqlite + 文件，没有分布式向量库；数据量大要换 Milvus 之类 |
| Trace 保留策略 | 只做了本地 JSONL，没有保留周期 / 大小上限 / 采样 |
| 沙箱 | `bash` 靠命令分级而不是容器隔离；不可信输入场景要加沙箱 |

---

## 9. 部署

```bash
# 服务器（Ubuntu/Debian + Node 20+）
git clone <repo> super-agent && cd super-agent
pnpm install
pnpm run init          # 生成配置，填 API Key
pm2 start "pnpm start" --name super-agent
pm2 save && pm2 startup
```

更新：`git pull && pnpm install && pm2 restart super-agent`

`.gitignore` 必须排除 `.env`、`super-agent.config.json`、`.sessions/`、`.memory/`、`.usage/`、`.cron/`、`.traces/`。
