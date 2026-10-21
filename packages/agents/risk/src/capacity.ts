/**
 * Review capacity: a rule that fires 800 times a day is not a rule, it is a queue.
 *
 * Precision and recall say whether a rule is *right*; nothing in the audit says whether the operations team can
 * *afford* it. A rule with 74% precision that fires once a day and one with 74% precision that fires 800 times a day
 * are operationally different products, and the difference is arithmetic: arrival rate, service time, number of
 * reviewers, and the service-level target.
 *
 * The model is Erlang-C, the standard queue for a staffed pool with a shared queue. It is deliberately not a
 * simulation: it is a closed form that a reviewer can check by hand, and its assumptions are stated so the number
 * cannot be quoted as if it were measured. In particular it assumes Poisson arrivals and exponential service times;
 * fraud queues are bursty, so treat the wait as a lower bound and the required headcount as a floor.
 */

export interface CapacityInput {
  /** Events the rule set sends to human review per day. */
  hitsPerDay: number;
  /** Minutes a reviewer spends per case (including the context switch). */
  minutesPerReview: number;
  /** Reviewers available, sharing one queue. */
  reviewers: number;
  /** Productive review hours per reviewer per day. */
  hoursPerDay?: number;
  /** The promise: this share of cases must not wait longer than `slaHours`. */
  targetServiceLevel?: number;
  slaHours?: number;
}

export interface CapacityPlan {
  input: Required<CapacityInput>;
  /** Offered load in erlangs: arrivals per hour x service time in hours. */
  offeredLoad: number;
  /** offeredLoad / reviewers. >= 1 means the queue does not clear. */
  utilisation: number;
  /** Probability an arriving case waits at all (Erlang-C). */
  waitProbability: number;
  /** Mean wait before a reviewer picks the case up, in hours. */
  waitHours: number;
  /** Mean time from arrival to decision (wait + service). */
  turnaroundHours: number;
  /** Share of cases handled within `slaHours` - the M/M/c approximation, CDF of the wait. */
  serviceLevel: number;
  queueLength: number;
  meetsSla: boolean;
  /** Smallest headcount meeting the SLA within `maxReviewers`, or null when none does. */
  requiredReviewers: number | null;
  /** How the wait moves with headcount, so a reader sees the cliff instead of a single number. */
  sensitivity: { reviewers: number; utilisation: number; waitHours: number; meetsSla: boolean }[];
  verdict: 'ok' | 'at-risk' | 'understaffed';
  reasons: string[];
  limits: string[];
}

const DEFAULTS = { hoursPerDay: 8, targetServiceLevel: 0.9, slaHours: 4, maxReviewers: 200 };

