# P0 + P1 交付笔记（语义 Agent / M2）

这份文件记录**实际发生了什么**，包括三处与规划不一致的地方和原因。规划在 `PLAN.md`，这里只写实现与偏差，
验收命令在文末。

## 1. 交付内容

| 模块 | 位置 | 内容 |
| --- | --- | --- |
| 契约 | `packages/contracts/src/index.ts` | `Candidate` / `Evidence` / `ProbeResult` / `QualityReport` / `Revision`，语义 id 约定 |
| P0 运行时 | `packages/core/src/` | 基座 HTTP 客户端（工具目录读取 + 调用）、LLM 网关（默认关闭）、按查询结构路由、JSONL 工作区与审计 |
| M0 数据面 | `packages/dataplane/src/` | SQLite catalog、只读守卫、执行器、Markdown 文档抽取（含 `PDF` 占位与缺口上报） |
| SQL 读取 | `packages/sqlkit-ts/src/` | 分词器、`CREATE TABLE` 解析（注释/主外键/索引）、`SELECT` 血缘分析（CTE/别名/聚合/GROUP BY/JOIN/WHERE） |
| M2 语义 Agent | `packages/semantic/src/` | 三源抽取 → 合并与冲突 → 五类探针 → 准确率/覆盖率与发布门 → 审查日志与版本回放 → 发布（图 + 分析型导出） |
| 验收 | `scripts/verify-p0.mjs`、`scripts/verify-m2.mjs` | 17 + 40 条断言 |

数据与语料：`fixtures/demo/`（投放域：5 张表 / 26 列 / 11 个指标 + 2 个维度，DDL、2 份 ETL SQL、1 份口径 wiki，
另有“注入错误”目录）。`scripts/build-demo-db.mjs` 生成 SQLite 数据与**独立计算的 goldens**（用 JS 汇总种子行，
不经 SQL），所以 `golden` 探针比较的是两条独立路径。

## 2. 一处关键发现：可写的图和可扫描的图不是同一种图

规划里写的验收是「publish 之后 `GET /api/v1/semantic/{g}/model` 能看到新版本」。实现时撞上的事实：

| 存储 | 能写（REST） | 能扫描 `g.V('Node')` |
| --- | --- | --- |
| `Aerospike` / `Aerospike-Edge`（keyed） | ✅ | ❌ `g.V('Node') starts from a whole type ... a keyed store answers by id` |
| `RocksDB-Edge`（analytical） | ❌ `writes go through the primary graph or a loader` | ✅ |

而基座 `SemanticService.load()` 正是 `g.V('Node').elementMap()`。也就是说**语义模型只能从 RocksDB 图读，
只能往 Aerospike 图写**，这两个集合没有交集。

因此 P1 的发布是两条腿，两条都由一次 `publish` 产出：

1. **键值副本**（Aerospike）：逐条写入 `Node` / `Relation`，然后**按 id 点读回验**（50 个节点全读、40 条边遍历抽样、
   0 失败）。这是 keyed 存储能给的最强校验，也足以证明没有丢写、没有类型错。
2. **分析型副本**（`v<N>.graph.json`）：同一模型导成 `Node`/`Relation` 文档 + `RocksDB-Edge` schema，交给基座的
   加载路径，供 `semantic/translate` 与基座语义读使用。

结论与后续：**P2 必须补一条真正的分析型加载路径**（要么给基座加一个「从 JSON 灌 RocksDB 图」的加载器，
要么由 PhoenixAgent 自己的 `/v1/semantic/{g}/model` 直接读键值副本并渲染 SQL）。这两条都在 P2 的范围内，
P1 不假装它已经通。

## 3. 另外两处偏差（都更小，也都记着）

**D1 — `sqlkit` 先用 TypeScript 实现，Python sidecar 留在 P2。** 这台机器上没有 Python（`py`/`python`/`python3`
都不存在），而 P1 只需要**读** DDL 和报表 SQL，不需要 sqlglot 的改写能力。所以 P1 的解析器是
`packages/sqlkit-ts`，契约（`parseDdl` / `analyzeSql` 的输出形状）就是给 P2 的 sqlglot sidecar 预留的接口。
P2 的改写/优化规则（P01–P14）才真正需要 sqlglot，届时按同一契约替换，不影响语义层。

