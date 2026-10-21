# PhoenixAgent 模块规划（v0，待评审）

> 目标读者：产品/架构评审。本文只做**规划**，不写代码。评审通过后按 §9 的阶段一片一片开发，每片都有可执行的验收。
>
> 评审重点：§3 模块目录是否缺项、§7 技术决策是否认可、§10 待确认问题请逐条给结论。

---

## 1. 产品定位与边界

**是什么**：企业内部数据分析系统的 agent 层。用户问一句业务问题，PhoenixAgent 负责"理解 → 选子 agent → 定口径 → 生成/改写 SQL → 执行 → 解释 → 沉淀经验"。

**三类使用者**：

| 使用者 | 用法 | 关心的 |
| --- | --- | --- |
| 业务方（运营/市场/风控） | 自然语言提问，看结论和依据 | 数字对不对、能不能解释、能不能落地 |
| 分析师 | 语义层审查、SQL 工作台、单步验证 | 口径可控、性能可控、可改可回放 |
| 平台方（数据治理/架构） | 接数据源、管权限、看台账 | 覆盖率、准确率、审计、成本 |

**不是**：不是通用 ChatBI 玩具、不做自由生成 SQL 直连生产、不做因果推断、不自动发布风控规则、不追 Spider/BIRD 榜单。

**贯穿原则（继承基座的三条）**：

1. **宁可拒绝，不猜**。口径不确定就列出候选要求澄清，不返回"看起来合理的错数"。
2. **每个数字可追溯**。答案必须带：语义模型版本、指标定义、join 路径、生成的 SQL、实际执行的位置、行数、限制说明。
3. **LLM 只做前端，不决定口径**。LLM 可以抽取、可以改写、可以写解释；口径来自语义层这张图，执行由确定性代码完成。

---

## 2. 与 PhoenixGraph 的分工（已实测的现有资产）

| 能力 | 现状 | 归属 |
| --- | --- | --- |
| 图存储/查询（HTAP、向量、算法） | ✅ 可用 | 基座，直接用 |
| 语义模型（metric/dim/column/table/query 顶点 + groupedBy/usesColumn/computedFrom/dimensionColumn/references/definedBy/contributesTo 边） | ✅ 已有 17 指标/11 维度/12 参考查询（TPC-H） | 基座**存**，PhoenixAgent **建与治理** |
| 语义层 HTTP：`/semantic/{g}/{model,translate,validate,ask}`、`/analysis/{g}/{analyze,attribute}` | ✅ 已交付，含 confirm 令牌门 | 基座 |
| 工具目录 `GET /api/v1/agent/tools` + MCP 插件 | ✅ 13 工具 | 基座 |
| 确定性问数解释器（无 LLM，别名同义词） | ✅ 已有，词表窄 | 基座，PhoenixAgent 在它之上加 LLM 理解 + 拒绝兜底 |
| **文档/DDL/ETL SQL → 语义层** 的构建流水线 | ❌ 无（只有标注好的 dataset 类） | **PhoenixAgent M2** |
| **SQL 解析/改写/性能分析** | ❌ 无（基座有 SqlRenderer，只渲染不优化） | **PhoenixAgent M3** |
| **Skill / tip 沉淀与检索** | ❌ 无 | **PhoenixAgent M4** |
| **子 agent 路由** | ❌ 无（基座是工具集，不是 agent） | **PhoenixAgent M1** |
| **归因的轮询/剪枝/批量查询** | ⚠️ 基座有单层 `attribute`（一个维度、一次分解） | **PhoenixAgent M5** 扩展到多层级联 |
| **投放 ROI 优化 / 风控规则合成** | ❌ 无 | **PhoenixAgent M6 / M7** |
| **人工审查/审批 UI** | ⚠️ 基座 graph-web 只能看图和改 schema | **PhoenixAgent M8** |
| **答案级回归台账** | ✅ `verification/eval-data-agent.mjs` 五类 | 继承形态，**PhoenixAgent M9** 扩到四类 agent |

一句话：**基座提供"能力"，PhoenixAgent 提供"会用它的人"**。所有对基座的调用只走 HTTP/MCP，不引 Java 依赖、不改基座代码（如需扩展边类型/属性，走 schema 向后兼容新增，由基座 PR 承接）。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│  M8 产品面：HTTP API(/v1/{ask,attribute,campaign,risk,semantic}) · MCP · CLI │
│             Console（语义审查 · SQL 工作台 · Skill 库 · 台账）             │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────────────────────────────────────────────┐
│  M1 运行时：QuerySignature → Router → SubAgent 契约(plan/execute/explain)  │
│             Session/Workspace · ToolBus · LLM Gateway · 审计与成本         │
└──────────────────────────────────────────────────────────────────────────┘
        │                        │                        │
┌───────────────┐   ┌────────────────────┐   ┌──────────────────────────┐
│ M2 语义 Agent │   │ M3 共享查询层 sqllayer │   │ M4 Skill 系统            │
│ 抽取·绑定·审查 │   │ 解析/改写/性能/单步    │   │ tip 沉淀·检索·晋升/退役    │
│ 准确率·覆盖率  │   │ ← 所有子 agent 共用    │   │ ← M2/M3/M5/M6/M7 喂它     │
└───────────────┘   └────────────────────┘   └──────────────────────────┘
        │                        │                        │
