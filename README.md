# Super Agent

一个从零手写的生产级 AI Agent 框架 —— TypeScript，约 8400 行，59 个源文件。

**不依赖任何 Agent 框架。** Agent Loop、工具系统、上下文工程、记忆、RAG、权限、定时任务、多 Agent 调度，全部是这个仓库里可读可改的源码，而不是某个库的黑盒。

---

## 为什么不用现成框架

用 LangChain / CrewAI 能更快跑出 demo。但遇到问题时你面对的是别人的抽象。

这个项目走另一条路：**把每一层都摊开写一遍**。想知道模型看到的上下文长什么样？打开 Prompt Pipe。想知道工具为什么没被选中？看 Registry 的 `shouldDefer` 与 `searchHint`。想知道一个请求花了多少钱？看 UsageTracker 的价格表。

用理解成本换来了完全的可控性。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **多步工具调用** | Agent 自己判断该调哪个工具、调几次，直到能回答。单轮最多 15 步 |
| **44 个内置工具** | 文件读写改、`glob` / `grep` / `bash`、网页抓取、本地预览服务、联网搜索……其中 18 个常驻 prompt，26 个按需发现 |
| **ToolSearch 延迟加载** | 工具太多时不全塞进 prompt，靠 `tool_search` 按需发现。44 个工具里只有 18 个占 prompt（约 1400 token） |
| **MCP 接入** | 手写 JSON-RPC 2.0 over stdio 的 MCP Client，可接任意 MCP Server（自带 GitHub 示例，26 个工具），连不上自动降级 Mock |
| **三层保险丝** | 死循环熔断（指纹哈希滑动窗口）、429 指数退避、跨轮 Token 预算 |
| **上下文工程** | 七插槽 Prompt Pipe + 两级压缩 + 三层即时防线，长对话不撑爆也不失忆 |
| **长期记忆** | 关掉终端再打开还记得你；索引 200 行上限、单文件 4000 字符上限；`/lint` 体检、`/dream` 整理 |
| **RAG 知识库** | 递归分块 → 向量化 → BM25 + 向量混合检索（70/30）→ MMR 去重 → 注入 prompt |
| **Skills** | 写一个 markdown 就加一种专业能力，渐进式加载 |
| **插件** | PluginApi 隔离 + `pluginName__` 命名空间 + 生命周期 |
| **飞书 Bot** | 群里 @机器人 就能对话。**长连接模式，不需要公网域名、不需要内网穿透** |
| **权限系统** | owner / collaborator / guest 三档角色；Bash 命令分级用正则实现，**不给模型绕过的机会** |
| **Hook 管线** | 工具执行前后可 allow / block / modify；只在启动时注册，运行期不可改 |
| **定时任务** | interval / cron / once 三种调度，持久化，连续失败自动停用 |
| **子 Agent** | 复杂请求拆给多个子 Agent 并行处理，各自独立上下文，受深度与并发上限约束 |
| **本地 Trace** | 一次任务一个 JSONL，记录每个 Step 的**输入上下文快照** + 输出 + token + 耗时 + 工具轨迹，自动脱敏，可复盘 |
| **模型降级链** | 主模型额度用尽 / 无权限 / 不存在时自动切下一个候选，支持多厂商混排；本轮降级几次、切到了谁，`/usage` 里能看到 |

---

## 快速开始

```bash
pnpm install

# 首次：交互式生成 super-agent.config.json 与 .env
pnpm run init

pnpm start
```

**没有任何 API Key 也能跑。** `.env` 里设 `USE_MOCK_MODEL=true`，全部走本地 Mock（模型 / MCP / embedding），零网络请求，主链路——工具调用、循环检测、重试、预算——全部可演示。

```bash
pnpm run typecheck   # tsc --noEmit，零报错
pnpm test            # 77 个用例
```

### 试试这些

启动后直接输入自然语言，Agent 会自己决定调哪些工具：

```
读取 package.json，告诉我项目版本和所有启动脚本
找出 sample-project 里所有 TODO，告诉我分别在哪个文件
用 rag_search 查一下部署相关的说明
```

`sample-project/` 是一个故意留了 TODO 的小项目，专门用来演示代码分析。

### 演示保险丝