**D3 — 删除改成墓碑。** 节点 id 含 `/`（`metric/cac`），而删除端点是
`DELETE /api/v1/graphs/{g}/vertices/{id}`：URL 编码的 `%2F` 被 Tomcat 拒绝（400），不编码则路径被切开。
于是新版本丢掉的节点不是删除，而是**重写为 `status: 'rejected'`**——这与基座自己「delete is a marker」的语义一致，
而且更好：图里留着「v1 发布过、v2 撤回」的历史，读者按 `status != rejected` 过滤。
验收里断言了 v2 的 `metric/cac` 读回来是 `rejected`。

## 4. 探针与数字（clean 语料，`verify:m2` 实测）

| 探针 | 作用 | 结果 |
| --- | --- | --- |
| `existence`（表/列/维度/指标表达式/结构关系） | 能不能编译、端点是否存在 | 26 列 + 12 指标 + 结构关系全过 |
| `references` | 外键 join 的命中率 | 5/5，命中率 100% |
| `groupedBy` | 切片可加总（`Σ切片 = 总量`，相对误差 < 1e-6） | 26/26 |
| `golden` | 与**独立计算**的基准比对 | 全过（GMV = 1,997,859.02） |
| `formula` | 比率指标 = 分子/分母（按切片）+ `contributesTo` 边是否有定义支撑 | 全过 |

对外两个数（每次构建重算）：**准确率** = 通过探针 / 已被探针覆盖（按类型分列，覆盖不足 80% 的类目报
`under-sampled` 且不给数）；**覆盖率** = 表 100%、列 100%、列有描述 84.6%、指标有可执行定义 91.7%、
join 对 5/5 且已验证 5/5。发布门：准确率 ≥ 95%、列描述 ≥ 80%、指标定义 ≥ 90%、无未裁决冲突。

注入的 3 个错误全部被抓到（`verify:m2` 断言）：

| 注入 | 抓它的探针 | 输出 |
| --- | --- | --- |
| `SUM(f.revenuee)` 拼错列 | `existence`（指标编译） | `no such column: fact_ad_daily.revenuee` |
| `FOREIGN KEY (region_id) REFERENCES dim_region(region_name)` | `references` | `0/864 child rows find a parent (0.00%)` |
| wiki 写 `GMV = SUM(amount)`（漏退款） | 合并期口径比较 | `metric/gmv 的口径有两个互不相等的定义`，进审查队列，门拒绝 |

## 5. 已知限制（P1 明确不做/做不到）

- 每个指标只落在单一事实表；跨事实表的指标会被 `RenderError` 拒绝而不是硬拼 join。
- `groupedBy` 的可加性探针只对 `SUM`/`COUNT` 生效，比率指标报 `skipped`（不是通过）。
- PDF 不读，只在报告里记为 `unread` 并把覆盖率标为低估。
- 文档里出现的名称若在 DDL/ETL 里没有定义，会成为 `needs_review` 候选（例如 `metric/cac`、`dim/日期`）——
  这是覆盖率缺口，不是错误，但需要人来决定补 ETL 还是改文档。
- 关系类型 `governedBy` / `synonymOf` 已在契约与发布属性里预留，尚未有抽取器产出它们。
- 参考查询节点（`query/*`）只做结构校验（`definedBy` 端点存在），不执行。

## 6. 怎么跑

```bash
npm run demo:db        # 生成 fixtures/demo/data/demo.db 与 goldens.json（确定性种子）
npm run verify:p0      # 需要 PhoenixGraph 在 8081（否则 SKIP）
npm run verify:m2      # 需要 PhoenixGraph 在 8081（build 部分不需要）

# 手工操作
node packages/semantic/src/cli.ts build   --graph demo-analytics --now 2026-10-20T00:00:00.000Z
node packages/semantic/src/cli.ts review  --graph demo-analytics --edit metric/gmv \
     --set 'payload.description=人工确认口径' --reason '口径修正' --actor analyst@demo
node packages/semantic/src/cli.ts publish --graph demo-analytics
node packages/semantic/src/cli.ts replay  --graph demo-analytics --version 1 --metric metric/gmv
```

产物（`.pag/`，已 gitignore）：`build/<graph>/candidates.json` + `report.json`、`reviews/<graph>.jsonl`（append-only）、
`models/<graph>/v<N>.json`（含发布时每个指标的值，供回放比对）与 `v<N>.graph.json`（分析型导出）。
