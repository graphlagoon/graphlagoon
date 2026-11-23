/**
 * Does a value shown in the details name a node or an edge of the graph? Then
 * it is a link that moves the focus there.
 */
export interface ItemRef {
  type: 'node' | 'edge';
  id: string;
}

export interface LoadedIds {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

/** Columns that hold ids: `id`, `owner_id`, `ownerId`, `OWNER_ID`, `src`, `parent`… */
const ID_COLUMN = /(^|_)(id|src|dst|source|target|parent|owner)$/i;
const ID_CAMEL = /[a-z0-9]I[dD]$/;

/**
 * A number is usually a quantity, so it only counts as an id in a column named
 * like one ("age: 3" must not link to the node "3"); any other text that equals
 * a loaded id does.
 */
export function itemRefOf(column: string, value: unknown, ids: LoadedIds): ItemRef | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  if (id === '') return null;
  const numeric = !Number.isNaN(Number(id));
  if (numeric && !(ID_COLUMN.test(column) || ID_CAMEL.test(column))) return null;
  if (ids.nodes.has(id)) return { type: 'node', id };
  if (ids.edges.has(id)) return { type: 'edge', id };
  return null;
}