```
sim              # 看看有哪些演示指令
测试死循环        # 触发循环熔断
测试重试          # 触发 429 退避重试
测试预算          # 触发 Token 预算拦截
测试并发          # 三个只读工具并行
测试截断          # 触发 Head/Tail 60:40 截断
```

---

## 命令

### CLI

| 命令 | 作用 |
|---|---|
| `pnpm start` | 启动交互式对话 |
| `pnpm run init` | 初始化向导，生成配置与 `.env` |
| `pnpm run continue` | 恢复上一次会话继续聊 |
| `pnpm run dev` | 热重载开发模式 |
| `pnpm trace:inspect <file>` | 复盘一条 Trace（打印每个 Step 的耗时、token、工具名） |

### 对话内

| 命令 | 作用 |
|---|---|
| `/context` | 上下文占用与 Prompt Pipe 各插槽状态 |
| `/usage` | Token 消耗、成本、缓存命中、**本轮模型降级次数与路径** |
| `/cache on\|off` | 开关 Prompt Cache |
| `/memory` | 查看 / 管理长期记忆 |
| `/lint` | 记忆体检（格式 + TTL 违规） |
| `/dream` | 让 Agent 走完整 Loop 整理记忆 |
| `/skill` | 列出已加载的 Skills |
| `/plugin` | 插件加载状态 |
| `/channel` | Channel 列表与状态 |
| `/cron` | 定时任务管理 |
| `/agents` | 子 Agent 注册表 |
| `/hooks` | 安全 Hook 管线 |
| `exit` | 退出 |

---

## 目录结构

```
src/
├── index.ts            CLI 路由：init / start / --continue
├── main.ts             装配层：按配置初始化所有子系统，串起主循环
├── mock-model.ts       符合 AI SDK LanguageModel v4 规范的模拟模型
│
├── agent/              Agent Loop 本体
│   ├── loop.ts           streamText 循环 + 每步重建工具集 + 降级链接入
│   ├── loop-detection.ts 指纹哈希滑动窗口（重复 / 乒乓 / 无进展）
│   └── retry.ts          指数退避，只对可重试错误生效
│
├── tools/              工具系统
│   ├── registry.ts       注册表、读写锁、Head/Tail 截断、角色过滤、延迟加载
│   ├── built-in-tools.ts 文件读写改 / glob / grep / bash / 预览服务
│   ├── search-tools.ts   web_search（Tavily / Serper）+ web_fetch
│   ├── mcp-client.ts     手写 JSON-RPC over stdio + 三层降级
│   └── memory-tools.ts / rag-tools.ts / cron-tools.ts / spawn-tools.ts
│
├── context/            上下文工程
│   ├── prompt-builder.ts 七插槽 Prompt Pipe
│   ├── compressor.ts     Microcompact + LLM 摘要压缩
│   └── defense.ts        三层即时防线（估算 / 截断 / TTL 修剪）
│
├── memory/             长期记忆（索引 + 分文件）
├── rag/                分块 → 向量化 → BM25+向量混合 → MMR → 注入
├── skills/             技能渐进式加载
├── plugins/            插件隔离与命名空间
├── channels/           飞书长连接 Bot + Gateway 会话隔离
├── security/           角色 / Bash 分级 / Hook 管线
├── cron/               定时任务
├── agents/             子 Agent 注册表与派生
├── session/            会话持久化
├── usage/              Token 记账与成本追踪
├── trace/              JSONL 本地 Trace + 复盘命令
├── model/              模型降级链
├── config/             Zod Schema / 加载器 / init 向导
└── commands/           斜杠命令分发器
```

其他目录：`tests/` 全部测试 · `docs/` RAG 示例文档 · `app/` 预览服务托管的网页脚手架 · `sample-project/` 代码分析演示素材。

---

## 技术底座