export function capacityPlan(input: CapacityInput): CapacityPlan {
  const settings: Required<CapacityInput> = {
    hitsPerDay: input.hitsPerDay,
    minutesPerReview: input.minutesPerReview,
    reviewers: input.reviewers,
    hoursPerDay: input.hoursPerDay ?? DEFAULTS.hoursPerDay,
    targetServiceLevel: input.targetServiceLevel ?? DEFAULTS.targetServiceLevel,
    slaHours: input.slaHours ?? DEFAULTS.slaHours,
  };
  if (settings.hitsPerDay < 0) throw new Error('hitsPerDay cannot be negative');
  if (settings.minutesPerReview <= 0) throw new Error('minutesPerReview must be positive');
  if (settings.reviewers < 1) throw new Error('reviewers must be at least 1');

  const arrivalsPerHour = settings.hitsPerDay / settings.hoursPerDay;
  const serviceHours = settings.minutesPerReview / 60;
  const offeredLoad = arrivalsPerHour * serviceHours;

  const evaluate = (reviewers: number) => {
    const utilisation = offeredLoad / reviewers;
    if (utilisation >= 1) {
      return { utilisation, waitProbability: 1, waitHours: Number.POSITIVE_INFINITY, serviceLevel: 0, queueLength: Number.POSITIVE_INFINITY };
    }
    const waitProbability = erlangC(offeredLoad, reviewers);
    const waitHours = (waitProbability * serviceHours) / (reviewers - offeredLoad);
    // P(wait > t) = C x exp(-(c - a) t / serviceTime); the SLA is 1 - that tail at t = slaHours
    const serviceLevel = 1 - waitProbability * Math.exp(-((reviewers - offeredLoad) * settings.slaHours) / serviceHours);
    return { utilisation, waitProbability, waitHours, serviceLevel, queueLength: offeredLoad + (waitProbability * utilisation) / Math.max(1 - utilisation, 1e-9) };
  };

  const current = evaluate(settings.reviewers);
  const meetsSla = current.serviceLevel >= settings.targetServiceLevel;
  let requiredReviewers: number | null = null;
  for (let reviewers = 1; reviewers <= DEFAULTS.maxReviewers; reviewers++) {
    const candidate = evaluate(reviewers);
    if (candidate.serviceLevel >= settings.targetServiceLevel) {
      requiredReviewers = reviewers;
      break;
    }
  }

  const sensitivity: CapacityPlan['sensitivity'] = [];
  for (const reviewers of [1, 2, 3, 5, 8, 13, 21].filter((value) => value <= DEFAULTS.maxReviewers)) {
    const candidate = evaluate(reviewers);
    sensitivity.push({
      reviewers,
      utilisation: round(candidate.utilisation, 4),
      waitHours: Number.isFinite(candidate.waitHours) ? round(candidate.waitHours, 4) : Number.POSITIVE_INFINITY,
      meetsSla: candidate.serviceLevel >= settings.targetServiceLevel,
    });
  }

  const reasons: string[] = [];
  const verdict: CapacityPlan['verdict'] = current.utilisation >= 1
    ? 'understaffed'
    : meetsSla ? 'ok' : 'at-risk';
  if (verdict === 'understaffed') {
    reasons.push(`offered load ${round(offeredLoad, 2)} erlangs exceeds ${settings.reviewers} reviewer(s): the queue grows without bound`);
  } else if (verdict === 'at-risk') {
    reasons.push(`only ${(current.serviceLevel * 100).toFixed(1)}% of cases start within ${settings.slaHours}h (target ${(settings.targetServiceLevel * 100).toFixed(0)}%)`);
    if (requiredReviewers !== null) reasons.push(`${requiredReviewers} reviewer(s) would meet it`);
  } else {
    reasons.push(`${(current.serviceLevel * 100).toFixed(1)}% start within ${settings.slaHours}h at ${settings.reviewers} reviewer(s), utilisation ${round(current.utilisation, 2)}`);
  }

  return {
    input: settings,
    offeredLoad: round(offeredLoad, 4),
    utilisation: round(current.utilisation, 4),
    waitProbability: round(current.waitProbability, 4),
    waitHours: Number.isFinite(current.waitHours) ? round(current.waitHours, 4) : Number.POSITIVE_INFINITY,
    turnaroundHours: Number.isFinite(current.waitHours) ? round(current.waitHours + serviceHours, 4) : Number.POSITIVE_INFINITY,
    serviceLevel: round(current.serviceLevel, 4),
    queueLength: Number.isFinite(current.queueLength) ? round(current.queueLength, 2) : Number.POSITIVE_INFINITY,
    meetsSla,
    requiredReviewers,
    sensitivity,
    verdict,
    reasons,
    limits: [
      'Erlang-C 假设到达是泊松、服务时间是指数分布；欺诈队列是突发性的，所以等待时间应读作下界、所需人力应读作下限',
      '只算人工审核时长，不含复核/申诉/误杀赔付',
      'SLA 用 M/M/c 的等待分布近似，不是逐案测量',
    ],
  };
}

/** Erlang-C: the probability that an arrival has to wait, for `c` servers and `a` erlangs of offered load. */
export function erlangC(offeredLoad: number, servers: number): number {
  if (servers <= 0) return 1;
  if (offeredLoad <= 0) return 0;
  if (offeredLoad >= servers) return 1;
  // top-down recursion for the Erlang-B terms is numerically stable for the sizes a review team reaches
  let term = 1;
  let sum = 1;
  for (let index = 1; index < servers; index++) {
    term *= offeredLoad / index;
    sum += term;
  }
  const erlangB = (term * (offeredLoad / servers)) / (sum + term * (offeredLoad / servers));
  const rho = offeredLoad / servers;
  return erlangB / (1 - rho * (1 - erlangB));
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
