# P7 / M8 交付：产品面（HTTP API + 三角色 + 确认门 + 审计 + Console + MCP + compose）

## 1. 一条原则：目录不能和路由漂移

`GET /v1/tools` 是**从路由表生成的**：每条路由声明 `method / path / role / summary / input`，目录由同一个表
walk 出来。所以

- 不能"广告了但没有实现"（目录里有的路由一定可调，验收里逐条打了）；
- 删掉一条路由，目录自动少一条；
- MCP server（读目录来注册工具）不可能和 HTTP 服务不一致——它自己不定义任何工具。

这跟基座的 13 个工具是同一条规则，这里刻意保持。

## 2. 路由（21 条）

| 模块 | 路由 |
| --- | --- |
| 元信息 | `GET /v1/health` · `GET /v1/tools` · `POST /v1/route` |
| 统一入口 | `POST /v1/ask`（按查询结构路由到 semantic / attribution / campaign / risk / base） |
| 语义 | `GET /v1/semantic/{report,model}` · `POST /v1/semantic/{build,review,publish}` |
| SQL | `POST /v1/sql/plan` · `GET|POST /v1/sql/steps/:id` |
| Skill | `GET /v1/skills` · `POST /v1/skills/{advise,decide}` · `GET /v1/skills/export` |
| 归因 / 投放 | `POST /v1/attribute` · `POST /v1/campaign/optimize` |
| 风控 | `GET /v1/risk/{report,approvals}` · `POST /v1/risk/approve` |
| 审计 | `GET /v1/audit/recent`（owner） |
| **P1 发布** | `POST /v1/semantic/{version,shadow}` · `GET|POST /v1/semantic/lexicon` |
| **P1 决策** | `POST /v1/risk/{conflicts,capacity}` · `POST /v1/campaign/writeback` |
| **P1 灰度** | `GET\|POST /v1/semantic/release` |
| **P1 词表队列** | `GET\|POST /v1/semantic/lexicon/drafts` · `POST /v1/semantic/lexicon/drafts/:id` |
| **P1 时间线** | `GET /v1/semantic/timeline` |
| **P1 值词表** | `GET\|POST /v1/semantic/values` |
| **P1 图与问数** | `POST /v1/graph/features` · `POST /v1/ask/hybrid` |

`POST /v1/ask` 是需求的第 2 条（按查询结构路由）在产品层的落点：一次提问 → 路由签名 → 选子 agent →
返回该 agent 的结构化答案；若路由分差不足，返回 `mode: "clarify"` 而不是硬选。

## 3. 角色：viewer / analyst / owner

| 角色 | 能做什么 | 为什么这样分 |
| --- | --- | --- |
| viewer | 读报告、模型、计划、Skill 库 | 看数不需要写权限 |
| analyst | 记录语义审查、编辑 SQL、晋升 tip、触发重建 | 都可回滚（审查与账本都是追加日志） |
| owner | **发布语义模型**、**审批风控规则** | 这两件事改变业务实际运行的东西 |

键来自 `PAGENT_API_KEYS=key:role,key:role`；没配就生成一个并打印（demo 不会意外敞开，生产不会意外锁死）。
验收断言：无 key 401、未知 key 401、viewer 审查 403、analyst 发布/审批 403、审计日志 owner-only，
且 403 的消息里写明"谁、什么角色、需要什么"。

## 4. 确认门（无状态令牌）

`mode: "confirm"` 返回 **计划 + 令牌**，不执行；带令牌重放才执行。令牌是
`HMAC(scope.planHash.expiresAt)`，覆盖三件事：**计划内容、端点、有效期**。四种失败各有自己的错误码：

| 情况 | code | HTTP |
| --- | --- | --- |
| 签名不对（被篡改） | `token-invalid` | 403 |
| 换了端点用 | `token-scope` | 400 |
| 过期 | `token-expired` | 410 |
| 同一令牌换计划 | `plan-mismatch` | 400 |

没有服务端会话，所以重启/多副本都不影响确认流程——和基座的选择一致。

## 5. 审计

每个请求一行 JSONL（`.pag/audit/api.jsonl`）：`{ts, actor, method, path, status, ms}`。验收里断言 200 和 403
都在里面，且 actor 能区分 alice / bob / carol。

## 6. Console（三个工作台）

`GET /` 一张页面，`GET /console.js` 一个无框架脚本（无构建步骤）：

