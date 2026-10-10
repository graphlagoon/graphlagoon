import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { applyAliases, snapshotToGraph, unifyGraph, type NodeOrigin, type UnifySource } from '@/utils/unifyGraph';
import type { MatchSuggestion } from '@/utils/entityResolution';
import type { ErWorkerInput, ErWorkerOutput } from '@/workers/erWorker';
import { provenanceColor } from '@/utils/graphAppearance';
import type { Edge, ExplorationState, GraphContext, Node } from '@/types/graph';
import type {
  CreateInvestigationRequest,
  EntityMatch,
  Investigation,
  InvestigationEvent,
  InvestigationEvidence,
  Hypothesis,
  InvestigationFile,
  InvestigationNote,
  InvestigationRole,
  InvestigationSource,
  MatchStatus,
  SourceMode,
} from '@/types/investigation';

/** One readable source loaded into the workspace (T2). */
export interface SourceGraph extends UnifySource {
  state: ExplorationState | null;
  /** Why the source shows no graph (no snapshot, load failure). */
  error: string | null;
}

export const useInvestigationStore = defineStore('investigation', () => {
  /** The queue (T1). */
  const investigations = ref<Investigation[]>([]);
  /** The open case and its sources. */
  const current = ref<Investigation | null>(null);
  const sources = ref<InvestigationSource[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** Workspace (T2): the readable sources' graphs, their contexts and expansions. */
  const sourceGraphs = ref<SourceGraph[]>([]);
  const contexts = ref<Record<string, GraphContext>>({});
  const expansions = ref<UnifySource[]>([]);
  /** Nodes promoted from enrichment tables (F2.2). shortcut: session only; the journal records them. */
  const derived = ref<UnifySource[]>([]);
  const graphLoading = ref(false);
  const sourceColors = computed<Record<string, string>>(() =>
    Object.fromEntries(sources.value.map((s, i) => [s.id, provenanceColor(i)])),
  );
  /** Entity matches (F2.8); the accepted ones alias their two entities in the unified view. */
  const matches = ref<EntityMatch[]>([]);
  const unified = computed(() =>
    applyAliases(
      unifyGraph([...sourceGraphs.value, ...expansions.value, ...derived.value], contexts.value),
      matches.value.filter((m) => m.status === 'aceito').map((m) => [m.left.uid, m.right.uid]),
    ),
  );

  /** Roles by unified node id (`state.roles`), notes and the journal (F1.7). */
  const roles = computed<Record<string, InvestigationRole>>(
    () => (current.value?.state?.roles as Record<string, InvestigationRole> | undefined) ?? {},
  );
  const notes = ref<InvestigationNote[]>([]);
  const events = ref<InvestigationEvent[]>([]);
  /** Case files (F2.3), newest first. */
  const files = ref<InvestigationFile[]>([]);

  async function fetchFiles() {
    if (current.value) files.value = await api.getInvestigationFiles(current.value.id);
  }

  /** After the file wizard (F2.5): new rows, and the generated source if any (opens via the sources watch). */
  function addFiles(rows: InvestigationFile[], source: InvestigationSource | null) {
    const ids = new Set(rows.map((r) => r.id));
    files.value = [...rows, ...files.value.filter((f) => !ids.has(f.id))];
    if (source) sources.value.push(source);
    void fetchEvents();
  }

  async function setRole(entity: string, role: InvestigationRole | null) {
    if (!current.value) return;
    current.value = await api.updateInvestigationState(current.value.id, { roles: { [entity]: role } });
    void fetchEvents();
  }

  async function fetchNotes() {
    if (current.value) notes.value = await api.getInvestigationNotes(current.value.id);
  }

  async function fetchEvents() {
    if (current.value) events.value = await api.getInvestigationEvents(current.value.id);
  }

  async function addNote(anchor: InvestigationNote['anchor'], body: string) {
    if (!current.value) return;
    notes.value.push(await api.createInvestigationNote(current.value.id, anchor, body));
    void fetchEvents();
  }

  async function deleteNote(noteId: string) {
    if (!current.value) return;
    await api.deleteInvestigationNote(current.value.id, noteId);
    notes.value = notes.value.filter((n) => n.id !== noteId);
    void fetchEvents();
  }

  /** Frozen evidence (F4.1), oldest first: E1, E2, … */
  const evidence = ref<InvestigationEvidence[]>([]);

  async function fetchEvidence() {
    if (current.value) evidence.value = await api.getInvestigationEvidence(current.value.id);
  }

  async function pinEvidence(body: Pick<InvestigationEvidence, 'title' | 'kind' | 'params'> & { snapshot: unknown }) {
    if (!current.value) return null;
    const row = await api.createInvestigationEvidence(current.value.id, body);
    evidence.value = [...evidence.value, row];
    void fetchEvents();
    return row;
  }

  /** Hypotheses of the case (`state.hypotheses`, F4.2). */
  const hypotheses = computed<Hypothesis[]>(() => (current.value?.state?.hypotheses as Hypothesis[] | undefined) ?? []);

  async function addHypothesis(body: Parameters<typeof api.createInvestigationHypothesis>[1]) {
    if (!current.value) return;
    current.value = await api.createInvestigationHypothesis(current.value.id, body);
    void fetchEvents();
  }

  async function updateHypothesis(hypothesisId: string, patch: Parameters<typeof api.updateInvestigationHypothesis>[2]) {
    if (!current.value) return;
    current.value = await api.updateInvestigationHypothesis(current.value.id, hypothesisId, patch);
    void fetchEvents();
  }

  /** F4.5: the server freezes the case; the store just takes the frozen copy. */
  async function recordDecision(body: Parameters<typeof api.recordInvestigationDecision>[1]) {
    if (!current.value) return;
    const id = current.value.id;
    current.value = await api.recordInvestigationDecision(id, body);
    sources.value = await api.getInvestigationSources(id);
    void fetchEvents();
  }

  async function fetchInvestigations() {
    loading.value = true;
    error.value = null;
    try {
      investigations.value = await api.getInvestigations();
    } catch (e) {
      error.value = getErrorMessage(e, 'Failed to load investigations');
    } finally {
      loading.value = false;
    }
  }

  async function createInvestigation(data: CreateInvestigationRequest) {
    const created = await api.createInvestigation(data);
    investigations.value.unshift({ ...created, source_count: 0 });
    return created;
  }

  async function openInvestigation(id: string) {
    loading.value = true;
    error.value = null;
    try {
      const [inv, srcs] = await Promise.all([
        api.getInvestigation(id),
        api.getInvestigationSources(id),
      ]);
      current.value = inv;
      sources.value = srcs;
    } catch (e) {
      current.value = null;
      sources.value = [];
      error.value = getErrorMessage(e, 'Failed to load investigation');
    } finally {
      loading.value = false;
    }
  }

  async function loadWorkspace() {
    const inv = current.value;
    if (!inv) return;
    graphLoading.value = true;
    fetchMatches().catch(() => {}); // accepted matches alias entities once they arrive
    const readable = sources.value.filter((s) => s.accessible && s.context_id);
    const contextIds = [...new Set(readable.map((s) => s.context_id!))];
    try {
      const [graphs, ctxs] = await Promise.all([
        Promise.all(
          readable.map(async (s): Promise<SourceGraph> => {
            const base = { id: s.id, contextId: s.context_id! };
            try {
              const payload = await api.getInvestigationSourceSnapshot(inv.id, s.id);
              return {
                ...base,
                ...snapshotToGraph(payload.snapshot),
                state: payload.exploration?.state ?? null,
                // shortcut: no query re-run here; an exploration without a snapshot shows empty.
                error: payload.snapshot ? null : 'No saved graph: open the exploration and save it',
              };
            } catch (e) {
              return { ...base, nodes: [], edges: [], state: null, error: getErrorMessage(e, 'Failed to load source') };
            }
          }),
        ),
        Promise.all(contextIds.map((id) => api.getGraphContext(id).catch(() => null))),
      ]);
      sourceGraphs.value = graphs;
      contexts.value = Object.fromEntries(
        ctxs.filter((c): c is GraphContext => c !== null).map((c) => [c.id, c]),
      );
      expansions.value = [];
      derived.value = [];
    } finally {
      graphLoading.value = false;
    }
  }

  /** Unifies an expansion as the source `expansion:<sourceId>` (03 §5.1). */
  function addExpansion(origin: NodeOrigin, nodes: Node[], edges: Edge[]) {
    const id = `expansion:${origin.sourceId}`;
    const base = sourceGraphs.value.find((g) => g.id === origin.sourceId);
    const prev = expansions.value.find((e) => e.id === id);
    // Nodes merge by uid anyway; edges the source (or an earlier expansion) already
    // has would come back as parallel edges.
    const prevNodes = new Set((prev?.nodes ?? []).map((n) => n.node_id));
    const seenEdges = new Set([...(base?.edges ?? []), ...(prev?.edges ?? [])].map((e) => e.edge_id));
    const next: UnifySource = {
      id,
      contextId: origin.contextId,
      nodes: [...(prev?.nodes ?? []), ...nodes.filter((n) => !prevNodes.has(n.node_id))],
      edges: [...(prev?.edges ?? []), ...edges.filter((e) => !seenEdges.has(e.edge_id))],
    };
    expansions.value = [...expansions.value.filter((e) => e.id !== id), next];
  }

  /** Adds (or replaces) promoted nodes and journals the promotion. */
  async function addDerived(source: UnifySource, payload: Record<string, unknown>) {
    if (!current.value) return;
    await api.postInvestigationEvent(current.value.id, 'nodes.promoted', payload);
    derived.value = [...derived.value.filter((d) => d.id !== source.id), source];
    void fetchEvents();
  }

  async function fetchMatches() {
    if (current.value) matches.value = await api.getInvestigationMatches(current.value.id);
  }

  /** Runs entity resolution (erWorker) on the unified graph and stores the new suggestions. */
  async function findMatches(): Promise<number> {
    if (!current.value) return 0;
    const nodes = unified.value.nodes.map((n) => ({ uid: n.node_id, properties: { ...(n.properties ?? {}) } }));
    const found = await new Promise<MatchSuggestion[]>((resolve, reject) => {
      const worker = new Worker(new URL('@/workers/erWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<ErWorkerOutput>) => {
        worker.terminate();
        if (e.data.type === 'RESULT') resolve(e.data.matches);
        else reject(new Error(e.data.error));
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message));
      };
      worker.postMessage({ type: 'RUN', nodes } as ErWorkerInput);
    });
    const created = found.length ? await api.addInvestigationMatches(current.value.id, found) : [];
    await fetchMatches();
    if (created.length) void fetchEvents();
    return created.length;
  }

  async function decideMatch(matchId: string, status: Exclude<MatchStatus, 'sugerido'>, reasonText: string) {
    if (!current.value) return;
    const updated = await api.decideInvestigationMatch(current.value.id, matchId, status, reasonText);
    matches.value = matches.value.map((m) => (m.id === updated.id ? updated : m));
    void fetchEvents();
  }

  /**
   * Adds explorations one by one (the API takes one per call). Stops at the first
   * failure and reports how many made it, so a partial add is never silent.
   */
  async function addExplorations(
    investigationId: string,
    explorationIds: string[],
    mode: SourceMode,
  ): Promise<{ added: number; error: string | null }> {
    let added = 0;
    try {
      for (const id of explorationIds) {
        const source = await api.addInvestigationSource(investigationId, id, mode);
        if (current.value?.id === investigationId) sources.value.push(source);
        added++;
      }
      return { added, error: null };
    } catch (e) {
      return { added, error: getErrorMessage(e, 'Failed to add exploration') };
    } finally {
      const row = investigations.value.find((i) => i.id === investigationId);
      if (row) row.source_count = (row.source_count ?? 0) + added;
      if (added && current.value?.id === investigationId) fetchEvents().catch(() => {});
    }
  }

  return {
    investigations,
    current,
    sources,
    loading,
    error,
    fetchInvestigations,
    createInvestigation,
    openInvestigation,
    addExplorations,
    sourceGraphs,
    contexts,
    expansions,
    graphLoading,
    sourceColors,
    unified,
    roles,
    notes,
    events,
    files,
    fetchFiles,
    addFiles,
    setRole,
    fetchNotes,
    fetchEvents,
    addNote,
    deleteNote,
    evidence,
    fetchEvidence,
    pinEvidence,
    hypotheses,
    addHypothesis,
    updateHypothesis,
    recordDecision,
    loadWorkspace,
    addExpansion,
    derived,
    addDerived,
    matches,
    fetchMatches,
    findMatches,
    decideMatch,
  };
});
