/**
 * The groups on the graph as one list of "layers" — the communities of the
 * current coloring and the clusters programs produced — with "show only"
 * built on graphStore.isolate (utils/isolation.ts). Shared by the Clusters
 * panel and the floating legend so both click the same way:
 *
 * - click a name: show only that group; click it again: show every node;
 * - Shift/Ctrl+click or the eye: add/remove the group from what is shown.
 */
import { computed } from 'vue';
import { useCommunityStore } from '@/stores/community';
import { useClusterStore } from '@/stores/cluster';
import { useGraphStore } from '@/stores/graph';

export type GroupKind = 'community' | 'cluster';

export interface GroupRow {
  key: string;
  kind: GroupKind;
  id: number | string;
  label: string;
  color: string;
  count: number;
  /** Collapsed into one cluster node (clusters, and communities under "Collapse"). */
  collapsed?: boolean;
  /** The cluster node that stands for it, when there is one. */
  clusterId?: string;
}

/** Community clusters made by "Collapse" (communityStore.syncToClusters). */
const COMMUNITY_CLUSTER_CLASS = 'community';
/** A case's group annotations drawn as clusters — the case's Groups panel owns them. */
const CASE_GROUP_CLUSTER_CLASS = 'group';
const communityClusterId = (id: number) => `community-${id}`;

export function useGroupRows() {
  const communityStore = useCommunityStore();
  const clusterStore = useClusterStore();
  const graphStore = useGraphStore();

  const communityRows = computed<GroupRow[]>(() => {
    const byId = new Map(clusterStore.clusters.map((c) => [c.cluster_id, c]));
    return communityStore.communitiesSorted.map((c) => {
      const cluster = byId.get(communityClusterId(c.id));
      return {
        key: `community:${c.id}`,
        kind: 'community',
        id: c.id,
        label: c.label,
        color: c.color,
        count: c.nodeCount,
        collapsed: cluster ? cluster.state === 'closed' : undefined,
        clusterId: cluster?.cluster_id,
      };
    });
  });

  /** Clusters a program produced through "Run" in the library (not the community ones). */
  const clusterRows = computed<GroupRow[]>(() =>
    clusterStore.clusters
      .filter((c) => c.cluster_class !== COMMUNITY_CLUSTER_CLASS && c.cluster_class !== CASE_GROUP_CLUSTER_CLASS)
      .map((c) => ({
        key: `cluster:${c.cluster_id}`,
        kind: 'cluster',
        id: c.cluster_id,
        label: c.cluster_name,
        color: c.color ?? '#888888',
        count: c.node_ids.length,
        collapsed: c.state === 'closed',
        clusterId: c.cluster_id,
      })),
  );

  function rowsOf(kind: GroupKind): GroupRow[] {
    return kind === 'community' ? communityRows.value : clusterRows.value;
  }

  /** Is this group on screen? Everything is, until a "show only" of its kind names others. */
  function isShown(row: GroupRow): boolean {
    const rule = graphStore.isolation;
    if (!rule) return true;
    if (rule.kind !== row.kind) return false;
    return (rule.ids as (number | string)[]).includes(row.id);
  }

  /** Is this the one group shown alone? */
  function isSolo(row: GroupRow): boolean {
    const rule = graphStore.isolation;
    return !!rule && rule.kind === row.kind && rule.ids.length === 1 && rule.ids[0] === row.id;
  }

  /** The rows of a kind currently shown, as a "show only" rule (null = all of them). */
  function showIds(kind: GroupKind, ids: (number | string)[]) {
    const all = rowsOf(kind);
    if (ids.length === 0 || ids.length >= all.length) {
      graphStore.clearIsolation();
      return;
    }
    const label = ids.length === 1
      ? (all.find((r) => r.id === ids[0])?.label ?? String(ids[0]))
      : `${ids.length} ${kind === 'community' ? 'communities' : 'clusters'}`;
    graphStore.isolate(
      kind === 'community'
        ? { kind, ids: ids as number[], label }
        : { kind, ids: ids as string[], label },
    );
  }

  /** Click on a name: solo it, or show everything again when it already is. */
  function solo(row: GroupRow) {
    if (isSolo(row)) graphStore.clearIsolation();
    else showIds(row.kind, [row.id]);
  }

  /** Eye or Shift/Ctrl+click: add the group to what is shown, or take it out. */
  function toggleShown(row: GroupRow) {
    const shown = rowsOf(row.kind).filter(isShown).map((r) => r.id);
    const next = isShown(row) ? shown.filter((id) => id !== row.id) : [...shown, row.id];
    // Hiding the last visible group would blank the canvas: show everything instead.
    showIds(row.kind, next);
  }

  /** Click handler shared by the list and the legend. */
  function clickRow(row: GroupRow, event?: MouseEvent | KeyboardEvent) {
    if (event && (event.shiftKey || event.ctrlKey || event.metaKey)) toggleShown(row);
    else solo(row);
  }

  /** Member node ids of a group. */
  function membersOf(row: GroupRow): string[] {
    if (row.kind === 'community') {
      return communityStore.communitiesById.get(row.id as number) ?? [];
    }
    return clusterStore.clusters.find((c) => c.cluster_id === row.id)?.node_ids ?? [];
  }

  function selectMembers(row: GroupRow) {
    graphStore.selectedNodeIds = new Set(membersOf(row));
    graphStore.selectedEdgeIds = new Set();
  }

  function toggleCollapsed(row: GroupRow) {
    if (row.clusterId) clusterStore.toggleClusterState(row.clusterId);
  }

  /** How many of the rows of a kind are on screen. */
  function shownCount(kind: GroupKind): number {
    return rowsOf(kind).filter(isShown).length;
  }

  return {
    communityRows,
    clusterRows,
    rowsOf,
    isShown,
    isSolo,
    solo,
    toggleShown,
    clickRow,
    membersOf,
    selectMembers,
    toggleCollapsed,
    shownCount,
  };
}
