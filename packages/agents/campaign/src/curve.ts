/**
 * Response curves: what one more unit of budget actually buys in one cell.
 *
 * The single most common mistake in campaign analytics is to rank cells by **average ROI** and move money to
 * the top of that list. Average ROI is revenue / spend, and revenue is concave in spend whenever an audience
 * saturates: the average of a concave curve falls as you spend more, so a cell that looks excellent on average
 * is often the one where the *next* yuan earns least. Reallocation has to be driven by the **marginal** return,
 * which means a curve, which means fitting one from that cell's own history.
 *
 * Three models, chosen by how much data a cell has and how well each fits:
 *
 * | model | form | marginal | when |
 * | --- | --- | --- | --- |
 * | `saturating` | \`R = m·S/(1+S/K)\` | \`m·K/(K+S)²\` | ≥8 points and it beats the power fit |
 * | `power` | \`R = a·S^b\` | \`a·b·S^(b-1)\` | ≥6 points |
 * | `linear` | \`R = m·S\` | \`m\` | too few points, or no curvature detectable |
 *
 * The linear case is not a failure, it is a finding: with no measurable curvature, no reallocation can be
 * justified from this cell's data, and the agent says so instead of inventing a gain.
 *
 * Fitting is deliberately small and deterministic - a grid over K with a closed-form scale for each K - so the
 * same data always produces the same curve, which is what makes the recommendation testable.
 */

export interface SpendRevenuePoint {
  spend: number;
  revenue: number;
}

export type CurveKind = 'saturating' | 'power' | 'linear';

export interface ResponseCurve {
  kind: CurveKind;
  points: number;
  params: Record<string, number>;
  /** Expected revenue at a spend level. */
  predict(spend: number): number;
  /** dRevenue/dSpend - the number a reallocation should look at. */
  marginal(spend: number): number;
  /** Root-mean-square error in revenue units, and the fit quality. */
  rmse: number;
  r2: number;
  /** marginal / average at this spend; 1 means linear, below 1 means saturated. */
  saturation: number;
  /** The spend level the saturation figure was computed at. */
  at: number;
}

const MIN_POINTS = 5;
const SATURATING_MIN_POINTS = 8;

export function fitResponse(points: SpendRevenuePoint[], options: { at?: number } = {}): ResponseCurve {
  const usable = points.filter((point) => point.spend > 0 && Number.isFinite(point.revenue) && point.revenue >= 0);
  if (usable.length < MIN_POINTS) {
    throw new Error(`a response curve needs at least ${MIN_POINTS} usable points, got ${usable.length}`);
  }
  const maxSpend = Math.max(...usable.map((point) => point.spend));
  const at = options.at ?? mean(usable.map((point) => point.spend));

  const linear = fitLinear(usable);
  const power = fitPower(usable);
  const saturating = fitSaturating(usable, maxSpend);
  const candidates = [saturating, power, linear].filter((curve): curve is CurveModel => curve !== null);

  // Choose by fit, with a preference for the model that can express saturation: an extra parameter has to
  // earn its place by at least 10% RMSE, and only a saturating fit is allowed to claim curvature.
  let chosen = candidates.find((curve) => curve.kind === 'linear')!;
  for (const curve of candidates) {
    if (curve.kind === 'linear') continue;
    if (curve.rmse <= chosen.rmse * 0.9) chosen = curve;
  }
  if (chosen.kind !== 'linear') {
    const powerFit = candidates.find((curve) => curve.kind === 'power');
    const saturatingFit = candidates.find((curve) => curve.kind === 'saturating');
    if (powerFit && saturatingFit && usable.length >= SATURATING_MIN_POINTS
      && saturatingFit.rmse <= powerFit.rmse * 0.9) {
      chosen = saturatingFit;
    } else if (powerFit) {
      chosen = powerFit;
    }
  }

  const curve = buildCurve(chosen, usable);
  const predicted = curve.predict(at);
  const average = at > 0 ? predicted / at : 0;
  const saturation = average > 0 ? curve.marginal(at) / average : 0;
  return { ...curve, saturation: round(saturation, 4), at: round(at, 2) };
}

interface CurveModel {
  kind: CurveKind;
  params: Record<string, number>;
  rmse: number;
  r2: number;
  predict(spend: number): number;
  marginal(spend: number): number;
}

