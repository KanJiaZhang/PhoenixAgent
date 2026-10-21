/**
 * Which sub-agent a question belongs to, decided by the *shape* of the question rather than by a
 * classification model.
 *
 * The plan calls this `QuerySignature`, and the reason it exists is requirement 2: route by query structure.
 * A keyword bag would put "为什么 5 月投放效果变差" into the campaign agent; the signature says it is
 * `diagnostic + asksWhy + has an attribution edge`, which is the attribution agent's job. So the signature
 * records the *type* of question (descriptive / diagnostic / prescriptive / detective), the shape it has to
 * touch (single fact, cross-domain, join path), and the intents it carries (why, what to do, which rule).
 *
 * Determinism is the point: the same question routes the same way in every deployment, and it routes the
 * same way with `PAGENT_LLM=none`. A model may later *propose* a signature, but the decision is this table.
 *
 * When two agents are within {@link AMBIGUITY_MARGIN} the router refuses to pick and returns a clarification
 * carrying the candidates - the same "refuse rather than guess" rule the semantic layer lives by. Silently
 * choosing the wrong agent is how a data product tells a confident wrong story.
 */

export type AgentName = 'semantic' | 'ask' | 'attribution' | 'campaign' | 'risk';

export type QuestionType = 'descriptive' | 'diagnostic' | 'prescriptive' | 'detective';

export interface QuerySignature {
  question: string;
  type: QuestionType;
  metrics: string[];
  dimensions: string[];
  asksWhy: boolean;
  asksWhatToDo: boolean;
  asksRule: boolean;
  entityShape: 'single-fact' | 'cross-domain' | 'join-path' | 'unknown';
  /** 0..1: how much of the question the router recognised. Low means "the vocabulary is not ours". */
  confidence: number;
  /** The matched terms, so the decision can be explained rather than asserted. */
  evidence: string[];
}

export interface RouteDecision {
  signature: QuerySignature;
  agent: AgentName | null;
  confidence: number;
  scores: Record<AgentName, number>;
  alternatives: { agent: AgentName; confidence: number }[];
  /** Set when the router refused to choose; `agent` is then null and nothing runs. */
  clarification?: { question: string; candidates: AgentName[] };
}

/** Two agents this close are both plausible; asking is cheaper than guessing. */
export const AMBIGUITY_MARGIN = 0.25;

interface Signal {
  agent: AgentName;
  test: RegExp;
  weight: number;
  label: string;
}

const SIGNALS: Signal[] = [
  // --- building and judging the semantic layer
  { agent: 'semantic', test: /语义层|语义模型|semantic/i, weight: 3, label: '语义层' },
  { agent: 'semantic', test: /表结构|建表|数据库结构|schema/i, weight: 2, label: '表结构' },
  { agent: 'semantic', test: /数据字典|字段含义|字段说明|列注释/i, weight: 3, label: '数据字典' },
  { agent: 'semantic', test: /血缘|lineage/i, weight: 3, label: '血缘' },
  { agent: 'semantic', test: /实体关系|关系抽取|指标关系/i, weight: 3, label: '实体关系' },
  { agent: 'semantic', test: /覆盖率|coverage/i, weight: 2, label: '覆盖率' },
  { agent: 'semantic', test: /口径(?:冲突|管理|审查|对齐)|指标定义/i, weight: 3, label: '口径' },
  { agent: 'semantic', test: /从\s*(?:wiki|文档|pdf|ddl|sql)\s*(?:里|中)?\s*(?:构建|抽取|生成)/i, weight: 3, label: '从文档构建' },

  // --- explaining a movement
  { agent: 'attribution', test: /为什么|为何|为啥|怎么会/i, weight: 3, label: '为什么' },
  { agent: 'attribution', test: /归因|attribution/i, weight: 3, label: '归因' },
  { agent: 'attribution', test: /原因|根因|驱动(?:因素|指标)?|贡献(?:度|率)|导致|拉动|拖累/i, weight: 2, label: '原因/驱动' },
  { agent: 'attribution', test: /变化|下降|上涨|下滑|增长|减少|恶化/i, weight: 1, label: '变化' },

  // --- deciding where to spend
  { agent: 'campaign', test: /投放|广告|campaign|media\s*buy/i, weight: 3, label: '投放' },
  { agent: 'campaign', test: /预算|分配|加投|减投|加强投入|降低投入|追加|砍掉/i, weight: 3, label: '预算分配' },
  { agent: 'campaign', test: /投入产出|产出比|ROI|ROAS|边际/i, weight: 2, label: '投入产出' },
  { agent: 'campaign', test: /在哪个(?:地区|行业|渠道)|应该(?:加|减)|怎么投/i, weight: 2, label: '投放决策' },

  // --- finding a rule
  { agent: 'risk', test: /欺诈|反欺诈|风控|黑产|团伙|套现|薅羊毛/i, weight: 3, label: '欺诈/风控' },
  { agent: 'risk', test: /规则|策略|阈值/i, weight: 2, label: '规则' },
  { agent: 'risk', test: /特征|feature/i, weight: 2, label: '特征' },
  { agent: 'risk', test: /召回|精准率|命中率|误杀/i, weight: 2, label: '召回/精准' },

  // --- plain looking up
  { agent: 'ask', test: /多少|几个|总额|总量|合计/i, weight: 2, label: '多少' },
  { agent: 'ask', test: /各(?:个)?(?:大区|地区|区域|行业|渠道)|按(?:月|日|周|年|地区|行业|渠道)|分布|明细|排名|同比|环比/i, weight: 2, label: '分解' },
  { agent: 'ask', test: /看一下|查一下|统计|报表/i, weight: 1, label: '查询' },
];