┌──────────────────────────────────────────────────────────────────────────┐
│ 子 Agent：M5 归因 · M6 投放/运营 · M7 风控策略   （M2 是它们的共同上游）      │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────────────────────────────────────────────┐
│  PhoenixGraph 基座：语义图(单一来源) · 事实图 · 图查询 · 语义/分析 API · MCP │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────────────────────────────────────────────┐
│  M0 数据面：数仓只读连接（JDBC/HTTP）· 元数据 catalog · 特征仓 · 文档源     │
└──────────────────────────────────────────────────────────────────────────┘
```

**为什么 SQL 层是一个独立模块而不是每个 agent 自己写 SQL**：需求 4 明确要求共用。实现上它是**一个有版本的库 + 一个可选 sidecar 服务**，四个子 agent 全部通过同一个 `QuerySpec → SQL → RewritePlan → ExecutedSQL` 管线，收益是：性能经验只积累一处（需求 7）、改写规则只维护一份、单步验证只有一种交互语义。

---

## 4. 模块目录（M0–M9）

图例：**输入** → 关键设计 → **验收**。每条的验收都是可执行断言，不是"完成"两个字。

### M0 数据面（Data Plane）

**职责**：把"企业内真实数据"变成一个可控、可审计的只读接入层。所有 agent 都不直接拿连接串。

| 组件 | 说明 |
| --- | --- |
| `catalog` | 元数据：库/表/列/分区/索引/统计信息/行数量级。来源 `information_schema`、`SHOW CREATE TABLE`、`SHOW INDEX`、`pg_indexes`、Hive metastore、Doris `SHOW TABLES`。定时增量刷新，带 `fetchedAt`。 |
| `sql-exec` | 只读执行器。硬性：只允许 `SELECT/WITH/EXPLAIN`；单语句；超时；行数上限；成本上限（预估超预算先拒绝）；结果落地为 Arrow/JSON。 |
| `feature-store` | 特征注册表（风控用）：特征名/实体/窗口/类型/覆盖率/新鲜度/负责人/上线状态。只读。 |
| `doc-source` | 文档源：wiki 导出（MD/HTML）、PDF、Git 仓库（GitHub API 或浅克隆）、ETL 目录（本地/对象存储）。 |
| `credential` | 凭证与租户隔离：每个数据源一个只读账号，密钥进 secret store，SQL 里禁止拼接凭证。 |

**验收**：`verify:m0` —— 对一个 demo 库列出 ≥N 张表与全部列、索引；`EXPLAIN` 可执行；`INSERT/UPDATE/DROP` 被 100% 拒绝；超时 30s 生效；同一租户 A 看不到租户 B 的 catalog 条目。

---

### M1 运行时与路由（Agent Kernel）

**职责**：需求 1、2。把"一句话"变成"选哪个子 agent、用什么口径、跑什么计划"。

**核心对象 `QuerySignature`**（这就是需求里"根据查询结构路由"的落地形态，不是按关键词）：

```jsonc
{ "type": "descriptive|diagnostic|prescriptive|detective",
  "metrics": ["revenue"], "dimensions": ["region","industry"],
  "filters": [{"dim":"orderDate","op":"between","value":["1995","1996"]}],
  "timeWindow": {"compare":["1995","1996"], "grain":"year"},
  "entityShape": "single-fact|cross-domain|join-path|unknown",
  "asksWhy": true, "asksWhatToDo": false, "asksRule": false,
  "confidence": 0.87, "evidence": ["「为什么」→ diagnostic", "「该加强/降低」→ prescriptive"] }
```

**路由规则（确定性优先，LLM 兜底）**：

| Signature 特征 | 目标子 agent |
| --- | --- |
| 建/改语义层、问"这张表是什么"、覆盖率/准确率 | M2 Semantic |
| `type=descriptive`（多少、多少按天/地区） | 基座 `ask_data`（+M3 优化） |
| `type=diagnostic` 且 `asksWhy`、有 `contributesTo` 可达 | M5 归因 |
| `type=prescriptive` 含 投入/预算/分配/ROI/效果 | M6 投放运营 |
| `type=detective` 含 欺诈/风险/规则/特征/召回 | M7 风控 |
| 结构歧义（多候选子 agent 分差 < 0.15） | 不选，回澄清项（继承"宁可拒绝"） |

**SubAgent 契约**（所有子 agent 一个形状，便于评测与组合）：

```ts
interface SubAgent {
  name: string;
  accepts(sig: QuerySignature, ctx: AgentContext): number;      // 0..1
  plan(sig: QuerySignature, ctx): Plan;                          // 无副作用、可预览、可签名确认
  execute(plan: Plan, ctx): Promise<AgentResult>;                // 只经 M0/M3，只读
  explain(result: AgentResult): Explanation;                     // 证据化叙述，不给因果
  skills(): SkillScope[];                                        // 该 agent 的 skill 作用域
}
```

**AgentResult 统一形状**（延续基座 `provenance/confidence/limits` 三件套）：

```jsonc
{ "agent": "attribution", "answer": { ... }, "plan": { ... },
  "provenance": { "semanticModel": {...}, "sql": [...], "rows": [...], "executedOn": "warehouse|graph" },
  "confidence": { "score": 0.0, "warnings": [] },
  "limits": ["描述性分解，非因果"], "refusals": [ ... ], "cost": {"queries": 7, "ms": 812} }
```

**同时包含**：Session/Workspace（跨轮上下文，落盘可回放）、ToolBus（统一记每个工具调用与耗时）、LLM Gateway（多供应商 + 离线确定性模式，见 §7 D2）、审计（每次 SQL、每次审批、每次 tip 采纳）。

**验收**：`verify:m1` —— 40 条标注问题，路由 top-1 准确率 ≥ 90%、歧义问题 100% 走澄清（不猜）；离线模式（`PAGENT_LLM=none`）下路由仍可运行（规则路径）。

---

### M2 语义 Agent（Semantic Agent）— 需求 3，本产品的护城河

**职责**：从企业存量资产里把语义层**建起来、验出来、审下去**。输出写到 PhoenixGraph 的语义图（单一来源）。

#### 4.1.1 抽取流水线（Source → Candidate，多源并行）

| 源 | 抽取器 | 产出 | 确定性程度 |
| --- | --- | --- | --- |
| DDL / `SHOW CREATE TABLE` / `information_schema` | 解析器（sqlglot） | 表、列、类型、主键、外键、注释 | **确定** |
| 已有 ETL/报表 SQL（含 GitHub 仓库里的 `.sql`） | 解析器做**血缘**（CTE/子查询/聚合 → 指标表达式、join 路径、过滤口径） | 指标候选、派生关系（`computedFrom`）、常用 join（`references`） | **确定** |
| Wiki（MD/HTML） | 结构化解析 + LLM | 业务术语、别名、口径说明、维度归属 | 概率 |
| PDF（指标口径手册、数据字典） | 版面解析 + LLM | 同上 + 指标公式 | 概率 |
| 用户显式指定 | 直接 upsert | 实体/关系/指标 | 人工（最高权重） |

**统一候选形态（每个候选必须能指回原文）**：

```jsonc
{ "kind": "entity|relation|metric", "id": "metric/gmv",
  "payload": { "name": "GMV", "expression": "sum(pay_amount)", "unit": "CNY" },
  "proposedBy": "llm|parser|human", "confidence": 0.0,
  "evidence": [{ "docId": "wiki/数仓口径-v3", "span": [1024, 1183], "quote": "GMV = 支付金额之和，不含退款" }],
  "status": "candidate|accepted|rejected|needs_review" }
