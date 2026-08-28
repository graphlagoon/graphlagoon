/**
 * Helpers shared by every "export as JSON file / import from JSON file" flow:
 * building the `source` schema block of a portable envelope, downloading a
 * JSON blob, and reading a picked file back as text.
 */
import type { GraphContext, QueryTemplate } from '@/types/graph';
import type { PortableSourceSchema } from '@/types/portable';

function uniqSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Describe the current graph so a reader (human or LLM) knows which names the
 * exported payload refers to. Declared types (context config) and loaded types
 * (whatever the canvas holds) are unioned: a nodeless/typeless context may
 * declare nothing, and an empty canvas may have loaded nothing.
 */
export function buildSourceSchema(input: {
  context: Pick<
    GraphContext,
    'title' | 'node_types' | 'relationship_types' | 'node_properties' | 'edge_properties'
  > | null;
  loadedNodeTypes?: string[];
  loadedEdgeTypes?: string[];
  templates?: Pick<QueryTemplate, 'id' | 'name' | 'parameters'>[];
}): PortableSourceSchema {
  const { context, loadedNodeTypes = [], loadedEdgeTypes = [], templates } = input;
  const schema: PortableSourceSchema = {
    context_title: context?.title || undefined,
    node_types: uniqSorted([...(context?.node_types ?? []), ...loadedNodeTypes]),
    relationship_types: uniqSorted([
      ...(context?.relationship_types ?? []),
      ...loadedEdgeTypes,
    ]),
    node_properties: (context?.node_properties ?? []).map((p) => p.name),
    edge_properties: (context?.edge_properties ?? []).map((p) => p.name),
  };
  if (templates) {
    schema.query_templates = templates.map((t) => ({
      id: t.id,
      name: t.name,
      parameters: t.parameters.map((p) => p.id),
    }));
  }
  return schema;
}

/** Keep a filename to something every OS accepts. */
export function safeFilename(base: string, extension = '.json'): string {
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${cleaned || 'export'}${extension}`;
}

/** Trigger a browser download of `data` serialized as pretty JSON. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  // The click has already handed the blob to the download; the object URL
  // only leaks memory from here on.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a file the user picked with `<input type="file">` as UTF-8 text. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}
