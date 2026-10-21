# 案例 1 逐步执行详解：风控策略 Agent

这份文档把 `npm run example:risk` **拆到每一步**，说明 PhoenixAgent 在那一刻做了什么：调了哪个模块、跑了哪条 SQL、
算出了什么、门禁在哪一步拦住什么、产物落在哪里。所有数字来自一次真实运行（演示数仓，2026-11-01 的固定时间戳），
可以按最后一节复现。

---

## 0. 输入与声明

| 项 | 值 |
| --- | --- |
| 声明 | `agents/risk-strategy.agent.json`（门禁与预算从这里读） |
| 问题 | 「最近欺诈趋势如何？哪些特征真的有效？给我一条可以上线的规则，并告诉我它在离线上能抓多少。」 |
| 门禁 | `holdoutMonths=3`、`minZ=4`、`minPrecision=0.75`、`minRecall=0.15`、`maxConditions=3`、`requireApproval=true`、`ruleNeverAutoPublishes=true` |
| 预算 | `maxQueries=40`、`maxMs=60000` |
| 数据 | `risk_event` 15,188 事件 / 449 欺诈（2.96%）/ 2024-01-01 ~ 2025-12-28；`feature_snapshot` 136,692 行（9 特征）；`feature_registry` 9 行；`risk_rule` 2 条 active |
| 时间戳 | 全部产物使用固定 `now=2026-11-01T00:00:00.000Z`，因此两次运行逐字节一致 |

---

## 步骤 1 — 路由：这句话该交给谁

**模块**：`packages/core/src/router.ts` → `route(question)`（纯函数，无 IO、无模型）

**Agent 看到的结构**（`signature`）：

```json
{ "type": "detective", "metrics": [], "dimensions": [],
  "asksWhy": false, "asksWhatToDo": false, "asksRule": true,
  "entityShape": "unknown", "confidence": 0.78,
  "evidence": ["欺诈/风控", "规则", "特征", "多少"] }
```

**打分**（同一次调用的 `scores`）：`risk=7`、`ask=2`，其余 0 → `agent=risk`，`confidence=1`。

**它为什么这样判断**：

1. `asksRule = /规则|策略|阈值|特征/ && /欺诈|风控|风险|团伙|套现|薅羊毛/` → 两者都命中 → `type=detective`；
2. 一旦是 `detective`，`eligible()` 只放行 `risk` 与 `semantic`——`ask` 的 2 分（"多少"）**被结构性排除**，
   不会因为"多少"而把风控问题当成普通问数；
3. `signature.confidence=0.78` 表示"识别到了多少词"，`confidence=1` 表示"在候选 agent 里有多确定"，
   两个数不是一回事，产物里都保留。

**这一步不做什么**：不读数据库、不调 LLM、不猜指标。它只决定"进哪个 agent"，其余交给下游。

---

## 步骤 2 — 装载：语义模型 + 域边界

**模块**：`examples/lib.mjs` → `loadModel()` → `pipeline.build()`（首次）/ `indexModel()`

- 语义模型：**7 表 / 34 列 / 11 维度 / 17 指标**（其中 `metric/capture_rate` 待审）。
- 域边界：`fixtures/demo/scope.json` 排除 `risk_event / feature_snapshot / feature_registry / risk_rule`，
  报告里写明"排除什么、为什么"——否则 `is_fraud` 会变成投放域的"维度"，覆盖率也会被稀释。
- **诚实说明一处关系**：风控 Agent 不用语义层里的指标口径，它读的是**自己的治理元数据**
  （特征注册表 + 标签 + 规则表）。语义模型在这个案例里提供两件事：域边界（哪些表属于本域）与
  "模型版本/审查状态"的展示。真正的数据契约是 `feature_registry.available_before_event` 与 `label_date`。

---

## 步骤 3 — 取数：5 条 SQL，之后全在内存里算

**模块**：`packages/agents/risk/src/agent.ts` → `riskAgent()`，所有 SQL 记在 `result.evidence.sql`

