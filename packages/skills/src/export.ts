/**
 * Export and import: a skill is portable, or it is a database row.
 *
 * `SKILL.md` is the same idea other agent runtimes use (front matter plus one section per skill), so a team can
 * review the tips in a pull request, diff two versions, and hand them to a different runtime. The export is
 * lossy on purpose: the file carries what a reader needs (scope, status, the statement, the reason, how much
 * evidence), and the full evidence stays in the append-only log where it belongs. Importing the file back gives
 * you the tips, not the provenance - which is why the importer marks them `candidate` unless a human promotes
 * them.
 */

import type { Tip, TipStatus } from './types.ts';

export interface SkillExportMeta {
  name: string;
  description: string;
  generatedAt: string;
}

export interface ParsedTip {
  id: string;
  scope: { agent: string; dialect?: string; shape?: string; table?: string };
  kind: string;
  status: TipStatus;
  confidence: number;
  statement: string;
  rationale: string;
  applies: { rule?: string; keywords?: string[] };
  evidence: number;
}

export function toSkillMarkdown(tips: Tip[], meta: SkillExportMeta): string {
  const adopted = tips.filter((tip) => tip.status === 'adopted').length;
  const lines: string[] = [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    `generatedAt: ${meta.generatedAt}`,
    `tips: ${tips.length}`,
    `adopted: ${adopted}`,
    '---',
    '',
    `# ${meta.name}`,
    '',
    `${meta.description}`,
    '',
    'Every tip carries its scope and its status. A `candidate` has been seen once; an `adopted` one has been',
    'confirmed by two independent runs or by a person; a `deprecated` one is kept only for the audit trail.',
    '',
  ];

  for (const tip of tips) {
    const scope = [tip.scope.agent, tip.scope.dialect ?? 'any dialect', tip.scope.shape ?? 'any shape',
      tip.scope.table ? `table ${tip.scope.table}` : ''].filter((part) => part.length > 0).join(' · ');
    const applies = tip.applies.rule
      ? `rule ${tip.applies.rule}`
      : `keywords ${(tip.applies.keywords ?? []).join(', ')}`;
    lines.push(
      `## ${tip.id}`,
      '',
      `- scope: ${scope}`,
      `- kind: ${tip.kind} · status: ${tip.status} · confidence: ${tip.confidence}`
        + ` · confirmations: ${tip.confirmations.length} · misses: ${tip.misses} · evidence: ${tip.evidence.length}`,
      `- applies: ${applies}`,
      '',
      `**${tip.statement}**`,
      '',
      tip.rationale,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function fromSkillMarkdown(text: string): { meta: Record<string, string>; tips: ParsedTip[] } {
  const meta: Record<string, string> = {};
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) {
    for (const line of (front[1] ?? '').split(/\r?\n/)) {
      const pair = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
      if (pair) meta[pair[1]!] = pair[2]!;
    }
  }

  const tips: ParsedTip[] = [];
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const id = (lines[0] ?? '').trim();
    if (id.length === 0) continue;
    const scopeLine = lines.find((line) => line.startsWith('- scope:')) ?? '';
    const parts = scopeLine.replace('- scope:', '').split('·').map((part) => part.trim());
    const kindLine = lines.find((line) => line.startsWith('- kind:')) ?? '';
    const status = /status:\s*(\w+)/.exec(kindLine)?.[1] as TipStatus | undefined;
    const confidence = Number(/confidence:\s*([\d.]+)/.exec(kindLine)?.[1] ?? 0);
    const evidence = Number(/evidence:\s*(\d+)/.exec(kindLine)?.[1] ?? 0);
    const appliesLine = lines.find((line) => line.startsWith('- applies:')) ?? '';
    const rule = /rule\s+(\S+)/.exec(appliesLine)?.[1];
    const keywords = /keywords\s+(.+)$/.exec(appliesLine)?.[1]?.split(',').map((keyword) => keyword.trim());
    const statementLine = lines.find((line) => line.startsWith('**') && line.endsWith('**')) ?? '';
    const statement = statementLine.replace(/^\*\*|\*\*$/g, '').trim();
    const rationale = lines.slice(lines.indexOf(statementLine) + 1).join('\n').trim();

    tips.push({
      id,
      scope: {
        agent: parts[0] ?? 'sqllayer',
        dialect: parts[1] && parts[1] !== 'any dialect' ? parts[1] : undefined,
        shape: parts[2] && parts[2] !== 'any shape' ? parts[2] : undefined,
        table: parts.find((part) => part.startsWith('table '))?.replace('table ', ''),
      },
      kind: /kind:\s*(\w+)/.exec(kindLine)?.[1] ?? 'check',
      status: status ?? 'candidate',
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
      statement,
      rationale,
      applies: { ...(rule ? { rule } : {}), ...(keywords && keywords.length > 0 ? { keywords } : {}) },
      evidence,
    });
  }

  return { meta, tips };
}
