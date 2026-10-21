# 案例 2 / 3 / 4：PhoenixGraph 用在哪、SQL 怎么验、规则/方案怎么验

> 对案例 1 的回答见 **[CASE-1-VERIFICATION.md](CASE-1-VERIFICATION.md)**。本文把同样三个问题问给另外三个案例，
> 数字全部来自真实运行（固定时间戳），可复现。

| 问题 | 案例 2 巡检 | 案例 3 归因+投放 | 案例 4 止损 |
| --- | --- | --- | --- |
| **1. PhoenixGraph** | 未调用（读风控关系表） | 未调用（用本地语义模型渲染 SQL） | 未调用（多用了跨事实渲染器与审查日志） |
| **2. SQL 验证** | 3 条固定查询 + 只读守卫 + **独立复算**（12/3、774/114、共享 1） | 生成的 SQL：归因 + 4 维网格；验证 = **代数恒等式 + 手写 SQL 对账**（逐区 4/4 相等，ROI 两因子 6 位小数相等） | 跨事实两子查询；验证 = 手写 SQL 对账（捕获率 0.013474 一致）+ 利润恒等式 + 约束 |
| **3. 方案有效性** | 不生成规则，判定由数据支撑：P/命中、重叠、容量、PSI、下线代价 | 边际导数（解析 vs 数值）+ 约束 + 增益>噪声 + **曲线时间外精度** + 重拟合稳健性 | 利润恒等式（精确）+ 不超上限 + 只砍边际<1 + **switchback** 设计 |

---

## 1. PhoenixGraph 在这三个案例里的角色：同样没有直接调用

`grep GraphClient` 的结论与案例 1 一致——三个案例的调用链上一次都没有出现。原因不是"图不好用"，而是**数据里没有实体**：

| 案例 | 它读的东西 | 有没有实体 id | 图能帮上什么（如果补上实体） |
| --- | --- | --- | --- |
| 2 巡检 | `risk_rule`、`risk_event`、`feature_snapshot` | 无（事件级） | 规则**覆盖盲区**：哪些团伙（连通分量）绕过了全部规则 |
| 3 归因/投放 | `fact_ad_daily`（日/大区/行业/渠道）、`fact_order` | 无（聚合级） | **跨渠道人群重叠**：同一账户在多个渠道被重复计费（归因重叠的真问题） |
| 4 止损 | 同上 + `capture_rate`（跨事实） | 无 | 砍量后的**替代流量**：相似账户（`nearest`）能否补回被砍掉的曝光 |

图真正出场的地方仍然是：语义模型发布（`verify:m2`）、基座问数/归因工具（`verify:m5/m8`）、工具目录与 MCP。

**接入的最小路径**（三个案例通用）：给事实表加 `account_id / device_id` → 写成
`Account-[UsesDevice]->Device`、`Device-[SharesIp]->Ip` → 用基座遍历产出**图特征**（连通分量大小、2 跳邻居数、PageRank）→
写进 `feature_snapshot`（`as_of ≤ event_date` 的 PIT 校验照旧）→ 走同一套 AUC/规则/holdout 验证。
**图只增加特征来源，不改变验证方式。**

---

## 2. SQL 如何执行与验证

三个案例都有 SQL，但"生成"的程度不同：

| 案例 | 生成了什么 SQL | 怎么执行 |
| --- | --- | --- |
| 2 巡检 | 3 条固定查询（规则表、事件、特征） | 每条过 `assertReadOnly` → 只读连接执行 |
| 3 归因+投放 | **动态**：归因渲染器（按维度/期间）+ 投放网格（4 维 GROUP BY，2 条） | 同上；语句记入 `evidence.sql` |
| 4 止损 | **动态**：跨事实比值（两个先聚合的子查询）+ 归因 + 网格 | 同上 |

### 2.1 案例 2：独立复算三张表

巡检给出的每个数都能用一段 SQL 重算（窗口 2025-07 ~ 2025-12，3,757 事件 / 155 欺诈）：

