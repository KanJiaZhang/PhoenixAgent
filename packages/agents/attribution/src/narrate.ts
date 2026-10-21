/**
 * The narrative: what moved, how much of it each part accounts for, and what is left over.
 *
 * The rules this file follows are the whole of "explain honestly":
 *
 * - **Numbers first, adjectives never.** Every sentence carries an amount and a share; there is no "significantly"
 *   and no "strongly".
 * - **The residual is a sentence, not a footnote.** "另有 3.4% 未解释" is stated at the same level as the top
 *   driver, because an attribution that rounds itself to 100% is the one thing this phase must not do.
 * - **No causality.** "解释了 63% 的变化" is a decomposition claim. "导致了 63% 的变化" is a causal claim, and
 *   the loop has no experiment behind it, so the words for it are not in this vocabulary.
 * - **A refusal is a full explanation.** When the model could not support a decomposition, the text says which
 *   edge is missing rather than describing a tree that was not computed.
 */

import type { AttributionNode, AttributionResult } from './loop.ts';

export function narrate(input: { metric: string; from: string; to: string; root: AttributionNode; path: AttributionNode[] }): string {
  const { metric, from, to, root, path } = input;
  if (root.previous === 0 && root.current === 0 && root.queries === 0) {
    return `${metric} 在 ${from} 与 ${to} 没有可比较的数据，无法归因。`;
  }

  const lines: string[] = [];
  const direction = root.delta >= 0 ? '上升' : '下降';
  lines.push(`${metric} 从 ${from} 的 ${format(root.previous)} ${direction}到 ${to} 的 ${format(root.current)}，`
    + `变动 ${format(root.delta)}（相对变动 ${relative(root.delta, root.previous)}）。`);

  if (root.decomposition === 'ratio' && root.drivers.length === 2) {
    const [numerator, denominator] = root.drivers;
    // No percentages here on purpose: the two effects of a ratio are exact but they largely cancel, so
    // "分子项占 -1215%" is arithmetically true and rhetorically useless.
    lines.push(`按比率的两因子分解（精确，无残差）：分子（${short(numerator!.metric)}）项 ${format(numerator!.contribution)}，`
      + `分母（${short(denominator!.metric)}）项 ${format(denominator!.contribution)}；`
      + `两项相抵即总变动 ${format(root.delta)}。比率分解的两项会相互抵消，份额没有意义，看数值与方向。`);
  } else if (root.decomposition === 'additive' && root.drivers.length > 0) {
    lines.push(`按可加分解：${root.drivers.slice(0, 3).map((driver) => `${short(driver.metric)} ${format(driver.contribution)}（${percent(driver.share)}）`).join('，')}。`);
  } else if (root.decomposition === 'association' && root.drivers.length > 0) {
    lines.push(`模型没有给出 ${metric} 的计算公式，因此这些指标只能报告为“同向变动”，不构成分解：`
      + `${root.drivers.slice(0, 3).map((driver) => `${short(driver.metric)} 变动 ${format(driver.delta)}`).join('，')}。`);
  }

  if (root.sliceSets.length > 0) {
    const best = [...root.sliceSets].sort((a, b) => Math.abs(b.items[0]?.delta ?? 0) - Math.abs(a.items[0]?.delta ?? 0))[0]!;
    const top = best.items.slice(0, 3);
    lines.push(`按 ${short(best.dimension)} 切片，贡献最大的${top.length > 1 ? '几项' : '一项'}是：`
      + `${top.map((item) => `${String(item.value)}（变动 ${format(item.delta)}，占 ${percent(item.share)}）`).join('，')}。`);
  }

  for (const node of path.slice(1)) {
    if (node.label) {
      lines.push(`下钻到 ${node.label}：该子集 ${format(node.previous)} → ${format(node.current)}，`
        + `变动 ${format(node.delta)}。`);
    } else if (node.filters.length > 0) {
      lines.push(`下钻到 ${node.filters.map(readableFilter).join(' 且 ')}：该子集 ${format(node.previous)} → ${format(node.current)}，`
        + `变动 ${format(node.delta)}。`);
    } else {
      lines.push(`下钻到 ${short(node.metric)}：${format(node.previous)} → ${format(node.current)}，变动 ${format(node.delta)}。`);
    }
    if (node.sliceSets.length > 0) {
      const best = node.sliceSets[0]!;
      const top = best.items.slice(0, 2);
      lines.push(`  其中 ${short(best.dimension)} 的主要贡献：`
        + `${top.map((item) => `${String(item.value)} ${format(item.delta)}（${percent(item.share)}）`).join('，')}。`);
    }
  }

  if (root.unexplained !== null) {
    const share = Math.abs(root.unexplained.share);
    if (share > 0.01) {
      lines.push(`另有 ${format(root.unexplained.absolute)}（占 ${percent(root.unexplained.share)}）未被这次分解解释：`
        + `说明模型声明的驱动/维度没有覆盖全部变化，不要把它归到"行业波动"之类的说法上。`);
    } else {
      lines.push(`分解残差 ${format(root.unexplained.absolute)}，可以忽略。`);
    }
  } else if (root.decomposition === 'association') {
    lines.push('这次的结论只是关联性的：没有残差可比，因为根本没有做加总分解。');
  }

  lines.push('以上是描述性分解，不是因果结论。');
  return lines.join('\n');
}

/** A one-line summary for a log or a console row. */
export function summarize(result: AttributionResult): string {
  const top = result.root.drivers[0] ?? result.root.sliceSets[0]?.items[0];
  if (!top) return `${result.metric}: ${format(result.root.delta)} (${result.root.decomposition})`;
  return `${result.metric} ${format(result.root.delta)} · ${result.root.decomposition} · top ${percent(top.share)} · `
    + `${result.cost.queries}/${result.cost.naiveQueries} queries`;
}

/** `"dim_channel"."channel_name" = '搜索'` -> `channel.channel_name = 搜索`, for prose. */
function readableFilter(filter: string): string {
  return filter.replace(/"/g, '').replace(/^dim_(w+)./, '$1.').replace(/'/g, '');
}

function short(id: string): string {
  return id.replace(/^metric\//, '').replace(/^dim\//, '');
}

function format(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${value.toFixed(2)}`;
  return value.toFixed(4);
}

function percent(share: number): string {
  if (!Number.isFinite(share)) return 'n/a';
  return `${(share * 100).toFixed(1)}%`;
}

function relative(delta: number, previous: number): string {
  if (previous === 0) return 'n/a';
  return percent(delta / previous);
}