| # | SQL | 返回行数 | 用时 |
| --- | --- | --- | --- |
| 0 | `SELECT event_id, event_date, region_id, channel_id, amount, is_fraud FROM risk_event ORDER BY event_date, event_id` | 15,188 | 58 ms |
| 1 | `SELECT event_id, feature_name, value, as_of_date FROM feature_snapshot` | 136,692 | 467 ms |
| 2 | `SELECT feature_name, owner, freshness_hours, available_before_event FROM feature_registry` | 9 | 0.3 ms |
| 3 | `SELECT region_id, substr(event_date,1,7) AS period, COUNT(*) AS events, SUM(is_fraud) AS frauds FROM risk_event GROUP BY 1,2 ORDER BY 1,2` | 96 | 7.6 ms |
| 4 | `SELECT rule_id, expression FROM risk_rule WHERE status = 'active'` | 2 | 0.3 ms |

**总计**：`cost = {queries: 5, events: 15188, features: 9, ms: 825}`。

设计取舍：特征表一次全读（13 万行、约 0.5 s），后续的 PIT 校验、AUC/KS/IV/PSI、规则扫描都在内存里做。
换成"每个特征一条聚合 SQL"会让查询数变成 9+ 且无法做阈值扫描——这是**用一次宽读换掉几十次窄读**。

---

## 步骤 4 — 趋势：不是"看起来涨了"

**模块**：`packages/agents/risk/src/trend.ts` → `analyseTrend()`（每区一次，4 区 + 整体，共 1.4 ms）

对每个大区取**月度**序列（24 期），然后：

1. **拐点**：对每个候选切分点（`minSegment=6`，即切在 2025-07 ~ 2025-12 前后）做两比例 z 检验，取 |z| 最大者；
2. **尖峰**：滚动 6 期基线 + 二项标准误的 z（`minZ=3`）；
3. **门槛**：`|z| ≥ 4` 且倍数 `≥ 1.4` 才算拐点（`minZ` 来自 manifest）。

**实测**（只有这一区有拐点）：

| 区域 | 拐点 | 之前 | 之后 | z | 倍数 |
| --- | --- | --- | --- | --- | --- |
| 大区 3 | **2025-07** | 2,854 事件 / 72 欺诈 = **2.52%** | 934 事件 / 63 欺诈 = **6.75%** | **6.042** | **2.67** |
| 大区 1 / 2 / 4 | 无 | — | — | — | — |
| 整体 | 2025-07（被大区 3 抬起来） | — | — | — | — |

z 的算术（可复核）：合并率 = 135/3,788 = 3.564%，标准误 = √(0.03564×0.96436×(1/2854+1/934)) = 0.699%，
z = (6.745% − 2.523%) / 0.699% = **6.04**。

**两个刻意的选择**：

- **月度而不是季度**：8 个季度里要保证两侧各 4 个季度，切分点只能试中间那一个，离末尾两季的变化永远看不见；
  月度 24 期可以试 6..18，注入的 2025-07 才落在可测范围内。
- **尖峰检测在这个案例里报 0**：阶跃之后滚动基线会跟着爬升，z 自然回落。尖峰检测回答的是"稳定期里的异常月"，
  阶跃由拐点检测负责——两者不互相替代（验收里用构造序列单独测尖峰：注入单月尖峰被唯一命中）。

---

## 步骤 5 — 特征：先问"合法的吗"，再问"有效吗"

**模块**：`packages/agents/risk/src/features.ts` → `evaluateFeature()`（9 个特征，12–63 ms/个，合计约 269 ms）

**PIT 硬门（第一步，挡在最前面）**：任一 `snapshot.as_of_date > event.date` 即判 `usable=false`。

| 特征 | AUC | KS | IV | PSI | 单调性 | 可用 |
| --- | --- | --- | --- | --- | --- | --- |
| model_score_v1 | **0.9435** | 0.7668 | 3.9589 | 0.0382 | 递增 | ✅ |
| f_chargeback_30d | 0.9355 | 0.8710 | 4.0266 | 0.0106 | 非单调 | ❌ **15,188/15,188 条快照晚于事件（未来函数）** |
| f_login_fail_7d | 0.8550 | 0.5649 | 2.1160 | 0.0245 | 递增 | ✅ |
| f_new_device_flag | 0.6912 | 0.4432 | 0.6778 | 0.0129 | 递增 | ✅ |
| f_amount_7d | 0.6923 | 0.2976 | 0.4884 | 0.0178 | 非单调（仅警告） | ✅ |
| f_blacklist_hit | 0.6667 | 0.6637 | 0.6775 | 0.0000 | 递增 | ✅ |
| f_night_txn_ratio | 0.5826 | 0.1259 | 0.0909 | 0.0185 | 非单调 | ✅ |
| f_device_shared_cnt | 0.5571 | 0.3697 | 0.0927 | 0.0056 | 非单调 | ✅ |
| f_account_age_days | 0.3416 | 0.2325 | 0.3256 | 0.0600 | 递减 | ✅（方向取反） |