```

**合并与冲突**：同一实体多源命中 → 按 `human > parser > llm`、`evidence 数`、`confidence` 合并；**口径冲突不自动裁决**（LLM 抽的公式 vs ETL SQL 血缘不一致）→ 进审查队列 `CONFLICT`，这是企业场景最常见也最贵的问题，必须显式暴露。

#### 4.1.2 关系本体（不止"包含"）

继承基座已有 7 种边，新增需求里点到和没点到的关系语义，**每种关系都带 `confidence/evidence/proposedBy/status`**：

| 关系 | 语义 | 来源 | 验证方式（见 4.1.3） |
| --- | --- | --- | --- |
| `contains` / `partOf` | 表含列、域含表、指标族含指标 | DDL、目录、LLM | 结构性，直接校验 |
| `references` | 外键/join 关联 | DDL、ETL join、LLM | **join 命中率探针** |
| `groupedBy` | 指标可由哪些维度切片 | ETL group by、wiki、LLM | 切片后可加总回原值 |
| `computedFrom` / `usesColumn` | 血缘 | ETL SQL 血缘（确定） | 表达式可执行 + 结果对账 |
| `contributesTo` | 归因贡献因子（谁驱动谁） | wiki/口径文档/人工 | **分解加总检验**（见 4.1.3） |
| `dimensionColumn` | 维度 → 物理列 | 目录 | 列存在性 + 基数检查 |
| `definedBy` | 指标 → 参考查询 | ETL/报表 SQL | 执行一致 |
| `governedBy`（新） | 实体 → 口径文档/负责人 | wiki/PDF | 引用可解析 |
| `synonymOf`（新） | 业务别名 ↔ 规范名 | wiki/人工 | 无重复占用 |

#### 4.1.3 验证：把"准确率"和"覆盖率"变成可执行的数

不是人工打分，是**探针（probe）执行**：

| 对象 | 探针 | 判定 | 记入 |
| --- | --- | --- | --- |
| 表/列存在 | `SELECT ... LIMIT 0` | 可执行 | 结构准确率 |
| `references` | `LEFT JOIN` 后 `matchRate = matched/total` | ≥0.95 通过；0.5–0.95 标 `weak`；<0.5 拒绝 | 关系准确率 |
| `groupedBy` | `Σ(切片) vs 总计` 相对误差 | <1e-6 通过 | 关系准确率 |
| 指标表达式 | 执行 vs 参考查询/人工基准 | 数值一致 | 指标准确率 |
| `contributesTo` | 两期分解 `ΣΔ切片 = Δ总` | 残差 < 阈值（且残差**必须显式报出**） | 归因关系准确率 |
| 维度列 | `COUNT(DISTINCT)`、空值率 | 基数合理、非全空 | 质量标记 |

**两个对外指标（每次构建/每次修改都重算并留趋势）**：

- **准确率 precision** = 通过探针的候选 / 已探针的候选（按 entityType、relationType 分列报；抽检覆盖率 <80% 的类目标 `under-sampled`，不报数）。
- **覆盖率 coverage** = 已有定义且已绑定物理列的实体 / 范围内实体（范围 = catalog 全量 ∪ 文档提及）；外加 `joinCoverage` = 至少有一条可用 join 路径的表对 / 实际有业务 join 的表对。

**发布门（gate）**：`precision ≥ 0.95` 且 `coverage ≥ 0.80` 且 `无未裁决 CONFLICT` → 允许 `publish`（提升 `modelVersion`）；否则只能以 `draft` 存在，agent 拒绝对 draft 出数。

#### 4.1.4 人在环：审查、修改、回滚

- 审查队列：按 `status=needs_review` 与 `CONFLICT` 排序，每条给"证据原文 + 探针结果 + 建议"。
- 可执行动作：采纳 / 修改（改表达式、改维度归属、改关系）/ 拒绝 / 新增 / 合并同义实体。
- 每一次人都产生 `revision`（append-only），支持**按 revision 出数回放**（"这个数是用 v12 的语义层算的"）和**回滚**。
- 审计：谁、何时、改了什么、为什么（必填 reason）。

**验收**：`verify:m2` ——
1. 给定 demo 场景的 DDL(≥20 表) + 4 篇 wiki + 1 份 PDF + ≥30 条 ETL SQL → 无人干预构建出 `draft`，报出 precision/coverage，且**每条实体都能追到证据 span**。
2. 人为注入 3 类错误（错列名、错 join、错口径冲突）→ 探针**全部**标出，且冲突项进审查队列而非被静默合并。
3. 人工修改 3 处后 `publish` → `/semantic/{g}/model` 可见新版本；用旧 revision 回放得到旧数。
4. 覆盖率/准确率指标在同一数据上重复运行结果稳定（可复算）。

---

### M3 共享查询层（sqllayer）— 需求 4、5、6，所有子 agent 共用

**职责**：语义请求 → SQL → **改写与性能校验** → 执行；全程单步可看、可改、可回滚。

#### 4.2.1 管线

```
QuerySpec（语义请求：metric/dims/filters/time/grain）
   │  generate        语义层 → 逻辑计划 → 方言 SQL（复用基座 SqlRenderer 口径）
   ▼
SQL(AST) ──► analyze     静态分析：血缘、扫描列、谓词、基数估计、风险
   │  rewrite         规则引擎 + 方言优化 → 候选改写（每步一条）
   ▼
