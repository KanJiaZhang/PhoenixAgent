# 案例 1 的三个关键问题：PhoenixGraph 用在哪、SQL 怎么验、规则怎么验

> 对应 `npm run example:risk`（风控策略 Agent）。下面的数字全部来自一次真实运行（固定时间戳 2026-11-01），可复现。

| 问题 | 一句话答案 |
| --- | --- |
| 1. 如何利用 PhoenixGraph | **在本案例里没有直接用**——风控 Agent 的证据是关系表上的统计，不是图遍历。图在本仓库真正出场的是语义层发布（`verify:m2`）与基座工具调用（`verify:m5/m8`）。第 1 节给出事实清点、不用它的三个具体原因，以及"如果要接，怎么接"。 |
| 2. 如何执行和验证 SQL 是否正确 | 执行前过**只读守卫**；结果做**自洽校验**（混淆矩阵加总、PIT 计数）；关键一步是**跨实现复算**：把规则编译成 SQL 在数仓里跑一遍，与 Agent 内存评估的 TP/FP 对齐（28/24/4 vs 28/24/4）；整体由 `verify:m7` 的 48 条断言回归。 |
| 3. 如何验证规则有效 | 六层：时间外 holdout 的 P/R/覆盖/lift → 对存量规则的**增量** → manifest 门禁 → **分段稳定性**（大区/月）→ **阈值敏感性** → 上线后的巡检（案例 2）。未验证的四件事（因果、误杀成本、生产时点、覆盖率）在第 3 节明确列出。 |

---

## 1. PhoenixGraph 在本案例中的角色

### 1.1 事实清点（可核对）

| 环节 | 是否调用 PhoenixGraph | 证据 |
| --- | --- | --- |
| 路由（`router.ts`） | ❌ 纯函数 | 无 IO |
| 装载语义模型（`examples/lib.mjs → pipeline.build`） | ❌ 本地文件 + `indexModel()` | 产物在 `.pag/examples/risk/`，不进图 |
| 取数（5 条 SQL） | ❌ 直连演示数仓（SQLite 只读） | `result.evidence.sql` |
| 趋势 / 特征 / 规则合成 / 回测 | ❌ 纯内存计算 | `trend.ts` / `features.ts` / `rules.ts` |
| 审批 | ❌ 追加 JSONL | `.pag/examples/risk/risk/demo-analytics.approvals.jsonl` |
| 发布 | ❌ 本案例不发布 | — |

`grep GraphClient` 的结果也一致：引用它的只有 `packages/api/src/server.ts`（发布/问数）、`packages/semantic/src/{cli,publish}.ts`、以及
`verify:m2`（发布）、`verify:m5`（调基座 `attribute_change`）、`verify:p0`（调基座 `ask_data`）——**案例 1 的调用链上一次都没有**。

### 1.2 为什么这个案例不用图（三条具体理由，不是"还没做"）

1. **没有实体，就没有图。** `risk_event` 的列是 `event_id, event_date, region_id, channel_id, amount, is_fraud, label_date`；
   特征以 `event_id` 为键。没有 `account_id / device_id / ip`，也就没有"账户—设备—IP"这类边。
   在没有边的数据上建图，只能造出假节点——这比不用图更糟。
2. **规则验证不是图问题。** "这条规则在 holdout 上精确率多少、比存量多抓几个"是**混淆矩阵**问题：
   需要全量正负样本的计数，而图遍历擅长的是"这些实体怎么连起来"。用图去算精确率会绕远且更慢。
3. **图的写读约束。** 基座里可写的（Aerospike，keyed）不支持类型扫描；可扫描的（RocksDB-Edge）不能通过 REST 写入。
   所以语义模型发布是"键值副本 + 按 id 回读 + 分析型导出"两条腿（见 `docs/P1-NOTES.md` §2）——这条约束本身就说明：
   图适合**按实体 id 取子图**，不适合当规则验证的存储。

### 1.3 图在本仓库真正出场的地方