**为什么把 AUC 0.9355 的未来函数拒掉**：`f_chargeback_30d` 是事件后 30 天才算出来的，
它在离线指标上几乎等于标签（分箱最高两箱欺诈率 26.9% / 37.5%）。如果放它进模型，holdout 会漂亮得不像话，
上线后这个特征根本拿不到。**规则合成的候选集里没有它，不是因为它弱，而是因为它不合法。**

**分箱看得见的单调性**（model_score_v1 的 11 个分位箱，欺诈率）：
`0.07% → 0.00% → 0.13% → 0.07% → 0.20% → 0.00% → 0.66% → 1.12% → 3.89% → 23.1% → 62.5%`。

**单调性用 Spearman 秩相关**（ρ≥0.7 视为有方向）；非单调只记警告、不阻断——非单调特征仍可作为区间条件，
规则自己的精确率会说明它值不值得用。

---

## 步骤 6 — 规则合成：15 条候选，8 条回传

**模块**：`packages/agents/risk/src/rules.ts` → `synthesizeRules()`（约 295 ms）

- **切分**：最近 3 个月为 holdout（`2025-10` 起，1,875 事件 / 71 欺诈），其余为 train（13,313 事件）。
  搜索只看 train，判定只看 holdout。
- **阈值**：每个特征按分位点 0.5/0.7/0.8/0.85/0.9/0.93/0.95/0.97/0.99 扫，方向由 AUC 决定（≥0.5 取高值侧）；
  布尔特征输出 `= 1` 而不是 `>= 1`（分析员要读这条规则）。
- **组合**：前 4 个特征两两组合，再在最优组合上加第三个条件；条件数上限 3。

**Agent 回传的 8 条**（`synthesizeRules` 返回 15 条，按"状态 → holdout F0.5"排序后取前 8）：

| 规则 | 表达式 | 条件 | train P / R | holdout P / R | 覆盖 | lift | TP/FP | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R-NEW-05 | `f_blacklist_hit = 1` | 1 | 0.765 / 0.336 | **0.857 / 0.338** | 1.49% | 22.6 | 24 / 4 | ✅ candidate |
| R-NEW-11 | `f_blacklist_hit = 1 AND f_new_device_flag = 1` | 2 | 0.938 / 0.159 | **0.923 / 0.169** | 0.69% | 24.4 | 12 / 1 | ✅ candidate |
| R-NEW-01 | `model_score_v1 >= 0.8895` | 1 | 0.444 / 0.471 | 0.458 / 0.380 | 3.15% | 12.1 | 27 / 32 | ❌ P<0.75 |
| R-NEW-09 | `f_blacklist_hit = 1 AND model_score_v1 >= 0.8895` | 2 | 0.983 / 0.153 | **1.000** / 0.127 | 0.48% | 26.4 | 9 / 0 | ❌ R<0.15 |
| R-NEW-13 | `model_score_v1 >= 0.8895 AND f_new_device_flag = 1` | 2 | 0.484 / 0.310 | 0.421 / 0.225 | 2.03% | 11.1 | 16 / 22 | ❌ P<0.75 |
| R-NEW-12 | `model_score_v1 >= 0.8895 AND f_login_fail_7d >= 5` | 2 | 0.614 / 0.164 | 0.583 / 0.099 | 0.64% | 15.4 | 7 / 5 | ❌ P<0.75、R<0.15 |
| R-NEW-99 | `f_blacklist_hit = 1 AND f_new_device_flag = 1 AND model_score_v1 >= 0.8895` | 3 | 1.000 / 0.085 | **1.000** / 0.056 | 0.21% | 26.4 | 4 / 0 | ❌ R<0.15 |
| R-NEW-02 | `f_login_fail_7d >= 5` | 1 | 0.322 / 0.233 | 0.256 / 0.141 | 2.08% | 6.8 | 10 / 29 | ❌ P<0.75、R<0.15 |