RewritePlan（steps[]，每步带 rationale + 预期收益 + 计划 diff）
   │  price           EXPLAIN（真实连接）：cost/rows/partition pruning
   ▼
ExecutedSQL + StepLedger（可交互编辑、可回放）
```

#### 4.2.2 性能规则表（需求 6 的落地清单，按方言生效）

| ID | 规则 | 检测 | 改写 | 方言 |
| --- | --- | --- | --- | --- |
| P01 | `SELECT *` / 多余列 | 投影列 ⊃ 语义请求所需 | 投影下推、裁剪 | 全 |
| P02 | 缺分区/时间谓词 | 大表无分区列谓词 | 从 timeRange 补谓词 | Hive/Doris/CH/PG 分区 |
| P03 | 索引列被函数/隐式转换包裹（non-sargable） | `WHERE f(col)=v`、`col::text=v` | 改写为 range/等值 | PG/MySQL |
| P04 | `OR` 跨不同列阻断索引 | 谓词树含跨列 OR | 拆 `UNION ALL` | PG/MySQL |
| P05 | 前导通配 `LIKE '%x'` | 字面量模式 | 降级告警 + 建议全文索引/trigram | PG/MySQL |
| P06 | 笛卡尔积/漏 join 条件 | join 无谓词连通性 | 拒绝 + 提供正确 join 路径（来自语义层 `references`） | 全 |
| P07 | 大表驱动小表 | 计划侧 row 估计 | 交换驱动表 / `STRAIGHT_JOIN` / hint | MySQL |
| P08 | 深层分页 `OFFSET` 大值 | offset > N | keyset pagination | 全 |
| P09 | 相关子查询可解相关 | 存在相关谓词 | 改 `JOIN`/窗口函数 | 全 |
| P10 | 聚合前未过滤 / 过滤写在 HAVING | 谓词位置 | 下推 | 全 |
| P11 | `DISTINCT` 掩盖重复 join | DISTINCT + join 扇出 | 改 `EXISTS`/预聚合 | 全 |
| P12 | CTE 重复扫描 | CTE 引用 ≥2 | 物化提示（PG 12+ `MATERIALIZED`）或临时表 | PG |
| P13 | 方言特有能力未用 | 场景匹配 | `PREWHERE`(CH)、runtime filter(StarRocks/Doris)、`ANALYZE` 提示、并行度、向量化开关 | CH/Doris/SR |
| P14 | 统计信息缺失/过期 | catalog `lastAnalyze` | 建议 `ANALYZE TABLE` | 全 |

**每条规则输出统一结构**，这是"性能最优"能被评审、能被沉淀的前提：

```jsonc
{ "rule": "P01", "severity": "high|medium|low", "before": "...", "after": "...",
  "rationale": "只用到 3 列，当前扫描 18 列", "evidence": { "explainDiff": {...}, "estCostDelta": -0.62 },
  "confidence": 0.9, "verified": true }
```

#### 4.2.3 单步验证 / 单步解释（需求 5）

- 每个 step 是一个**可独立执行的对象**：`preview`（看这一步的 SQL 与预期）、`apply`、`revert`、`explain`（为什么这么改 + 计划 diff）。
- 用户可以直接编辑 SQL → 重新 parse → 重新 analyze → 重新 price，**编辑本身也进 StepLedger**（谁改的、改了什么、性能是变好还是变坏）。
- `StepLedger` 落盘（SQLite/JSONL），可导出为报告："这次查询经过 6 步，收益 -78% cost，其中 2 步被人改过"。
- 与基座的区别：基座是**无状态 confirm 令牌**（适合 API 一次确认），这里是**有状态工作台**（适合人反复试）。两者不冲突：agent 自动路径用令牌模式，人工审查路径用 Ledger。

**验收**：`verify:m3` ——
1. 30 条固定 SQL 的改写**语义等价**（改写前后结果集哈希一致，逐行逐列）。
2. 15 条性能回归（真实 EXPLAIN）：改写后 cost/扫描列/扫描分区严格变好，或明确 `no-improvement`（不许"优化了"但实际变差）。
3. P01–P06 规则检出率 100%（构造集），误报 ≤ 0；P07–P14 至少可在 2 个方言上演示。
4. 单步交互：编辑一条 SQL 后重新校验通过/失败都给出原因；Ledger 重放能复现最终 SQL。

---

### M4 Skill 系统（需求 7、8 沉淀）

**职责**：把"经验"变成**有作用域、有证据、可退役**的条目，而不是越来越长的 prompt。

```jsonc
// Tip
{ "id": "tip/perf/pg-nonsargable-date",
  "scope": { "agent": "sqllayer", "dialect": "postgres", "shape": "filter.date.range|filter.date.cast",
             "metricFamily": null, "domain": "gmv" },
  "statement": "日期列上先用 CAST 再比较会让分区裁剪失效，改用区间谓词。",
  "rationale": "谓词写在了函数外层，规划器无法用 index/partition key。",
  "evidence": [{ "runId": "2026-10-20T…", "sqlBefore": "...", "sqlAfter": "...", "costDelta": -0.83 }],
  "confidence": 0.92, "hits": 7, "misses": 0,
  "status": "candidate|adopted|deprecated", "version": 3, "createdBy": "agent|human" }
```

规则：

1. **无证据不入库**。每条 tip 必须挂一次真实执行/验证（`evidence` 非空），拒绝"LLM 觉得"。
2. **晋升/退役**：`candidate` → 需 2 次独立复现或人工确认 → `adopted`（参与决策）；连续 2 次适用但未生效 → `deprecated`。append-only 版本，不覆盖历史。
3. **检索**：scope 精确匹配（agent/dialect/shape 是硬过滤）→ 向量召回（PhoenixGraph `nearest`）→ 取 top-k，按 confidence×命中率排序。
4. **两种出口**：① 作为**确定性规则注入** sqllayer（性能类 tip 变成可执行规则，最可靠）；② 作为**提示片段**给 LLM（解释类 tip）。别把可执行的写成 prompt。
5. **导出**：可导出 `SKILL.md`（与 pi/Anthropic skill 形态兼容），供外部 agent 复用；也可反向 import。

**验收**：`verify:m4` —— 从 M3/M5 的真实运行中沉淀 ≥10 条；leave-one-out：去掉 tip 后同类问题的改写成功率/归因命中率下降可量化；tip 冲突时能给出择优理由；跨方言 tip 不会误用（scope 硬过滤断言）。

---

### M5 智能归因子 Agent（需求 8）

**职责**：指标变了，找出**是哪些具体指标/维度导致的**，给出可加总、可解释、残差显式的分解。

#### 4.4.1 归因循环（轮询 + 剪枝，这是本模块的技术核心）

```
ΔMetric (t0→t1)
  │ 1. 目标层：Δ 总量、显著度
  ▼