```sql
SELECT SUM(CASE WHEN e.amount >= 5000 AND n.value = 1 THEN 1 ELSE 0 END)               AS r001_hits,
       SUM(CASE WHEN e.amount >= 5000 AND n.value = 1 AND e.is_fraud = 1 THEN 1 ELSE 0 END) AS r001_tp,
       SUM(CASE WHEN l.value >= 3 THEN 1 ELSE 0 END)                                   AS r002_hits,
       SUM(CASE WHEN l.value >= 3 AND e.is_fraud = 1 THEN 1 ELSE 0 END)                AS r002_tp,
       SUM(CASE WHEN e.amount >= 5000 AND n.value = 1 AND l.value >= 3 THEN 1 ELSE 0 END) AS shared,
       SUM(e.is_fraud) AS positives
FROM risk_event e
JOIN feature_snapshot n ON n.event_id = e.event_id AND n.feature_name = 'f_new_device_flag'
JOIN feature_snapshot l ON l.event_id = e.event_id AND l.feature_name = 'f_login_fail_7d'
WHERE e.event_date >= '2025-07-01';
```

| 指标 | Agent 巡检 | 独立 SQL | 一致 |
| --- | --- | --- | --- |
| R001 命中 / TP | 12 / 3 | **12 / 3** | ✅ |
| R001 精确率 | 0.25 | **0.25** | ✅ |
| R002 命中 / TP | 774 / 114 | **774 / 114** | ✅ |
| R002 精确率 / 召回 | 0.1473 / 0.7355 | **0.1473 / 0.7355** | ✅ |
| 两条规则共享命中 | 「0%」 | **1 次（Jaccard 0.0013）** | ⚠️ 见下 |

> **一处必须说清的展示误差**：巡检报告里 R001 与 R002 重叠显示「0%」，那是把 `0.0013` 按整数百分比打印的结果；
> 独立 SQL 显示它们其实共享 **1 次命中**（Jaccard 0.13%）。数字本身没错，但"0%"会让人以为完全不相交——
> 这正是"展示层要保留精度"的例子，文档里按 0.13% 记录。

### 2.2 案例 3：代数恒等式 + 手写 SQL 双轨

**归因切片**（按大区，2025-10 → 2025-11 花费变化）——Agent 的值与手写 SQL 逐区相等：

| 大区 | 手写 SQL Δ | Agent 切片 Δ | 一致 |
| --- | --- | --- | --- |
| 华东 | 694,489.38 | 694,489.38 | ✅ |
| 华北 | 604,002.60 | 604,002.60 | ✅ |
| 华南 | 925,649.68 | 925,649.68 | ✅ |
| 西南 | 419,162.47 | 419,162.47 | ✅ |

**比率两因子**（ROI 2.0347 → 1.4727）——SQL 里按定义直接算，与 Agent 的分解到 6 位小数一致：

```sql
-- 分子效应 = (rev1 - rev0) / spend1；分母效应 = rev0 * (1/spend1 - 1/spend0)
SELECT (SUM(CASE WHEN date_key >= '2025-11-01' AND date_key < '2025-12-01' THEN revenue ELSE 0 END)
      - SUM(CASE WHEN date_key >= '2025-10-01' AND date_key < '2025-11-01' THEN revenue ELSE 0 END))
       / NULLIF(SUM(CASE WHEN date_key >= '2025-11-01' AND date_key < '2025-12-01' THEN spend ELSE 0 END), 0) AS numerator_effect,
       SUM(CASE WHEN date_key >= '2025-10-01' AND date_key < '2025-11-01' THEN revenue ELSE 0 END)
       * (1.0 / NULLIF(SUM(CASE WHEN date_key >= '2025-11-01' AND date_key < '2025-12-01' THEN spend ELSE 0 END), 0)
        - 1.0 / NULLIF(SUM(CASE WHEN date_key >= '2025-10-01' AND date_key < '2025-11-01' THEN spend ELSE 0 END), 0)) AS denominator_effect
FROM fact_ad_daily WHERE date_key >= '2025-10-01' AND date_key < '2025-12-01';
```

| 项 | SQL | Agent | 一致 |
| --- | --- | --- | --- |
| 分子（收入）效应 | 0.533793 | 0.533793 | ✅ |
| 分母（花费）效应 | −1.095764 | −1.095764 | ✅ |
| 两项之和 | −0.561971 | Δ = −0.561971 | ✅（残差 0） |

