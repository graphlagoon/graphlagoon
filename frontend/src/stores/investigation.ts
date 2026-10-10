import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { applyAliases, snapshotToGraph, unifyGraph, type NodeOrigin, type UnifySource } from '@/utils/unifyGraph';
import { provenanceColor } from '@/utils/graphAppearance';
import { groupColor, vocabularyOf } from '@/utils/casePresets';
import type { Edge, EdgeSemanticsByType, ExplorationState, GraphContext, IdentityKey, Node } from '@/types/graph';
import type {
  CaseAnnotation,
  CaseBrief,
  CaseItem,
  CaseViewContent,
  CreateAnnotationRequest,
  CreateInvestigationRequest,
  CreateItemRequest,
  GroupValue,
  Investigation,
  InvestigationEvent,
  ItemProvenance,
  ShareRole,
  UpdateInvestigationRequest,
  UpdateItemRequest,
} from '@/types/investigation';

/** One graph item loaded into the workspace (its snapshot in the store's shape). */
export interface SourceGraph extends UnifySource {
  state: ExplorationState | null;
  /** Why the item shows no graph (no snapshot, load failure). */
  error: string | null;
}

/** A confirmed `group` annotation, resolved for the UI (05 §5). */
export interface CaseGroup {
  id: string;
  name: string;
  color: string;
  targets: string[];
  by?: string;
  author_kind: CaseAnnotation['author_kind'];
}

/** An analysis saved as an item (05 §3 "Resultado = item"): the content of its latest version. */
export interface AnalysisSpec {
  tool: 'trace' | 'paths' | 'typologies' | 'links' | 'metrics' | 'communities';
  title: string;
  kind: 'table' | 'graph';
  subkind: CaseItem['subkind'];
  params: Record<string, unknown>;
  content: unknown;
  /** Re-run: a new version of this item instead of a new item. */
  itemId?: string | null;
  description?: string;
}

/** Items that put nodes on the canvas (a saved view is chips + layout only). */
export function isGraphItem(item: CaseItem): boolean {
  if (item.deleted_at || item.status === 'rejected') return false;
  if (item.kind === 'graph') return item.subkind !== 'view';
  if (item.kind === 'table') return item.mapping?.as === 'graph';
  if (item.kind === 'query') return item.query?.output === 'graph';
  return false;
}

