import { describe, it, expect } from 'vitest';
import { buildContextMenuActionSkill } from '../contextMenuActionSkill';

const INPUT = {
  nodeTypes: ['Person', 'Company'],
  edgeTypes: ['KNOWS'],
  nodeProperties: [
    { name: 'name', data_type: 'string', description: 'Full name' },
    { name: 'email', data_type: 'string' },
  ],
  edgeProperties: [{ name: 'since', data_type: 'timestamp' }],
  queryTemplates: [
    {
      id: 'tpl-uuid-1',
      name: 'Neighbors',
      description: 'Direct neighbors',
      parameters: [
        { id: 'person', label: 'Person', required: true },
        { id: 'depth', label: 'Depth', required: false },
      ],
    },
  ],
};

describe('buildContextMenuActionSkill', () => {
  it('embeds the graph metadata', () => {
    const skill = buildContextMenuActionSkill(INPUT);
    expect(skill).toContain('- Person');
    expect(skill).toContain('- Company');
    expect(skill).toContain('- KNOWS');
    expect(skill).toContain('name (string) — Full name');
    expect(skill).toContain('since (timestamp)');
  });

  it('lists query templates with ids and parameter requirements', () => {
    const skill = buildContextMenuActionSkill(INPUT);
    expect(skill).toContain('tpl-uuid-1');
    expect(skill).toContain('"Neighbors"');
    expect(skill).toContain('person (required)');
    expect(skill).toContain('depth');
  });

  it('documents the three kinds and the JSON contract', () => {
    const skill = buildContextMenuActionSkill(INPUT);
    expect(skill).toContain('open-url');
    expect(skill).toContain('copy-text');
    expect(skill).toContain('run-query-template');
    expect(skill).toContain('"urlTemplate"');
    expect(skill).toContain('paramBindings');
    expect(skill).toContain('http://');
  });

  it('handles empty metadata with placeholders', () => {
    const skill = buildContextMenuActionSkill({
      nodeTypes: [],
      edgeTypes: [],
      nodeProperties: [],
      edgeProperties: [],
      queryTemplates: [],
    });
    expect(skill).toContain('(no nodes loaded yet)');
    expect(skill).toContain('(no query templates in this context)');
  });

  it('asks the LLM to interview the user before writing JSON', () => {
    const skill = buildContextMenuActionSkill(INPUT);
    expect(skill).toContain('Do NOT write JSON immediately');
  });

  it('includes the ego-layout deep-link example anchored on the current exploration', () => {
    const skill = buildContextMenuActionSkill({
      ...INPUT,
      graphViewUrl: 'https://studio.example.com/graph/ctx-1',
      explorationId: 'exp-42',
    });
    expect(skill).toContain(
      'https://studio.example.com/graph/ctx-1?exploration=exp-42&layout=ego&layout.ego.focusNodeId={node_id}',
    );
    expect(skill).toContain('ego layout centred on the clicked node');
  });

  it('falls back to placeholders when no graph view URL / exploration is given', () => {
    const skill = buildContextMenuActionSkill(INPUT);
    expect(skill).toContain(
      'https://YOUR_APP_HOST/graph/YOUR_CONTEXT_ID?exploration=YOUR_EXPLORATION_ID&layout=ego&layout.ego.focusNodeId={node_id}',
    );
  });

  it('explains that a deep link must load a graph (exploration / precomputed / template)', () => {
    const skill = buildContextMenuActionSkill(INPUT);
    expect(skill).toContain('a bare graph URL opens empty');
    expect(skill).toContain('precomputed=');
    expect(skill).toContain('template=');
  });
});
