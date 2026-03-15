<script setup lang="ts">
import { ref, watch, shallowRef, computed } from 'vue';
import { Codemirror } from 'vue-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

interface PropertyColumn {
  name: string;
  data_type: string;
  display_name?: string;
  description?: string;
}

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
  nodeTypes?: string[];
  relationshipTypes?: string[];
  nodeProperties?: PropertyColumn[];
  edgeProperties?: PropertyColumn[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const code = ref(props.modelValue);
const view = shallowRef<EditorView>();

// Key to force re-render when types/properties change
const editorKey = computed(() => {
  const nodeTypesKey = (props.nodeTypes || []).join(',');
  const relTypesKey = (props.relationshipTypes || []).join(',');
  const nodePropsKey = (props.nodeProperties || []).map(p => p.name).join(',');
  const edgePropsKey = (props.edgeProperties || []).map(p => p.name).join(',');
  return `${nodeTypesKey}|${relTypesKey}|${nodePropsKey}|${edgePropsKey}`;
});

watch(() => props.modelValue, (newVal) => {
  if (newVal !== code.value) {
    code.value = newVal;
  }
});

watch(code, (newVal) => {
  emit('update:modelValue', newVal);
});

// OpenCypher keywords
const CYPHER_KEYWORDS = [
  'MATCH', 'OPTIONAL', 'WHERE', 'RETURN', 'WITH', 'ORDER', 'BY', 'SKIP', 'LIMIT',
  'CREATE', 'MERGE', 'DELETE', 'DETACH', 'SET', 'REMOVE', 'FOREACH',
  'UNION', 'ALL', 'CALL', 'YIELD', 'UNWIND', 'AS',
  'AND', 'OR', 'XOR', 'NOT', 'IN', 'STARTS', 'ENDS', 'CONTAINS',
  'IS', 'NULL', 'TRUE', 'FALSE', 'COUNT', 'COLLECT', 'DISTINCT',
  'ASC', 'DESC', 'ASCENDING', 'DESCENDING',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'ON', 'CONSTRAINT', 'INDEX', 'DROP', 'EXISTS', 'ASSERT'
];

// Functions
const CYPHER_FUNCTIONS = [
  'count', 'collect', 'sum', 'avg', 'min', 'max', 'stdev', 'percentile',
  'head', 'last', 'tail', 'size', 'length', 'type', 'id', 'labels', 'keys',
  'nodes', 'relationships', 'properties', 'startNode', 'endNode',
  'coalesce', 'timestamp', 'toInteger', 'toFloat', 'toString', 'toBoolean',
  'trim', 'ltrim', 'rtrim', 'replace', 'substring', 'left', 'right', 'split',
  'abs', 'ceil', 'floor', 'round', 'sign', 'rand', 'sqrt', 'log', 'exp',
  'range', 'reduce', 'extract', 'filter', 'all', 'any', 'none', 'single'
];

// Simple Cypher language mode
const cypherLanguage = StreamLanguage.define({
  token(stream) {
    // Skip whitespace
    if (stream.eatSpace()) return null;

    // Comments
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }

    // Strings
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'/)) return 'string';

    // Numbers
    if (stream.match(/^-?\d+\.?\d*/)) return 'number';

    // Node patterns (n), (n:Label)
    if (stream.match(/^\(\s*\w*\s*(?::\w+)?\s*\)/)) return 'atom';

    // Relationship patterns [r], [r:TYPE]
    if (stream.match(/^\[\s*\w*\s*(?::\w+)?\s*\]/)) return 'atom';

    // Labels :Label
    if (stream.match(/^:\w+/)) return 'tag';

    // Properties {key: value}
    if (stream.peek() === '{') {
      stream.next();
      return 'bracket';
    }
    if (stream.peek() === '}') {
      stream.next();
      return 'bracket';
    }

    // Arrows
    if (stream.match(/^-+>|<-+|--/)) return 'operator';

    // Operators
    if (stream.match(/^[=<>!]+|^\+|-|\*|\/|%/)) return 'operator';

    // Keywords and identifiers
    if (stream.match(/^\w+/)) {
      const word = stream.current();
      if (CYPHER_KEYWORDS.includes(word.toUpperCase())) return 'keyword';
      if (CYPHER_FUNCTIONS.includes(word.toLowerCase())) return 'builtin';
      return 'variable';
    }

    // Parentheses and brackets
    if (stream.match(/^[()[\]]/)) return 'bracket';

    // Any other character
    stream.next();
    return null;
  }
});

// Detect if cursor is inside node () or relationship [] pattern
function detectPatternContext(doc: string, pos: number): 'node' | 'relationship' | 'unknown' {
  // Look backwards from cursor position to find the last unclosed ( or [
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = pos - 1; i >= 0; i--) {
    const char = doc[i];
    if (char === ')') parenDepth++;
    else if (char === '(') {
      if (parenDepth > 0) parenDepth--;
      else return 'node'; // Found unclosed (
    }
    else if (char === ']') bracketDepth++;
    else if (char === '[') {
      if (bracketDepth > 0) bracketDepth--;
      else return 'relationship'; // Found unclosed [
    }
  }
  return 'unknown';
}

