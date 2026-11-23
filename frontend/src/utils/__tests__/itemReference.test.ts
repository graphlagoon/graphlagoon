import { describe, it, expect } from 'vitest';
import { itemRefOf } from '@/utils/itemReference';

const ids = { nodes: new Set(['acc-1', '3']), edges: new Set(['e9']) };

describe('itemRefOf', () => {
  it('text that equals a loaded id is a link, whatever the column', () => {
    expect(itemRefOf('boss', 'acc-1', ids)).toEqual({ type: 'node', id: 'acc-1' });
    expect(itemRefOf('via', 'e9', ids)).toEqual({ type: 'edge', id: 'e9' });
    expect(itemRefOf('boss', 'acc-2', ids)).toBeNull();
  });

  it.each(['id', 'account_id', 'accountId', 'ACCOUNT_ID', 'src', 'parent'])('a number links in an id column (%s)', (column) => {
    expect(itemRefOf(column, 3, ids)).toEqual({ type: 'node', id: '3' });
    expect(itemRefOf(column, '3', ids)).toEqual({ type: 'node', id: '3' });
  });

  it.each(['age', 'paid', 'valid', 'grid'])('a number elsewhere is a quantity (%s)', (column) => {
    expect(itemRefOf(column, '3', ids)).toBeNull();
  });

  it('ignores empty and structured values', () => {
    expect(itemRefOf('id', '', ids)).toBeNull();
    expect(itemRefOf('id', null, ids)).toBeNull();
    expect(itemRefOf('id', ['3'], ids)).toBeNull();
  });
});
