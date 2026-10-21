# M2.6 交付：跨事实表指标 + 域边界（scope）

## 1. 为什么这是语义层最难的一块

两个事实表的粒度不同：投放花费在 `(日期, 大区, 行业, 渠道)`，订单 GMV 在 `(订单, 大区, 行业)`。**按大区 join 两张事实表**，
每条订单行会乘上该大区的每一条投放行，两边的和同时被放大——数字看起来正常，错得很安静。这就是 fan-out。

正确做法是**先各自聚合，再组合**：

```sql
WITH n AS (SELECT <共享维度>, SUM(<GMV 表达式>) AS value FROM fact_order  ... GROUP BY <共享维度>),
     d AS (SELECT <共享维度>, SUM(<revenue 表达式>) AS value FROM fact_ad_daily ... GROUP BY <共享维度>)
SELECT n.dim_value, n.value / NULLIF(d.value, 0) AS value FROM n JOIN d ON n.dim_value = d.dim_value
```

## 2. 四件事，代码里各有对应的坚持

| 要求 | 实现 | 验收 |
| --- | --- | --- |
| 共享维度才可切 | `commonDimensions()` = 两侧 `groupedBy` 的交集；别的维度是 `RenderError` 并列出共享维度 | 「各渠道捕获率」→ `no-such-dimension`；强推渲染器 → `not-in-model` + `shared: …` |
| 期间过滤逐侧生效 | 每一侧用自己的日期列（`fact_order.order_date` / `fact_ad_daily.date_key`）生成半开区间 | SQL 里两处 `2025-11-01`；两侧合计分别等于手写 SQL |
| 不平白产生扇出 | 两侧先 `GROUP BY` 再 join；探针/验收比对"每切片行数"与"分子侧分组行数" | 4 个行、逐区与手写比值一致（<1e-9） |
| 比率不可加 | `additive: false`；`ask` 的 total 走"去掉维度"的同一渲染器，并在 limits 明说 | total = 全窗口比值（0.01347），切片之和是 0.0558 且被明确否认为 total |

## 3. 模型怎么得到它

文档里一句 `- **捕获率（capture_rate）**：… \`capture_rate = gmv / revenue\` …` 就够了：

1. 文档抽取器识别"内联公式"（公式里的名字可以是同义词/别名，不必和中文标签逐字相同）；
2. `derive.ts` 把公式两侧解析成**指标 id**，检查两侧有共同维度，然后写入
   `crossFact {numerator, denominator}`、`tables` 并集、`additive: false`；
3. 同时补出 `groupedBy` 边（只指向共享维度）——否则解释器、归因、探针都会看到一个"没有切片"的指标；
4. 指标进入 `needs_review`：**在被人采纳之前，问数面直接拒绝**（`unvalidated`，并指路审查接口）。

## 4. 域边界（scope）

同一份仓库里现在有两个域（投放、风控）。风控表进投放语义层只会制造噪音：`is_fraud` 会变成一个"维度"，
覆盖率被稀释，审查队列塞满没人要的候选。所以边界写在 `fixtures/demo/scope.json`：

```json
{ "excludeTables": ["risk_event", "feature_snapshot", "feature_registry", "risk_rule"], "reason": "…" }
```

pipeline 用它裁剪目录与候选（表、列、触及这些表的关系、以及**全部来源都被排除**的指标）。验收断言：模型回到
7 表/34 列/11 维度，且没有 `dim/is_fraud`；报告里写明排除了什么、为什么。

## 5. 实测（`npm run verify:m2x`，37 条断言）

- 指标：`metric/capture_rate`、`ratio`、`crossFact {gmv, revenue}`、`tables` 两张事实、`additive=false`、`needs_review`、
  两个 `groupedBy` 边（region/industry）。
- 数字：2025-11 各区 `gmv/revenue` 与手写 SQL 逐区一致（0.01436 / 0.01531 / 0.00707 / 0.01904）；
  分子侧合计 = GMV 97,400.71，分母侧合计 = 收入 7,228,696.63。
- 扇出：4 行（无重复）；分子侧按区求和 = 该区 GMV 总数。
- 审查门：采纳前拒绝（`unvalidated` 并指路 `POST /v1/semantic/review`），采纳后作答。
- 不可加：total = 0.013474（全窗口），切片和 0.0558 被显式排除；limits 有"各行不可加"。
- 切片限制：`各渠道` 拒绝并列共享维度；强推渲染器也拒绝。
- 归因：`attribute({metric:'capture_rate', mode:'drivers'})` → ratio 分解，两项之和 = 变动（−0.001287），残差 0，可下钻到 revenue。

## 6. 修掉的两个真 bug（都是"跨表"暴露出来的）

1. **期间维度被驱动复用**：跨事实根节点的时间轴取自分母侧（`dim/month` → `fact_ad_daily.date_key`），
   而驱动 `gmv` 在 `fact_order` 上，于是驱动查询里出现了一张它不读的表，报"不知道 fact_ad_daily 怎么 join fact_order"。
   修法：每个驱动用自己的月级维度（`monthDimOf`），下钻时同样。
2. **`monthWindow` 的正则被写坏**（`\d` 变成 `d`）：所有跨事实期间都变成 `>= '2025-10' AND < '2025-10'`，空窗口、
   total 为 null。直接打 SQL 才看见；修好后 delta 从 0 变成真实值。

## 7. 诚实的限制

- **只能按两侧都有的维度切**：时间层级是分事实的（`dim/month` 属于投放、`dim/fact_order_month` 属于订单），
  所以"按月看捕获率"目前是拒绝，而不是自动对齐口径。要做得更好需要"一个维度多张物理列"的绑定模型。
- **只支持两因子**：`A / B`。三张事实表或 `A + B` 的复合公式没做。
- **没有做时间对齐**（大促错位、口径截断）。
- **域边界是白名单式排除**：新增一个域不会自动隔离，得在 `scope.json` 里声明。
