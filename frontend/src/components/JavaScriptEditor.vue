<script setup lang="ts">
import { ref, watch, shallowRef, computed } from 'vue';
import { Codemirror } from 'vue-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const code = ref(props.modelValue);
const view = shallowRef<EditorView>();

watch(() => props.modelValue, (newVal) => {
  if (newVal !== code.value) {
    code.value = newVal;
  }
});

watch(code, (newVal) => {
  emit('update:modelValue', newVal);
});

// Context API completions - variables available in cluster programs
const CONTEXT_API = [
  { label: 'nodes', type: 'variable', detail: 'Array<{node_id, node_type, properties}>' },
  { label: 'edges', type: 'variable', detail: 'Array<{edge_id, src, dst, relationship_type, properties}>' },
  { label: 'selectedNodeIds', type: 'variable', detail: 'string[]' },
  { label: 'selectedEdgeIds', type: 'variable', detail: 'string[]' },
];

// Common cluster properties
const CLUSTER_PROPERTIES = [
  { label: 'cluster_name', type: 'property', detail: 'string (required)' },
  { label: 'cluster_class', type: 'property', detail: 'string (optional)' },
  { label: 'node_ids', type: 'property', detail: 'string[] (required)' },
  { label: 'figure', type: 'property', detail: "'circle'|'box'|'diamond'|'hexagon'|'star'" },
  { label: 'state', type: 'property', detail: "'open'|'closed'" },
  { label: 'color', type: 'property', detail: 'string (hex color, optional)' },
  { label: 'description', type: 'property', detail: 'string (optional)' },
];

// Code snippets
const SNIPPETS = [
  {
    label: 'Group by Type',
    type: 'snippet',
    detail: 'Template',
    apply: `const clustersByType = new Map();

nodes.forEach(node => {
  if (!clustersByType.has(node.node_type)) {
    clustersByType.set(node.node_type, []);
  }
  clustersByType.get(node.node_type).push(node.node_id);
});

const clusters = [];
clustersByType.forEach((nodeIds, nodeType) => {
  clusters.push({
    cluster_name: \`\${nodeType} Cluster\`,
    cluster_class: 'by-type',
    figure: 'circle',
    state: 'closed',
    node_ids: nodeIds
  });
});

return clusters;`
  },
  {
    label: 'Orphan Nodes',
    type: 'snippet',
    detail: 'Template',
    apply: `// Find nodes with exactly 1 connection
const nodeConnections = new Map();

edges.forEach(edge => {
  if (!nodeConnections.has(edge.src)) {
    nodeConnections.set(edge.src, new Set());
  }
  if (!nodeConnections.has(edge.dst)) {
    nodeConnections.set(edge.dst, new Set());
  }
  nodeConnections.get(edge.src).add(edge.dst);
  nodeConnections.get(edge.dst).add(edge.src);
});

const orphans = [];
nodes.forEach(node => {
  const connections = nodeConnections.get(node.node_id);
  if (connections && connections.size === 1) {
    orphans.push(node.node_id);
  }
});

return [{
  cluster_name: 'Orphan Nodes',
  cluster_class: 'orphan',
  figure: 'star',
  state: 'closed',
  node_ids: orphans
}];`
  },
  {
    label: 'Selected Nodes',
    type: 'snippet',
    detail: 'Template',
    apply: `if (selectedNodeIds.length === 0) {
  return [];
}

return [{
  cluster_name: 'Selected Nodes',
  cluster_class: 'selection',
  figure: 'hexagon',
  state: 'closed',
  node_ids: selectedNodeIds,
  color: '#3b82f6'
}];`
  }
];

// Custom completions for cluster programming context
function clusterCompletions(context: CompletionContext) {
  const word = context.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const text = word.text;
  const options = [
    ...CONTEXT_API,
    ...CLUSTER_PROPERTIES,
    ...SNIPPETS,
  ];

  return {
    from: word.from,
    options: options.filter(o =>
      o.label.toLowerCase().startsWith(text.toLowerCase())
    ),
  };
}

// Editor theme
const editorTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace",
  },
  '.cm-content': {
    padding: '10px 12px',
    minHeight: '200px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-secondary, #f5f5f5)',
    color: 'var(--text-muted, #999)',
    border: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-line': {
    padding: '0 4px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--bg-tertiary, #eee)',
  },
});

// Error border style
const errorStyle = EditorView.theme({
  '&': {
    border: '1px solid var(--error-color, #e74c3c)',
    borderRadius: '4px',
  },
  '&.cm-focused': {
    boxShadow: '0 0 0 2px rgba(231, 76, 60, 0.2)',
  },
});

const normalStyle = EditorView.theme({
  '&': {
    border: '1px solid var(--border-color, #ddd)',
    borderRadius: '4px',
    backgroundColor: 'var(--bg-color, #fff)',
  },
  '&.cm-focused': {
    borderColor: 'var(--primary-color, #42b883)',
    boxShadow: '0 0 0 2px rgba(66, 184, 131, 0.2)',
  },
});

const extensions = computed(() => [
  javascript(),
  autocompletion({
    override: [clusterCompletions],
    activateOnTyping: true,
    activateOnTypingDelay: 100,
    defaultKeymap: true,
  }),
  editorTheme,
  props.hasError ? errorStyle : normalStyle,
  EditorView.lineWrapping,
]);

function handleReady(payload: { view: EditorView }) {
  view.value = payload.view;
}
</script>

<template>
  <Codemirror
    v-model="code"
    :placeholder="placeholder"
    :disabled="disabled"
    :extensions="extensions"
    :style="{ minHeight: '200px' }"
    @ready="handleReady"
  />
</template>

<style scoped>
:deep(.cm-editor) {
  height: auto;
  min-height: 200px;
}

:deep(.cm-tooltip-autocomplete) {
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-width: 400px;
}

:deep(.cm-tooltip-autocomplete ul li) {
  padding: 6px 10px;
  font-size: 12px;
}

:deep(.cm-tooltip-autocomplete ul li[aria-selected]) {
  background: var(--primary-color, #42b883);
  color: white;
}

:deep(.cm-completionIcon-variable) {
  color: #07a;
  font-weight: 600;
}

:deep(.cm-completionIcon-property) {
  color: #905;
}

:deep(.cm-completionIcon-snippet) {
  color: #690;
}

:deep(.cm-completionLabel) {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
}

:deep(.cm-completionDetail) {
  font-style: italic;
  color: #999;
  font-size: 11px;
}
</style>