| 场景 | 用到什么 | 证据 |
| --- | --- | --- |
| 语义模型发布 | `POST /api/v1/schema`、`/graphs/{g}/batch`、按 id 点读回验 | `verify:m2`：72 节点 / 214 边 / 0 失败，连跑两次幂等 |
| 基座的问数与归因 | `POST /semantic/{g}/ask`、`/analysis/{g}/attribute` | `verify:m5`：基座复现 TPC-H 的 95,612,794.05 → 98,879,432.89，+3,266,638.84 |
| 工具目录 / MCP | `GET /api/v1/agent/tools`（14 个工具）、`GET /v1/tools`（本项目 24 条路由） | `verify:p0`（13+ 工具、绑定一致）、`verify:m8`（MCP 与 HTTP 目录一致） |

### 1.4 如果要把图接进风控，怎么接（最小三步 + 诚实代价）

**前提**：补上实体级数据（账户、设备、IP、收款方），一行一个事件关联到实体。没有这一步，下面全是空谈。

1. **把实体关系写成图**：`Account -[UsesDevice]-> Device`、`Device -[SharesIp]-> Ip`、`Account -[Pays]-> Payee`，
   顶点带 `firstSeen / lastSeen / riskLevel`。查询侧就能用基座已有的遍历：
   `g.V('acc-9').both('UsesDevice').both('SharesIp').dedup()` —— 这就是"同一个 IP 下还有哪些账户"。
2. **把图特征变成规则可用的列**：连通分量大小、2 跳邻居数、PageRank。
   基座有现成算法（`pagerank()` / 连通分量），产出写成 `feature_snapshot` 里的一行（`f_graph_component_size`），
   然后**走完全相同的流程**：PIT 校验（`as_of ≤ event_date`，图特征尤其要查，因为它常常是"事后快照"）→
   AUC/KS/IV → 规则合成 → holdout 回测。图不改变验证方式，只增加特征来源。
3. **用基座的 MCP/工具目录暴露它**：把 `risk.audit`、`graph.neighbors(account)` 注册成工具，
   让别的 agent（或人）通过 `/v1/tools` 调用——这与本项目的 API 和基座的 14 个工具是同一套做法。

**代价与收益（诚实）**：多一张实体图 + 一条图特征管道；收益是"团伙"类信号（单事件上看不出来的），
而这类信号的**验证仍然靠 holdout 的精确率/召回**——图不会替你证明规则有效。

---

## 2. 生成的 SQL 如何执行与验证

### 2.1 先说清楚：本案例的 SQL 是"读"，不是"生成"

案例 1 里 Agent 执行的是 5 条**固定检索语句**（事件、特征、注册表、趋势、存量规则），
生成物是**规则表达式**（`f_blacklist_hit = 1`）与它的阈值。这两类东西的验证方式不同：

| 对象 | 怎么产生 | 怎么验 |
| --- | --- | --- |
| 5 条检索 SQL | 代码里写死 | 只读守卫 + 结果自洽 + 行数与耗时进 `cost` |
| 规则表达式 | 阈值扫描 + 组合搜索 | 落成 SQL 做跨实现复算（见 2.3） |
| （对比）动态 SQL | 案例 3/4 的问数与归因由 `sql.ts` 渲染 | 等价改写逐行对比 + `EXPLAIN` + 手写 SQL 对账（见 2.4） |

### 2.2 四层验证

1. **执行前：只读守卫**（`packages/dataplane/src/guard.ts`）
   每条语句过 `assertReadOnly`：只允许 `SELECT / WITH / EXPLAIN / VALUES`；出现 `INSERT/UPDATE/DELETE/DROP/PRAGMA/ATTACH…` 即抛
   `ReadOnlyViolation`；多语句（`;` 分隔）直接拒。守卫基于**分词**而不是字符串匹配，所以 `'drop table'` 这种字面量不会误伤。
2. **执行后：结果自洽**
   混淆矩阵四项相加必须等于样本数（24 + 4 + 47 + 1,800 = **1,875**）；`TP` 与事件表里 `is_fraud=1` 的行数一致（71）；
   PIT 违规数必须等于事件数（15,188）——这几条在实例与 `verify:m7` 里都是断言。
3. **跨实现复算**（本案例最硬的一条，见 2.3）
4. **回归套件**：`npm run verify:m7` 的 48 条断言覆盖同一管线（趋势 z、特征 AUC/KS/IV/PSI、PIT 硬门、
   holdout P/R、增量、审批）；`npm run example:risk` 的 17 条断言覆盖端到端行为。两者都能重复跑。