// Detect if cursor is inside property braces {} and what context (node or relationship)
function detectPropertyBraceContext(doc: string, pos: number): 'node' | 'relationship' | null {
  let braceDepth = 0;

  for (let i = pos - 1; i >= 0; i--) {
    const char = doc[i];
    if (char === '}') braceDepth++;
    else if (char === '{') {
      if (braceDepth > 0) {
        braceDepth--;
      } else {
        // Found unclosed {, now check if it's inside () or []
        const ctx = detectPatternContext(doc, i);
        return ctx === 'unknown' ? null : ctx;
      }
    }
  }
  return null;
}

// Detect variable type from its definition in the query
// e.g., "(s:Product)" means s is a node, "[r:KNOWS]" means r is a relationship
function detectVariableType(doc: string, varName: string): 'node' | 'relationship' | 'unknown' {
  // Look for node pattern: (varName) or (varName:Type)
  const nodePattern = new RegExp(`\\(\\s*${varName}\\s*(?::\\w+)?\\s*(?:\\{|\\))`, 'i');
  if (nodePattern.test(doc)) return 'node';

  // Look for relationship pattern: [varName] or [varName:Type]
  const relPattern = new RegExp(`\\[\\s*${varName}\\s*(?::\\w+)?\\s*(?:\\{|\\])`, 'i');
  if (relPattern.test(doc)) return 'relationship';

  return 'unknown';
}

// Factory for Cypher autocomplete - creates function with current node/edge types and properties
function createCypherCompletions(
  nodeTypes: string[],
  relationshipTypes: string[],
  nodeProperties: PropertyColumn[],
  edgeProperties: PropertyColumn[]
) {
  return function(context: CompletionContext) {
    const doc = context.state.doc.toString();

    // Check for property access pattern: variable.property (e.g., n.name, r.weight)
    const propAccessMatch = context.matchBefore(/(\w+)\.(\w*)/);
    if (propAccessMatch) {
      const [, varName, propPrefix] = propAccessMatch.text.match(/(\w+)\.(\w*)/) || [];
      if (varName) {
        const varType = detectVariableType(doc, varName);
        const options: Array<{ label: string; type: string; detail?: string; boost?: number }> = [];

        // Add properties based on variable type
        if (varType === 'node' || varType === 'unknown') {
          for (const prop of nodeProperties) {
            options.push({
              label: prop.name,
              type: 'property',
              detail: `Node property (${prop.data_type})`,
              boost: varType === 'node' ? 5 : 2,
            });
          }
        }

        if (varType === 'relationship' || varType === 'unknown') {
          for (const prop of edgeProperties) {
            options.push({
              label: prop.name,
              type: 'property',
              detail: `Edge property (${prop.data_type})`,
              boost: varType === 'relationship' ? 5 : 2,
            });
          }
        }

        // Filter by what the user has typed after the dot
        const filteredOptions = propPrefix
          ? options.filter(o => o.label.toLowerCase().startsWith(propPrefix.toLowerCase()))
          : options;

        if (filteredOptions.length > 0) {
          // Position from after the dot
          const dotPos = propAccessMatch.from + varName.length + 1;
          return {
            from: dotPos,
            options: filteredOptions,
          };
        }
      }
    }

    // Check for property pattern inside braces: {propName: value}
    const braceContext = detectPropertyBraceContext(doc, context.pos);
    if (braceContext) {
      const propMatch = context.matchBefore(/\w*/);
      if (propMatch) {
        const propPrefix = propMatch.text;
        const options: Array<{ label: string; type: string; detail?: string; boost?: number }> = [];

        // Add properties based on brace context
        if (braceContext === 'node') {
          for (const prop of nodeProperties) {
            options.push({
              label: `${prop.name}:`,
              type: 'property',
              detail: `Node property (${prop.data_type})`,
              boost: 5,
            });
          }
        } else if (braceContext === 'relationship') {
          for (const prop of edgeProperties) {
            options.push({
              label: `${prop.name}:`,
              type: 'property',
              detail: `Edge property (${prop.data_type})`,
              boost: 5,
            });
          }
        }

        // Filter by what the user has typed
        const filteredOptions = propPrefix
          ? options.filter(o => o.label.toLowerCase().startsWith(propPrefix.toLowerCase()))
          : options;

        if (filteredOptions.length > 0) {
          return {
            from: propMatch.from,
            options: filteredOptions,
          };
        }
      }
    }

    // Check for label pattern (typing after :)
    const labelMatch = context.matchBefore(/:\w*/);
    if (labelMatch) {
      const labelText = labelMatch.text.slice(1); // Remove the leading :
      const options: Array<{ label: string; type: string; detail?: string; boost?: number }> = [];

      // Detect context: are we inside () or []?
      const patternContext = detectPatternContext(doc, labelMatch.from);

      // Add appropriate types based on context
      if (patternContext === 'node' || patternContext === 'unknown') {
        for (const nodeType of nodeTypes) {
          options.push({
            label: `:${nodeType}`,
            type: 'type',
            detail: 'Node type',
            boost: patternContext === 'node' ? 5 : 3,
          });
        }
      }

      if (patternContext === 'relationship' || patternContext === 'unknown') {
        for (const relType of relationshipTypes) {
          options.push({
            label: `:${relType}`,
            type: 'type',
            detail: 'Relationship type',
            boost: patternContext === 'relationship' ? 5 : 3,
          });
        }
      }

      // Filter by what the user has typed (if anything)
      const filteredOptions = labelText
        ? options.filter(o => o.label.toLowerCase().includes(labelText.toLowerCase()))
        : options;

      if (filteredOptions.length > 0) {
        return {
          from: labelMatch.from,
          options: filteredOptions,
        };
      }
    }

    // Regular word completion
    const word = context.matchBefore(/\w+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    const text = word.text;
    const options: Array<{ label: string; type: string; detail?: string; boost?: number }> = [];

    // Regular keywords and functions
    options.push(
      ...CYPHER_KEYWORDS.map(k => ({ label: k, type: 'keyword', boost: 2 })),
      ...CYPHER_FUNCTIONS.map(f => ({ label: f, type: 'function', boost: 1 })),
    );

    // Add node type suggestions
    for (const nodeType of nodeTypes) {
      options.push({
        label: nodeType,
        type: 'type',
        detail: 'Node type',
        boost: 1,
      });
    }

    // Add relationship type suggestions
    for (const relType of relationshipTypes) {
      options.push({
        label: relType,
        type: 'type',
        detail: 'Relationship type',
        boost: 1,
      });
    }

    // Common snippets
    options.push(
      { label: 'MATCH (s)-[r]->(d) RETURN r', type: 'text', detail: 'Basic pattern' },
      { label: 'RETURN r', type: 'text', detail: 'Return relationship' },
      { label: 'LIMIT 100', type: 'text', detail: 'Limit results' },
    );

    return {
      from: word.from,
      options: options.filter(o =>
        o.label.toLowerCase().startsWith(text.toLowerCase())
      ),
    };
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
    minHeight: '120px',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-line': {
    padding: '0',
  },
});

