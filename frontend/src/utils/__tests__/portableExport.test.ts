import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '../portableExport';

describe('buildSourceSchema', () => {
  it('unions declared and loaded types, sorted and deduplicated', () => {
    const schema = buildSourceSchema({
      context: {
        title: 'Fraud',
        node_types: ['Person'],
        relationship_types: ['KNOWS'],
        node_properties: [{ name: 'name', data_type: 'string' }],
        edge_properties: [{ name: 'since', data_type: 'date' }],
      },
      loadedNodeTypes: ['Company', 'Person'],
      loadedEdgeTypes: ['WORKS_AT'],
    });
    expect(schema.context_title).toBe('Fraud');
    expect(schema.node_types).toEqual(['Company', 'Person']);
    expect(schema.relationship_types).toEqual(['KNOWS', 'WORKS_AT']);
    expect(schema.node_properties).toEqual(['name']);
    expect(schema.edge_properties).toEqual(['since']);
    expect(schema.query_templates).toBeUndefined();
  });

  it('records template ids and parameter ids when given', () => {
    const schema = buildSourceSchema({
      context: null,
      templates: [
        { id: 't1', name: 'Neighbors', parameters: [{ id: 'person', required: true } as any] },
      ],
    });
    expect(schema.node_types).toEqual([]);
    expect(schema.query_templates).toEqual([{ id: 't1', name: 'Neighbors', parameters: ['person'] }]);
  });
});

describe('safeFilename', () => {
  it('strips characters a filesystem may reject', () => {
    expect(safeFilename('style-Meu Contexto/2026')).toBe('style-Meu-Contexto-2026.json');
    expect(safeFilename('///')).toBe('export.json');
  });
});

describe('downloadJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads pretty JSON and revokes the object URL', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadJson('a.json', { a: 1 });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as unknown as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe('{\n  "a": 1\n}');
    expect(click).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
    vi.useRealTimers();
  });
});

describe('readFileAsText', () => {
  it('resolves with the file contents', async () => {
    const file = new File(['{"x":1}'], 'x.json', { type: 'application/json' });
    await expect(readFileAsText(file)).resolves.toBe('{"x":1}');
  });
});