**投放网格**：2 条 `GROUP BY period, region, industry, channel` 的语句（一条算花费、一条算收入），
一条语句返回全部 36 个 cell × 24 期。正确性由三件事保证：网格粒度（每 cell 每期一行，无重复）、
预算守恒（`Σ proposed = budget`，误差 <1e-3 元）、以及 `verify:m6` 的 48 条断言（含"每 cell 变动 ≤ ±50%"）。

### 2.3 案例 4：跨事实 SQL 的两个子查询

止损案例的关键 SQL 是"两侧先聚合再组合"：

```sql
SELECT n.dim_value AS dim_value, n.value / NULLIF(d.value, 0) AS value
FROM (SELECT "dim_region"."region_name" AS dim_value,
             SUM(fact_order.amount - fact_order.refund_amount) AS value
      FROM fact_order JOIN dim_region ON fact_order.region_id = dim_region.region_id
      WHERE (fact_order.status = 'paid')
        AND ("fact_order"."order_date" >= '2025-11-01' AND "fact_order"."order_date" < '2025-12-01')
      GROUP BY 1) n
JOIN (SELECT "dim_region"."region_name" AS dim_value, SUM(fact_ad_daily.revenue) AS value
      FROM fact_ad_daily JOIN dim_region ON fact_ad_daily.region_id = dim_region.region_id
      WHERE ("fact_ad_daily"."date_key" >= '2025-11-01' AND "fact_ad_daily"."date_key" < '2025-12-01')
      GROUP BY 1) d ON n.dim_value = d.dim_value
ORDER BY n.dim_value;
```

| 检查 | 手写 SQL | Agent | 一致 |
| --- | --- | --- | --- |
| 全窗口捕获率（2025-11） | 0.013474 | 0.013474 | ✅ |
| 分区捕获率（4 行） | 华东 0.01436 / 华北 0.01531 / 华南 0.00707 / 西南 0.01904 | 同左 | ✅（`verify:m2x` 逐区比对） |
| 两侧期间过滤 | 各自用自己的日期列 | SQL 里两处 `2025-11-01` | ✅ |
| 扇出 | — | 4 行（每区一行，无重复） | ✅ |

### 2.4 三个案例共同的 SQL 纪律

- 每条语句执行前过 `assertReadOnly`（分词级：只允许 `SELECT/WITH/EXPLAIN/VALUES`，禁写/PRAGMA/ATTACH，拒多语句）；
- 执行过的语句全部记在 `result.evidence.sql`（案例 3：网格 2 条 + 归因若干；案例 4：多一条跨事实）；
- 案例 3/4 的**动态 SQL** 另有专项回归：`verify:m5`（45 条）、`verify:m6`（48 条）、`verify:m2x`（37 条）、`verify:m2q`（40 条）。

**没有验证的**：SQL 的语义是否符合业务口径（归语义层与审查）、空/类型/时区边界、以及跨方言的可移植性（演示只跑 SQLite）。

---

## 3. 规则 / 方案如何验证有效

三个案例的"产物"性质不同，验证强度也不同：

| 案例 | 产物 | 验证手段 |
| --- | --- | --- |
| 2 巡检 | 对**存量规则**的判定（keep/retune/retire） | 判定阈值 + 数据复算 + 改动守护 |
| 3 归因+投放 | 归因结论 + **预算再分配方案** | 数学恒等式 + 约束 + 曲线时间外精度 + 重拟合稳健性 + holdout |
| 4 止损 | **砍预算方案** + 验证设计 | 利润恒等式 + 上限/未花 + 只砍边际<1 + switchback |

### 3.1 案例 2：判定怎么验

| 判定 | 依据 | 怎么验 |
| --- | --- | --- |
| R001 `retire` | 精确率 0.25 < 门槛 0.5；独占 3 个欺诈；每天 0.07 次拦截 | 独立 SQL 复算 12 命中 / 3 TP ✅；下线代价用存活规则的并集重算 → 剩余召回 73.55%，**只少抓 3 个** |
| R002 `retune` | 精确率 0.147 < 0.5，但独占 114 个（73.5% 召回主力） | 独立 SQL 复算 774/114 ✅；阈值扫描收到最紧 `f_login_fail_7d >= 5` 仍只有 P=0.311 → 输出"阈值无解" |
| 不自动下线 | — | 巡检前后 `risk_rule.status` 都是 `active`（断言） |