### 2.3 跨实现复算：同一条规则，两条完全不同的执行路径

Agent 在内存里评估规则（`matchesAll`），我们再把同一条规则编译成 SQL 在数仓里跑一遍：

```sql
-- holdout 窗口 = 最近 3 个月（2025-10-01 起）
SELECT COUNT(*)                                        AS hits,
       SUM(CASE WHEN e.is_fraud = 1 THEN 1 ELSE 0 END) AS tp,
       SUM(CASE WHEN e.is_fraud = 0 THEN 1 ELSE 0 END) AS fp
FROM risk_event e
JOIN feature_snapshot s
  ON s.event_id = e.event_id AND s.feature_name = 'f_blacklist_hit'
WHERE e.event_date >= '2025-10-01'
  AND s.value = 1;
```

| 指标 | Agent 内存评估 | 数仓 SQL | 一致 |
| --- | --- | --- | --- |
| 命中 hits | 28 | **28** | ✅ |
| TP | 24 | **24** | ✅ |
| FP | 4 | **4** | ✅ |
| 正例总数 | 71 | **71** | ✅ |
| precision / recall | 0.8571 / 0.3380 | **0.8571 / 0.3380** | ✅ |

**为什么这才是"SQL 正确"的证据**：内存路径用的是 JS 的过滤函数与分箱，SQL 路径用的是 JOIN + 聚合；
两条路径共享的只有**数据**。如果阈值、布尔语义（`= 1` vs `>= 1`）、JOIN 条件或时间窗有任何一处不一致，
这两个 24 就会对上不了。

### 2.4 动态 SQL 的场景（案例 3/4）是怎么验的

案例 1 不生成分析 SQL，但本仓库的另外两个案例会（归因、跨事实指标）。那里的验证是：

- **等价改写逐行对比**：改写前后两条 SQL 都执行，比较排序后的行集合（`verify:m3`，30 条固定 SQL）；
- **计划证据**：`EXPLAIN QUERY PLAN` + 实测耗时，`SCAN` 是否变成 `SEARCH … USING INDEX`（`verify:m3`）；
- **手写 SQL 对账**：问数与跨事实比值的每一行都与手写查询比对（`verify:m2q` 40 条、`verify:m2x` 37 条）。

### 2.5 这套验证**没有**覆盖什么

- 只读守卫是**语法级**的：它保证不改数据，不保证语义正确（比如 `status='paid'` 是不是业务想的口径——那由语义层负责）；
- 复算只覆盖了 `inputs → 规则 → 计数` 这条链，不覆盖"特征在线上是否同样可得"（见 3.4）；
- 空结果、类型转换、时区：演示数据里不存在，真实环境需要单独用例；
- SQL 的**性能**不在案例 1 的范围内（5 条固定语句），性能证据在 `verify:m3` 与 `verify:m6`。

---

## 3. 生成的规则如何验证有效

### 3.1 六层验证，从强到弱

| 层 | 做法 | 本次结果 |
| --- | --- | --- |
| ① 时间外 holdout | 搜索只看 2025-10 之前的 13,313 个事件；判定只看之后 3 个月（1,875 事件 / 71 欺诈） | **P=0.8571、R=0.3380**、覆盖 1.49%、lift 22.6 |
| ② 对存量规则的增量 | 与 `R001`/`R002` 比较独占/共享/漏掉 | 独占 **6**、共享 18、漏掉 36、重叠 67.9%、**增量召回 8.45%** |
| ③ manifest 门禁 | `P≥0.75 且 R≥0.15`，被拒候选保留原因 | `R-NEW-09`：P=**1.000** 但 R=0.127 → 拒；`R-NEW-01`：P=0.458 → 拒 |
| ④ 分段稳定性 | 同一规则按大区、按月拆开看 P/R | 大区 P 0.50–1.00（R 0.14–0.41）；月 P 0.800–0.909（R 0.273–0.417） |
| ⑤ 阈值敏感性 | 数值规则看邻近阈值的 P/R 曲线 | `model_score_v1`：0.80→P 0.395/R 0.634；0.8895→0.458/0.380；0.96→0.706/0.169（单调、无悬崖） |
| ⑥ 上线后 | 案例 2 的巡检：新窗口上重算 P/R、重叠、容量、PSI 漂移 → keep/retune/retire | R002 在新窗口 P=0.147 且独占 73.5% 欺诈 → **retune**（不是下线） |

