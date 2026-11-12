/**
 * The one graph-mode execution path for a query template, shared by the
 * execute modal and the `?template=` URL auto-run.
 *
 * Extracted from TemplateExecuteModal so a link and a click cannot drift
 * apart: same substitution, same capability gating, same store calls. Table
 * mode stays in the modal — it is Query Console plumbing, and a URL only ever
 * asks for the graph.
 */
import { useGraphStore } from '@/stores/graph';
import {
  capabilitiesFor,
  resolveDatasourceType,
} from '@/composables/useDatasourceCapabilities';
import { useToast } from '@/composables/useToast';
import { substituteTemplateParams } from '@/utils/templateSubstitution';
import { resolveTemplateAfterRun } from '@/utils/templateAfterRun';
import type { QueryTemplate } from '@/types/graph';

export function useTemplateExecution() {
  const graphStore = useGraphStore();
  const toast = useToast();

  /**
   * Apply the template's `options.after_run` (layout, ego settings, focus) to
   * the graph that just loaded. Fail-open: the query already ran, so a bad
   * field or a focus node missing from the result is skipped with a warning.
   */
  function applyTemplateAfterRun(
    template: QueryTemplate,
    values: Record<string, string>,
  ): void {
    const paramIds = template.parameters.map((parameter) => parameter.id);
    const resolved = resolveTemplateAfterRun(template.options?.after_run, paramIds, values);
    if (!resolved) return;
    const issues = [...resolved.issues];
    const inGraph = (id: string) => graphStore.nodes.some((node) => node.node_id === id);

    const { algorithm, modeConfig } = resolved.layout;
    const egoCentre = modeConfig.ego?.focusNodeId;
    if (egoCentre && !inGraph(egoCentre)) {
      issues.push(`The ego centre “${egoCentre}” is not in the result, so the ego layout was not applied.`);
    } else {
      // Same pair, same order as the `?layout=` path: synchronous and adjacent,
      // so the canvas never sees ego switched on without its centre.
      if (algorithm) graphStore.setLayoutAlgorithm(algorithm);
      if (Object.keys(modeConfig).length > 0) graphStore.updateLayoutModeConfig(modeConfig);
    }

    const focus = resolved.focusNodeId;
    if (focus && inGraph(focus)) graphStore.pendingFocusNodeId = focus;
    else if (focus) issues.push(`The focus node “${focus}” is not in the result.`);

    if (issues.length > 0) {
      toast.warning(`“${template.name}” ran, but after the run: ${issues.join(' ')}`, 6000);
    }
  }

  /**
   * Substitute `values` into the template and load the result as the graph.
   *
   * Capabilities are snapshotted at call time from the current context — a
   * per-execution read is exactly right, and it keeps this callable from any
   * async path without a reactive setup context.
   */
  async function executeTemplateAsGraph(
    template: QueryTemplate,
    values: Record<string, string>,
    // The `?template=` link applies after-run itself, between `?style=` and
    // `?layout.*`, so the link's own layout keys win over the template's.
    { afterRun = true }: { afterRun?: boolean } = {},
  ): Promise<void> {
    const capabilities = capabilitiesFor(
      resolveDatasourceType(graphStore.currentContext),
    );
    const paramIds = template.parameters.map((parameter) => parameter.id);
    const substituted = substituteTemplateParams(template.query, paramIds, values);
    const opts = template.options;
    // A stored CTE pre-filter is SQL over the edge table. On a native-graph
    // context it cannot be honoured, and sending it would earn a 400 — drop it.
    const cte =
      opts?.cte_prefilter && capabilities.supportsCtePrefilter
        ? substituteTemplateParams(opts.cte_prefilter, paramIds, values)
        : '';

    graphStore.setGraphQuery(substituted);
    graphStore.ctePrefilter = cte;
    // Transpiler and result-transport settings only reach a warehouse backend;
    // leaving them untouched elsewhere keeps stored options from silently
    // rewriting store state a native-graph query will never consult.
    if (capabilities.supportsTranspile) {
      graphStore.vlpRenderingMode = opts?.procedural_bfs ? 'procedural' : 'cte';
      graphStore.useExternalLinks = opts?.large_results_mode ?? true;
    }

    if (template.query_type === 'cypher') {
      // The Cypher endpoint transpiles and executes server-side on every
      // datasource (procedural BEGIN…END scripts included — the raw-SQL
      // endpoint rejects those); the transpiled SQL still surfaces through
      // graphStore.lastTranspiledSql for review.
      await graphStore.executeCypherQuery(substituted, { preserveGraphQuery: true });
    } else {
      await graphStore.executeGraphQuery(substituted, { preserveGraphQuery: true });
    }
    if (afterRun && graphStore.queryError === null) applyTemplateAfterRun(template, values);
  }

  return { executeTemplateAsGraph, applyTemplateAfterRun };
}