**诚实缺口**：判定阈值（0.5 精确率、0.25 PSI）是业务参数；标签只来自一个窗口；容量只算命中次数，不含人工审核成本。

### 3.2 案例 3：投放方案怎么验

1. **边际导数的正确性**（`verify:m6`）：解析导数 vs 中心差分，在 3 个花费水平 × 2 个模型上逐点比对（相对误差 <1e-3）。
   这一条抓过一次真实事故——饱和模型的边际被少乘一个 K，导致"每个 cell 的下一元都不赚钱"，推荐方向完全相反。
2. **约束**：预算守恒（<1e-3 元）、每 cell ±50%、份额 0.5%–35%，`verify:m6` 断言。
3. **增益高于噪声**：本例 +902.5k vs 曲线噪声 62.7k；门槛是 `minGainOverNoise=1`（manifest）。
4. **曲线的时间外精度**（本次新增实测）：只用 2025-06 之前 18 期拟合，预测之后 6 期的实际花费下收入——
   **216 个 cell-期，相对误差中位数 6.4%，p90 13.2%，78.7% 落在 ±10% 内**。
   这回答的是"曲线是不是过拟合"。
5. **重拟合稳健性**：用 train-only 曲线重新分配 2025-07 的预算，模型仍预计 **+15.1%**（全量曲线是 +15.56%），
   说明增益不是靠最后几个月"记住"的。
6. **可反驳性**：holdout 设计（geoholdout 4 周、处理/对照/样本量）随方案给出；真实因果结论只能由它产生。

**诚实缺口**：第 4/5 条验证的是"曲线的预测能力"，不是"再分配的因果效果"；方案增益仍是模型外推。
另外，响应曲线假设"花费是唯一变量"——素材、竞价、竞品都会让它失效。

### 3.3 案例 4：止损方案怎么验

1. **利润恒等式（精确）**：`profitΔ = revenueΔ − spendΔ` →
   `787,425.30 = (−475,718.48) − (−1,263,143.78)` ✅（误差 <1e-3，实例断言）。
2. **上限与未花**：预算上限 2,895,163；提议花费 2,142,930.28；**留出 752,232.72 不花**（断言 `spend ≤ cap` 且 `unspent > 0`）。
3. **只砍边际回报 <1 的 cell**：被砍的三条边际 ROI 0.275 / 0.300 / 0.252（断言全 <1）。
4. **实验设计随方案**：`switchback`（同批 cell 按周交替），对照组是"不执行调整的那一半周"——因为地区对照会把需求差异混进来。
5. **曲线精度**：与案例 3 同一套曲线，时间外误差中位数 6.4% 同样适用。

**诚实缺口**：止损方案没有反事实数据——"砍掉的花费会不会带来本可以拿到的收入"只能由 switchback 实验回答；
方案里的 −475.7k 收入是**模型预计**，不是既成事实。

---

## 4. 一张表看清"什么会推翻它"

| 案例 | 最脆弱的一环 | 推翻方式 |
| --- | --- | --- |
| 2 巡检 | 判定阈值 + 单窗口标签 | 把 `minPrecision` 调到 0.1（R002 变 keep）；holdout 缩到 1 个月（样本不足，区间比结论宽） |
| 3 归因+投放 | 响应曲线的外推 | 数据无饱和（曲线判 `linear`，边际≈平均 → 任何再分配都不产生增益，Agent 拒绝）；`maxChangePct=0`（无法移动） |
| 4 止损 | 砍量的因果效果 | 把目标改回 `revenue`（Agent 拒绝：收入下降无法证明有利）；`budgetIsCap=false`（预算必须花满，止损无从表达） |

---

## 5. 复现

```bash
npm run example:audit       # 案例 2：12 项自检
npm run example:growth      # 案例 3：23 项自检
npm run example:stoploss    # 案例 4：21 项自检
npm run verify:m7           # 风控管线回归（48 条）
npm run verify:m6           # 投放：边际导数 + 约束 + 证据（48 条）
npm run verify:m5           # 归因：恒等式 + 残差 + 确定性（45 条）
npm run verify:m2x          # 跨事实：逐区手写 SQL 对账（37 条）
```
