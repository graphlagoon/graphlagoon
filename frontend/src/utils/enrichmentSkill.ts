/**
 * "Ask an AI" for Your data → Enrich (an exploration's layer). Two copy-pasteable prompts,
 * same shape and tone as `labelTemplateSkill.ts` / `librarySkill.ts`:
 *   - fill: the AI is the source. It gets the canvas's nodes (id, type, name) and answers a
 *     CSV keyed by `node_id`, which joins without any setting;
 *   - clean: the person has a messy file. The AI gets its first lines and how the canvas's
 *     ids look, and answers a clean CSV (or, for a large file, a script that writes one).
 * Either answer is pasted back and goes through the auto-match. Pure functions.
 */
import { bulletList } from './clusterProgramSkill';

export interface SkillNode {
  id: string;
  type: string;
  name: string;
}

export interface EnrichmentFillSkillInput {
  nodes: SkillNode[];
  /** Nodes the person chose before the cap (the prompt says when some were left out). */
  total: number;
  /** Property names the nodes already have. */
  nodeProperties: string[];
}

export interface EnrichmentCleanSkillInput {
  fileName: string;
  /** The first lines of the file as it is. */
  headLines: string[];
  /** Per node type: a few node ids and, per property, a few values (how keys look on the canvas). */
  samplesByType: { type: string; ids: string[]; properties: Record<string, string[]> }[];
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const CSV_RULES = `- Comma-separated, first line the header, no code fence and no prose around it.
- Quote a cell that has a comma or a quote ("…", with "" inside).
- A number is written plainly (\`1234.5\`, no thousands separator); a date as \`yyyy-mm-dd\`.
- An empty cell sets nothing: leave it empty when you do not know. Never guess a value.
- Column names in snake_case, without spaces.`;

export function buildEnrichmentFillSkill(input: EnrichmentFillSkillInput): string {
  const { nodes, total, nodeProperties } = input;
  const left = total > nodes.length ? `\nOnly the first ${nodes.length} of ${total} nodes are listed.\n` : '';
  const rows = nodes.map((n) => [n.id, n.type, n.name].map(csvCell).join(',')).join('\n');
  return `# Task: add data to the nodes of a graph

You are helping me add properties to the nodes of a graph in Graph Lagoon, a
graph exploration tool. You are the source of the data: what you know about
each node, or what I give you in this chat (a document, a list, a page).
Your final answer will be ONE CSV whose first column is \`node_id\`.

## The nodes (node_id, type, name)

\`\`\`csv
node_id,type,name
${rows}
\`\`\`
${left}
## Properties they already have

${bulletList(nodeProperties, 'none')}

## How to help me

1. Ask me which columns I want (for example \`sector\`, \`country\`, \`founded\`)
   and where the data should come from. Do not repeat a property they already
   have unless I ask to replace it.
2. Show me the column list with one example row, and let me correct it.
3. Then output ONLY the CSV:
   - first column \`node_id\`, with the ids exactly as listed above (they are
     how each row finds its node: do not change, shorten or reformat them);
   - then the columns I asked for, one row per node you have data for. Skip a
     node you know nothing about rather than invent a row.
${CSV_RULES}

I will paste your CSV back into Graph Lagoon, which puts each row on its node.
`;
}

export function buildEnrichmentCleanSkill(input: EnrichmentCleanSkillInput): string {
  const { fileName, headLines, samplesByType } = input;
  const samples = samplesByType
    .map((t) => {
      const props = Object.entries(t.properties)
        .map(([k, vs]) => `  - \`${k}\`: ${vs.map((v) => `\`${v}\``).join(', ')}`)
        .join('\n');
      return `### ${t.type}\n\n- node ids: ${t.ids.map((v) => `\`${v}\``).join(', ')}\n${props}`;
    })
    .join('\n\n');
  return `# Task: clean a file so it joins the nodes of a graph

You are helping me turn a messy file into a clean CSV that Graph Lagoon, a
graph exploration tool, can join to the nodes on my canvas. Each row of the
CSV must name one node by a **key**: its node id or the value of one of its
properties, written the way the canvas writes it. Your final answer will be
ONE CSV (or, for a file too large to paste here, a script that writes it).

## The file: \`${fileName}\`, first ${headLines.length} lines as they are

\`\`\`text
${headLines.join('\n')}
\`\`\`

## How keys look on the canvas

${samples || '(no nodes on the canvas)'}

## What usually needs fixing

- A key inside text (\`Acme Ltd (ID 4471)\` → \`4471\`), split across two
  columns, or with another mask (\`123.456.789-01\` vs \`12345678901\`).
- Title lines, notes or totals above or below the table; merged cells; one
  entity spread over several rows.
- Numbers with a decimal comma or thousands separator (\`1.234,56\` →
  \`1234.56\`), dates in local formats (\`31/12/2026\` → \`2026-12-31\`).

## How to help me

1. Tell me which node type and which id or property the rows should join,
   and which column of the file gives that key, and how you will rewrite it.
   Ask me if it is not clear.
2. Ask me which columns to keep.
3. If I can paste the whole file here, output ONLY the clean CSV:
   - first column the key, written exactly like the canvas's values above;
   - then the columns I keep, one row per entity.
${CSV_RULES}
4. If the file is too large to paste, write a short Python script (standard
   library only) that reads \`${fileName}\` and writes \`clean.csv\` by the same
   rules, and tell me how to run it.

I will paste the clean CSV back into Graph Lagoon, which finds the join on its own.
`;
}

/** An AI answer as plain CSV: the code fence around it, if any, removed. */
export function stripCodeFence(text: string): string {
  const m = text.trim().match(/^```[\w-]*\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : text.trim();
}