| 工作台 | 做什么 | 对应端点 |
| --- | --- | --- |
| 语义审查 | 待审候选列表、采纳/拒绝、门禁与覆盖率、发布 | `/v1/semantic/{model,review,report,publish}` |
| SQL 工作台 | 分析/改写、逐步应用与撤销、账本回放、Plan 证据 | `/v1/sql/{plan,steps}` |
| Skill 库 | 列表与分数、按 SQL 检索、晋级、导出 SKILL.md | `/v1/skills/*` |
| 业务 Agent | 一句话提问、归因、投放分配、风控报告 | `/v1/{ask,attribute,campaign,risk}` |
| 发布与决策 | 版本 diff + 漂移 + shadow + 发布门；规则冲突；审核容量；图特征；混合问数与跟进；下发干跑/提交 | `/v1/semantic/{version,shadow,lexicon}`、`/v1/risk/{conflicts,capacity}`、`/v1/graph/features`、`/v1/ask/hybrid`、`/v1/campaign/writeback` |

页面刻意薄：每个按钮一一对应一个端点，所以**验收可以直接打 HTTP**，不需要浏览器——`verify:m8` 就是这么做的。
浏览器级（Playwright）没有跑，这一点写在限制里。

## 7. MCP 与部署

- `packages/api/src/mcp.mjs`：stdio JSON-RPC，`initialize` / `tools/list` / `tools/call`，工具列表来自
  `/v1/tools`；`--selftest` 与 `--list` 供 CI 使用。
- `Dockerfile` + `docker-compose.yml`：Node 24 直接跑 TS 源码（无构建产物），entrypoint 会先生成 demo 数仓、
  再建语义模型、再起服务；`--profile full` 加上 PhoenixGraph（发布模型与 `/v1/ask` 需要它）。

## 8. 验收（`npm run verify:m8`，69 条断言）

- 目录 41 条路由（M8 时 24 条，P1 增加 17 条），只读路由逐条 200；未知路由 404（带 `/v1/tools` 提示）；错误方法 405（提示正确方法）。
- P1 的 9 条路由由单独的 `verify:p1api`（105 条）验收：角色、确认令牌、审计、Console 调用与库层同一实现。
- 角色矩阵 7 条断言全过（含"谁要求了什么"的消息内容）。
- 确认门：令牌验证/换计划/换端点/过期/篡改 5 种情形，各自的错误码；`mode=confirm` 的响应里**没有答案**；
  令牌重放执行成功；换计划被 `plan-mismatch` 拒。
- 工作台：归因（含残差）、投放（增益 + holdout）、语义报告/模型/审查、SQL plan→apply→edit→revert→回放、
  suggestion 400、Skill 列表/检索/导出、风控报告与审批发布。
- Console：页面含三个工作台、脚本含端点与 `x-api-key`。
- MCP：`--selftest` 通过、`--list` 的工具数与 HTTP 目录一致。
- 审计：≥20 条、含 alice/bob/carol、含 403。

## 9. 这一阶段抓到的两个真问题

1. **"schema 文件存在" ≠ "图被服务"**：基底重启后，之前 publish 写下的 `demo-semantics.json` 还躺在
   PhoenixGraph 的工作目录里，`GET /schema/{graph}` 于是返回 200，publish 以为图已存在、跳过注册，随后所有写入
   报 `Unknown graph`。修法：用 `GET /v1/graphs` 判断**是否被服务**，不被服务就用 `replace=true` 重新注册，
   注册后仍不可见则明确报错（并说明"文件可能是陈旧的"）。顺带删掉了我们留在基底仓库里的 4 个 demo schema 文件。
2. **验收自己把自己锁死**：`verify:m8` 里 API 跑在同一进程，用 `execFileSync` 起 MCP 子进程会阻塞事件循环，
   子进程等不到回答 → 60s 超时。改成 async `execFile`（并给 mcp.mjs 的 `--selftest`/`--list` 加 `process.exit`，
   因为 undici 的 keep-alive socket 会让一次性的 CLI 挂住）。

## 10. 诚实的限制

- **TLS / 限流 / 多租户** 没有做：只有 body 大小上限和角色；这些是部署层该解决的问题，写在这里而不是假装有。
- **Console 很薄**：没有 diff 视图、分页、富表格；浏览器级 e2e（Playwright）未运行。
- **审计是本地 JSONL**：没有轮转、保留策略、集中收集；生产应接 stdout/日志管道。
- **发布依赖基底**：`/v1/semantic/publish` 与 `/v1/ask` 的事实类问题需要 PhoenixGraph；其余端点可离线运行。
- **没有生成 OpenAPI**：`/v1/tools` 是机器可读目录，但不是完整 schema（参数类型只有粗粒度声明）。
- **审批仍是单签**：接口支持多次决定与日志，但没有强制"风控负责人 + 数据 owner 双签"的流程。
