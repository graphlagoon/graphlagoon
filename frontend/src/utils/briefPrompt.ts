/**
 * What to paste into an agent connected to this app's MCP server (Claude Desktop,
 * Claude Code) to have it write the case brief. The brief is the agent's job more often
 * than the person's, so an empty brief offers this instead of a blank editor only.
 */
export function briefPrompt(inv: { id: string; title: string }): string {
  return [
    `Using the graphlagoon MCP server, write the brief of the case "${inv.title}" (investigation_id ${inv.id}).`,
    '',
    '1. Read the case first: get_case, get_brief, list_items, then read_item for each item that matters, and get_graph or search_entities for who is involved.',
    '2. Write it with write_brief, in markdown, readable in two minutes, with these headings in this order:',
    '   - "## What this case is about" (two or three sentences)',
    '   - "## Who is involved" (each with its role)',
    '   - "## What is established" (one line per point, naming the item it rests on by its exact title)',
    '   - "## Still unknown"',
    '   - "## Suggested next steps"',
    '   If a brief exists, keep its unchanged lines exactly as they were: I will read the diff.',
    '3. Do not state anything the items do not support, and do not decide the case: a person does.',
  ].join('\n');
}
