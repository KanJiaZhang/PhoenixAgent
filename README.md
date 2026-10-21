# PhoenixAgent

企业级 data agent 产品。面向"企业内部数据分析系统"的 agent 集合：智能问数、智能归因、业务运营、市场投放、风控策略。

- **基座**：[PhoenixGraph](../PhoenixGraph) —— 图存储/查询（Gremlin + openCypher）、语义层 HTTP API、13 个 agent 工具、MCP 插件。基座里没有 LLM。
- **本仓库**：agent 运行时与路由、语义层构建流水线（M2）、共享 SQL 层（M3，P2）、Skill 沉淀（M4，P3）、三类业务子 agent（M5–M7）。

## 当前状态

| 阶段 | 状态 | 验收 |
| --- | --- | --- |
| **P0** 骨架：运行时、基座客户端、路由、离线模式 | ✅ 完成 | `npm run verify:p0` → 17/17 |
| **P1 / M2** 语义 Agent：DDL+ETL+wiki+PDF 抽取、视图/装载血缘、数据概况发现、13 种关系、探针、准确率/覆盖率/每表完备度、审查、发布与回放 | ✅ 完成 | `npm run verify:m2` → 53/53 |
| **P1.5** 语义层能力升级（PDF/视图/概况/本体/完备度） | ✅ 完成 | 见 [docs/SEMANTIC-UPGRADE.md](docs/SEMANTIC-UPGRADE.md) |
| **P2 / M3** 共享查询层：规则、等价改写、EXPLAIN 证据、单步账本 | ✅ 完成 | `npm run verify:m3` → 29/29 |
| **P3 / M4** Skill 系统：证据强制、作用域硬过滤、晋升/退役、检索与 SKILL.md 导出 | ✅ 完成 | `npm run verify:m4` → 29/29 |
| **P4 / M5** 智能归因：循环下钻、批量查询、精确分解、显式残差、经验沉淀 | ✅ 完成 | `npm run verify:m5` → 45/45 |
| **P5 / M6** 投放：边际响应曲线、约束分配、holdout 设计 | ✅ 完成 | `npm run verify:m6` → 48/48 |
| **P6 / M7** 风控：趋势、特征有效性（PIT 硬门）、规则合成、离线回测、审批 | ✅ 完成 | `npm run verify:m7` → 48/48 |
| **M2.5** 语义层问数面：确定性解释器 + translate/ask/validate + yoy/top-N | ✅ 完成 | `npm run verify:m2q` → 40/40 |
| **M2.6** 跨事实表指标（两侧先聚合再组合）+ 域边界 scope | ✅ 完成 | `npm run verify:m2x` → 37/37 |
| **P7 / M8** 产品面：HTTP API（24 路由/三角色/确认令牌/审计）、Console、MCP、compose | ✅ 完成 | `npm run verify:m8` → 69/69 |
| **P1 升级（图 / 版本 / 决策平台 / 混合问数 / 接口面 / 灰度）** 图特征进 AUC 对比、模型 diff+漂移+shadow、规则冲突+容量+双签+下发（含本侧幂等）、提案校验+词表学习+多轮、11 条新路由 + Console 第五个工作台、sticky 灰度与自动回滚 | ✅ 完成 | `npm run verify:p1graph/p1ver/p1dec/p1ask/p1api/p1rel`；见 [docs/P1-UPGRADE.md](docs/P1-UPGRADE.md) |
**八个阶段 + 语义问数面 + 跨事实指标 + P1 升级全部交付**：713 条验收断言（16 套）。

规划：[docs/PLAN.md](docs/PLAN.md)。P0+P1 的实现笔记与三处与规划的偏差：[docs/P1-NOTES.md](docs/P1-NOTES.md)。