/** \`R = m·S\`, through the origin: revenue at zero spend should be zero, not the least-squares intercept. */
function fitLinear(points: SpendRevenuePoint[]): CurveModel {
  const m = sum(points.map((point) => point.spend * point.revenue)) / sum(points.map((point) => point.spend ** 2));
  return model('linear', { m }, points, (spend) => m * spend, () => m);
}

/** \`R = a·S^b\` via least squares on logs. */
function fitPower(points: SpendRevenuePoint[]): CurveModel | null {
  const logged = points.map((point) => ({ x: Math.log(point.spend), y: Math.log(point.revenue) }));
  const meanX = mean(logged.map((point) => point.x));
  const meanY = mean(logged.map((point) => point.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of logged) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  if (denominator === 0) return null;
  const b = numerator / denominator;
  const a = Math.exp(meanY - b * meanX);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return model('power', { a: round(a, 8), b: round(b, 6) }, points,
    (spend) => a * spend ** b, (spend) => a * b * spend ** (b - 1));
}

/**
 * \`R = m·S/(1+S/K)\`, fitted by a grid over the saturation budget K.
 *
 * For a fixed K the model is linear in m (\`R = m·u\` with \`u = S/(1+S/K)\`), so m has a closed form and only K
 * needs searching. That makes the fit deterministic and cheap, which matters: it runs once per cell.
 */
function fitSaturating(points: SpendRevenuePoint[], maxSpend: number): CurveModel | null {
  let best: { k: number; m: number; rmse: number } | null = null;
  const lowest = Math.max(maxSpend * 0.05, 1);
  const highest = maxSpend * 50;
  for (let step = 0; step <= 80; step++) {
    const k = lowest * (highest / lowest) ** (step / 80);
    const u = points.map((point) => point.spend / (1 + point.spend / k));
    const denominator = sum(u.map((value) => value ** 2));
    if (denominator === 0) continue;
    const m = sum(points.map((point, index) => point.revenue * u[index]!)) / denominator;
    if (!Number.isFinite(m) || m <= 0) continue;
    const rmse = rootMeanSquare(points.map((point, index) => point.revenue - m * u[index]!));
    if (!best || rmse < best.rmse) best = { k, m, rmse };
  }
  if (!best) return null;
  const { k, m } = best;
  return model('saturating', { m: round(m, 8), k: round(k, 2) }, points,
    (spend) => (m * spend) / (1 + spend / k),
    // d/dS [ m·S/(1+S/K) ] = m / (1+S/K)²  — note the K²: writing m·K/(K+S)² understates the marginal by a
    // factor of K, which makes every saturated cell look like it returns nothing and inverts every
    // recommendation. The verification checks this against a numerical derivative for exactly this reason.
    (spend) => m / (1 + spend / k) ** 2);
}

function buildCurve(entry: CurveModel, points: SpendRevenuePoint[]): Omit<ResponseCurve, 'saturation' | 'at'> {
  return {
    kind: entry.kind,
    points: points.length,
    params: entry.params,
    predict: entry.predict,
    marginal: entry.marginal,
    rmse: round(entry.rmse, 4),
    r2: round(entry.r2, 4),
  };
}

function model(kind: CurveKind, params: Record<string, number>, points: SpendRevenuePoint[],
  predict: (spend: number) => number, marginal: (spend: number) => number): CurveModel {
  const residuals = points.map((point) => point.revenue - predict(point.spend));
  const rmse = rootMeanSquare(residuals);
  const meanRevenue = mean(points.map((point) => point.revenue));
  const total = sum(points.map((point) => (point.revenue - meanRevenue) ** 2));
  const residualSum = sum(residuals.map((value) => value ** 2));
  const r2 = total === 0 ? 1 : 1 - residualSum / total;
  return { kind, params, rmse, r2, predict, marginal };
}

/** \`marginal × step\` for a concave curve is the exact revenue gain: the integral of the marginal is predict. */
export function revenueGain(curve: ResponseCurve, fromSpend: number, toSpend: number): number {
  return curve.predict(toSpend) - curve.predict(fromSpend);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function rootMeanSquare(values: number[]): number {
  return values.length === 0 ? 0 : Math.sqrt(sum(values.map((value) => value ** 2)) / values.length);
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
