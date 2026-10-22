import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import { applyAliases, baseSourceId, snapshotToGraph, unifyGraph, type NodeOrigin, type UnifySource } from '@/utils/unifyGraph';
import { applyFileEnrichment, fileEnrichmentRows, tableContentOf, type FileRows, type TableContent } from '@/utils/enrichment';
import { decoderLabel } from '@/utils/fileImport';
import { provenanceColor } from '@/utils/graphAppearance';
import { groupColor, vocabularyOf } from '@/utils/caseVocabulary';
import { caseShortIds, evidenceNumbers } from '@/utils/caseShortIds';
import type { Edge, EdgeSemanticsByType, ExplorationState, GraphContext, IdentityKey, Node } from '@/types/graph';
import type {
  CaseAnnotation,
  TaskValue,
  CaseBrief,
  CaseItem,
  CaseViewContent,
  FileEnrichmentSpec,
  CreateAnnotationRequest,
  CreateInvestigationRequest,
  CreateItemRequest,
  GroupValue,
  CaseType,
  Investigation,
  InvestigationPage,
  QueueParams,
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

/** An analysis saved as an item (05 §3 "Result = item"): the content of its latest version. */
export interface AnalysisSpec {
  tool: 'trace' | 'paths' | 'links' | 'metrics' | 'communities';
  title: string;
  kind: 'table' | 'graph';
  subkind: CaseItem['subkind'];
  params: Record<string, unknown>;
  content: unknown;
  /** Re-run: a new version of this item instead of a new item. */
  itemId?: string | null;
  description?: string;
}

/** `state.canvas_items`: the graph items on the canvas, or all of them. */
export type CanvasChoice = string[] | 'all';

/** Graph items made from what was already on the canvas: never the one a case opens on. */
const FROZEN_SUBKINDS = new Set(['snapshot', 'selection', 'derived']);

/** Items that put nodes on the canvas (a saved view is chips + layout only). */
export function isGraphItem(item: CaseItem): boolean {
  if (item.deleted_at || item.status === 'rejected') return false;
  if (item.kind === 'graph') return item.subkind !== 'view';
  if (item.kind === 'table') return item.mapping?.as === 'graph';
  if (item.kind === 'query') return item.query?.output === 'graph';
  return false;
}

/** Tables whose rows add properties to the canvas (BYOD-2): no nodes of their own. */
export function isEnrichmentItem(item: CaseItem): boolean {
  if (item.deleted_at || item.status === 'rejected') return false;
  return item.kind === 'table' && item.mapping?.as === 'enrichment' && item.current_version > 0;
}

/** One enrichment file of the case, parsed: what `unified` applies and the inspector shows. */
export interface EnrichmentFile {
  item: CaseItem;
  spec: FileEnrichmentSpec;
  rows: FileRows;
}

export const useInvestigationStore = defineStore('investigation', () => {
  /** The queue. */
  const investigations = ref<Investigation[]>([]);
  /** The queue page (06 §2b): `investigations` holds its rows. */
  const queueTotal = ref(0);
  const queueCounts = ref<InvestigationPage['counts']>({});
  /** The org's case types (06 §1), loaded once. */
  const caseTypes = ref<CaseType[]>([]);
  let caseTypesLoaded: Promise<void> | null = null;
  /** The open case and its material (05 §1). */
  const current = ref<Investigation | null>(null);
  const items = ref<CaseItem[]>([]);
  /** Removed items (soft delete): restorable, and they keep their short ids and evidence numbers. */
  const removedItems = ref<CaseItem[]>([]);
  const annotations = ref<CaseAnnotation[]>([]);
  const events = ref<InvestigationEvent[]>([]);
  const brief = ref<CaseBrief>({ item: null, text: '' });
  const loading = ref(false);
  const error = ref<string | null>(null);

  const graphItems = computed(() => items.value.filter(isGraphItem));
  const readableGraphItems = computed(() => graphItems.value.filter((i) => i.accessible));
  /**
   * Which graph items are on the canvas (UX-1): `state.canvas_items`, ids or "all". Several graphs
   * merged into one layout confuse more than they show, so a case opens one graph at a time and
   * "All items" unifies them on request.
   */
  const canvasOverride = ref<CanvasChoice | null>(null);
  const canvasChoice = computed<CanvasChoice | null>(
    () => canvasOverride.value ?? ((current.value?.state?.canvas_items as CanvasChoice | undefined) ?? null),
  );
  const canvasItems = computed(() => {
    const readable = readableGraphItems.value;
    const choice = canvasChoice.value;
    if (choice === 'all') return readable;
    if (choice) {
      if (!choice.length) return [];
      const ids = new Set(choice);
      const picked = readable.filter((i) => ids.has(i.id));
      if (picked.length) return picked;
    }
    // Nothing chosen (or all of it gone): the first graph someone brought, not a frozen copy of the canvas.
    const first = readable.find((i) => !FROZEN_SUBKINDS.has(i.subkind)) ?? readable[0];
    return first ? [first] : [];
  });
  const canvasIds = computed(() => new Set(canvasItems.value.map((i) => i.id)));
  const allOnCanvas = computed(() => readableGraphItems.value.length > 0 && canvasItems.value.length === readableGraphItems.value.length);
  const restrictedItems = computed(() => graphItems.value.filter((i) => !i.accessible));

  /** Workspace: each canvas item's graph, the contexts (or per-item keys) and expansions. */
  const sourceGraphs = ref<SourceGraph[]>([]);
  const contexts = ref<Record<string, GraphContext>>({});
  const expansions = ref<UnifySource[]>([]);
  /** Nodes promoted from enrichment tables. shortcut: session only; the journal records them. */
  const derived = ref<UnifySource[]>([]);
  const graphLoading = ref(false);
  /** Why a graph item shows nothing (no saved snapshot, load failure), by item id. */
  const sourceErrors = computed<Record<string, string>>(() =>
    Object.fromEntries(sourceGraphs.value.filter((g) => g.error).map((g) => [g.id, g.error as string])),
  );
  const sourceColors = computed<Record<string, string>>(() =>
    Object.fromEntries(graphItems.value.map((s, i) => [s.id, provenanceColor(i)])),
  );
  const sameAs = computed<[string, string][]>(() =>
    annotations.value
      .filter((a) => a.kind === 'same_as' && a.status === 'confirmed' && a.targets.length === 2)
      .map((a) => [a.targets[0], a.targets[1]]),
  );
  /** Enrichment files' contents by item id, fetched once per version (an audited read). */
  const enrichmentContents = ref<Record<string, { version: number; content: TableContent | null; error: string | null }>>({});
  const enrichmentItems = computed(() => items.value.filter((i) => isEnrichmentItem(i) && i.accessible));
  /** Parsed per spec, so a mapping edit (no new version) re-keys the rows without a fetch. */
  const enrichmentFiles = computed<EnrichmentFile[]>(() =>
    enrichmentItems.value.flatMap((item) => {
      const loaded = enrichmentContents.value[item.id];
      if (!loaded?.content || loaded.version !== item.current_version) return [];
      const spec = (item.mapping as { as: 'enrichment'; spec: FileEnrichmentSpec }).spec;
      try {
        return [{ item, spec, rows: fileEnrichmentRows(loaded.content, spec) }];
      } catch {
        return [];
      }
    }),
  );
  const unified = computed(() => {
    const overrides = (current.value?.settings?.identity_keys as IdentityKey[] | undefined) ?? [];
    const edgeOverrides = (current.value?.settings?.edge_semantics as EdgeSemanticsByType | undefined) ?? null;
    const graph = applyAliases(
      unifyGraph(
        [
          ...sourceGraphs.value.filter((g) => canvasIds.value.has(g.id)),
          ...expansions.value.filter((e) => canvasIds.value.has(baseSourceId(e.id))),
          ...derived.value,
        ],
        contexts.value,
        overrides,
        edgeOverrides,
      ),
      sameAs.value,
    );
    // Same order as the server (case_graph): sources, aliases, then the files' properties.
    for (const f of enrichmentFiles.value) applyFileEnrichment(graph, f.spec, f.rows, f.item.id);
    return graph;
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
  const vocabulary = computed(() => vocabularyOf(current.value?.settings));
  /** The current case's type (its catalog, fields, notice), null until the types load. */
  const caseType = computed(() => caseTypes.value.find((t) => t.slug === (current.value?.case_type ?? 'general')) ?? null);
  const caseTypeLabel = (slug: string | null | undefined) => caseTypes.value.find((t) => t.slug === (slug ?? 'general'))?.label ?? slug ?? 'General';
  const labelTemplates = computed(() => (current.value?.settings?.label_templates as Record<string, string> | undefined) ?? null);
  /** Saved views (`graph/view` items). */
  const views = computed(() => items.value.filter((i) => i.kind === 'graph' && i.subkind === 'view' && !i.deleted_at));
  /** Analyses: results saved as items, newest first. */
  const analyses = computed(() =>
    items.value
      .filter((i) => !i.deleted_at && i.provenance?.tool && ['trace', 'paths', 'links', 'metrics', 'communities'].includes(String(i.provenance.tool)))
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
  /** G3, Q2, D1…: stable, see `caseShortIds`. */
  const shortIds = computed(() => caseShortIds([...items.value, ...removedItems.value]));
  const evidenceLabels = computed(() => evidenceNumbers([...items.value, ...removedItems.value]));
  const evidenceLabel = (itemId: string, version: number) => evidenceLabels.value.get(`${itemId}:${version}`) ?? 'E?';

  const itemTitle = (itemId: string) => items.value.find((i) => i.id === itemId)?.title ?? itemId;

  // --- queue and case ---------------------------------------------------------

  /** One page of the queue; the server filters, sorts and counts. */
  async function fetchInvestigations(params: QueueParams = {}) {
    loading.value = true;
    error.value = null;
    try {
      const page = await api.getInvestigationPage(params);
      investigations.value = page.items;
      queueTotal.value = page.total;
      queueCounts.value = page.counts ?? {};
    } catch (e) {
      error.value = getErrorMessage(e, 'Failed to load investigations');
    } finally {
      loading.value = false;
    }
  }

  /** The case types, once per session (a failed load is retried next time). */
  function fetchCaseTypes(force = false): Promise<void> {
    if (force || !caseTypesLoaded) {
      caseTypesLoaded = Promise.resolve()
        .then(() => api.getCaseTypes())
        .then((types) => {
          caseTypes.value = types;
        })
        .catch(() => {
          caseTypesLoaded = null;
        });
    }
    return caseTypesLoaded;
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

  /** `reason`: a superuser deleting a case under retention (kept in the audit log). */
  async function deleteInvestigation(reason?: string) {
    if (!current.value) return;
    const id = current.value.id;
    await api.deleteInvestigation(id, reason);
    investigations.value = investigations.value.filter((i) => i.id !== id);
    current.value = null;
  }

  async function reopenInvestigation() {
    if (!current.value) return;
    current.value = await api.reopenInvestigation(current.value.id);
    syncRow(current.value);
    void fetchEvents();
  }

  /** The server hashes the decision (and closes the case when it closes); the store takes the copy. */
  async function recordDecision(body: Parameters<typeof api.recordInvestigationDecision>[1]) {
    if (!current.value) return;
    current.value = await api.recordInvestigationDecision(current.value.id, body);
    syncRow(current.value);
    if (body.tasks?.length || body.proposal_id) await fetchAnnotations(); // its actions became tasks; the proposal was taken up
    void fetchEvents();
  }

  async function reviewDecision(decisionId: string, approve: boolean, note?: string) {
    if (!current.value) return;
    current.value = await api.reviewInvestigationDecision(current.value.id, decisionId, { approve, ...(note ? { note } : {}) });
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
      removedItems.value = [];
      annotations.value = [];
      events.value = [];
      brief.value = { item: null, text: '' };
      canvasOverride.value = null;
      sourceGraphs.value = [];
      expansions.value = [];
      derived.value = [];
      contents.value = {};
    }
    void fetchCaseTypes();
    try {
      const [inv, rows, notes] = await Promise.all([
        api.getInvestigation(id),
        api.getInvestigationItems(id, { include_deleted: true }),
        api.getInvestigationAnnotations(id),
      ]);
      current.value = inv;
      setItems(rows);
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

  function setItems(rows: CaseItem[]) {
    items.value = rows.filter((i) => !i.deleted_at);
    removedItems.value = rows.filter((i) => i.deleted_at);
  }

  async function fetchItems() {
    if (current.value) setItems(await api.getInvestigationItems(current.value.id, { include_deleted: true }));
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

  /** A report drafted from an org template: a new markdown item of the case. */
  async function renderReport(template: string) {
    if (!current.value) return null;
    const item = await api.renderInvestigationReport(current.value.id, template);
    upsertItem(item);
    void fetchEvents();
    return item;
  }

  async function addVersion(itemId: string, body: { content?: string; content_json?: unknown }) {
    if (!current.value) return;
    upsertItem(await api.addInvestigationItemVersion(current.value.id, itemId, body));
    void fetchEvents();
  }

  async function removeItem(itemId: string) {
    if (!current.value) return;
    await api.deleteInvestigationItem(current.value.id, itemId);
    const gone = items.value.find((i) => i.id === itemId);
    if (gone) removedItems.value = [...removedItems.value, { ...gone, deleted_at: new Date().toISOString() }];
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

  /**
   * Puts graph items on the canvas. Saved in the case (`state.canvas_items`) for whoever can edit
   * it; a reader's (or a closed case's) choice lasts the session.
   */
  async function setCanvas(choice: CanvasChoice) {
    canvasOverride.value = choice;
    const inv = current.value;
    if (!inv?.has_write_access || inv.status === 'closed') return;
    try {
      await saveState({ canvas_items: choice });
      if (canvasOverride.value === choice) canvasOverride.value = null;
    } catch {
      // Kept for the session: the canvas must not jump back because a save failed.
    }
  }

  /** Only this graph on the canvas. */
  const showOnly = (itemId: string) => setCanvas([itemId]);
  /** Every readable graph, unified (one ring per source). */
  const showAll = () => setCanvas('all');
  /** Adds or removes one graph, keeping the others. */
  function toggleCanvas(itemId: string, on: boolean) {
    const ids = new Set(canvasIds.value);
    if (on) ids.add(itemId);
    else ids.delete(itemId);
    return setCanvas([...ids]);
  }

  /**
   * Adds explorations as live references, one by one (the API takes one per call).
   * Stops at the first failure and reports how many made it.
   */
  async function addExplorations(investigationId: string, explorationIds: string[]): Promise<{ added: number; error: string | null }> {
    let added = 0;
    const shown: string[] = [];
    try {
      for (const id of explorationIds) {
        const item = await api.createInvestigationItem(investigationId, { kind: 'graph', subkind: 'exploration_ref', exploration_id: id });
        if (current.value?.id === investigationId) {
          upsertItem(item);
          shown.push(item.id);
        }
        added++;
      }
      // What was just brought is what the person wants to look at.
      if (shown.length) void setCanvas(shown);
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

  /** The agent's pending decision draft (06 P8, A4), the latest one: the decision panel opens filled with it. */
  const decisionProposal = computed(
    () => [...annotations.value].reverse().find((a) => a.kind === 'decision_proposal' && a.status === 'suggested') ?? null,
  );

  /** Follow-ups (06 §1), due first; rejected suggestions drop out. */
  const tasks = computed(() =>
    annotations.value
      .filter((a) => a.kind === 'task' && a.status !== 'rejected')
      .sort((a, b) => String(a.value.due_at ?? '\uffff').localeCompare(String(b.value.due_at ?? '\uffff')) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))),
  );

  async function addTask(value: Partial<TaskValue> & { title: string }, targets: string[] = []) {
    return addAnnotation({ kind: 'task', targets, value: { state: 'open', assignee_kind: 'human', ...value } });
  }

  /** Works on a closed case too: follow-ups outlive the decision. */
  async function updateTask(annotationId: string, value: Partial<TaskValue>, reason?: string) {
    if (!current.value) return;
    await api.updateInvestigationAnnotation(current.value.id, annotationId, { value, ...(reason ? { reason } : {}) });
    await fetchAnnotations();
    void fetchEvents();
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
      await loadEnrichments();
      sourceGraphs.value = graphs;
      expansions.value = [];
      derived.value = [];
    } finally {
      graphLoading.value = false;
    }
  }

  /** Fetches the enrichment files not loaded at their current version. */
  async function loadEnrichments() {
    const inv = current.value;
    if (!inv) return;
    const stale = enrichmentItems.value.filter((i) => enrichmentContents.value[i.id]?.version !== i.current_version);
    await Promise.all(
      stale.map(async (item) => {
        const spec = (item.mapping as { as: 'enrichment'; spec: FileEnrichmentSpec }).spec;
        let entry: { version: number; content: TableContent | null; error: string | null };
        try {
          const buffer = await api.getInvestigationItemContent(inv.id, item.id);
          const json = item.latest?.content_type?.startsWith('application/json');
          const text = new TextDecoder(json ? 'utf-8' : decoderLabel(spec.input?.encoding)).decode(buffer);
          entry = { version: item.current_version, content: tableContentOf(text, item.latest?.content_type), error: null };
        } catch (e) {
          entry = { version: item.current_version, content: null, error: getErrorMessage(e, 'Failed to read the file') };
        }
        enrichmentContents.value = { ...enrichmentContents.value, [item.id]: entry };
      }),
    );
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
    // A graph result (links) is drawn over the graphs it was computed on.
    if (item && !spec.itemId && spec.kind === 'graph') void toggleCanvas(item.id, true);
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

  /** "Use in the dossier": a `dossier` tag on the item. */
  async function setInDossier(item: CaseItem, on: boolean) {
    const tags = item.tags.filter((t) => t !== 'dossier');
    await updateItem(item.id, { tags: on ? [...tags, 'dossier'] : tags });
  }

  return {
    investigations,
    queueTotal,
    queueCounts,
    caseTypes,
    caseType,
    caseTypeLabel,
    fetchCaseTypes,
    current,
    items,
    removedItems,
    shortIds,
    evidenceLabel,
    annotations,
    events,
    brief,
    loading,
    error,
    graphItems,
    readableGraphItems,
    canvasItems,
    canvasIds,
    canvasChoice,
    allOnCanvas,
    restrictedItems,
    sourceErrors,
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
    renderReport,
    tasks,
    decisionProposal,
    addTask,
    updateTask,
    reviewDecision,
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
    setCanvas,
    showOnly,
    showAll,
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
    loadEnrichments,
    enrichmentFiles,
    enrichmentContents,
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
