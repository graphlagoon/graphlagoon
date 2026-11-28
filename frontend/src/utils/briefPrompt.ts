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
    '2. Write it with write_brief, in markdown, short enough to read in two minutes:',
    '   - What this case is about (two or three sentences).',
    '   - Who is involved and in what role.',
    '   - What is established, each point naming the item it rests on by its title.',
    '   - What is still unknown or contradictory.',
    '   - Suggested next steps for the person reviewing.',
    '3. Do not state anything the items do not support, and do not decide the case: a person does.',
  ].join('\n');
}
