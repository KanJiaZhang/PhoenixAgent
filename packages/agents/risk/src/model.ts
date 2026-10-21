/**
 * A logistic model small enough to audit: IRLS, ridge, fixed iteration cap, no library.
 *
 * The point is not to build a scorer - the risk domain already has one (`model_score_v1`). The point is to answer
 * one question with a number: **does adding the graph block move held-out AUC?** For that, the comparison has to be
 * apples to apples: same rows, same split, same solver, same regularisation, only the feature list differs.
 *
 * Two details decide whether the answer means anything.
 *
 * - **Standardisation is fitted on train only.** Means and scales taken from the test window leak its
 *   distribution into the weights, which is the quiet version of training on the answer.
 * - **AUC is rank-based on the test window.** Accuracy would reward a threshold nobody chose; AUC asks only
 *   whether frauds rank above non-frauds, which is what a rules engine actually consumes.
 */

import { rankAuc, type LabelledValue } from './features.ts';

export interface Sample {
  x: number[];
  y: 0 | 1;
}

export interface LogisticModel {
  /** Includes the intercept as `weights[0]`. */
  weights: number[];
  names: string[];
  iterations: number;
  converged: boolean;
  predict(x: number[]): number;
}

export interface Standardizer {
  means: number[];
  scales: number[];
  transform(x: number[]): number[];
}

export interface FitOptions {
  l2?: number;
  iterations?: number;
  tolerance?: number;
}

/** Mean/scale from the training rows; a constant column gets scale 1 so it contributes nothing rather than NaN. */
export function fitStandardizer(rows: Sample[]): Standardizer {
  const width = rows[0]?.x.length ?? 0;
  const means = new Array<number>(width).fill(0);
  const scales = new Array<number>(width).fill(1);
  for (const row of rows) for (let index = 0; index < width; index++) means[index]! += row.x[index]! / rows.length;
  for (const row of rows) for (let index = 0; index < width; index++) scales[index]! += (row.x[index]! - means[index]!) ** 2 / rows.length;
  for (let index = 0; index < width; index++) scales[index] = Math.sqrt(scales[index]!) || 1;
  return {
    means,
    scales,
    transform: (x) => x.map((value, index) => (value - means[index]!) / scales[index]!),
  };
}

export function fitLogistic(rows: Sample[], names: string[], options: FitOptions = {}): LogisticModel {
  const l2 = options.l2 ?? 1;
  const maxIterations = options.iterations ?? 40;
  const tolerance = options.tolerance ?? 1e-7;
  const width = rows[0]?.x.length ?? 0;
  const design = rows.map((row) => [1, ...row.x]);
  let beta = new Array<number>(width + 1).fill(0);
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations++) {
    const gradient = new Array<number>(width + 1).fill(0);
    const hessian = Array.from({ length: width + 1 }, () => new Array<number>(width + 1).fill(0));
    for (let index = 0; index < design.length; index++) {
      const row = design[index]!;
      const eta = dot(beta, row);
      const p = 1 / (1 + Math.exp(-eta));
      const w = Math.max(p * (1 - p), 1e-6);
      const residual = rows[index]!.y - p;
      for (let a = 0; a <= width; a++) {
        gradient[a]! += residual * row[a]!;
        for (let b = 0; b <= width; b++) hessian[a]![b]! += w * row[a]! * row[b]!;
      }
    }
    for (let a = 1; a <= width; a++) {
      gradient[a]! -= l2 * beta[a]!;
      hessian[a]![a]! += l2;
    }
    const step = solve(hessian, gradient);
    if (!step) break;
    let largest = 0;
    for (let a = 0; a <= width; a++) {
      beta[a]! += step[a]!;
      largest = Math.max(largest, Math.abs(step[a]!));
    }
    if (largest < tolerance) {
      converged = true;
      iterations++;
      break;
    }
  }

  const weights = beta;
  return {
    weights,
    names: ['intercept', ...names],
    iterations,
    converged,
    predict: (x: number[]) => 1 / (1 + Math.exp(-dot(weights, [1, ...x]))),
  };
}

export interface Evaluation {
  auc: number;
  rows: number;
  positives: number;
}

/** Rank AUC on the rows, with the model's own scores; ties count half (see `rankAuc`). */
export function evaluate(model: LogisticModel, rows: Sample[]): Evaluation {
  const scored: LabelledValue[] = rows.map((row) => ({
    value: model.predict(row.x),
    label: row.y,
    asOfBeforeEvent: true,
    window: 'test',
  }));
  const positives = scored.filter((entry) => entry.label === 1);
  const negatives = scored.filter((entry) => entry.label === 0);
  return {
    auc: positives.length > 0 && negatives.length > 0 ? rankAuc(positives, negatives) : Number.NaN,
    rows: rows.length,
    positives: positives.length,
  };
}

function dot(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index++) total += left[index]! * right[index]!;
  return total;
}

/** Gaussian elimination with partial pivoting: `null` when the system is singular (then the caller stops). */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    for (let row = column + 1; row < size; row++) {
      const factor = augmented[row]![column]! / augmented[column]![column]!;
      if (factor === 0) continue;
      for (let index = column; index <= size; index++) augmented[row]![index]! -= factor * augmented[column]![index]!;
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row--) {
    let total = augmented[row]![size]!;
    for (let column = row + 1; column < size; column++) total -= augmented[row]![column]! * solution[column]!;
    solution[row] = total / augmented[row]![row]!;
  }
  return solution;
}