Loop(level = 1..maxDepth, budget = {maxQueries: 60, p95 ≤ 8s}):
  │ 2. 候选展开：沿 contributesTo 边（语义层）+ groupedBy 维度 → 候选 (子指标 × 维度切片)
  │ 3. 批量化查询：一层用**一条** GROUP BY（多指标 × 多切片），不是 N 条  ← 性能关键点
  │ 4. 分解：additive(ΣΔ) / mix 结构效应 / 交互项；乘法链用 LMDI
  │ 5. 打分：贡献额、贡献率、显著度（日序列 t 检验 / bootstrap）、稳定性
  │ 6. 剪枝：贡献 < ε 或 波动 < 噪声 或 无 contributesTo 边 → 停止该分支
  │ 7. 若最优分支仍有未解释残差 且 level < max → 继续下一层
  ▼
归因树（top-k 路径）+ 残差 + 每个节点 evidence
```

- **性能就是需求本身**：一次归因可能 5 层 × 8 维度。所以：① 批量（`GROUP BY metric, dim, period` 单查询）；② 语义层预聚合（`contributesTo` 给出可加性的保证，避免"先查再猜"）；③ M3 改写 + M4 性能 tip；④ 结果缓存（同签名的分解复用）。
- **禁止凑数**：`Σ贡献 = Δ` 必须成立或**残差显式报出**（`unexplained: 4.2%`）。基座 `attribute` 已经这么做了，这里继承并扩展到多层。
- **解释**：每个结论挂 SQL + 数值；措辞限制在"分解归因"，明确写"描述性，非因果"。

**验收**：`verify:m5` ——
1. 复现基座 TPC-H 案例：`95,612,794.05 → 98,879,432.89`，变化 `+3,266,638.84`，贡献之和 = 变化量（容差 1e-6）。
2. 构造一个"二级驱动"案例（A 指标变化主要由 B 指标的 region 切片驱动）→ 循环能下钻到第 2 层并找到它，且查询条数 ≤ budget。
3. 批量 vs 逐条：同一问题上查询条数下降 ≥ 80%，p95 延迟达标。
4. 残差不为 0 时必须出现 `unexplained` 字段（反向断言：删掉残差输出测试必须失败）。
5. 无 `contributesTo` 边时明确拒绝，不瞎猜维度。

---

### M6 业务运营 / 投放子 Agent（需求 9）

**职责**：投放效果 → 哪个地区/行业该**加**、哪个该**减**，以最大化投入产出。

- **口径先行**：`spend`、`revenue`、`conversion`、`ROI`、`CAC`、增量归因窗口（`attributionWindow`）必须先落在 M2 语义层，否则拒绝（不拿点击量当收入）。
- **平均 ROI 是错的**：按 `region × industry × channel` 拟合**边际响应曲线**（饱和：Hill/对数/分段线性，按数据量选择），估计 `dROI/dSpend`。
- **分配**：贪心边际均等（把预算从边际 ROI 低处搬到高处）为主，线性规划（带 min/max 份额、总预算、品牌约束）为可选精解；输出**每一步预算变动的预期增量与区间**。
- **可反驳**：每个建议附一个验证设计（geoholdout / switchback 建议），不给"照做就能涨 X%"。
- **反馈闭环**：执行后回收真实结果 → 写入 M4（哪种曲线/分配策略在哪个行业更准）。

**验收**：`verify:m6` —— 在合成/真实投放数据上：① 建议方案的模拟收益 > 现状分配（且差距 > 噪声）；② 约束全部满足（份额上下限、总预算守恒）；③ 建议清单可解释到曲线参数；④ 提出 holdout 方案并通过可行性检查（有对照组规模、观察窗口）。

---

### M7 风控策略子 Agent（需求 10）

**职责**：发现欺诈趋势 → 从特征仓找有效特征 → 合成新规则 → 离线量出召回率/准确率。

流水线：

1. **趋势检测**：按机构/地区/渠道/时段的欺诈量、欺诈率、命中率时序 → 变化点/异常（复用基座图算法与序列统计）。
2. **特征发现**：`feature-store` 检索（实体/窗口/类型/覆盖率/新鲜度过滤）→ 候选特征集。
3. **特征有效性**：AUC / KS / IV / PSI（跨期稳定性）/ 单调性 / 与标签的覆盖率；**point-in-time 正确**（防标签穿越，硬性断言）。
4. **规则合成**：单特征分位点阈值 → 最多 3 条件的合取（限制复杂度，禁止过拟合）；每条规则给出 `coverage`、`precision`、`recall`、`lift`、与**现有规则的增量**（新增命中 / 重叠 / 误杀成本）。
5. **离线回测**：在带标签窗口上算混淆矩阵与阈值曲线，输出可审计报告；通过门（如 `precision ≥ 0.85 @ recall ≥ 0.30`，阈值可配）才进入候选发布。
6. **人工审批**：规则永不自动上线；审批记录进审计。

**验收**：`verify:m7` —— ① 趋势检测在注入的拐点上召回 100%、误报 0（构造集）；② 特征有效性报告含 AUC/KS/PSI 且 point-in-time 断言通过（故意做一次穿越，测试必须报错）；③ 规则回测可与现有规则做增量对比；④ 未审批的规则无法出现在"已发布"列表。

---

### M8 产品面（API / MCP / Console）

| 面 | 内容 |
| --- | --- |
| HTTP API | `/v1/ask`、`/v1/attribute`、`/v1/campaign/optimize`、`/v1/risk/{trend,features,rules,backtest}`、`/v1/semantic/{build,review,publish,validate}`、`/v1/sql/{rewrite,explain,steps}`、`/v1/skills`。统一 `mode=auto|confirm`，沿用基座令牌模式。 |
| MCP | 每个子 agent 暴露 3–5 个工具，工具目录仍从服务端读（不重复定义）。可被 pi / Claude / 自研 agent 调用。 |
| Console | 三个工作台：**语义审查**（实体/关系/证据/探针/冲突）、**SQL 工作台**（生成→改写→单步→编辑→执行→对比）、**Skill 库**（tip 证据/命中/晋升/退役）。复用 graph-web 的图可视化组件展示语义图与归因树。 |
| 交付形态 | `docker compose`（PhoenixAgent + PhoenixGraph + 一个 demo 数仓）；支持纯内网无外网运行。 |

**验收**：`verify:m8` —— 三个工作台的关键流程 e2e 通过（Playwright：审查一条冲突、改一段 SQL 看性能 diff、采纳一条 tip）；API 契约测试（OpenAPI 与实际一致）；MCP `--selftest` 通过。

---

### M9 评估与可信（跨越所有模块）

**台账**（继承基座"答案级"做法，每类 agent 一份）：

| 类别 | 断言 |
| --- | --- |
| 正确 | 数值等于基准（人工核对过）+ provenance 完整（模型版本/SQL/行数） |
| 必须拒答 | 缺指标/缺维度/缺时间列 → 有 refusal 且指出缺什么 |
| 歧义 | 多候选口径 → 给候选，**不执行** |
| 漂移/陈旧 | schema 变了 / 数据不覆盖 → 明确 warning，不静默 |
| 性能 | 改写后计划严格不变差；`no-improvement` 显式 |
| 安全 | 写操作/越权/超预算 100% 拒绝 |
| 成本 | 每题查询数、token、延迟落在预算内（超了报警） |

产出：`eval/<agent>.jsonl` 金标集 + `eval/runs/<ts>.json` 趋势；CI 门禁（失败即阻塞）。指标面板：准确率、覆盖率、拒答正确率、p50/p95 延迟、每题成本、SKILL 命中率。

---

## 5. 需求 → 模块 → 验收 追溯表

| 需求 | 模块 | 关键交付 | 验收命令 |
| --- | --- | --- | --- |
| 1 企业级 data agent 产品 | M1, M8, M9 | 运行时 + API/Console + 台账 | `verify:m1`、`verify:m8` |
| 2 按查询结构路由子 agent | **M1** | `QuerySignature` + 路由表 + 歧义澄清 | `verify:m1`（≥90%，歧义 100% 澄清） |
| 3 语义层构建（DDL/wiki/PDF/ETL/GitHub）+ 人能改 + 准确率/覆盖率 | **M2** | 抽取流水线、关系本体、探针验证、审查与版本 | `verify:m2`（4 条断言） |
| 4 共享查询解析与改写层 | **M3** | `QuerySpec→SQL→RewritePlan` 统一管线 | `verify:m3`（等价性 30 条） |
| 5 单步验证/单步解释 + 交互式改语句 | **M3** | StepLedger（apply/revert/edit/explain） | `verify:m3`（重放一致） |
| 6 查询性能最优检查 | **M3** | P01–P14 规则 + EXPLAIN 计价 | `verify:m3`（15 条性能回归） |
| 7 性能调优沉淀为 skill | **M4** | Tip 模型 + 证据 + 晋升/退役 + 两种出口 | `verify:m4`（leave-one-out） |
| 8 智能归因（轮询、循环、子查询性能）+ 分析沉淀 skill | **M5** + M4 | 归因循环、批量化、剪枝、残差显式 | `verify:m5`（5 条断言，含复现基座案例） |
| 9 业务运营/投放 ROI 分配 | **M6** | 边际响应曲线 + 约束优化 + holdout 设计 | `verify:m6` |
| 10 风控：趋势 → 特征有效性 → 规则 → 离线召回/准确率 | **M7** | 特征评估 + 规则合成 + 回测 + 审批 | `verify:m7` |

---

## 6. 仓库结构（提议）

```
PhoenixAgent/
  packages/
    core/          M1 运行时：signature/router/session/toolbus/llm-gateway/audit
    dataplane/     M0 catalog · sql-exec · feature-store · doc-source
    semantic/      M2 抽取器 · 合并 · 探针 · 审查 · publish
    sqllayer/      M3 generate/analyze/rewrite/rules/price/steps  (TS)
    sqlkit/        M3 的 Python sidecar：sqlglot 解析·血缘·方言·优化（见 §7 D1）
    skills/        M4 store · retrieval · lifecycle · export
    agents/
      attribution/ M5      campaign/ M6      risk/ M7
    api/           M8 HTTP + MCP
    console/       M8 Web 工作台
  eval/            金标集与趋势
  fixtures/        demo 场景：DDL / wiki / PDF / ETL SQL / 样例数据
  docs/            PLAN.md · CONTRACTS.md · 各模块 ADR
  scripts/         verify:m0..m9 一键跑
