import { describe, it, expect } from 'vitest';
import { matchesAction } from '../menuActionMatcher';
import { createNode } from '@/__tests__/fixtures/nodes';
import { createEdge } from '@/__tests__/fixtures/edges';
import type { ContextMenuActionConfig } from '@/types/contextMenuActions';

function makeConfig(overrides: Partial<ContextMenuActionConfig> = {}): ContextMenuActionConfig {
  return {
    id: 'a1',
    label: 'Test',
    enabled: true,
    kind: 'copy-text',
    textTemplate: '{node_id}',
    match: { target: 'both' },
    ...overrides,
  } as ContextMenuActionConfig;
}

describe('matchesAction', () => {
  it('disabled config never matches', () => {
    const config = makeConfig({ enabled: false });
    expect(matchesAction(config, 'node', createNode())).toBe(false);
  });

  it('target filtering: node-only action hidden on edges and vice versa', () => {
    const nodeOnly = makeConfig({ match: { target: 'node' } });
    const edgeOnly = makeConfig({ match: { target: 'edge' } });
    const both = makeConfig({ match: { target: 'both' } });
    expect(matchesAction(nodeOnly, 'node', createNode())).toBe(true);
    expect(matchesAction(nodeOnly, 'edge', createEdge())).toBe(false);
    expect(matchesAction(edgeOnly, 'edge', createEdge())).toBe(true);
    expect(matchesAction(edgeOnly, 'node', createNode())).toBe(false);
    expect(matchesAction(both, 'node', createNode())).toBe(true);
    expect(matchesAction(both, 'edge', createEdge())).toBe(true);
  });

  it('node type list: empty list means all, non-empty requires membership', () => {
    const all = makeConfig({ match: { target: 'node', nodeTypes: [] } });
    const onlyCompany = makeConfig({ match: { target: 'node', nodeTypes: ['Company'] } });
    const person = createNode({ node_type: 'Person' });
    expect(matchesAction(all, 'node', person)).toBe(true);
    expect(matchesAction(onlyCompany, 'node', person)).toBe(false);
    expect(matchesAction(onlyCompany, 'node', createNode({ node_type: 'Company' }))).toBe(true);
  });

  it('relationship type list filters edges', () => {
    const config = makeConfig({
      match: { target: 'edge', relationshipTypes: ['PAID'] },
    });
    expect(matchesAction(config, 'edge', createEdge({ relationship_type: 'PAID' }))).toBe(true);
    expect(matchesAction(config, 'edge', createEdge({ relationship_type: 'KNOWS' }))).toBe(false);
  });

  it('exists: property present in properties or a built-in', () => {
    const config = makeConfig({
      match: {
        target: 'node',
        propertyConditions: [{ property: 'email', operator: 'exists' }],
      },
    });
    expect(matchesAction(config, 'node', createNode({ properties: { email: 'a@b.c' } }))).toBe(true);
    expect(matchesAction(config, 'node', createNode({ properties: {} }))).toBe(false);

    const builtin = makeConfig({
      match: {
        target: 'node',
        propertyConditions: [{ property: 'node_type', operator: 'exists' }],
      },
    });
    expect(matchesAction(builtin, 'node', createNode())).toBe(true);
  });

  it('not-empty fails for missing, empty and null values (deferred properties hide the action)', () => {
    const config = makeConfig({
      match: {
        target: 'node',
        propertyConditions: [{ property: 'symbol', operator: 'not-empty' }],
      },
    });
    // deferred/unloaded: properties not present yet
    expect(matchesAction(config, 'node', createNode())).toBe(false);
    expect(matchesAction(config, 'node', createNode({ properties: { symbol: '' } }))).toBe(false);
    expect(matchesAction(config, 'node', createNode({ properties: { symbol: null } }))).toBe(false);
    expect(matchesAction(config, 'node', createNode({ properties: { symbol: 'BRCA1' } }))).toBe(true);
  });

  it('equals / not-equals / contains compare the resolved string', () => {
    const node = createNode({ properties: { status: 'active', name: 'John Smith' } });
    const equals = makeConfig({
      match: { target: 'node', propertyConditions: [{ property: 'status', operator: 'equals', value: 'active' }] },
    });
    const notEquals = makeConfig({
      match: { target: 'node', propertyConditions: [{ property: 'status', operator: 'not-equals', value: 'inactive' }] },
    });
    const contains = makeConfig({
      match: { target: 'node', propertyConditions: [{ property: 'name', operator: 'contains', value: 'Smith' }] },
    });
    const containsMiss = makeConfig({
      match: { target: 'node', propertyConditions: [{ property: 'name', operator: 'contains', value: 'Doe' }] },
    });
    expect(matchesAction(equals, 'node', node)).toBe(true);
    expect(matchesAction(notEquals, 'node', node)).toBe(true);
    expect(matchesAction(contains, 'node', node)).toBe(true);
    expect(matchesAction(containsMiss, 'node', node)).toBe(false);
  });

  it('contains with no value never matches', () => {
    const config = makeConfig({
      match: { target: 'node', propertyConditions: [{ property: 'name', operator: 'contains' }] },
    });
    expect(matchesAction(config, 'node', createNode({ properties: { name: 'x' } }))).toBe(false);
  });

  it('multiple conditions are ANDed', () => {
    const config = makeConfig({
      match: {
        target: 'node',
        propertyConditions: [
          { property: 'status', operator: 'equals', value: 'active' },
          { property: 'email', operator: 'not-empty' },
        ],
      },
    });
    expect(
      matchesAction(config, 'node', createNode({ properties: { status: 'active', email: 'a@b.c' } })),
    ).toBe(true);
    expect(
      matchesAction(config, 'node', createNode({ properties: { status: 'active' } })),
    ).toBe(false);
  });

  it('conditions on built-ins work (node_type equals)', () => {
    const config = makeConfig({
      match: {
        target: 'node',
        propertyConditions: [{ property: 'node_type', operator: 'equals', value: 'Person' }],
      },
    });
    expect(matchesAction(config, 'node', createNode({ node_type: 'Person' }))).toBe(true);
    expect(matchesAction(config, 'node', createNode({ node_type: 'Company' }))).toBe(false);
  });
});