// Error border style
const errorStyle = EditorView.theme({
  '&': {
    border: '1px solid var(--error-color, #e74c3c)',
    borderRadius: '6px',
  },
  '&.cm-focused': {
    boxShadow: '0 0 0 2px rgba(231, 76, 60, 0.2)',
  },
});

const normalStyle = EditorView.theme({
  '&': {
    border: '1px solid var(--border-color, #ddd)',
    borderRadius: '6px',
    backgroundColor: 'var(--bg-color, #fafafa)',
  },
  '&.cm-focused': {
    borderColor: 'var(--primary-color, #42b883)',
    boxShadow: '0 0 0 2px rgba(66, 184, 131, 0.2)',
  },
});

const extensions = computed(() => {
  // Create completions function with current prop values
  const completions = createCypherCompletions(
    props.nodeTypes || [],
    props.relationshipTypes || [],
    props.nodeProperties || [],
    props.edgeProperties || []
  );

  return [
    cypherLanguage,
    autocompletion({
      override: [completions],
      activateOnTyping: true,
      activateOnTypingDelay: 100,
      defaultKeymap: true,
    }),
    editorTheme,
    props.hasError ? errorStyle : normalStyle,
    EditorView.lineWrapping,
  ];
});

function handleReady(payload: { view: EditorView }) {
  view.value = payload.view;
}
</script>

<template>
  <Codemirror
    :key="editorKey"
    v-model="code"
    :placeholder="placeholder"
    :disabled="disabled"
    :extensions="extensions"
    :style="{ minHeight: '120px' }"
    @ready="handleReady"
  />
</template>

<style scoped>
:deep(.cm-editor) {
  height: auto;
  min-height: 120px;
}

:deep(.cm-keyword) {
  color: #07a;
  font-weight: 600;
}

:deep(.cm-builtin) {
  color: #690;
}

:deep(.cm-string) {
  color: #a31515;
}

:deep(.cm-number) {
  color: #905;
}

:deep(.cm-comment) {
  color: #998;
  font-style: italic;
}

:deep(.cm-operator) {
  color: #9a6e3a;
}

:deep(.cm-atom) {
  color: #219;
}

:deep(.cm-tag) {
  color: #170;
  font-weight: 500;
}

:deep(.cm-bracket) {
  color: #997;
}

:deep(.cm-variable) {
  color: #333;
}

:deep(.cm-tooltip-autocomplete) {
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

:deep(.cm-tooltip-autocomplete ul li) {
  padding: 4px 8px;
}

:deep(.cm-tooltip-autocomplete ul li[aria-selected]) {
  background: var(--primary-color, #42b883);
  color: white;
}

:deep(.cm-completionIcon-keyword) {
  color: #07a;
}

:deep(.cm-completionIcon-function) {
  color: #690;
}

:deep(.cm-completionIcon-type) {
  color: #170;
}

:deep(.cm-completionIcon-text) {
  color: #999;
}

:deep(.cm-completionIcon-property) {
  color: #905;
}
</style>