```

约定：每个模块**先写契约（JSON Schema / TS interface）再写实现**；每个验收脚本是**断言**不是 smoke test；所有对外接口版本化（`/v1`，模型 `modelVersion`，tip `version`）。

---

## 7. 关键技术决策（请重点评审）

### D1 技术栈：TS 主控 + Python `sqlkit` sidecar（推荐）

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **A. TS 主控 + Python sqlkit**（推荐） | Node 侧 MCP/流式/工具生态最好，与基座 `tools/*.mjs`、`verification/*.mjs` 同语言；sqlglot 是目前唯一能同时做**多方言解析 + 血缘 + 优化规则（谓词下推/列裁剪）+ 方言转写**的库，正好命中需求 4/6；Python 又是特征评估/规则回测（pandas/sklearn）的天然选择 | 两种语言，需一个 HTTP/gRPC 契约 |
| B. 全 Python | 单语言，数据科学顺手 | MCP/agent 生态与基座脚本割裂，并发/流式要自己补 |
| C. 全 Java | 与基座同构 | 无 sqlglot 等价物；文档解析/LLM 生态差；迭代慢 |

契约上 sqlkit 只是 `POST /analyze {sql, dialect}` → `{ast, lineage, scannedColumns, predicates}`，可替换。

### D2 LLM 策略：多供应商 + 必须可离线

- 供应商可插拔（OpenAI 兼容 / DeepSeek / Azure / 本地 vLLM），按任务分档（抽取用强模型、路由用轻模型、解释用中模型）。
- **`PAGENT_LLM=none` 时必须仍能跑**：路由走规则、语义抽取只剩确定性解析器（DDL/ETL SQL）、问数走基座确定性解释器。即 LLM 是增强不是前提——这也是企业私有化落地的硬要求。
- LLM 允许：抽取候选、意图分类、改写建议、解释叙述。LLM 禁止：决定口径、跳过探针、直接执行 SQL、生成要自动上线的规则。
- 所有 LLM 输出进**候选/建议**通道，带 `proposedBy=llm`，需确定性校验或人工确认才能生效。

### D3 语义层存储：PhoenixGraph 是单一来源（推荐）

- 语义实体与关系写入基座语义图（沿用 `Node` + `Relation`，新增边类型走向后兼容的 schema 版本），PhoenixAgent 不另建主库。
- 原因：① 基座的 `ask/attribute/translate` 直接就能用；② 关系查询（多跳、路径、向量召回）正是图擅长；③ 避免双写不一致。
- 代价：需要图 schema 扩展（`governedBy`/`synonymOf` 边、候选态 `status/confidence/evidence` 属性）→ 走基座 PR。
- 本地只存**过程态**（抽取批次、探针结果、StepLedger、审查队列）在 SQLite，作为可重放的暂存区。

### D4 有状态 vs 无状态

- **自动 agent 路径**：无状态 confirm 令牌（沿用基座，多副本友好）。
- **人工工作台**：有状态 Workspace/Ledger（必须能"改一步、看一步、回滚"），落盘并带 revision。
- 两者共用同一 `Plan` 结构，令牌哈希覆盖计划，改一个字段即失效。

### D5 "性能最优"的判定以真实计划为准

- 静态规则只生成**候选**；是否"更优"以 `EXPLAIN` 的 cost/rows/扫描列/扫描分区 + 实测延迟为准，二者冲突时以实测为准并记录反例（反例进 M4 做证据）。
- 无法测量（无权限 EXPLAIN、无统计信息）→ 标 `unverified`，不声称优化。

### D6 安全与合规默认开

- 只读 SQL 白名单 + 单语句 + 超时 + 行数/成本上限；SQL 拼接禁用（参数化/语义层生成）。
- PII 列在语义层标 `sensitive`，默认不进 prompt、不进结果集，需显式授权。
- 全量审计：SQL、结果行数、审批、tip 采纳、LLM 调用（含 token 与成本）。

---

## 8. 企业与工程约定

- **评测即代码**：没有验收脚本的模块视为未交付；每个验收脚本进 CI。
- **先契约后实现**：模块间只通过 `packages/*/contracts`（JSON Schema）对话。
- **可回放**：任何一次答案都能用 `{modelVersion, planHash, sqlkitVersion, tipVersions}` 重放。
- **失败要响**：拒绝、降级、未验证三种状态必须出现在响应里，不许吞。

---

## 9. 分阶段实施计划

| 阶段 | 内容 | 交付物 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| **P0** 骨架（~3 天） | 仓库结构、契约层、基座 HTTP/MCP 客户端、`verify:` 脚手架、CI | `packages/core` 空壳 + 工具发现 | `verify:p0`：发现基座 13 工具；一条 `ask_data` 往返绿；离线模式可启动 | — |
| **P1** 语义 Agent 竖切（~2 周） | M0 最小（catalog + sql-exec + 文档源）+ M2 抽取（DDL/ETL/wiki，PDF 后置）+ 探针 + 审查 API + publish | 一个业务场景从 0 到 `draft→publish` | `verify:m2` 四条断言 | P0、**需定场景（§10 Q1）** |
| **P2** 查询层 + 单步工作台（~2 周） | M3：generate/analyze/rewrite(P01–P06)/price + StepLedger + API | `POST /v1/sql/{rewrite,explain,steps}` | `verify:m3`（等价性 + 性能回归） | P1（需要真实表与索引） |
| **P3** Skill（~1 周） | M4 store/检索/生命周期 + 从 P2 沉淀 | `/v1/skills` + 导出 | `verify:m4` | P2 |
| **P4** 归因 Agent（~2 周） | M5 循环/批量/剪枝/残差 + 解释 | `/v1/attribute` | `verify:m5`（含基座案例复现） | P2、P3 |
| **P5** 投放运营（~2 周） | M6 曲线/优化/holdout | `/v1/campaign/optimize` | `verify:m6` | P4 |
| **P6** 风控策略（~2–3 周） | M7 趋势/特征/规则/回测 | `/v1/risk/*` | `verify:m7` | P4（共用归因与特征查询） |
| **P7** 产品化（~2 周） | M8 Console 三工作台、RBAC、审计、成本、compose | 可交付镜像 | `verify:m8` | 全部 |

顺序理由：**M2 是上游**（没有可信语义层，其余全是猜）；**M3 是被四个 agent 复用的地基**，必须先于 M5/M6/M7；**M4 越早插越好**（否则经验散落在代码里）；M5 是第一个真实消费者，用它来压 M3 的性能；M6/M7 可以并行。

---

## 10. 待你确认的问题（阻断开发，请逐条给结论）

| # | 问题 | 为什么阻断 | 我的建议 |
| --- | --- | --- | --- |
| Q1 | **第一个业务场景**用哪个？（投放 / 风控 / 电商 GMV / 其他） | 决定 P1 的语料（DDL/wiki/PDF/ETL）与 P5/P6 顺序 | 先做**投放效果**：口径清晰、可合成数据、与需求 9 直连；风控第二 |
| Q2 | 技术栈是否采纳 D1（TS + Python sqlkit） | 全仓结构 | 采纳 |
| Q3 | **数据源怎么接**？有只读账号/JDBC 吗？能跑 `EXPLAIN` 吗？ | 没有真实连接 → 需求 6 的性能校验做不了，只能静态规则 | 至少要一个可 `EXPLAIN` 的只读实例（DuckDB/PG 均可起步） |
| Q4 | 语义层是否**只存 PhoenixGraph**（D3）？允许改基座 schema 吗？ | 影响是否要维护双写 | 只存图，基座加向后兼容属性/边 |
| Q5 | LLM 供应商与**数据出境**要求？私有化部署吗？ | 决定默认配置与"离线模式"是否是主路径 | 默认离线可用，LLM 可配 |
| Q6 | 数据规模？（表数/字段数/文档页数/ETL SQL 条数） | 决定抽取是单机批处理还是需要增量队列 | 给个数量级即可 |
| Q7 | 审批角色：谁审语义口径？谁审风控规则？ | 决定 M8 权限模型与流程 | 语义=数据 owner；规则=风控负责人+数据 owner 双签 |
| Q8 | 前端先做还是先 API？ | 影响 P7 排期与 P1 的审查体验（P1 只有 API 也能审，但效率低） | P1 先 CLI/JSON + 极简表格页，完整 Console 放 P7 |

---

## 11. 明确不做（第一版）

- 不做写操作/DDL/数据回刷；不做因果推断与"保证涨"/"保证降"的话术。
- 不做自由生成 SQL 直连生产（一切经语义层与 M3 管线，生成物用于导出/对照）。
- 不自动发布风控规则；不让 LLM 决定口径或跳过探针。
- 不追通用 Text2SQL 榜单；优先级是"企业内真实口径 + 可审计"，不是开放域覆盖率。
- 不做跨租户共享语义模型（租户隔离优先）。

---

## 12. 进展（每片完成即更新）

| 片 | 状态 | 证据 |
| --- | --- | --- |
| **P0** 骨架 | ✅ 完成 | `npm run verify:p0`：13 工具与 13 绑定一致；`ask_data` 实往返（5 行、SQL、provenance、confidence 0.85）；43 条标注问题路由 100%，2 条近义问题 100% 转澄清；离线网关抛 `LlmDisabled` 且路由仍可用。17/17 |
| **P1 / M2** 语义 Agent | ✅ 完成 | `npm run verify:m2`：clean 语料门通过（准确率 100%，列描述 84.6%，指标定义 91.7%，join 5/5 已验证）；3 类注入错误全被抓（编译失败 / join 0% / 口径冲突），冲突进审查队列；同一 `--now` 两次构建报告逐字节一致；3 条人工决定（改描述、拒 CAC、新增净收入）后发布 v2，墓碑 `metric/cac`，`replay v1` 复现 v1 的数；40/40 |
| **P1.5** 语义层能力升级 | ✅ 完成 | PDF 文本层（ToUnicode）、视图与装载、数据概况发现（粒度/未声明外键/维度表标签/时间层级/PII）、本体 7→13 种关系、业务域、探针 +grain/+enum、每表 completeness + orphans + drift。表 5→7、指标 11→14、维度 4→11、关系 100→214、注入错误检出 3→4。见 `docs/SEMANTIC-UPGRADE.md`；`verify:m2` 53/53 |
| **P2 / M3** 共享查询层 | ✅ 完成 | `packages/sqllayer`：规则 P01/P02/P03/P04/P06/P13、结果等价改写（P01 列裁剪、P03 日期前缀→半开区间）、EXPLAIN QUERY PLAN + 实测耗时证据、单步账本（apply/revert/人改皆记账、可重放）、suggestion 拒绝应用、CLI。`verify:m3` 29/29 |
| **P3 / M4** Skill 系统 | ✅ 完成 | `packages/skills`：证据强制（无 evidence 直接拒绝）、作用域硬过滤（方言/表）、两次独立确认才 adopted / 两次 miss 退役、append-only 历史、severity×命中率排序、SKILL.md 往返、CLI。11 条 tip 从真实运行沉淀；8/8 检索命中，去掉一条可量化下降 2；并修掉 publish 依赖 `GET /schema/{graph}` 的真 bug（运行期建图该端点返回 404）。见 `docs/SKILLS-M4.md`；`verify:m4` 29/29 |

| **P1 升级** 图/版本/决策平台/混合问数 | ✅ 完成 | 图特征（5 个结构量）进 holdout 增量：0.9613 → 0.9733；快照取上月最后一天，翻转标签特征不变；基座遍历 40/40。模型 diff 五级分类 + 漂移（7 表/34 列）+ shadow（10% → hold）+ 发布门四组合。规则集重复/子集/冲突/不可达、Erlang-C 容量、双签 quorum、下发幂等键（重排同键、改 1 元变键）。提案校验（6 类）+ 词表学习（目标必须存在、同词不可二指）+ 三轮跟进。见 `docs/P1-UPGRADE.md`；28+33+45+42 = 148 条 |

### 与规划不一致的三处（已在 `docs/P1-NOTES.md` 详述）

1. **可写图 ≠ 可扫描图**：基座语义加载器用 `g.V('Node')`（只有 RocksDB 图支持），而 RocksDB 图拒绝 REST 写入；
   可写的是 Aerospike 图但不支持类型扫描。因此 publish 产出**键值副本**（按 id 点读回验）**+ 分析型导出**
   （`v<N>.graph.json`，RocksDB-Edge schema + 数据）。P2 必须补真正的分析型加载路径或 PhoenixAgent 自己的
   `/v1/semantic/{g}/model`。
2. **`sqlkit` 先用 TypeScript**：本机无 Python，P1 只需读 DDL/报表 SQL；契约即为 P2 的 sqlglot sidecar 预留。
3. **删除改墓碑**：含 `/` 的 id 无法经 URL 删除（Tomcat 拒绝 `%2F`），丢掉的节点重写为 `status: rejected`，
   与基座「delete is a marker」一致，且保留了发布历史。