### 3.2 holdout 的混淆矩阵（可复核）

|  | 预测拦截 | 未拦截 |
| --- | --- | --- |
| 实际欺诈（71） | **TP 24** | FN 47 |
| 实际正常（1,804） | FP 4 | TN 1,800 |

`precision = 24/28 = 0.857`、`recall = 24/71 = 0.338`、`coverage = 28/1875 = 1.49%`、`lift = 0.857 / 0.0379 = 22.6`。

### 3.3 三条"不能只看一个数"的判断

1. **精确率 1.0 不等于好规则**：`R-NEW-09`（blacklist + 高分）P=1.0 只抓到 9/71 个欺诈（R=0.127 < 0.15）。
   门禁要的是一对可用的数，而不是单一指标好看。
2. **AUC 0.667 的特征也能产生首选规则**：`f_blacklist_hit` 的 AUC 不高，但"命中即拦"时精确率 0.857。
   **规则按规则自己的 P/R 排，不按特征强弱排。**
3. **增量优先于漂亮指标**：一条 P/R 好看但抓到的全是存量规则已覆盖的规则，对业务没有价值（这就是 ② 那一行）。

### 3.4 这套验证**没有**证明的（必须说清）

| 未证明的事 | 为什么 | 需要什么才能证明 |
| --- | --- | --- |
| **因果效果**（拦截后欺诈真的少了吗） | holdout 是时间外样本，不是实验；同期可能有外部变化 | 上线后做 holdout 对照 / 切换实验（案例 4 的 switchback 就是为这个设计的） |
| **误杀成本**（FP=4 值多少钱） | 只数了 4 个 FP，没有折算人工与客户体验成本 | 业务侧给每个 FP 定价，或按客群分层计成本 |
| **生产时点可得性** | 只校验了 `as_of_date ≤ event_date`；注册表里 `freshness_hours=12` 是元数据，**没有强制** | 在评分服务里加"特征延迟 ≤ 12h"的监控；缺失即降级 |
| **覆盖率** | 规则只命中 1.49% 的事件：它买的是精确率，不是召回 | 与召回型规则（如 `R002`）配合使用，不能替代 |
| **分布漂移** | 阈值是在历史分布上扫的；换季度/换大促会失效 | 定期巡检（案例 2）：PSI > 0.25 或精确率下降 → retune |

### 3.5 什么会推翻"这条规则有效"

- **删掉 `f_blacklist_hit`**：剩下的特征单用都到不了 P=0.75（`model_score_v1` 最高 P=0.706 且 R 只有 0.169）；
- **窗口换成无季节差异的两个月**：欺诈率接近基线，规则命中变少、召回掉到噪声里；
- **黑名单延迟**：`freshness_hours` 从 12h 变成 72h，命中集合会变，P/R 需要重算；
- **标签回填不全**：holdout 里有未确认的事件被当成负例，精确率会**虚高**（这是风控里最常见的一种自欺）。

---

## 4. 亲手复现

```bash
npm run demo:db            # 生成演示数仓（确定性种子）
npm run example:risk       # 案例 1：17 项自检
npm run verify:m7          # 风控管线的 48 条回归断言

# 规则 → SQL 的跨实现复算（与 2.3 节同一段 SQL，可粘进任意 SQLite 客户端）
sqlite3 -readonly fixtures/demo/data/demo.db "
SELECT COUNT(*) hits, SUM(e.is_fraud=1) tp, SUM(e.is_fraud=0) fp
FROM risk_event e
JOIN feature_snapshot s ON s.event_id = e.event_id AND s.feature_name = 'f_blacklist_hit'
WHERE e.event_date >= '2025-10-01' AND s.value = 1;"
# → 28 | 24 | 4
```

## 5. 一句话总结

本案例的"正确"由三件事保证，而不是由一个漂亮的数字：**只读**（守卫不让它改数据）、
**可复算**（同一条规则用 SQL 再算一遍，24 = 24）、**可拒绝**（P=1.0 但召回不足的规则被门禁拒掉，
没有规则达标时 Agent 会返回 `unvalidated` 而不是放宽门槛）。