| 关注点 | 选型 | 理由 |
|---|---|---|
| 模型接入 | Vercel AI SDK v7（`streamText` / `generateText`） | 抹平厂商差异；Provider 适配器模式，自研 Mock 模型也能直接塞进去 |
| 工具执行 | 交给 AI SDK | 循环只消费 `response.messages`，不自己拼 `tool-call` / `tool-result` |
| 工具协议 | 手写 JSON-RPC 2.0 over stdio | MCP 协议本身不复杂，手写一遍比接 SDK 更清楚 pending Map 与超时怎么处理 |
| 持久化 | 本地文件 | 记忆 / 会话 / Trace 都用文件，零外部依赖 |
| 向量检索 | 云端 embedding + 本地 BM25 混合 | 云端不可用时自动降级 mock 向量，关键词路径照常工作 |
| Channel | 飞书长连接（WebSocket） | 不需要公网域名 |
| 运行时 | Node.js 20+ / TypeScript 严格模式 | `tsc --noEmit` 零报错是硬门槛 |

---

## 配置

`super-agent.config.json`（由 `pnpm run init` 生成，也可以手写；已在 `.gitignore` 里）。

**配置最小化原则**：每个字段都有默认值，只写跟默认不一样的部分。比如只想改并发数：

```json
{ "agents": { "maxConcurrent": 5 } }
```

```jsonc
{
  "model": {
    "provider": "dashscope",
    "name": "qwen-plus-latest",
    "baseURL": "...",
    "apiKey": "${DASHSCOPE_API_KEY}",
    // 降级链：主模型报"额度用尽 / 无权限 / 不存在"时依次尝试
    // 字符串 = 同一个 provider；对象 = 另一个厂商（自带 baseURL / apiKey）
    "chain": ["qwen3.7-flash", { "name": "step-2", "baseURL": "...", "apiKey": "..." }]
  },
  "channels": { "feishu": { "enabled": false, "appId": "${FEISHU_APP_ID}", "appSecret": "${FEISHU_APP_SECRET}", "port": 3000 } },
  "agents": { "maxSpawnDepth": 1, "maxConcurrent": 3, "defaultTimeout": 60000 },
  "security": { "defaultRole": "owner", "auditLog": true, "bashTimestamp": true },
  "rag": { "enabled": true, "docsDir": "docs" },
  "cron": { "enabled": true, "dataDir": "." },
  "usage": { "trackingFile": ".usage/today.jsonl" }
}
```

读取顺序：**读 JSON → 替换 `${ENV_VAR}` → Zod 校验 + 默认值合并**。校验失败会打印具体是哪个字段、为什么。

### 环境变量

全部可选，一个都不配也能跑。见 `.env.example`。

| 变量 | 用途 |
|---|---|
| `MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY` | 主模型（OpenAI 兼容协议） |
| `DASHSCOPE_API_KEY` | RAG 向量化 + 降级链候选 |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 真实 GitHub MCP Server（没配则 Mock） |
| `TAVILY_API_KEY` / `SERPER_API_KEY` | 真实联网搜索（没配则预置结果） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书 Bot（没配则只启动本地 Dashboard） |
| `USE_MOCK_MODEL` | `true` = 强制本地 Mock，零网络请求 |

---

## 接飞书 Bot

1. [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用，拿 App ID / Secret 填进 `.env`
2. 「添加应用能力」→ 开启**机器人**
3. 「权限管理」→ 开通 `im:message`、`im:message:send_as_bot`
4. 「事件与回调」→ 订阅方式选**长连接** → 添加事件 `im.message.receive_v1`
5. 「版本管理与发布」→ 创建版本并发布
6. 配置里 `channels.feishu.enabled` 设 `true`，`pnpm start`

启动看到这几行就通了：

```
[info]: [ 'client ready' ]
    飞书长连接已建立（无需公网域名）
  [gateway] ✓ feishu 已启动
[info]: [ 'ws', 'ws client ready' ]
```

**没配飞书也能测整条链路**：`http://localhost:3000` 有个 Dashboard，可以直接发模拟消息。

---

## 部署

```bash
# 服务器（Ubuntu/Debian + Node 20+）
git clone <repo> super-agent && cd super-agent
pnpm install
pnpm run init
npm install -g pm2
pm2 start "pnpm start" --name super-agent
pm2 save && pm2 startup
```

更新：`git pull && pnpm install && pm2 restart super-agent`

`.gitignore` 已排除 `.env`、`super-agent.config.json`、`.sessions/`、`.memory/`、`.usage/`、`.cron/`、`.traces/`。

---

## License

MIT
