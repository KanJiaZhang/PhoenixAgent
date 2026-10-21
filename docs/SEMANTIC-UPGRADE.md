# 语义层能力升级（P1.5）：从"能建出来"到"敢用来出数"

## 1. 诊断：原来的 P1 简单在哪

机制（候选 → 证据 → 探针 → 门 → 审查）是对的，但**输入太窄、本体太薄、推断太少、覆盖度不可行动**。逐条说，每条都能指到代码或数据：

| 短板 | 具体表现（升级前） | 后果 |
| --- | --- | --- |
| 来源只有 3 种 | DDL 文本、`SELECT` 报表、Markdown。PDF 只在报告里记"未读" | 企业里最权威的口径手册（PDF）完全没进模型 |
| 不读视图、不读装载 | `CREATE VIEW` 被 DDL 阅读器跳过；`INSERT INTO tgt SELECT` 不解析 | 报表层和 ADS 层的口径丢失；`derivedFrom`/`writes` 血缘为零 |
| 没有数据概况 | 只用目录（表/列/类型）和 DDL 注释 | 主键是否真唯一、`*_id` 是否真外键、"维度"是否其实是主键，全靠声明 |
| 本体太薄 | 7 种关系；维度只能绑定"一个物理列"；没有时间层级、没有业务域、没有代理键→标签的绑定 | `dim/region` 会被绑到 `fact.region_id` 或 `dim_region.region_name` 中的一个，取决于文件顺序；比率/时间上卷无法表达 |
| 推断几乎为零 | 维度只来自 `GROUP BY`；外键只来自 `FOREIGN KEY` | 一份没人 group by 过的低基数列永远不是维度；DDL 忘写的外键永远不会被发现 |
| 覆盖度不可行动 | 只有全局 84.6% / 91.7% | 看不出是哪张表在拖后腿，也不知道"缺的到底是什么" |

## 2. 这次补的六项能力（都带证据与探针）

### 2.1 PDF 文本层阅读（含 ToUnicode CMap）

`packages/dataplane/src/pdf.ts`：解 FlateDecode 流、读文本算子（`Tj`/`TJ`/`'`/`"`、`Td`/`TD`/`T*`/`Tm` 断行）、按字体的 `/ToUnicode` CMap（`bfchar`/`bfrange`）把两字节字形码映射回文字——这是中文 PDF 能被读到的唯一机制。读不出来（纯扫描件、无 CMap 的字体）时**明确报告不可读**，而不是把乱码喂给抽取器。

夹具里是一份真的 PDF（`fixtures/demo/docs/指标口径补充.pdf`，由 `scripts/build-fixture-pdf.mjs` 生成：一页、Helvetica + ToUnicode、内容流 Flate 压缩），所以 inflate 与 CMap 两条路径每次验收都被真实执行。效果：`metric/spend`、`metric/revenue`、`metric/roi`、`dim/channel` 各多出一条 `kind: 'pdf'` 的证据。

### 2.2 视图与装载（企业语义层真正的上游）

- `CREATE VIEW name AS SELECT ...` → `query/view:<name>` 节点 + 到每张基表的 `derivedFrom` 边；视图里的聚合照常成为指标候选（本夹具贡献 `ad_spend`/`ad_revenue`/`ad_conversions`）。
- `INSERT INTO tgt (cols) SELECT ...` → 查询节点带 `writes` 边指向目标表，说明"这张 ADS 表的口径来自哪里"。

### 2.3 数据概况（profiling）驱动发现

`packages/dataplane/src/profile.ts` → `packages/semantic/src/extract/catalog.ts`：

| 概况事实 | 变成什么 | 例子 |
| --- | --- | --- |
| 主键在数据里唯一 | 表的 `grain` + `grain` 探针通过 | `fact_ad_daily`：864 行、四个键组合唯一 |
| `*_id` 命名 + 同名维度表 | 未声明的 `references`（confidence 0.7，**命名匹配，不看值**） | `fact_ad_daily.campaign_id → dim_campaign.campaign_id`（DDL 里没写外键） |
| 低基数、非键、非 FK | 维度候选（带基数与样本值） | `dim_campaign.campaign_name → dim/campaign` |
| 日期列 | `month`/`quarter`/`year` 三个时间层级 + `hierarchy` 边 | `dim/month → dim/quarter → dim/year` |
| 列名含 email/phone/id_card… | `sensitivity: 'pii'`，并记一条"不进 prompt、不进默认结果集" | 演示数据里无 PII，路径仍有测试 |

**关键的一条纪律**：维度绑定的是**维度表的标签列**（`GROUP BY fact.region_id` → `dim_region.region_name`），不是事实表的键。否则同一个 `dim/region` 会因文件顺序被绑到两个不同列，gmv 这类另一张事实表的指标就再也 join 不上（这次升级中真实踩到并修掉）。

### 2.4 本体扩展（关系 7 → 13 种）

