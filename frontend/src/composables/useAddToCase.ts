/**
 * "Adicionar ao caso" from anywhere (05 §4): one composable behind every
 * button outside the case (toolbar, console, tables, selection, explorations)
 * and inside it (popover, drop/paste). The target is the current case unless
 * `caseId` says otherwise; every add ends in one toast "Adicionado ao caso …
 * · ver" that opens the case.
 */
import { computed, unref, type MaybeRef } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/services/api';
import { useCurrentCaseStore } from '@/stores/currentCase';
import { useInvestigationStore } from '@/stores/investigation';
import { useGraphStore } from '@/stores/graph';
import { useToast } from '@/composables/useToast';
import { getErrorMessage } from '@/utils/errorMessage';
import type { CaseItem, CaseQuerySpec, CreateItemRequest, ItemAnchor, ItemProvenance } from '@/types/investigation';
import type { TemplateParameter } from '@/types/graph';

export interface TableInput {
  columns: string[];
  rows: unknown[][];
  title: string;
  provenance?: ItemProvenance;
  description?: string;
}

export interface SaveQueryInput {
  context_id: string;
  text: string;
  language: 'sql' | 'cypher';
  parameters?: TemplateParameter[];
  output?: 'table' | 'graph';
  title?: string;
}

const URL_RE = /^https?:\/\/\S+$/i;

/** What a pasted text is: a link, a delimited table (2+ lines, same delimiter count) or a note. */
export function classifyPaste(text: string): { kind: 'url' } | { kind: 'table'; columns: string[]; rows: string[][] } | { kind: 'note' } {
  const trimmed = text.trim();
  if (URL_RE.test(trimmed)) return { kind: 'url' };
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length >= 2) {
    for (const d of ['\t', ';', ',']) {
      const n = lines[0].split(d).length;
      if (n >= 2 && lines.every((l) => l.split(d).length === n)) {
        const cells = lines.map((l) => l.split(d).map((c) => c.trim()));
        return { kind: 'table', columns: cells[0], rows: cells.slice(1) };
      }
    }
  }
  return { kind: 'note' };
}

/** `:name` placeholders of a query (the same rule as the server's `substitute`). */
export function queryParameterNames(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)].map((m) => m[1]))];
}