**两个值得展开的判断**：

1. **`R-NEW-09` 精确率 100% 却被拒**：它只抓到 9/71 个欺诈（召回 0.1268 < 0.15）。
   精确率 1.0 而召回 5.6% 的规则是一张"只抓最明显那几个"的网，门禁要求的是一对可用的数字，不是单一指标好看。
2. **首选是 `f_blacklist_hit = 1`**（AUC 只有 0.6667）：因为把阈值放在"命中即拦"时它**精确率 0.857**，
   而模型分数要买到同样的精确率只能牺牲召回。**规则不是按特征强弱排的，是按规则自己的 P/R 排的。**

---

## 步骤 7 — 回测与增量：这条规则比现有的多做什么

**模块**：`rules.ts → backtest()` 与 `incrementOf()`（1.6 ms）

- 混淆矩阵（holdout 1,875 事件 / 71 欺诈）：**TP 24 / FP 4 / FN 47 / TN 1,800**，
  precision 24/28 = **0.8571**、recall 24/71 = **0.3380**、coverage 28/1875 = **1.49%**、
  lift = 0.8571 / (71/1875) = **22.6**。
- 与存量规则（`R001` = `amount>=5000 AND f_new_device_flag=1`，`R002` = `f_login_fail_7d>=3`）相比：

| 指标 | 值 |
| --- | --- |
| 新增独占抓到（其他规则都没抓到） | **6** 个欺诈 |
| 与其他规则共享 | 18 个 |
| 其他规则抓到而它漏掉 | 36 个 |
| 命中重叠率 | **67.9%** |
| 增量召回（6/71） | **8.45%** |

**这一步的意义**：一条规则即使自己的 P/R 好看，如果抓到的全是存量规则已经抓到的，它对业务没有增量。
增量召回 8.45% 才是"上线它能多抓多少"。

---

## 步骤 8 — 审批：Agent 到此为止

**模块**：`packages/agents/risk/src/agent.ts → RiskApprovals`（只读日志）+ 实例里的 `decide()`（写日志）

1. 第一次运行：`result.published = []`——**Agent 自己绝不发布**（代码层面：`riskAgent` 只读审批日志，
   只有 `RiskApprovals.decide()` 会写）。
2. 审批人写入一行 JSONL（`.pag/examples/risk/risk/demo-analytics.approvals.jsonl`）：

```json
{"ts":"2026-11-01T00:00:00.000Z","actor":"risk-lead@demo","ruleId":"R-NEW-05",
 "decision":"approve","expression":"f_blacklist_hit = 1",
 "note":"holdout P=0.8571 R=0.338，增量 +6，同意上线"}
```

3. 重新运行：`published = [{ id: "R-NEW-05", approvedBy: "risk-lead@demo", approvedAt: "2026-11-01T00:00:00.000Z",
   holdoutPrecision: 0.8571, holdoutRecall: 0.338 }]`。
4. 没有署名的审批会直接抛错（`an approval needs an actor: the log is the audit trail`）。

---

## 步骤 9 — 经验沉淀：3 条 tip，带产生它的数字

**模块**：`packages/skills/src/harvest.ts → harvestFromRisk()` + `types.ts → SkillStore`

| tip | 内容（截断） | 证据指标 |
| --- | --- | --- |
| `tip/risk/any/feature-effectiveness/…/risk+model_score_v1` | `model_score_v1 是目前最有效的风控特征（AUC 0.9435、KS 0.7668、IV 3.9589…` | `{auc:0.9435, ks:0.7668, iv:3.9589, positives:449}` |
| `tip/risk/any/point-in-time/…/risk+feature+as_of` | `f_chargeback_30d 的快照日期晚于事件日期，是未来函数…` | `{rejectedFeatures:1, violations:15188}` |
| `tip/risk/any/rule-backtest/…/risk+rule+f_blacklist_hit` | `规则「f_blacklist_hit = 1」在 holdout 上精确率 0.8571、召回率 0.338…` | `{precision:0.8571, recall:0.338, incrementalRecall:0.0845, newOnlyPositives:6}` |