const METRIC_WORDS: { test: RegExp; name: string }[] = [
  { test: /GMV|成交总额|商品交易总额/i, name: 'gmv' },
  { test: /ROI|投入产出|回报率/i, name: 'roi' },
  { test: /CAC|获客成本|新客成本/i, name: 'cac' },
  { test: /转化率/i, name: 'conversion_rate' },
  { test: /花费|消耗|投入/i, name: 'spend' },
  { test: /收入|营收/i, name: 'revenue' },
  { test: /新客/i, name: 'new_customers' },
  { test: /订单|单量/i, name: 'orders' },
  { test: /曝光/i, name: 'impressions' },
  { test: /点击/i, name: 'clicks' },
];

const DIMENSION_WORDS: { test: RegExp; name: string }[] = [
  { test: /大区|地区|区域|省|城市/i, name: 'region' },
  { test: /行业|品类/i, name: 'industry' },
  { test: /渠道/i, name: 'channel' },
  { test: /日期|每天|日粒度|天/i, name: 'date' },
  { test: /月|月度/i, name: 'month' },
  { test: /季度|季/i, name: 'quarter' },
  { test: /年|年度/i, name: 'year' },
];

/** Reads a question into the structure the router decides on. */
export function signatureOf(question: string): QuerySignature {
  const evidence: string[] = [];
  const scores: Record<AgentName, number> = { semantic: 0, ask: 0, attribution: 0, campaign: 0, risk: 0 };
  for (const signal of SIGNALS) {
    if (signal.test.test(question)) {
      evidence.push(signal.label);
      scores[signal.agent] += signal.weight;
    }
  }

  const metrics = unique(METRIC_WORDS.filter((m) => m.test.test(question)).map((m) => m.name));
  const dimensions = unique(DIMENSION_WORDS.filter((d) => d.test.test(question)).map((d) => d.name));

  const asksWhy = /为什么|为何|为啥|原因|归因|驱动|导致/i.test(question);
  const asksWhatToDo = /应该(?:加|减|投|停)|怎么(?:投|分配)|加投|减投|加强投入|降低投入|优化(?:预算|投放)|砍掉?|止损/i.test(question);
  const asksRule = /规则|策略|阈值|特征/i.test(question) && /欺诈|风控|风险|团伙|套保|套现|薅羊毛/i.test(question);

  const type: QuestionType = asksRule
    ? 'detective'
    : asksWhatToDo && (scores.campaign > 0 || /预算/.test(question))
      ? 'prescriptive'
      : asksWhy
        ? 'diagnostic'
        : 'descriptive';

  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  const maxScore = Math.max(...Object.values(scores));
  const confidence = total === 0 ? 0.2 : Math.round((maxScore / total) * 100) / 100;

  return {
    question,
    type,
    metrics,
    dimensions,
    asksWhy,
    asksWhatToDo,
    asksRule,
    entityShape: dimensions.length >= 2 ? 'cross-domain' : dimensions.length === 1 ? 'join-path' : 'unknown',
    confidence,
    evidence: unique(evidence),
  };
}

/** Decides the agent. Returns `agent: null` plus a clarification when two answers are equally plausible. */
export function route(question: string): RouteDecision {
  const signature = signatureOf(question);
  const scores: Record<AgentName, number> = { semantic: 0, ask: 0, attribution: 0, campaign: 0, risk: 0 };
  for (const signal of SIGNALS) {
    if (signal.test.test(question)) scores[signal.agent] += signal.weight;
  }

  // The question's type is a hard constraint: a "why" question is never answered by the lookup agent, even
  // when the words inside it look like a lookup. This is where the signature earns its keep.
  const eligible = (agent: AgentName): boolean => {
    if (signature.type === 'diagnostic') return agent === 'attribution' || (agent === 'campaign' && signature.asksWhatToDo);
    if (signature.type === 'prescriptive') return agent === 'campaign';
    if (signature.type === 'detective') return agent === 'risk' || agent === 'semantic';
    return true;
  };

  const ranked = (Object.keys(scores) as AgentName[])
    .map((agent) => ({ agent, score: eligible(agent) ? scores[agent] : 0 }))
    .sort((a, b) => b.score - a.score);
  const total = ranked.reduce((sum, entry) => sum + entry.score, 0);

  if (total === 0) {
    // Nothing matched. The lookup agent is the honest default - it will refuse with the vocabulary it has.
    return {
      signature,
      agent: 'ask',
      confidence: 0.3,
      scores,
      alternatives: [{ agent: 'ask', confidence: 0.3 }],
    };
  }

  const top = ranked[0]!;
  const second = ranked[1]!;
  const confidence = Math.round((top.score / total) * 100) / 100;
  const alternatives = ranked
    .filter((entry) => entry.score > 0)
    .map((entry) => ({ agent: entry.agent, confidence: Math.round((entry.score / total) * 100) / 100 }));

  const gap = (top.score - second.score) / top.score;
  if (second.score > 0 && gap < AMBIGUITY_MARGIN) {
    return {
      signature,
      agent: null,
      confidence,
      scores,
      alternatives,
      clarification: {
        question: `这个问题可以按 ${alternatives.map((a) => a.agent).join(' 或 ')} 处理，请确认。`,
        candidates: alternatives.map((a) => a.agent),
      },
    };
  }

  return { signature, agent: top.agent, confidence, scores, alternatives };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