export function useAddToCase(caseId?: MaybeRef<string | null | undefined>) {
  const current = useCurrentCaseStore();
  const investigation = useInvestigationStore();
  const toast = useToast();
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    router = useRouter();
  } catch {
    router = null; // outside a component (tests): the toast has no "ver"
  }

  const targetId = computed(() => unref(caseId) ?? current.caseId);
  const targetTitle = computed(() =>
    targetId.value === current.caseId ? current.title : investigation.current?.id === targetId.value ? investigation.current.title : '',
  );
  const enabled = computed(() => !!targetId.value && (targetId.value !== current.caseId || current.canAdd || !current.investigation));

  /** The case to add to, or null after telling the person to pick one. */
  function target(): string | null {
    if (!targetId.value) toast.info('Escolha um caso atual na barra superior.');
    return targetId.value;
  }

  function notify(item: CaseItem, id: string) {
    const title = targetTitle.value || item.title;
    const message = `Adicionado ao caso ${title}`;
    if (router && router.currentRoute.value.name !== 'investigation') {
      toast.show(message, 'success', 6000, { label: 'ver', onClick: () => void router!.push(`/investigations/${id}`) });
    } else {
      toast.success(message);
    }
  }

  async function create(data: CreateItemRequest): Promise<CaseItem | null> {
    const id = target();
    if (!id) return null;
    try {
      const item = await api.createInvestigationItem(id, data);
      if (investigation.current?.id === id) await investigation.fetchItems().catch(() => {});
      notify(item, id);
      return item;
    } catch (e) {
      toast.error(getErrorMessage(e, 'Falha ao adicionar ao caso'));
      return null;
    }
  }

  function addTable(input: TableInput) {
    return create({
      kind: 'table',
      subkind: 'result',
      title: input.title,
      description: input.description,
      provenance: input.provenance,
      content_json: { columns: input.columns, rows: input.rows, row_count: input.rows.length },
    });
  }

  /** The current graph filtered to the selection, stored as a `graph/selection` snapshot. */
  function addSelection(nodeIds: Iterable<string>, edgeIds: Iterable<string> = [], title?: string) {
    const graph = useGraphStore();
    const nodes = new Set(nodeIds);
    const edges = new Set(edgeIds);
    // Same shape as the store's buildGraphSnapshot, filtered to the selection.
    const picked = {
      nodes: graph.nodes
        .filter((n) => nodes.has(n.node_id))
        .map((n) => ({ id: n.node_id, type: n.node_type, properties: (n.properties ?? {}) as Record<string, unknown>, x: n.x, y: n.y })),
      edges: graph.edges
        .filter((e) => edges.has(e.edge_id) || (nodes.has(e.src) && nodes.has(e.dst)))
        .map((e) => ({ id: e.edge_id, source: e.src, target: e.dst, type: e.relationship_type, properties: (e.properties ?? {}) as Record<string, unknown> })),
    };
    if (!picked.nodes.length) {
      toast.info('Selecione nós no grafo primeiro.');
      return Promise.resolve(null);
    }
    return create({
      kind: 'graph',
      subkind: 'selection',
      title: title ?? `Seleção · ${picked.nodes.length} nós`,
      context_id: graph.currentContext?.id,
      provenance: { context_id: graph.currentContext?.id, exploration_id: graph.currentExploration?.id ?? undefined, tool: 'selection' },
      anchor: { entity_ids: [...nodes] },
      content_json: picked,
    });
  }

  function addExploration(explorationId: string) {
    return create({ kind: 'graph', subkind: 'exploration_ref', exploration_id: explorationId });
  }

  /** A file (upload), a URL (link document) or text (markdown document). */
  async function addDocument(source: File | string, title?: string): Promise<CaseItem | null> {
    if (source instanceof File) {
      const id = target();
      if (!id) return null;
      const table = /\.(csv|tsv|txt)$/i.test(source.name);
      try {
        const item = await api.uploadInvestigationItem(id, source, {
          kind: table ? 'table' : 'document',
          subkind: table ? 'csv' : 'upload',
          title: title ?? source.name,
        });
        if (investigation.current?.id === id) await investigation.fetchItems().catch(() => {});
        notify(item, id);
        return item;
      } catch (e) {
        toast.error(getErrorMessage(e, 'Falha ao enviar o arquivo'));
        return null;
      }
    }
    const text = source.trim();
    if (URL_RE.test(text)) {
      return create({ kind: 'document', subkind: 'link', title: title ?? text.replace(/^https?:\/\//, '').slice(0, 80), content: text, provenance: { url: text } });
    }
    return create({ kind: 'document', subkind: 'markdown', title: title ?? (text.split('\n')[0] || 'Documento').slice(0, 80), content: text });
  }

  function addNote(text: string, anchor?: ItemAnchor) {
    const body = text.trim();
    return create({
      kind: 'note',
      subkind: anchor?.entity_ids?.length || anchor?.item_id ? 'anchored' : 'free',
      title: body.length > 60 ? `${body.slice(0, 57)}…` : body,
      description: body,
      content: body,
      anchor,
    });
  }

  /** Pasted text → note, link document or table (05 §3). */
  function addPasted(text: string) {
    const what = classifyPaste(text);
    if (what.kind === 'url') return addDocument(text);
    if (what.kind === 'table') return addTable({ columns: what.columns, rows: what.rows, title: `Colado · ${what.rows.length} linhas`, provenance: { tool: 'paste' } });
    return addNote(text);
  }

  /** A saved query of the case: `:name` placeholders become declared parameters. */
  function saveQuery(input: SaveQueryInput) {
    const declared = input.parameters ?? [];
    const parameters: TemplateParameter[] = [
      ...declared,
      ...queryParameterNames(input.text)
        .filter((n) => !declared.some((p) => p.id === n))
        .map((n) => ({ id: n, type: 'input' as const, label: n, required: true })),
    ];
    const query: CaseQuerySpec = { text: input.text, language: input.language, parameters, output: input.output ?? 'table' };
    const firstLine = input.text.trim().split('\n')[0];
    return create({
      kind: 'query',
      subkind: input.language,
      title: input.title ?? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine),
      context_id: input.context_id,
      query,
      provenance: { context_id: input.context_id, tool: 'console' },
    });
  }

  async function runQuery(itemId: string, parameters: Record<string, unknown> = {}): Promise<CaseItem | null> {
    const id = target();
    if (!id) return null;
    try {
      const item = await api.runInvestigationQuery(id, itemId, parameters);
      if (investigation.current?.id === id) await investigation.fetchItems().catch(() => {});
      const run = item.latest?.run as { row_count?: number; duration_ms?: number } | undefined;
      toast.success(`Consulta executada: ${run?.row_count ?? '?'} linhas em ${run?.duration_ms ?? '?'} ms`);
      return item;
    } catch (e) {
      toast.error(getErrorMessage(e, 'Falha ao executar a consulta'));
      return null;
    }
  }

  return { targetId, targetTitle, enabled, addTable, addSelection, addExploration, addDocument, addNote, addPasted, saveQuery, runQuery };
}