新增 `belongsTo`（业务域归属）、`hasMetric`（域内指标）、`hierarchy`（层级上卷）、`derivedFrom`（视图血缘）、`writes`（装载血缘），并给维度加了 `expression`（时间层级用 SQL 表达式表示）与 `level`。文档前置元数据 `---\ndomain: 投放域\n---` 会生成 `domain/投放域` 节点及 9 条 `belongsTo`、5 条 `hasMetric`。

### 2.5 探针从 5 类到 7 类

新增：

- **`grain`**：`COUNT(*) - COUNT(DISTINCT key…)`，主键不唯一就直接失败。这是"事实表被 fan-out 放大却没人发现"唯一能自动抓住的办法。
- **`enum`**：口径里的字面量（`status = 'paid'`）到底能匹配几行。拼错成 `'paidd'` 时指标恒为 0，看起来像"那天没有成交"——注入夹具里就是这么设计的，现在会被点出来。

### 2.6 覆盖度变成可行动的报告

新增 `completeness`（每张表按"有描述/有键/有连接/被指标使用"四项加权，并列出缺什么）、`orphans`（什么都没用到的表）、`relationInventory`（本体自身的覆盖）、`drift`（与上一次构建相比新增/变化/删除的候选）。摘要从"84.6%"变成"`dim_campaign 66.7%`、`fact_ad_daily 100%`、0 孤儿"。

## 3. 效果（同一份夹具，升级前后）

| 指标 | 升级前 | 升级后 |
| --- | --- | --- |
| 表 / 列 | 5 / 26 | **7 / 34** |
| 指标（有可执行定义） | 11 | **14**（+3 个来自视图） |
| 维度 | 4 | **11**（维度表标签、状态、时间三层） |
| 关系类型 / 关系总数 | 7 / 100 | **13 / 214** |
| 外键 references | 5（全部来自 DDL） | **7**（其中 2 条来自命名 + join 探针发现） |
| 时间层级 | 0 | 3 条 `hierarchy` |
| 视图血缘 / 装载血缘 | 0 / 0 | 3 条 `derivedFrom` / 1 条 `writes` |
| 业务域 | 0 | 1 个域，9 条归属，5 条域内指标 |
| 列描述覆盖 | 84.6% | **85.3%**（多了 8 列，其中 5 列有注释） |
| 指标定义覆盖 | 91.7% | 93.3%（`metric/cac` 只有文档、没有 SQL，仍如实标记） |
| 探针族 | 5 | 7（+grain、+enum；formula 现在还校验 `contributesTo` 是否有定义支撑） |
| 注入错误检出 | 3 | **4**（+死字面量 `'paidd'`） |
| 验收断言 | 40 | **53**（`verify:m2`）+ 29（`verify:m3`） |

## 4. 仍然缺什么（不藏）

1. **只支持单一事实表上的指标**；跨事实表指标会被 `RenderError` 拒绝（拒绝是对的，但能力还没到）。
2. **`dbt` / BI 工具元数据 / 存储过程** 还不是来源；Excel 数据字典也是。
3. **PDF 只做文本层**：扫描件不可读（明确报告）；双栏排版会按流顺序读；表格不重建。
4. **`synonymOf`、`governedBy` 有本体位置但没有抽取器**；同义名目前存在实体的 `alias` 上。
5. **关系 `references` 发现只按命名**（这是刻意保守），值分布只用于探针判定。行业名与区域名那种"值域重叠"的情况因此不会被误判。
6. **`completeness` 的权重是拍的**（0.4/0.2/0.2/0.2），没有用真实使用频次校准——P3 的 Skill/使用日志上来后应该按实际查询热度加权。

## 5. P2 / M3 交付（本次一并完成）

`packages/sqllayer/`：

- `analyze.ts`：规则 P01（多列/星号）、P02（缺时间过滤）、P03（列上包裹函数，索引失效）、P04（跨列 OR）、P06（笛卡尔/漏 join）、P13（无界结果集）。每条 finding 带证据片段与建议。
- `proposeRewrites`：只产出**结果等价**的改写（P01 按调用方需要的列裁剪、P03 日期前缀 → 半开区间）；会改变答案的（LIMIT）标成 `suggestion`，工作台**拒绝**应用。
- `explain` / `compareEvidence`：SQLite `EXPLAIN QUERY PLAN` + 实测耗时。`substr(order_date,1,7)='2024-05'` 从 `SCAN fact_order` 变成 `SEARCH ... USING INDEX idx_fact_order_date`，同一份数据行数一致；拿计划与自己做对比时明确回答 **no improvement**。
- `steps.ts`：append-only 单步账本（apply / revert / **人改也记账**），`state()` 从日志重放出当前 SQL。
- `cli.ts`：`plan / analyze / rewrite / apply / revert / edit / show`。

验收 `npm run verify:m3`（29/29）：6 条规则命中、5 组改写逐行等价、计划证据来自真实 EXPLAIN、账本 apply→edit→revert 重放一致、suggestion 被拒。