export const useInvestigationStore = defineStore('investigation', () => {
  /** The queue. */
  const investigations = ref<Investigation[]>([]);
  /** The open case and its material (05 §1). */
  const current = ref<Investigation | null>(null);
  const items = ref<CaseItem[]>([]);
  const annotations = ref<CaseAnnotation[]>([]);
  const events = ref<InvestigationEvent[]>([]);
  const brief = ref<CaseBrief>({ item: null, text: '' });
  const loading = ref(false);
  const error = ref<string | null>(null);

  const graphItems = computed(() => items.value.filter(isGraphItem));
  /** Graph items the person unchecked ("no canvas"): nodes leave without a layout reset. */
  const offCanvas = ref<Set<string>>(new Set());
  const canvasItems = computed(() => graphItems.value.filter((i) => i.accessible && !offCanvas.value.has(i.id)));
  const restrictedItems = computed(() => graphItems.value.filter((i) => !i.accessible));

  /** Workspace: each canvas item's graph, the contexts (or per-item keys) and expansions. */
  const sourceGraphs = ref<SourceGraph[]>([]);
  const contexts = ref<Record<string, GraphContext>>({});
  const expansions = ref<UnifySource[]>([]);
  /** Nodes promoted from enrichment tables. shortcut: session only; the journal records them. */
  const derived = ref<UnifySource[]>([]);
  const graphLoading = ref(false);
  const sourceColors = computed<Record<string, string>>(() =>
    Object.fromEntries(graphItems.value.map((s, i) => [s.id, provenanceColor(i)])),
  );
  const sameAs = computed<[string, string][]>(() =>
    annotations.value
      .filter((a) => a.kind === 'same_as' && a.status === 'confirmed' && a.targets.length === 2)
      .map((a) => [a.targets[0], a.targets[1]]),
  );
  const unified = computed(() => {
    const overrides = (current.value?.settings?.identity_keys as IdentityKey[] | undefined) ?? [];
    const edgeOverrides = (current.value?.settings?.edge_semantics as EdgeSemanticsByType | undefined) ?? null;
    return applyAliases(
      unifyGraph(
        [...sourceGraphs.value.filter((g) => !offCanvas.value.has(g.id)), ...expansions.value, ...derived.value],
        contexts.value,
        overrides,
        edgeOverrides,
      ),
      sameAs.value,
    );
  });
  /** Dated edges exist: trace, paths by time and the timeline have something to work with. */
  const hasAmounts = computed(() => unified.value.edges.some((e) => e.__amount !== undefined && e.__t !== undefined));
  const hasTimes = computed(() => unified.value.edges.some((e) => e.__t !== undefined));

  /** Confirmed roles by unified node id (annotations kind role). */
  const roles = computed<Record<string, string>>(() =>
    Object.fromEntries(
      annotations.value
        .filter((a) => a.kind === 'role' && a.status === 'confirmed' && a.targets.length === 1)
        .map((a) => [a.targets[0], String(a.value.role)]),
    ),
  );
  /** Confirmed tags by unified node id. */
  const entityTags = computed<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>();
    for (const a of annotations.value) {
      if (a.kind !== 'tag' || a.status !== 'confirmed') continue;
      for (const t of a.targets) map.set(t, [...new Set([...(map.get(t) ?? []), String(a.value.tag)])]);
    }
    return map;
  });
  const tagsUsed = computed(() => [...new Set([...entityTags.value.values()].flat())].sort());
  /** Confirmed groups (05 §5), in creation order. */
  const groups = computed<CaseGroup[]>(() =>
    annotations.value
      .filter((a) => a.kind === 'group' && a.status === 'confirmed')
      .map((a, i) => {
        const v = a.value as GroupValue;
        return { id: a.id, name: v.name ?? `Group ${i + 1}`, color: groupColor(v.color, i), targets: a.targets, by: v.by, author_kind: a.author_kind };
      }),
  );
  const groupsClosed = computed<string[]>(() => (current.value?.state?.groups_closed as string[] | undefined) ?? []);
  const vocabulary = computed(() => vocabularyOf(current.value?.settings, current.value?.kind_preset));
  const labelTemplates = computed(() => (current.value?.settings?.label_templates as Record<string, string> | undefined) ?? null);
  /** Saved views (`graph/view` items). */
  const views = computed(() => items.value.filter((i) => i.kind === 'graph' && i.subkind === 'view' && !i.deleted_at));
  /** Analyses: results saved as items, newest first. */
  const analyses = computed(() =>
    items.value
      .filter((i) => !i.deleted_at && i.provenance?.tool && ['trace', 'paths', 'typologies', 'links', 'metrics', 'communities'].includes(String(i.provenance.tool)))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
  );
  const hypotheses = computed(() => annotations.value.filter((a) => a.kind === 'hypothesis'));
  const suggestions = computed(() => [
    ...items.value.filter((i) => i.status === 'suggested').map((i) => ({ kind: 'item' as const, item: i })),
    ...annotations.value.filter((a) => a.status === 'suggested').map((a) => ({ kind: 'annotation' as const, annotation: a })),
  ]);
  /** Pinned versions across items, oldest first: E1, E2, … */
  const evidence = computed(() =>
    items.value
      .flatMap((i) => i.pinned.map((v) => ({ item: i, version: v })))
      .sort((a, b) => (a.version.pinned_at ?? '').localeCompare(b.version.pinned_at ?? '')),
  );
  const notes = computed(() => items.value.filter((i) => i.kind === 'note'));

  const itemTitle = (itemId: string) => items.value.find((i) => i.id === itemId)?.title ?? itemId;

  // --- queue and case ---------------------------------------------------------

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
    investigations.value.unshift({ ...created, item_count: 0, suggested_count: 0 });
    return created;
  }

  function syncRow(inv: Investigation) {
    const i = investigations.value.findIndex((r) => r.id === inv.id);
    if (i >= 0) investigations.value[i] = { ...inv, item_count: investigations.value[i].item_count, suggested_count: investigations.value[i].suggested_count };
  }

  /** Header edits: the server answers with the whole case (deadline recomputed). */
  async function updateInvestigation(patch: UpdateInvestigationRequest) {
    if (!current.value) return;
    current.value = await api.updateInvestigation(current.value.id, patch);
    syncRow(current.value);
    void fetchEvents();
  }

  async function shareInvestigation(email: string, role: ShareRole) {
    if (!current.value) return;
    await api.shareInvestigation(current.value.id, email, role);
    const rest = current.value.shared_with.filter((s) => s.email !== email);
    current.value = { ...current.value, shared_with: [...rest, { email, role }] };
    void fetchEvents();
  }

  async function unshareInvestigation(email: string) {
    if (!current.value) return;
    await api.unshareInvestigation(current.value.id, email);
    current.value = { ...current.value, shared_with: current.value.shared_with.filter((s) => s.email !== email) };
    void fetchEvents();
  }

  async function deleteInvestigation() {
    if (!current.value) return;
    const id = current.value.id;
    await api.deleteInvestigation(id);
    investigations.value = investigations.value.filter((i) => i.id !== id);
    current.value = null;
  }

  async function reopenInvestigation() {
    if (!current.value) return;
    current.value = await api.reopenInvestigation(current.value.id);
    syncRow(current.value);
    void fetchEvents();
  }

  /** The server freezes the case; the store just takes the frozen copy. */
  async function recordDecision(body: Parameters<typeof api.recordInvestigationDecision>[1]) {
    if (!current.value) return;
    current.value = await api.recordInvestigationDecision(current.value.id, body);
    syncRow(current.value);
    void fetchEvents();
  }

  async function openInvestigation(id: string) {
    loading.value = true;
    error.value = null;
    if (current.value?.id !== id) {
      // Another case's lists must not show while this one loads.
      current.value = null;
      items.value = [];
      annotations.value = [];
      events.value = [];
      brief.value = { item: null, text: '' };
      offCanvas.value = new Set();
      sourceGraphs.value = [];
      expansions.value = [];
      derived.value = [];
      contents.value = {};
    }
    try {
      const [inv, rows, notes] = await Promise.all([
        api.getInvestigation(id),
        api.getInvestigationItems(id),
        api.getInvestigationAnnotations(id),
      ]);
      current.value = inv;
      items.value = rows;
      annotations.value = notes;
    } catch (e) {
      current.value = null;
      items.value = [];
      error.value = getErrorMessage(e, 'Failed to load investigation');
    } finally {
      loading.value = false;
    }
  }

  // --- material ---------------------------------------------------------------

  async function fetchItems() {
    if (current.value) items.value = await api.getInvestigationItems(current.value.id);
  }

  function upsertItem(item: CaseItem) {
    const i = items.value.findIndex((x) => x.id === item.id);
    if (i >= 0) items.value[i] = item;
    else items.value.push(item);
    const row = investigations.value.find((x) => x.id === current.value?.id);
    if (row && i < 0) row.item_count = (row.item_count ?? 0) + 1;
  }

  async function addItem(data: CreateItemRequest): Promise<CaseItem | null> {
    if (!current.value) return null;
    const item = await api.createInvestigationItem(current.value.id, data);
    upsertItem(item);
    void fetchEvents();
    return item;
  }

  async function uploadItem(file: File, params: Parameters<typeof api.uploadInvestigationItem>[2]): Promise<CaseItem | null> {
    if (!current.value) return null;
    const item = await api.uploadInvestigationItem(current.value.id, file, params);
    upsertItem(item);
    void fetchEvents();
    return item;
  }

  async function updateItem(itemId: string, patch: UpdateItemRequest) {
    if (!current.value) return;
    upsertItem(await api.updateInvestigationItem(current.value.id, itemId, patch));
    void fetchEvents();
  }

  async function addVersion(itemId: string, body: { content?: string; content_json?: unknown }) {
    if (!current.value) return;
    upsertItem(await api.addInvestigationItemVersion(current.value.id, itemId, body));
    void fetchEvents();
  }

  async function removeItem(itemId: string) {
    if (!current.value) return;
    await api.deleteInvestigationItem(current.value.id, itemId);
    items.value = items.value.filter((i) => i.id !== itemId);
    sourceGraphs.value = sourceGraphs.value.filter((g) => g.id !== itemId);
    const row = investigations.value.find((i) => i.id === current.value?.id);
    if (row) row.item_count = Math.max(0, (row.item_count ?? 1) - 1);
    void fetchEvents();
  }

  async function pinItem(itemId: string, body: { version?: number; label?: string } = {}) {
    if (!current.value) return null;
    const version = await api.pinInvestigationItem(current.value.id, itemId, body);
    await fetchItems();
    void fetchEvents();
    return version;
  }

  async function setItemStatus(itemId: string, status: 'confirmed' | 'rejected') {
    if (!current.value) return;
    upsertItem(await api.setInvestigationItemStatus(current.value.id, itemId, status));
    void fetchEvents();
  }

  async function runQuery(itemId: string, parameters: Record<string, unknown> = {}) {
    if (!current.value) return null;
    const item = await api.runInvestigationQuery(current.value.id, itemId, parameters);
    upsertItem(item);
    void fetchEvents();
    return item;
  }

  function toggleCanvas(itemId: string, on: boolean) {
    const next = new Set(offCanvas.value);
    if (on) next.delete(itemId);
    else next.add(itemId);
    offCanvas.value = next;
  }

  /**
   * Adds explorations as live references, one by one (the API takes one per call).
   * Stops at the first failure and reports how many made it.
   */
  async function addExplorations(investigationId: string, explorationIds: string[]): Promise<{ added: number; error: string | null }> {
    let added = 0;
    try {
      for (const id of explorationIds) {
        const item = await api.createInvestigationItem(investigationId, { kind: 'graph', subkind: 'exploration_ref', exploration_id: id });
        if (current.value?.id === investigationId) upsertItem(item);
        added++;
      }
      return { added, error: null };
    } catch (e) {
      return { added, error: getErrorMessage(e, 'Failed to add exploration') };
    } finally {
      const row = investigations.value.find((i) => i.id === investigationId);
      if (row && current.value?.id !== investigationId) row.item_count = (row.item_count ?? 0) + added;
      if (added && current.value?.id === investigationId) fetchEvents().catch(() => {});
    }
  }

  /**
   * Freezes an analysis result or a graph as an item and pins it (evidence).
   * Returns the pinned version (sha256).
   */
  async function pinEvidence(body: { title: string; kind: 'trace' | 'graph_state' | 'table'; params: Record<string, unknown>; snapshot: unknown }) {
    if (!current.value) return null;
    const item = await addItem(
      body.kind === 'graph_state'
        ? { kind: 'graph', subkind: 'snapshot', title: body.title, content_json: body.snapshot, provenance: { tool: 'graph_state', params: body.params } }
        : { kind: 'table', subkind: 'result', title: body.title, content_json: body.snapshot, provenance: { tool: body.kind, params: body.params } },
    );
    if (!item) return null;
    // A frozen graph stays out of the canvas: it duplicates what is already there.
    if (body.kind === 'graph_state') toggleCanvas(item.id, false);
    return pinItem(item.id);
  }

  async function fetchBrief() {
    if (current.value) brief.value = await api.getInvestigationBrief(current.value.id);
  }

  async function saveBrief(text: string) {
    if (!current.value) return;
    brief.value = await api.putInvestigationBrief(current.value.id, text);
    if (brief.value.item) upsertItem(brief.value.item);
    void fetchEvents();
  }

  // --- annotations ------------------------------------------------------------

  async function fetchAnnotations() {
    if (current.value) annotations.value = await api.getInvestigationAnnotations(current.value.id);
  }

  async function addAnnotation(data: CreateAnnotationRequest): Promise<CaseAnnotation | null> {
    if (!current.value) return null;
    const row = await api.createInvestigationAnnotation(current.value.id, data);
    await fetchAnnotations(); // a confirmed role replaces the previous one server-side
    void fetchEvents();
    return row;
  }

  async function setAnnotationStatus(annotationId: string, status: 'confirmed' | 'rejected') {
    if (!current.value) return;
    await api.setInvestigationAnnotationStatus(current.value.id, annotationId, status);
    await fetchAnnotations();
    if (status === 'confirmed') current.value = await api.getInvestigation(current.value.id); // a status_change moves the case
    void fetchEvents();
  }

  async function deleteAnnotation(annotationId: string) {
    if (!current.value) return;
    await api.deleteInvestigationAnnotation(current.value.id, annotationId);
    annotations.value = annotations.value.filter((a) => a.id !== annotationId);
    void fetchEvents();
  }

  /** Sets (or clears) the confirmed role of an entity. */
  async function setRole(entity: string, role: string | null) {
    if (role) {
      await addAnnotation({ kind: 'role', targets: [entity], value: { role } });
      return;
    }
    const existing = annotations.value.find((a) => a.kind === 'role' && a.status === 'confirmed' && a.targets[0] === entity);
    if (existing) await deleteAnnotation(existing.id);
  }

  async function addHypothesis(text: string) {
    return addAnnotation({ kind: 'hypothesis', value: { text, status: 'open' } });
  }

  async function updateHypothesis(annotationId: string, patch: { status?: string; evidence_for?: string[]; evidence_against?: string[]; text?: string }) {
    if (!current.value) return;
    if (patch.status) {
      await addAnnotation({ kind: 'hypothesis_status', targets: [annotationId], value: { status: patch.status } });
    }
    const { status: _s, ...rest } = patch;
    if (Object.keys(rest).length) {
      await api.updateInvestigationAnnotation(current.value.id, annotationId, { value: rest });
      await fetchAnnotations();
      void fetchEvents();
    }
  }

  /** A note anchored on an entity (item note/anchored). */
  async function addNote(entityId: string | null, body: string) {
    // The body is also the description, so the inspector shows it without fetching the version.
    return addItem({
      kind: 'note',
      subkind: entityId ? 'anchored' : 'free',
      title: body.length > 60 ? `${body.slice(0, 57)}…` : body,
      description: body,
      content: body,
      anchor: entityId ? { entity_ids: [entityId] } : undefined,
    });
  }

  /** Runs entity resolution on the server; new pairs arrive as suggested same_as. */
  async function findMatches(): Promise<number> {
    if (!current.value) return 0;
    const created = await api.runInvestigationEntityResolution(current.value.id);
    await fetchAnnotations();
    if (created.length) void fetchEvents();
    return created.length;
  }

  async function fetchEvents() {
    if (current.value) events.value = await api.getInvestigationEvents(current.value.id);
  }

  // --- canvas -----------------------------------------------------------------

  async function loadWorkspace() {
    const inv = current.value;
    if (!inv) return;
    graphLoading.value = true;
    const readable = graphItems.value.filter((s) => s.accessible);
    try {
      const graphs = await Promise.all(
        readable.map(async (s): Promise<SourceGraph> => {
          const contextId = s.context_id ?? s.id;
          const base = { id: s.id, contextId };
          try {
            const payload = await api.getInvestigationItemSnapshot(inv.id, s.id);
            // Mapped tables and stored snapshots carry their own keys: a pseudo-context per item.
            if (!s.context_id) {
              contexts.value[s.id] = {
                id: s.id,
                title: s.title,
                identity_keys: payload.identity_keys ?? [],
                edge_semantics: payload.edge_semantics ?? undefined,
              } as unknown as GraphContext;
            }
            return {
              ...base,
              ...snapshotToGraph(payload.snapshot),
              unified: !!payload.unified,
              state: payload.exploration?.state ?? null,
              // shortcut: no query re-run here; an exploration without a snapshot shows empty.
              error: payload.snapshot ? null : 'No saved graph: open the exploration and save it',
            };
          } catch (e) {
            return { ...base, nodes: [], edges: [], state: null, error: getErrorMessage(e, 'Failed to load item') };
          }
        }),
      );
      const contextIds = [...new Set(readable.map((s) => s.context_id).filter(Boolean) as string[])];
      const ctxs = await Promise.all(contextIds.map((id) => api.getGraphContext(id).catch(() => null)));
      for (const c of ctxs) if (c) contexts.value[c.id] = c;
      sourceGraphs.value = graphs;
      expansions.value = [];
      derived.value = [];
    } finally {
      graphLoading.value = false;
    }
  }

  /** Unifies an expansion as the source `expansion:<itemId>`. */
  function addExpansion(origin: NodeOrigin, nodes: Node[], edges: Edge[]) {
    const id = `expansion:${origin.sourceId}`;
    const base = sourceGraphs.value.find((g) => g.id === origin.sourceId);
    const prev = expansions.value.find((e) => e.id === id);
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

  async function postEvent(kind: string, payload: Record<string, unknown> = {}) {
    if (!current.value) return;
    await api.postInvestigationEvent(current.value.id, kind, payload);
    void fetchEvents();
  }

  // --- item contents, analyses, views, groups (F4) ----------------------------

  /** JSON content of the latest version, by `${item}:${version}`; filled on creation, else fetched. */
  const contents = ref<Record<string, unknown>>({});
  const contentKey = (item: CaseItem) => `${item.id}:${item.current_version}`;

  function rememberContent(item: CaseItem, json: unknown) {
    contents.value = { ...contents.value, [contentKey(item)]: json };
  }

  async function loadItemJson<T = unknown>(item: CaseItem): Promise<T | null> {
    if (!current.value || !item.current_version) return null;
    const key = contentKey(item);
    if (key in contents.value) return contents.value[key] as T;
    const buffer = await api.getInvestigationItemContent(current.value.id, item.id);
    let json: unknown = null;
    try {
      json = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      json = null;
    }
    rememberContent(item, json);
    return json as T | null;
  }

  /** Saves an analysis result as an item (new) or as a new version (re-run); provenance carries tool and params. */
  async function saveAnalysis(spec: AnalysisSpec): Promise<CaseItem | null> {
    if (!current.value) return null;
    const provenance: ItemProvenance = { tool: spec.tool, params: spec.params, engine: 'browser' };
    let item: CaseItem | null;
    if (spec.itemId) {
      item = await api.addInvestigationItemVersion(current.value.id, spec.itemId, { content_json: spec.content });
      upsertItem(item);
      void fetchEvents();
    } else {
      item = await addItem({
        kind: spec.kind,
        subkind: spec.subkind,
        title: spec.title,
        description: spec.description,
        provenance,
        content_json: spec.content,
      });
    }
    if (item) rememberContent(item, spec.content);
    return item;
  }

  /** View-only state (`state.groups_closed`, …): merged, never replaced. */
  async function saveState(patch: Record<string, unknown>) {
    if (!current.value) return;
    await updateInvestigation({ state: { ...(current.value.state ?? {}), ...patch } });
  }

  async function setGroupClosed(groupId: string, closed: boolean) {
    const set = new Set(groupsClosed.value);
    if (closed) set.add(groupId);
    else set.delete(groupId);
    await saveState({ groups_closed: [...set] });
  }

  /** A group from a selection or a rule (05 §5): a confirmed `group` annotation. */
  async function addGroup(name: string, targets: string[], options: { color?: string | number; by?: string; closed?: boolean } = {}) {
    const row = await addAnnotation({ kind: 'group', targets, value: { name, color: options.color ?? groups.value.length, by: options.by } });
    if (row && options.closed) await setGroupClosed(row.id, true);
    return row;
  }

  async function renameGroup(groupId: string, patch: Partial<GroupValue>) {
    if (!current.value) return;
    const g = annotations.value.find((a) => a.id === groupId);
    if (!g) return;
    await api.updateInvestigationAnnotation(current.value.id, groupId, { value: { ...g.value, ...patch } });
    await fetchAnnotations();
  }

  /** Replaces the confirmed tags of an entity (one annotation per tag). */
  async function setTags(entity: string, tags: string[]) {
    if (!current.value) return;
    const wanted = new Set(tags.map((t) => t.trim()).filter(Boolean));
    const mine = annotations.value.filter((a) => a.kind === 'tag' && a.status === 'confirmed' && a.targets.length === 1 && a.targets[0] === entity);
    for (const a of mine) if (!wanted.has(String(a.value.tag))) await api.deleteInvestigationAnnotation(current.value.id, a.id);
    const have = new Set(mine.map((a) => String(a.value.tag)));
    for (const t of wanted) if (!have.has(t)) await api.createInvestigationAnnotation(current.value.id, { kind: 'tag', targets: [entity], value: { tag: t } });
    await fetchAnnotations();
    void fetchEvents();
  }

  /** Saves the chips, layout and closed groups as a `graph/view` item. */
  async function saveView(title: string, content: CaseViewContent) {
    const item = await addItem({ kind: 'graph', subkind: 'view', title, content_json: content, provenance: { tool: 'view' } });
    if (item) rememberContent(item, content);
    return item;
  }

  /** "Usar no dossiê": a `dossie` tag on the item. */
  async function setInDossier(item: CaseItem, on: boolean) {
    const tags = item.tags.filter((t) => t !== 'dossie');
    await updateItem(item.id, { tags: on ? [...tags, 'dossie'] : tags });
  }

  return {
    investigations,
    current,
    items,
    annotations,
    events,
    brief,
    loading,
    error,
    graphItems,
    canvasItems,
    restrictedItems,
    offCanvas,
    sourceGraphs,
    contexts,
    expansions,
    derived,
    graphLoading,
    sourceColors,
    unified,
    hasAmounts,
    hasTimes,
    roles,
    entityTags,
    tagsUsed,
    groups,
    groupsClosed,
    vocabulary,
    labelTemplates,
    views,
    analyses,
    contents,
    hypotheses,
    suggestions,
    evidence,
    notes,
    itemTitle,
    fetchInvestigations,
    createInvestigation,
    updateInvestigation,
    shareInvestigation,
    unshareInvestigation,
    deleteInvestigation,
    reopenInvestigation,
    recordDecision,
    openInvestigation,
    fetchItems,
    addItem,
    uploadItem,
    updateItem,
    addVersion,
    removeItem,
    pinItem,
    setItemStatus,
    runQuery,
    toggleCanvas,
    addExplorations,
    pinEvidence,
    fetchBrief,
    saveBrief,
    fetchAnnotations,
    addAnnotation,
    setAnnotationStatus,
    deleteAnnotation,
    setRole,
    addHypothesis,
    updateHypothesis,
    addNote,
    findMatches,
    fetchEvents,
    loadWorkspace,
    addExpansion,
    addDerived,
    postEvent,
    loadItemJson,
    rememberContent,
    saveAnalysis,
    saveState,
    setGroupClosed,
    addGroup,
    renameGroup,
    setTags,
    saveView,
    setInDossier,
  };
});