随后用 `advise(store, "risk feature model_score_v1 rule")` 检索，命中第一条（分数 0.288 = 置信度 0.8 × 命中率 1.0 ×
候选态权重 0.6 × 关键词匹配权重 0.6）。

---

## 步骤 10 — 产物

`.pag/examples/risk/artifacts/`：

| 文件 | 大小 | 内容 |
| --- | --- | --- |
| `trend.json` | 7.3 KB | 有拐点/尖峰的序列（大区 3 + 整体） |
| `features.json` | 16.8 KB | 9 个特征的完整报告（含分箱、PIT、警告） |
| `rules.json` | 9.3 KB | 回传的 8 条规则（含 train/holdout 指标与拒绝原因） |
| `approval.json` | 221 B | 审批日志行 |
| `skills.json` | 1.6 KB | 3 条 tip 及其证据 |

---

## 每一步"如果……会怎样"（会被看到的失败，而不是静默的错误）

| 步骤 | 触发条件 | 你会看到 |
| --- | --- | --- |
| 1 路由 | 问题同时像"问数"和"风控"且分差 <25% | `agent=null` + `clarification`（要求澄清，不硬选） |
| 3 取数 | 事件 <100 或正例 <30 | `refusal: unvalidated`，并提示"扩大窗口或降低标签门槛" |
| 4 趋势 | `z < minZ` 或倍数 <1.4 | 该区 `changePoint=null`，叙述写"没有拐点超过检测门槛" |
| 5 特征 | 任一 `as_of_date > event_date` | 该特征 `usable=false`，理由写明"future function"，且**不进规则候选** |
| 5 特征 | 正例 <20 或特征恒定 | 该特征 `usable=false`，理由列出 |
| 6 规则 | 候选全部不达 holdout 门 | `refusal: unvalidated` + 当前门禁数值 + 建议（补标签或与业务确认降门槛） |
| 6 规则 | 条件数 >3 | 该候选直接不进（`maxConditions` 来自 manifest） |
| 7 回测 | 增量 0（全是存量规则已覆盖） | 该规则仍可能通过 P/R 门，但报告里"新增 0 个"，实例断言"有增量"会失败 |
| 8 审批 | 没有审批行 | `published=0`，实例断言"批准后只有一条"会失败 |
| 全流程 | 查询数 > `maxQueries` 或超时 | `refusal: budget`（不返回半棵树/半个报告） |

---

## 成本与性能

| 项 | 值 |
| --- | --- |
| SQL 条数 | **5**（事件、特征、注册表、趋势、存量规则） |
| 行数 | 15,188 事件 + 136,692 特征行 |
| `riskAgent()` 总耗时 | **825 ms**（取数 ~534 ms；趋势 1.4 ms；特征 ~269 ms；规则 295 ms；增量 1.6 ms） |
| 峰值内存 | 特征表全量驻留（约 13 万行 × 4 列），为阈值扫描服务 |
| 确定性 | 固定时间戳 + 固定种子 → 两次运行 SQL 序列、规则、指标逐字节一致 |

---

## 复现

```bash
npm run demo:db          # 生成演示数仓（确定性种子）
npm run example:risk     # 跑本案例，17 项自检
cat .pag/examples/risk/artifacts/rules.json | head -40
cat .pag/examples/risk/risk/demo-analytics.approvals.jsonl   # 审批日志（追加式）
```

## 边界（这一步之外的事）

- 审批是**单签**（接口支持多条日志，流程未强制双签）。
- 演示数据的信噪比是设计的：`f_blacklist_hit` 这类高精度信号是否存在，决定门禁能否被满足；
  真实环境里"没有规则能达到门禁"才是常态，那时 Agent 会拒绝，而不是偷偷放宽门槛。
- PSI 只比较窗口内前后两半；跨更长时间的特征漂移需要更长的历史。
- 阈值只在历史 spend/特征分布区间内被数据支持，超出区间的规则是外推。
