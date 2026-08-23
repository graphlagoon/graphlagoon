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
import { substituteTemplateParams } from '@/utils/templateSubstitution';
import type { QueryTemplate } from '@/types/graph';

export function useTemplateExecution() {
  const graphStore = useGraphStore();

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
      if (!capabilities.supportsTranspile) {
        // A datasource that speaks Cypher natively has no SQL to review, so
        // the transpile-then-execute two-step cannot run there — send the
        // Cypher itself, the same thing GraphQueryPanel does.
        await graphStore.executeCypherQuery(substituted);
      } else {
        const sql = await graphStore.transpileCypher(substituted);
        if (sql) {
          await graphStore.executeGraphQuery(sql, { preserveGraphQuery: true });
        }
      }
    } else {
      await graphStore.executeGraphQuery(substituted, { preserveGraphQuery: true });
    }
  }

  return { executeTemplateAsGraph };
}