```bash
npm run demo:db      # 生成 demo 数仓（确定性种子）与独立计算的金标
npm run verify:p0    # 需要 PhoenixGraph 在 :8081
npm run verify:m2    # 语义层端到端：构建 → 探针 → 审查 → 发布 → 回放
npm run verify:m2q   # 语义问数：解释 → SQL → 执行 → 与手写 SQL 对账
npm run verify:m2x   # 跨事实指标：两侧先聚合 → 不产生扇出 → 与手写比值对账
npm run verify:m3    # 共享查询层：规则命中 → 等价改写 → 计划证据 → 单步账本
npm run verify:m4    # Skill：从真实运行沉淀 → 晋升/退役 → 检索（leave-one-out）→ SKILL.md
npm run verify:m5    # 归因：循环下钻 → 批量取证 → 精确分解 → 残差 → 经验入 skill
npm run verify:m6    # 投放：拟合曲线 → 边际分配 → holdout 可行性
npm run verify:m7    # 风控：趋势 → 特征有效性 → 规则 → 回测 → 审批
npm run verify:m8    # 产品面：路由目录 → 角色 → 确认令牌 → 三个工作台 → MCP → 审计
npm run verify:p1graph # 图特征：PIT 快照 → 结构特征 → AUC 增量 → （可选）基座遍历对账
npm run verify:p1ver   # 模型版本：变更分级 → 漂移对账 → shadow → 发布门
npm run verify:p1dec   # 决策平台：规则冲突/容量/双签/下发幂等
npm run verify:p1ask   # 混合问数：LLM 提案 → 确定性校验 → 词表学习 → 多轮
npm run verify:p1api   # 接口面：9 条新路由 → 角色 → 确认令牌 → 下发干跑/提交 → 审计 → Console
npm run verify:p1rel   # 灰度发布：sticky 分桶 → 灰度侧服务新版本 → 晋升门 → 回滚 → 连续失败自动停
npm run verify:all     # 上面 16 套串跑

npm run serve        # 起 HTTP 服务 + Console（默认 :8790，未配 key 会打印一个）

npm run example:risk       # 案例 1：风控建规则（趋势 → 特征 → 规则 → 回测 → 审批）     17 项自检
npm run example:audit      # 案例 2：风控策略巡检（重叠/容量/漂移 → keep/retune/retire） 12 项自检
npm run example:growth     # 案例 3：归因 + 同预算重分配（曲线 → 分配 → holdout）       23 项自检
npm run example:stoploss   # 案例 4：止损 + 砍预算（利润目标、预算上限、switchback）     21 项自检
npm run examples           # 四个案例依次跑完（四个案例见 docs/AGENT-CASES.md）
                           # 案例 1 逐步执行明细：docs/CASE-1-TRACE.md
                           # 案例 1 三个关键问题（图/SQL/规则验证）：docs/CASE-1-VERIFICATION.md
                           # 案例 2/3/4 的同样三个问题：docs/OTHER-CASES-VERIFICATION.md

node packages/semantic/src/cli.ts build --graph demo-analytics   # 抽取 + 合并 + 探针 + 门
node packages/semantic/src/cli.ts publish --graph demo-analytics # 写入图 + 分析型导出
node packages/semantic/src/cli.ts replay --graph demo-analytics --version 1 --metric metric/gmv
node packages/semantic/src/cli.ts ask --question "2025 年 11 月各大区花费"
node packages/semantic/src/cli.ts translate --question "2025年11月花费同比"
node packages/semantic/src/cli.ts ask --question "2025年11月各大区捕获率"   # 需先采纳 metric/capture_rate
node packages/sqllayer/src/cli.ts plan --sql "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'"
node packages/skills/src/cli.ts advise --sql "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'" --dialect sqlite
node packages/agents/attribution/src/cli.ts --metric roi --from 2025-10 --to 2025-11 --harvest
node packages/agents/campaign/src/cli.ts --harvest
node packages/agents/risk/src/cli.ts          # 趋势 + 特征 + 规则
node packages/agents/risk/src/cli.ts approve --rule R-NEW-05 --expression "f_blacklist_hit = 1" --actor risk-lead

# 产品面
PAGENT_API_KEYS="owner-key:owner,analyst-key:analyst,viewer-key:viewer" npm run serve
#   → http://127.0.0.1:8790/            三个工作台
#   → http://127.0.0.1:8790/v1/tools    工具目录（由路由生成）
docker compose up agent                # 只跑 Agent（离线可用）
docker compose --profile full up       # 加上 PhoenixGraph（发布模型与事实问数需要）
```

## 设计要点（三条不变量）

1. **宁可拒绝，不猜。** 口径有冲突就进审查队列，探针覆盖不足就不报准确率，join 路径不在模型里就报错并点名两张表。
2. **每个数字可追溯。** 候选带 `sourceFile + 字符区间 + 原文`；答案带语义模型版本、SQL、行数、限制。
3. **LLM 只做前端。** `PAGENT_LLM=none` 是默认且完整的模式：路由、抽取（确定性部分）、探针、门、SQL 都不用模型。
