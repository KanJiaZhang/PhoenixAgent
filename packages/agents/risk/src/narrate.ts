/**
 * The risk narrative: the trend, the evidence for each feature, the rule and its offline numbers, and the fact
 * that nothing has been deployed.
 *
 * The sentence that matters most is the one a risk lead checks first: "这条规则在 holdout 上精确率 X、召回 Y，
 * 相比现有规则多抓到 Z 个案例". Every other line supports it or limits it.
 */

import type { RiskResult } from './agent.ts';

export function narrate(result: RiskResult, settings: { minPrecision: number; minRecall: number; holdoutMonths: number }): string {
  const lines: string[] = [];
  const { window: span } = result;
  lines.push(`${span.from} ~ ${span.to} 共 ${span.events} 个事件、${span.frauds} 个欺诈（${(span.rate * 100).toFixed(2)}%）。`);

  const trend = result.trends.find((entry) => entry.changePoint !== null);
  if (trend?.changePoint) {
    const point = trend.changePoint;
    lines.push(`趋势：${trend.dimension === 'region' ? `大区 ${trend.value}` : '整体'} 在 ${point.period} 出现拐点，`
      + `欺诈率 ${(point.before.rate * 100).toFixed(2)}% → ${(point.after.rate * 100).toFixed(2)}%`
      + `（${point.direction === 'up' ? '上升' : '下降'}，z=${point.z}，样本 ${point.before.events}/${point.after.events}）。`);
  } else {
    lines.push('趋势：没有拐点超过检测门槛。');
  }

  const usable = result.features.filter((feature) => feature.usable);
  const top = [...usable].sort((a, b) => b.auc - a.auc).slice(0, 3);
  if (top.length > 0) {
    lines.push('特征有效性：' + top.map((feature) => `${feature.name} AUC ${feature.auc} / KS ${feature.ks} / IV ${feature.iv}`
      + ` / PSI ${Number.isFinite(feature.psi) ? feature.psi : 'n/a'}`).join('；') + '。');
  }
  const leaking = result.rejectedFeatures.filter((feature) => !feature.pointInTime.ok);
  if (leaking.length > 0) {
    lines.push(`已剔除 ${leaking.length} 个未来函数特征（快照日期晚于事件日期）：`
      + leaking.map((feature) => `${feature.name}（${feature.pointInTime.violations} 处）`).join('、') + '。');
  }

  const recommended = result.rules.filter((rule) => rule.status === 'candidate' || rule.status === 'published');
  if (recommended.length === 0) {
    lines.push(`规则：没有规则在 holdout 上同时达到精确率 ${settings.minPrecision} 与召回率 ${settings.minRecall}，`
      + '按门禁原则不推荐上线。');
  } else {
    const best = recommended[0]!;
    const metrics = best.holdout ?? best.train;
    lines.push(`规则建议：IF ${best.expression} THEN 拦截。`
      + `holdout 精确率 ${metrics.precision}、召回率 ${metrics.recall}、命中覆盖 ${(metrics.coverage * 100).toFixed(2)}%、lift ${metrics.lift}`
      + `（窗口 ${best.holdout?.window ?? 'train'}，样本 ${metrics.evaluated}，TP ${metrics.tp}/FP ${metrics.fp}）。`);
    if (best.incremental) {
      lines.push(`与现有规则相比：新增命中欺诈 ${best.incremental.newOnlyPositives} 个、重叠 ${best.incremental.sharedPositives} 个、`
        + `重叠率 ${(best.incremental.overlapShare * 100).toFixed(1)}%，增量召回 ${(best.incremental.incrementalRecall * 100).toFixed(2)}%。`);
    }
    lines.push(`状态：${best.status === 'published' ? '已审批发布' : '候选规则，尚未发布'}——规则不会自动上线。`);
  }

  lines.push('离线指标基于历史标签；不是上线后效果的保证，也不是因果结论。');
  return lines.join('\n');
}
