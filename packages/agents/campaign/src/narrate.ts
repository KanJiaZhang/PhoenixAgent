/**
 * The campaign narrative: what to move, why that cell, and what would prove it wrong.
 *
 * Three habits, and they are the point of the file:
 *
 * - **A move always carries two numbers**: the marginal ROI where the budget leaves and where it lands. A
 *   recommendation without them is an opinion.
 * - **Projection is labelled as projection.** "模型预计" appears in the sentence that carries the gain, and the
 *   `limits` say it is not a realised increase.
 * - **The holdout gets a paragraph, not a footnote.** If the experiment cannot detect the effect, that is the
 *   most important sentence in the answer, not a caveat at the bottom.
 */

import type { CampaignResult } from './agent.ts';

export function narrate(result: CampaignResult, objective: 'revenue' | 'profit' = 'revenue'): string {
  const lines: string[] = [];
  const { allocation } = result;
  const totals = allocation.totals;
  lines.push(`本周期预算 ${money(result.budget)}（${result.window.periods} 期数据，当前期 ${result.window.last}），`
    + `优化目标：${objective === 'profit' ? '利润（收入 − 花费）' : '收入（预算不变）'}。`
    + `花费 ${money(totals.currentSpend)} → ${money(totals.proposedSpend)}，`
    + `模型预计收入 ${money(totals.expectedRevenueCurrent)} → ${money(totals.expectedRevenueProposed)}（${money(totals.expectedRevenueDelta)}），`
    + `利润 ${money(totals.expectedProfitCurrent)} → ${money(totals.expectedProfitProposed)}（${money(totals.expectedProfitDelta)}）。`);

  const increases = result.cells.filter((cell) => cell.delta > 0).slice(0, 3);
  const decreases = result.cells.filter((cell) => cell.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
  if (increases.length > 0) {
    lines.push('加投：' + increases.map((cell) => `${cell.id} ${money(cell.delta)}`
      + `（边际 ROI ${cell.marginalRoi}，当前平均 ${cell.currentRoi}）`).join('；') + '。');
  }
  if (decreases.length > 0) {
    lines.push('减投：' + decreases.map((cell) => `${cell.id} ${money(cell.delta)}`
      + `（边际 ROI ${cell.marginalRoi}，当前平均 ${cell.currentRoi}）`).join('；') + '。');
  }

  const kinds = countKinds(result.cells.map((cell) => cell.curve.kind));
  const saturations = result.cells.map((cell) => cell.curve.saturation).sort((a, b) => a - b);
  lines.push(`响应曲线：${kinds}；边际/平均 ROI 中位数 ${saturations[Math.floor(saturations.length / 2)]?.toFixed(2) ?? 'n/a'}`
    + `（1.00 表示线性、没有边际递减）。`);

  const curveExample = result.cells.find((cell) => cell.delta > 0) ?? result.cells[0];
  if (curveExample) {
    const params = Object.entries(curveExample.curve.params)
      .map(([name, value]) => `${name}=${Number(value).toPrecision(6)}`).join(', ');
    lines.push(`以 ${curveExample.id} 为例：${curveExample.curve.kind}（${params}），r²=${curveExample.curve.r2}，`
      + `${curveExample.curve.points} 个历史点。加投的钱按这条曲线定价，不是按平均 ROI。`);
  }

  const holdout = result.holdout;
  lines.push(`验证建议：${holdout.design === 'geoholdout' ? '地区/账号对照' : '时间切换'}，处理组「${holdout.treatment}」，`
    + `对照组 ${holdout.control}，观察 ${holdout.horizonWeeks} 周；`
    + `需要每组 ${holdout.requiredUnitsPerArm} 个 cell-月，可比 cell 有 ${holdout.availableUnits} 个 → `
    + `${holdout.feasible ? '可行' : '不可行'}。${holdout.note}`);
  lines.push('以上是模型预测与建议，不是已实现的增量，也不是因果结论。');
  return lines.join('\n');
}

function countKinds(kinds: string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join(' / ');
}

function money(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(2);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
