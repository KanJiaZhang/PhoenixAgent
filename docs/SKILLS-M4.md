# P3 / M4 交付：Skill 系统（带证据、可晋升、可退役、可导出）

## 1. 为什么不是"往 prompt 里追加一句"

需求 7/8 说"把性能调优与分析经验沉淀成 skill，以 tip 形式加入"。直接往系统提示里追加句子的失败方式是可预测的：提示越来越长、每条 tip 无法归因、过时的 tip 永远不会消失、没人能解释 agent 为什么这么做。所以这一层按"**声明 + 证据 + 作用域 + 状态**"来建模：

| 规则 | 机制 | 为什么 |
| --- | --- | --- |
| 无证据不入库 | `SkillStore.harvest` 在 `evidence` 为空时直接抛错 | 一条没跑过的 tip 是猜测；猜测不该有和测量一样的地位 |
| 作用域是**硬过滤** | `advise` 先按 dialect / table / agent 过滤，再做匹配 | 跨方言、跨事实表泄漏是正确性 bug，不是排序问题 |
| 状态是挣来的 | 两次**独立运行**（distinct runId）或人工晋升 → `adopted`；两次 miss → `deprecated` | 一次是轶事，三次是习惯；一直错的 tip 应该退出，而不是被降权后继续出现 |
| 日志只追加 | 每行是一个完整快照，`history(id)` 即审计轨迹 | 可回放、可 diff、可解释"这条 tip 什么时候变的" |
| 检索是确定性的 | 规则 id 命中 **或** 关键词全部出现；不用向量、不用模型 | 同一个问题得到同一个建议，否则 skill 无法被测试 |

排名：`severity(该 finding 的严重度) × confidence × 命中率 × 状态权重`。严重度优先是刻意的——笛卡尔积（P06）的建议应该排在"结果集无 LIMIT"（P13）前面，哪怕后者被确认过更多次。

## 2. 两个出口（对应规划里的两条）

1. **确定性注入**：`advise()` 把命中的 tip 连同 `why`（"SQL 层报告了 P03" / "查询包含 substr, order_date"）返回给 SQL 层与工作台。可执行的性能 tip 走这条路，不进 prompt。
2. **叙述片段**：`toSkillMarkdown` 导出 SKILL.md（front matter + 每条一节），供人评审、diff、交给别的 runtime；`fromSkillMarkdown` 可读回。

## 3. 实测（`npm run verify:m4`，29 条断言）

| 断言 | 结果 |
| --- | --- |
| 从真实运行沉淀 ≥10 条 | **11 条**：6 条来自 M3 的 6 次 plan（P03 被两条不同查询确认 → 自动 adopted）、3 条来自注入语料的失败探针（existence/enum/references）、1 条人工（比率指标不可加） |
| 每条都有证据；rewrite tip 带测量数值 | ✅（`rowsBefore/rowsAfter`、`fullScans`、耗时） |
| 无证据的 tip 被拒 | ✅ 抛错 |
| 两次独立确认才 adopted | ✅（同一 runId 再次 confirm 不增加版本） |
| 两次 miss 退役 | ✅ 版本 3、状态 deprecated，历史 3 行 |
| 8 条标注查询全部命中期望 tip | **8/8** |
| 去掉 P03 这条 tip 后损失可量化 | 8 → **6**（恰好是依赖它的两条月份/年份前缀查询） |
| 去掉全部 tip | 0 |
| mysql tip 不出现在 sqlite 查询里，反之亦然 | ✅ |
| 退役 tip 不可见 | ✅ |
| adopted 排在 candidate 之前 | ✅ 分数序列 `adopted:0.95 → adopted:0.6 → candidate:0.36 …` |
| SKILL.md 往返 | ✅ 13 条 tip 的 id / statement / scope 全部一致 |
| CLI `list` / `advise` 与库一致 | ✅ |

## 4. 这一阶段发现并修掉的一个真 bug

`publish` 原本用 `GET /api/v1/schema/{graph}` 读回 schema 以取得属性 id。写完整套验收后重跑 M2 时，第二次发布直接失败：

```
POST /api/v1/schema?replace=false -> 400 "Graph 'demo-semantics' is already served"
```

原因：**运行期创建的图由注册表在内存中提供，`GET /schema/{graph}` 读的是加载器写的文件，对这类图返回 404**。于是"已存在"被误判成"不存在"。

修法：属性 id 不再依赖服务端回读——草稿里属性声明顺序就是服务端分配的下标（1 起、按元素类型各自计数），由声明推导；服务端能回答时再做**交叉校验**（不一致就报"这个模型是别的 schema 版本写的"）。写入是否正确的证明仍然是**按 id 逐条回读**（72 个节点、40 条边遍历抽样），这才是 keyed 存储能通过的最强检查。`verify:m2` 现在连跑两次都通过，即幂等。

## 5. 诚实的限制

- **没有向量召回**：检索是规则/关键词匹配。规划里写的是"scope 精确匹配 → 向量召回"，现在只做了前半段。理由是同义表述的收益在这个阶段小于"同一问题同一建议"的可测性；`applies.keywords` 目前偏粗（例如枚举 tip 用 `status` + `=`），换成检索式语义匹配要等真实问题集。
- **还没有下游消费者**：M5（归因）、M6（投放）、M7（风控）尚未实现，所以 attribution/campaign/risk 三类 tip 只有 1 条（人工）。当 M5 落地时，归因循环里的"哪种分解顺序有效""哪个维度信息量大"应该由同一套 harvest 产出。
- **晋升门槛固定为 2**：没有按样本量自适应，也没有"在 A/B 里验证过"这类更强证据等级。
- **人的反馈只有 CLI**：没有从 UI 的"这次建议不对"直接打 miss 的路径（M8 的 Console 才会做）。
- **冲突只做排序不做裁决**：两条同作用域的 tip 都给出来，按分数排先后；没有"合并成一条"的操作。
