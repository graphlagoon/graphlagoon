<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-container" data-testid="context-menu-actions-modal">
        <div class="modal-header">
          <h2>Context Menu Actions</h2>
          <div class="header-actions">
            <button
              class="btn-icon-only"
              data-testid="menu-action-skill-help"
              :title="importText.trim() ? 'Ask an AI to adapt the pasted actions to this graph' : 'Ask an AI to write context-menu actions'"
              :aria-label="importText.trim() ? 'Ask an AI to adapt the pasted actions to this graph' : 'Ask an AI to write context-menu actions'"
              @click="showSkill = true"
            >
              <Bot :size="16" />
            </button>
            <button class="btn-icon-only" @click="close" title="Close" aria-label="Close">
              <X :size="16" />
            </button>
          </div>
        </div>

        <div class="modal-content">
          <p v-if="!canEdit" class="readonly-note">
            You have read-only access to this context — actions are shown but cannot be edited.
          </p>

          <!-- Action list -->
          <div class="section">
            <div class="section-title">
              Configured actions ({{ store.actionConfigs.length }})
            </div>
            <p v-if="store.actionConfigs.length === 0" class="empty-note">
              No actions yet. Actions appear in the right-click menu of nodes and edges.
            </p>
            <div
              v-for="config in store.actionConfigs"
              :key="config.id"
              class="action-row"
              :data-testid="`menu-action-row-${config.id}`"
            >
              <label class="enable-toggle" :title="config.enabled ? 'Enabled' : 'Disabled'">
                <input
                  type="checkbox"
                  :checked="config.enabled"
                  :disabled="!canEdit"
                  @change="store.setEnabled(config.id, ($event.target as HTMLInputElement).checked)"
                />
              </label>
              <span class="action-icon">{{ config.icon || kindIconFallback(config.kind) }}</span>
              <span class="action-label" :title="actionSummary(config)">{{ config.label }}</span>
              <span class="kind-badge">{{ config.kind }}</span>
              <span class="target-badge">{{ config.match.target }}</span>
              <div class="row-buttons" v-if="canEdit">
                <button class="btn-small" @click="startEdit(config)">Edit</button>
                <button class="btn-small" @click="duplicate(config)">Duplicate</button>
                <button class="btn-small danger" @click="remove(config)">Delete</button>
              </div>
            </div>
            <div class="list-actions">
              <button v-if="canEdit" class="btn-primary" data-testid="menu-action-add" @click="startCreate">
                + New action
              </button>
              <button
                v-if="canEdit"
                class="btn-secondary"
                data-testid="menu-action-import-toggle"
                @click="showImport = !showImport"
              >
                Import JSON
              </button>
              <button
                class="btn-secondary"
                data-testid="menu-action-export"
                :disabled="store.actionConfigs.length === 0"
                title="Download all actions as a JSON file you can import into another context"
                @click="exportActions"
              >
                <Download :size="14" /> Export JSON
              </button>
            </div>
          </div>

          <!-- Import JSON (Ask-AI return leg) -->
          <div v-if="showImport && canEdit" class="section import-section">
            <div class="section-title">Import JSON</div>
            <p class="hint">
              Paste the JSON array produced by the AI prompt (robot button above),
              or a file exported from another context. Actions from another
              graph name other types, properties and templates — the robot
              button then rewrites them for this graph.
            </p>
            <textarea
              v-model="importText"
              class="import-textarea"
              data-testid="menu-action-import-text"
              rows="6"
              placeholder='[{"kind": "open-url", "label": "...", ...}]'
            />
            <div class="list-actions">
              <input
                ref="fileInput"
                type="file"
                accept=".json,application/json"
                class="file-input"
                data-testid="menu-action-import-file"
                @change="pickFile"
              />
              <button class="btn-secondary" @click="fileInput?.click()">Choose file…</button>
            </div>
            <p
              v-if="parsedImport && !parsedImport.ok"
              class="field-error"
              data-testid="menu-action-import-parse-error"
            >
              {{ parsedImport.error }}
            </p>
            <div v-if="importWarnings" class="hint warning warning-block" data-testid="menu-action-import-warnings">
              <p>These actions name things this graph does not have:</p>
              <ul>
                <li v-if="importWarnings.missingNodeTypes.length">
                  node types: {{ importWarnings.missingNodeTypes.join(', ') }}
                </li>
                <li v-if="importWarnings.missingEdgeTypes.length">
                  relationship types: {{ importWarnings.missingEdgeTypes.join(', ') }}
                </li>
                <li v-if="importWarnings.missingProperties.length">
                  properties: {{ importWarnings.missingProperties.join(', ') }}
                </li>
                <li v-if="importWarnings.missingTemplateIds.length">
                  query template ids: {{ importWarnings.missingTemplateIds.join(', ') }}
                </li>
                <li v-if="importWarnings.missingProviders.length" data-testid="menu-action-import-missing-providers">
                  table sources this context does not declare (these actions stay hidden until someone
                  declares them in the context form):
                  {{ importWarnings.missingProviders.join(', ') }}
                </li>
                <li v-if="importWarnings.sessionMetricRefs.length">
                  metrics (session-computed — these actions only work after the
                  metric is computed here): {{ importWarnings.sessionMetricRefs.join(', ') }}
                </li>
              </ul>
              <button
                class="btn-secondary"
                data-testid="menu-action-import-adapt"
                @click="showSkill = true"
              >
                <Bot :size="14" /> Ask an AI to adapt them
              </button>
            </div>
            <p v-if="importError" class="field-error">{{ importError }}</p>
            <button
              class="btn-primary"
              data-testid="menu-action-import-apply"
              :disabled="!parsedImport?.ok"
              @click="applyImport"
            >
              Add imported actions
            </button>
          </div>

          <!-- Editor form -->
          <div v-if="editing && canEdit" class="section form-section" data-testid="menu-action-form">
            <div class="section-title">{{ isNew ? 'New action' : 'Edit action' }}</div>

            <div class="form-grid">
              <label>Label</label>
              <input v-model="editing.label" type="text" placeholder="Search on PubMed" data-testid="menu-action-label" />

              <label>Icon (emoji)</label>
              <input v-model="editing.icon" type="text" maxlength="4" placeholder="🔎" class="icon-input" />

              <label>Kind</label>
              <select v-model="editing.kind" data-testid="menu-action-kind">
                <option value="open-url">Open URL</option>
                <option value="copy-text">Copy text</option>
                <option value="run-query-template">Run query template</option>
                <option value="show-same-value">Show only nodes with…</option>
                <option value="show-table">Table from the canvas</option>
                <option value="run-table-provider" :disabled="tableSources.length === 0">
                  Table from a provider{{ tableSources.length === 0 ? ' (this context declares no table source)' : '' }}
                </option>
              </select>

              <label>Applies to</label>
              <select v-model="editing.match.target" :disabled="editing.kind === 'show-same-value'">
                <option value="node">Nodes</option>
                <option value="edge">Edges</option>
                <option value="both">Nodes and edges</option>
              </select>
            </div>

            <!-- Type filters -->
            <div v-if="editing.match.target !== 'edge'" class="type-filter">
              <div class="subsection-title">Node types (none checked = all)</div>
              <div class="type-checkboxes">
                <label v-for="t in nodeTypes" :key="t" class="type-checkbox">
                  <input type="checkbox" :value="t" v-model="editingNodeTypes" /> {{ t }}
                </label>
                <span v-if="nodeTypes.length === 0" class="hint">no node types loaded</span>
              </div>
            </div>
            <div v-if="editing.match.target !== 'node'" class="type-filter">
              <div class="subsection-title">Relationship types (none checked = all)</div>
              <div class="type-checkboxes">
                <label v-for="t in edgeTypes" :key="t" class="type-checkbox">
                  <input type="checkbox" :value="t" v-model="editingEdgeTypes" /> {{ t }}
                </label>
                <span v-if="edgeTypes.length === 0" class="hint">no edge types loaded</span>
              </div>
            </div>

            <!-- Property conditions -->
            <div class="conditions">
              <div class="subsection-title">
                Property conditions (all must hold)
                <button class="btn-small" @click="addCondition">+ condition</button>
              </div>
              <div v-for="(condition, i) in editingConditions" :key="i" class="condition-row">
                <input
                  v-model="condition.property"
                  type="text"
                  list="menu-action-properties"
                  placeholder="property"
                  class="condition-property"
                />
                <select v-model="condition.operator">
                  <option value="exists">exists</option>
                  <option value="not-empty">not empty</option>
                  <option value="equals">equals</option>
                  <option value="not-equals">not equals</option>
                  <option value="contains">contains</option>
                </select>
                <input
                  v-if="['equals', 'not-equals', 'contains'].includes(condition.operator)"
                  v-model="condition.value"
                  type="text"
                  placeholder="value"
                  class="condition-value"
                />
                <button class="btn-small danger" @click="editingConditions.splice(i, 1)">✕</button>
              </div>
              <datalist id="menu-action-properties">
                <option v-for="p in availableConditionRefs" :key="p" :value="p" />
              </datalist>
              <p v-if="availableMetricNames.length" class="hint">
                Conditions and templates may reference metrics (metric:&lt;name&gt;).
                Metrics are session-computed: actions referencing one stay hidden
                (conditions) or fail with a "missing" message (URLs) until it is computed.
              </p>
            </div>

            <!-- Kind-specific fields -->
            <div v-if="editing.kind === 'open-url'" class="kind-fields">
              <label>URL template</label>
              <input
                v-model="editingUrlTemplate"
                type="text"
                data-testid="menu-action-url-template"
                placeholder="https://example.com/search?q={prop:name}"
              />
              <p class="hint">
                Starts with https:// for a web page, or an app scheme (vscode://,
                claude-cli://, obsidian://, mailto:, …) to open a desktop app.
                Values are URL-encoded automatically.
                Available: {{ placeholderHint }}
              </p>
              <p v-if="urlTemplateError" class="field-error">{{ urlTemplateError }}</p>
              <p v-else-if="editingAppScheme" class="hint" data-testid="menu-action-app-link-hint">
                Opens the app registered for <code>{{ editingAppScheme }}:</code> on the
                clicking user's machine — the browser asks them first.
              </p>
              <div v-if="!editingAppScheme" class="radio-row" data-testid="menu-action-open-in">
                <label><input type="radio" value="new-tab" v-model="editingOpenIn" /> New tab</label>
                <label><input type="radio" value="same-tab" v-model="editingOpenIn" /> Current tab</label>
              </div>
            </div>

            <div v-else-if="editing.kind === 'copy-text'" class="kind-fields">
              <label>Text template</label>
              <input
                v-model="editingTextTemplate"
                type="text"
                data-testid="menu-action-text-template"
                placeholder="{prop:name} <{prop:email}>"
              />
              <p class="hint">Available: {{ placeholderHint }}</p>
              <p v-if="textTemplateError" class="field-error">{{ textTemplateError }}</p>
            </div>

            <div v-else-if="editing.kind === 'show-same-value'" class="kind-fields" data-testid="menu-action-same-value">
              <label>Field</label>
              <input
                v-model="editingField"
                type="text"
                list="menu-action-fields"
                data-testid="menu-action-field"
                placeholder="community_id, node_type, metric:degree…"
              />
              <datalist id="menu-action-fields">
                <option value="node_type" />
                <option v-for="p in availableConditionRefs" :key="p" :value="p" />
              </datalist>
              <div class="radio-row" data-testid="menu-action-mode">
                <label><input type="radio" value="same" v-model="editingMode" /> the same value as the clicked node</label>
                <label><input type="radio" value="has" v-model="editingMode" /> any value (the field is set)</label>
              </div>
              <p class="hint">
                Hides every other node — the layout stays. "Showing only" in the status
                bar says what is shown; its ✕ shows every node again. Saved with the
                exploration and with a case's saved views.
              </p>
            </div>

            <div v-else-if="editing.kind === 'show-table'" class="kind-fields" data-testid="menu-action-canvas-table">
              <p class="hint">
                Rows computed in the browser from the graph on the canvas: instant, and on a
                case canvas they include file and derived nodes. For everything in the
                warehouse, use "Run query template" with the Table result.
              </p>
              <label>Source</label>
              <div class="radio-row" data-testid="menu-action-table-source-kind">
                <label><input v-model="editingTableSource" type="radio" value="neighborhood" /> Neighbors — no code</label>
                <label><input v-model="editingTableSource" type="radio" value="program" data-testid="menu-action-table-source-program" /> Program — JavaScript</label>
              </div>
              <template v-if="editingTableSource === 'neighborhood'">
                <div class="inline-fields">
                  <label>Hops
                    <select v-model.number="editingHops" data-testid="menu-action-hops">
                      <option v-for="n in MAX_NEIGHBORHOOD_HOPS" :key="n" :value="n">{{ n }}</option>
                    </select>
                  </label>
                  <label>Direction
                    <select v-model="editingDirection">
                      <option value="any">any</option>
                      <option value="out">out</option>
                      <option value="in">in</option>
                    </select>
                  </label>
                  <label>List
                    <select v-model="editingList" data-testid="menu-action-list">
                      <option value="nodes">the nodes reached</option>
                      <option value="edges">the edges of those nodes</option>
                    </select>
                  </label>
                </div>
                <label>Walk over edge types <span class="hint-inline">(comma-separated; empty: all)</span></label>
                <input v-model="editingWalkTypes" type="text" list="menu-action-edge-types" :placeholder="edgeTypes.slice(0, 3).join(', ')" />
                <label>Node types listed <span class="hint-inline">(empty: all; the walk passes through every type)</span></label>
                <input v-model="editingListedNodeTypes" type="text" data-testid="menu-action-listed-node-types" :placeholder="nodeTypes.slice(0, 3).join(', ')" />
                <template v-if="editingList === 'edges'">
                  <label>Edge types listed <span class="hint-inline">(empty: all)</span></label>
                  <input v-model="editingListEdgeTypes" type="text" data-testid="menu-action-list-edge-types" :placeholder="edgeTypes.slice(0, 3).join(', ')" />
                </template>
                <label>Columns <span class="hint-inline">(properties or metric:&lt;name&gt;; empty: every property)</span></label>
                <input v-model="editingColumns" type="text" :placeholder="availableConditionRefs.slice(0, 3).join(', ')" />
                <datalist id="menu-action-edge-types">
                  <option v-for="t in edgeTypes" :key="t" :value="t" />
                </datalist>
              </template>
              <template v-else>
                <label>Program</label>
                <JavaScriptEditor
                  v-model="editingProgramCode"
                  :completions="TABLE_PROGRAM_COMPLETIONS"
                  :has-error="!!canvasSourceError"
                  placeholder="return hops(item.node_id, 2).map(n => ({ node_id: n.node_id, type: n.node_type, hop: n.hop }))"
                  data-testid="menu-action-program-code"
                />
                <p class="hint">
                  Runs in a sandboxed worker (no network, no storage, 10 s limit) and returns an
                  array of objects or <code>{ columns, rows }</code>. In scope: <code>item</code>,
                  <code>params</code>, <code>nodes</code>, <code>edges</code>, <code>node(id)</code>,
                  <code>neighbors(id, opts)</code>, <code>hops(id, k, opts)</code>,
                  <code>edgesOf(ids, opts)</code>, <code>metric(ref, id)</code>, <code>selectedNodeIds</code>.
                </p>
                <label>Parameters <span class="hint-inline">(JSON, optional: editable in the table window)</span></label>
                <textarea
                  v-model="editingProgramParams"
                  rows="3"
                  class="params-json"
                  data-testid="menu-action-program-params"
                  placeholder='[{ "id": "min_amount", "label": "Min amount", "default": "0" }]'
                />
                <div v-if="programParamIds.length" class="bindings">
                  <div class="subsection-title">Parameter bindings</div>
                  <div v-for="id in programParamIds" :key="id" class="binding-row">
                    <span class="binding-param">{{ id }}</span>
                    <input v-model="editingBindings[id]" type="text" placeholder="{prop:...} — empty: uses default" />
                  </div>
                </div>
              </template>
              <p v-if="canvasSourceError" class="hint warning" data-testid="menu-action-canvas-error">{{ canvasSourceError }}</p>
              <div class="test-row">
                <button
                  class="btn-secondary"
                  :disabled="!!canvasSourceError || !testItem"
                  data-testid="menu-action-test"
                  @click="testCanvasTable"
                >Test on {{ testItem ? `${testItem.type} ${testItem.id}` : 'a selected node' }}</button>
                <span v-if="!testItem" class="hint-inline">Select a node (or an edge) on the canvas first.</span>
              </div>
              <div v-if="testPreview" class="test-preview" data-testid="menu-action-test-preview">
                <p v-if="testPreview.loading.value" class="hint">Running…</p>
                <p v-else-if="testPreview.error.value" class="hint warning">{{ testPreview.error.value }}</p>
                <p v-else-if="testPreview.needsParameters.value" class="hint warning">
                  Needs: {{ Object.entries(testPreview.problems.value).map(([k, v]) => `${k} ${v}`).join('; ') }}
                </p>
                <template v-else>
                  <p class="hint">{{ testPreview.rows.value.length.toLocaleString() }} rows{{ testPreview.truncated.value ? ' (more)' : '' }}<template v-if="testPreview.rows.value.length > 8">, first 8:</template></p>
                  <div class="preview-scroll">
                    <table>
                      <thead><tr><th v-for="c in testPreview.columns.value" :key="c">{{ c }}</th></tr></thead>
                      <tbody>
                        <tr v-for="(r, i) in testPreview.rows.value.slice(0, 8)" :key="i"><td v-for="(v, j) in r" :key="j">{{ v }}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </div>
            </div>

            <div v-else-if="editing.kind === 'run-table-provider'" class="kind-fields" data-testid="menu-action-table-provider">
              <p class="hint">
                Rows about the clicked item from a table source of this context: code this deployment
                registered (for example a call to an internal service), declared in the context form under
                <strong>Enrichments and data sources</strong>. Runs on the server, opens in the same table
                window as a query template's table, works on a case canvas, and agents can run it.
                <a :href="guideUrl('context-menu-actions', 'table-provider')" target="_blank" rel="noopener">More in the guide</a>
              </p>
              <label>Table source</label>
              <select v-model="editingSource" data-testid="menu-action-provider-select">
                <option value="" disabled>— select a table source —</option>
                <option v-for="t in tableSources" :key="t.name" :value="t.name">{{ t.label }}</option>
                <option v-if="editingSource && !selectedSource" :value="editingSource">
                  {{ editingSource }} (not declared in this context)
                </option>
              </select>
              <p v-if="editingSource && !selectedSource" class="hint warning" data-testid="menu-action-provider-missing">
                This context declares no table source with that name: the action stays hidden until someone
                with the "Create graph contexts" permission declares it in the context form.
              </p>
              <p v-else-if="selectedSource && !selectedSource.registered" class="hint warning" data-testid="menu-action-provider-missing">
                Its provider ({{ selectedSource.provider }}) is not registered on this server: the action stays
                hidden until the deployment registers it.
              </p>
              <template v-else-if="selectedSource">
                <p class="hint" data-testid="menu-action-provider-description">
                  {{ selectedSource.description || 'This source has no description.' }}
                  It has a table for: {{ selectedSource.targets.map((t) => `${t}s`).join(' and ') }}.
                  <template v-if="selectedSource.columns.length">Returns: {{ selectedSource.columns.join(', ') }}.</template>
                </p>
                <p v-if="providerTargetError" class="field-error" data-testid="menu-action-provider-target-error">{{ providerTargetError }}</p>
                <div class="bindings">
                  <div class="subsection-title">Parameters</div>
                  <div
                    v-for="p in selectedSource.params"
                    :key="p.name"
                    class="provider-param"
                    data-testid="menu-action-provider-param"
                  >
                    <div class="provider-param-head">
                      <span class="binding-param">{{ p.name }}<span v-if="p.required" class="required">*</span></span>
                      <span v-if="paramHint(p)" class="hint-inline">{{ paramHint(p) }}</span>
                    </div>
                    <div class="binding-row">
                      <select
                        v-model="editingProviderHow[p.name]"
                        :aria-label="`Where ${p.name} comes from`"
                        :data-testid="`menu-action-provider-how-${p.name}`"
                      >
                        <option value="run">
                          {{ p.default === null || p.default === undefined ? 'Asked in the table window' : `Default (${paramText(p.default)}), editable in the window` }}
                        </option>
                        <option value="bind">From the clicked item</option>
                        <option value="fixed">Fixed value (cannot be changed)</option>
                      </select>
                      <input
                        v-if="editingProviderHow[p.name] === 'bind'"
                        v-model="editingProviderText[p.name]"
                        type="text"
                        :placeholder="`{node_id} or {prop:...}`"
                        :data-testid="`menu-action-provider-value-${p.name}`"
                      />
                      <select
                        v-else-if="editingProviderHow[p.name] === 'fixed' && (p.choices?.length || p.type === 'bool')"
                        v-model="editingProviderText[p.name]"
                        :data-testid="`menu-action-provider-value-${p.name}`"
                      >
                        <option value="" disabled>— choose —</option>
                        <option v-for="c in p.type === 'bool' ? ['true', 'false'] : p.choices!" :key="c" :value="c">{{ c }}</option>
                      </select>
                      <input
                        v-else-if="editingProviderHow[p.name] === 'fixed'"
                        v-model="editingProviderText[p.name]"
                        type="text"
                        placeholder="value"
                        :data-testid="`menu-action-provider-value-${p.name}`"
                      />
                    </div>
                    <p v-if="providerParamError(p)" class="field-error" data-testid="menu-action-provider-param-error">
                      {{ p.name }} {{ providerParamError(p) }}
                    </p>
                  </div>
                  <p v-if="selectedSource.locked.length" class="hint" data-testid="menu-action-provider-locked">
                    Set by the context, not changeable here:
                    {{ selectedSource.locked.map((l) => `${l.name} = ${l.value || '(none)'}`).join(', ') }}.
                  </p>
                  <p v-if="!selectedSource.params.length && !selectedSource.locked.length" class="hint">This source has no parameters.</p>
                  <p v-if="selectedSource.params.length" class="hint">
                    From the clicked item: {{ placeholderHint }}. Give the source the item's id this way
                    (for example <code>{node_id}</code>): it receives the parameters, not the item's properties.
                  </p>
                </div>
              </template>
            </div>

            <div v-else class="kind-fields">
              <label>Query template</label>
              <select v-model="editingTemplateId" data-testid="menu-action-template-select">
                <option value="" disabled>— select a template —</option>
                <option v-for="t in templatesStore.templates" :key="t.id" :value="t.id">
                  {{ t.name }}{{ t.visibility === 'private' ? ' (private)' : '' }}
                </option>
              </select>
              <label>Result</label>
              <div class="radio-row" data-testid="menu-action-result-mode">
                <label><input v-model="editingResultMode" type="radio" value="graph" /> Graph — replaces the canvas</label>
                <label><input v-model="editingResultMode" type="radio" value="table" data-testid="menu-action-result-table" /> Table — rows in a window, the graph stays</label>
              </div>
              <p v-if="editingResultMode === 'table'" class="hint">
                Runs on the server for the clicked item: the query may return any columns
                (e.g. the transactions of the accounts linked to this company). Its
                parameters can be edited in the window and run again. Also offered on a
                case canvas, and to agents as a tool (<code>run_entity_action</code>).
              </p>
              <p v-if="selectedTemplate?.visibility === 'private'" class="hint warning">
                This template is private: the action will be invisible to everyone
                who cannot see the template. Prefer a shared template.
              </p>
              <div v-if="selectedTemplate" class="bindings">
                <div class="subsection-title">Parameter bindings</div>
                <div
                  v-for="parameter in selectedTemplate.parameters"
                  :key="parameter.id"
                  class="binding-row"
                >
                  <span class="binding-param">
                    {{ parameter.id }}<span v-if="parameter.required" class="required">*</span>
                  </span>
                  <input
                    v-model="editingBindings[parameter.id]"
                    type="text"
                    :placeholder="`{prop:...} — empty: ${parameter.required ? 'asks at run time' : 'uses default'}`"
                  />
                </div>
                <p v-if="selectedTemplate.parameters.length === 0" class="hint">
                  This template has no parameters.
                </p>
              </div>
            </div>

            <div class="form-buttons">
              <button
                class="btn-primary"
                data-testid="menu-action-save"
                :disabled="!formValid"
                @click="save"
              >
                {{ isNew ? 'Add action' : 'Save changes' }}
              </button>
              <button class="btn-secondary" @click="editing = null">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <ContextMenuActionSkillModal
      v-model="showSkill"
      :imported-json="importText"
      :imported-source="importedSource"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, shallowRef, onBeforeUnmount } from 'vue';
import { resolveBoundValues } from '@/composables/useConfigurableMenuActions';
import { X, Bot, Download } from 'lucide-vue-next';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useToast } from '@/composables/useToast';
import { validateTemplate } from '@/utils/labelFormatter';
import { isAppUrl, urlScheme, validateUrlTemplate } from '@/utils/safeUrl';
import {
  actionCompatibilityWarnings,
  hasActionCompatibilityWarnings,
  parseImportedActionConfigs,
} from '@/utils/contextMenuActionImport';
import { buildSourceSchema, downloadJson, readFileAsText, safeFilename } from '@/utils/portableExport';
import { PORTABLE_EXPORT_VERSION, type PortableContextMenuActions } from '@/types/portable';
import ContextMenuActionSkillModal from './ContextMenuActionSkillModal.vue';
import JavaScriptEditor, { type EditorCompletion } from './JavaScriptEditor.vue';
import { parseCanvasTableSource } from '@/utils/contextMenuActionImport';
import { useMenuActionTable } from '@/composables/useMenuActionTable';
import { actionTableSource, contextTableSources } from '@/utils/enrichmentSources';
import { paramHint, paramProblem, paramText, paramValues } from '@/utils/providerParams';
import { guideUrl } from '@/utils/docsLinks';
import type { ProviderParamInfo } from '@/types/graph';
import type {
  CanvasTableSource,
  ContextMenuActionConfig,
  PropertyCondition,
  MenuActionTarget,
} from '@/types/contextMenuActions';
import { MAX_NEIGHBORHOOD_HOPS } from '@/types/contextMenuActions';

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

const graphStore = useGraphStore();
const metricsStore = useMetricsStore();
const templatesStore = useQueryTemplatesStore();
const store = useContextMenuActionsStore();
const { success } = useToast();

const canEdit = computed(() => graphStore.currentContext?.has_write_access === true);
const nodeTypes = computed(() => graphStore.currentContext?.node_types ?? []);
const edgeTypes = computed(() => graphStore.currentContext?.relationship_types ?? []);

const availableProperties = computed(() => {
  const names = new Set<string>();
  for (const p of graphStore.currentContext?.node_properties ?? []) names.add(p.name);
  for (const p of graphStore.currentContext?.edge_properties ?? []) names.add(p.name);
  return [...names];
});

const availableMetricNames = computed(() => {
  const names = new Set<string>();
  for (const m of metricsStore.nodeMetrics) names.add(m.name);
  for (const m of metricsStore.edgeMetrics) names.add(m.name);
  return [...names];
});

/** Condition property suggestions: real columns plus `metric:<name>` refs. */
const availableConditionRefs = computed(() => [
  ...availableProperties.value,
  ...availableMetricNames.value.map((name) => `metric:${name}`),
]);

const placeholderHint = computed(() => {
  const props = availableProperties.value.slice(0, 6).map((p) => `{prop:${p}}`);
  const metrics = availableMetricNames.value.slice(0, 2).map((name) => `{metric:${name}}`);
  const more = availableProperties.value.length > 6 || availableMetricNames.value.length > 2;
  return ['{node_id}', ...props, ...metrics].join(' ') + (more ? ' …' : '');
});

// ---------------------------------------------------------------------------
// Editing state — a mutable draft separate from the store until Save.
// ---------------------------------------------------------------------------

interface Draft {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
  kind: ContextMenuActionConfig['kind'];
  match: { target: MenuActionTarget };
}

const editing = ref<Draft | null>(null);
const isNew = ref(false);
const editingNodeTypes = ref<string[]>([]);
const editingEdgeTypes = ref<string[]>([]);
const editingConditions = ref<PropertyCondition[]>([]);
const editingUrlTemplate = ref('');
const editingOpenIn = ref<'new-tab' | 'same-tab'>('new-tab');
const editingTextTemplate = ref('');
const editingTemplateId = ref('');
const editingBindings = ref<Record<string, string>>({});
const editingResultMode = ref<'graph' | 'table'>('graph');
const editingField = ref('');
const editingMode = ref<'same' | 'has'>('same');
// run-table-provider (a table from a source the context declares)
const tableSources = computed(() => contextTableSources(graphStore.currentContext?.enrichment_tables));
const editingSource = ref('');
/** Per open parameter: left to the table window, bound to the clicked item, or fixed by the action. */
const editingProviderHow = ref<Record<string, 'run' | 'bind' | 'fixed'>>({});
const editingProviderText = ref<Record<string, string>>({});
const selectedSource = computed(() => tableSources.value.find((t) => t.name === editingSource.value));

function loadProvider(config?: { source?: string; provider?: string; paramBindings?: Record<string, string>; params?: Record<string, unknown> }) {
  // An action older than sources names the provider: open it on the source that uses it.
  editingSource.value = config ? actionTableSource(config, tableSources.value)?.name ?? config.source ?? config.provider ?? '' : '';
  const how: Record<string, 'run' | 'bind' | 'fixed'> = {};
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(config?.paramBindings ?? {})) {
    how[k] = 'bind';
    text[k] = v;
  }
  for (const [k, v] of Object.entries(config?.params ?? {})) {
    how[k] = 'fixed';
    text[k] = paramText(v);
  }
  editingProviderHow.value = how;
  editingProviderText.value = text;
  defaultProviderHow();
}

/** Every open parameter has a choice (default: left to the table window). */
function defaultProviderHow() {
  for (const p of selectedSource.value?.params ?? []) {
    if (!editingProviderHow.value[p.name]) editingProviderHow.value[p.name] = 'run';
  }
}
watch(selectedSource, defaultProviderHow);

function providerParamError(p: ProviderParamInfo): string {
  const how = editingProviderHow.value[p.name] ?? 'run';
  const text = (editingProviderText.value[p.name] ?? '').trim();
  if (how === 'run') return '';
  if (!text) return how === 'bind' ? 'needs a template, e.g. {node_id}' : 'needs a value';
  if (how === 'bind') {
    const validation = validateTemplate(text);
    return validation.valid ? '' : validation.errors[0];
  }
  return paramProblem(p, text);
}

const providerTargetError = computed(() => {
  const provider = selectedSource.value;
  const target = editing.value?.match.target;
  if (!provider || !target) return null;
  const wanted = target === 'both' ? (['node', 'edge'] as const) : [target];
  const unserved = wanted.find((t) => !provider.targets.includes(t));
  return unserved ? `This provider has no table for ${unserved}s: change "Applies to".` : null;
});

// show-table (a table from the canvas)
const editingTableSource = ref<'neighborhood' | 'program'>('neighborhood');
const editingHops = ref(1);
const editingDirection = ref<'any' | 'out' | 'in'>('any');
const editingList = ref<'nodes' | 'edges'>('nodes');
const editingWalkTypes = ref('');
const editingListedNodeTypes = ref('');
const editingListEdgeTypes = ref('');
const editingColumns = ref('');
const editingProgramCode = ref('');
const editingProgramParams = ref('');

const TABLE_PROGRAM_COMPLETIONS: EditorCompletion[] = [
  { label: 'item', type: 'variable', detail: 'the clicked node or edge (canvas ids)' },
  { label: 'params', type: 'variable', detail: 'the parameter values' },
  { label: 'nodes', type: 'variable', detail: 'every node on the canvas' },
  { label: 'edges', type: 'variable', detail: 'every edge on the canvas' },
  { label: 'node', type: 'function', detail: '(id) → node', apply: 'node()' },
  { label: 'neighbors', type: 'function', detail: '(id, {direction, edgeTypes, nodeTypes}) → nodes', apply: 'neighbors(item.node_id)' },
  { label: 'hops', type: 'function', detail: '(id, k, opts) → nodes with .hop', apply: 'hops(item.node_id, 2)' },
  { label: 'edgesOf', type: 'function', detail: '(ids, {types, direction}) → edges', apply: 'edgesOf()' },
  { label: 'metric', type: 'function', detail: '(ref, id) → value', apply: "metric('pagerank', )" },
  { label: 'selectedNodeIds', type: 'variable', detail: 'ids selected on the canvas' },
];

const splitList = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

/** The draft's canvas-table source, or what is wrong with it. */
const canvasSource = computed((): CanvasTableSource | string => {
  if (editingTableSource.value === 'neighborhood') {
    return parseCanvasTableSource({
      type: 'neighborhood',
      hops: editingHops.value,
      direction: editingDirection.value,
      list: editingList.value,
      edgeTypes: splitList(editingWalkTypes.value),
      nodeTypes: splitList(editingListedNodeTypes.value),
      ...(editingList.value === 'edges' ? { listEdgeTypes: splitList(editingListEdgeTypes.value) } : {}),
      columns: splitList(editingColumns.value),
    });
  }
  let params: unknown;
  const text = editingProgramParams.value.trim();
  if (text) {
    try {
      params = JSON.parse(text);
    } catch {
      return 'Parameters: not valid JSON';
    }
  }
  return parseCanvasTableSource({ type: 'program', code: editingProgramCode.value, params });
});
const canvasSourceError = computed(() =>
  editing.value?.kind === 'show-table' && typeof canvasSource.value === 'string' ? canvasSource.value : null,
);
const programParamIds = computed(() =>
  typeof canvasSource.value !== 'string' && canvasSource.value.type === 'program'
    ? (canvasSource.value.params ?? []).map((p) => p.id)
    : [],
);

/** What "Test" runs on: the first selected node, else the first selected edge. */
const testItem = computed(() => {
  const nodeId = graphStore.selectedNodeIds.values().next().value as string | undefined;
  if (nodeId) {
    const node = graphStore.nodes.find((n) => n.node_id === nodeId);
    if (node) return { type: 'node' as const, id: node.node_id, node };
  }
  const edgeId = graphStore.selectedEdgeIds.values().next().value as string | undefined;
  const edge = edgeId ? graphStore.edges.find((e) => e.edge_id === edgeId) : undefined;
  return edge ? { type: 'edge' as const, id: edge.edge_id, edge } : null;
});
const testPreview = shallowRef<ReturnType<typeof useMenuActionTable> | null>(null);

function testCanvasTable() {
  const source = canvasSource.value;
  const item = testItem.value;
  if (typeof source === 'string' || !item) return;
  testPreview.value?.cancel();
  const bindings = source.type === 'program' ? editingBindings.value : {};
  const canvasItem =
    item.type === 'node'
      ? { type: 'node' as const, node_id: item.node.node_id, node_type: item.node.node_type, properties: item.node.properties }
      : { type: 'edge' as const, edge_id: item.edge.edge_id, src: item.edge.src, dst: item.edge.dst, relationship_type: item.edge.relationship_type, properties: item.edge.properties };
  const preview = useMenuActionTable({
    contextId: graphStore.currentContext?.id ?? '',
    actionId: editing.value?.id ?? 'test',
    label: editing.value?.label || 'Test',
    target: { type: item.type, id: item.id },
    parameters: resolveBoundValues(bindings, item.type, item.type === 'node' ? item.node : item.edge, { metrics: metricsStore.metricResolver }),
    canvas: { source, item: canvasItem, bindings },
  });
  testPreview.value = preview;
  void preview.run();
}
onBeforeUnmount(() => testPreview.value?.cancel());
watch(() => editing.value?.id, () => {
  testPreview.value?.cancel();
  testPreview.value = null;
});

// Isolating by a node's value: an edge has nothing to isolate by.
watch(() => editing.value?.kind, (kind) => {
  if (kind === 'show-same-value' && editing.value) editing.value.match.target = 'node';
});

const selectedTemplate = computed(() =>
  templatesStore.templates.find((t) => t.id === editingTemplateId.value),
);

// Keep the bindings map aligned with the selected template's parameters.
watch(selectedTemplate, (template) => {
  if (!template) return;
  const next: Record<string, string> = {};
  for (const parameter of template.parameters) {
    next[parameter.id] = editingBindings.value[parameter.id] ?? '';
  }
  editingBindings.value = next;
});

const urlTemplateError = computed(() => {
  if (editing.value?.kind !== 'open-url' || !editingUrlTemplate.value) return null;
  const prefixError = validateUrlTemplate(editingUrlTemplate.value);
  if (prefixError) return prefixError;
  const validation = validateTemplate(editingUrlTemplate.value);
  return validation.valid ? null : validation.errors[0];
});

/** Scheme of an app-link template (null for web links) — swaps the tab choice for a hint. */
const editingAppScheme = computed(() =>
  editing.value?.kind === 'open-url' && isAppUrl(editingUrlTemplate.value)
    ? urlScheme(editingUrlTemplate.value)
    : null,
);

const textTemplateError = computed(() => {
  if (editing.value?.kind !== 'copy-text' || !editingTextTemplate.value) return null;
  const validation = validateTemplate(editingTextTemplate.value);
  return validation.valid ? null : validation.errors[0];
});

const formValid = computed(() => {
  const draft = editing.value;
  if (!draft || draft.label.trim() === '') return false;
  if (draft.kind === 'open-url') {
    return editingUrlTemplate.value.trim() !== '' && !urlTemplateError.value;
  }
  if (draft.kind === 'copy-text') {
    return editingTextTemplate.value.trim() !== '' && !textTemplateError.value;
  }
  if (draft.kind === 'show-same-value') return editingField.value.trim() !== '';
  if (draft.kind === 'show-table') return !canvasSourceError.value;
  if (draft.kind === 'run-table-provider') {
    // One not registered here is kept as it was (it may be registered later); a new one must exist.
    // One not declared (or not registered) here is kept as it was; a new one must be usable.
    if (!selectedSource.value?.registered) return editingSource.value !== '' && !isNew.value;
    return !providerTargetError.value && !selectedSource.value.params.some((p) => providerParamError(p));
  }
  return editingTemplateId.value !== '';
});

function kindIconFallback(kind: ContextMenuActionConfig['kind']): string {
  return kind === 'open-url' ? '🔗' : kind === 'copy-text' ? '📋' : kind === 'show-same-value' ? '◎'
    : kind === 'show-table' || kind === 'run-table-provider' ? '▦' : '▶';
}

function actionSummary(config: ContextMenuActionConfig): string {
  if (config.kind === 'open-url') return config.urlTemplate;
  if (config.kind === 'copy-text') return config.textTemplate;
  if (config.kind === 'show-same-value') {
    return config.mode === 'has' ? `show only: ${config.field} is set` : `show only: same ${config.field}`;
  }
  if (config.kind === 'show-table') {
    const src = config.source;
    if (src.type === 'program') return 'canvas table · program';
    const what = src.list === 'edges' ? `edges${src.listEdgeTypes?.length ? ` ${src.listEdgeTypes.join('/')}` : ''}` : 'nodes';
    const types = src.nodeTypes?.length ? ` of ${src.nodeTypes.join('/')}` : '';
    return `canvas table · ${what}${types} within ${src.hops} hop${src.hops === 1 ? '' : 's'}`;
  }
  if (config.kind === 'run-table-provider') {
    const source = actionTableSource(config, tableSources.value);
    return source ? `provider table · ${source.label}` : `provider table · ${config.source || config.provider} (not declared in this context)`;
  }
  const name = config.templateName || config.templateId;
  return config.resultMode === 'table' ? `${name} · table` : name;
}

function startCreate() {
  isNew.value = true;
  editing.value = {
    id: crypto.randomUUID(),
    label: '',
    icon: '',
    enabled: true,
    kind: 'open-url',
    match: { target: 'node' },
  };
  editingNodeTypes.value = [];
  editingEdgeTypes.value = [];
  editingConditions.value = [];
  editingUrlTemplate.value = '';
  editingOpenIn.value = 'new-tab';
  editingTextTemplate.value = '';
  editingTemplateId.value = '';
  editingBindings.value = {};
  editingResultMode.value = 'graph';
  editingField.value = '';
  editingMode.value = 'same';
  loadCanvasSource(undefined);
  loadProvider(undefined);
}

function loadCanvasSource(source: CanvasTableSource | undefined) {
  const n = source?.type === 'neighborhood' ? source : undefined;
  const p = source?.type === 'program' ? source : undefined;
  editingTableSource.value = p ? 'program' : 'neighborhood';
  editingHops.value = n?.hops ?? 1;
  editingDirection.value = n?.direction ?? 'any';
  editingList.value = n?.list ?? 'nodes';
  editingWalkTypes.value = (n?.edgeTypes ?? []).join(', ');
  editingListedNodeTypes.value = (n?.nodeTypes ?? []).join(', ');
  editingListEdgeTypes.value = (n?.listEdgeTypes ?? []).join(', ');
  editingColumns.value = (n?.columns ?? []).join(', ');
  editingProgramCode.value = p?.code ?? '';
  editingProgramParams.value = p?.params?.length ? JSON.stringify(p.params, null, 2) : '';
}

function startEdit(config: ContextMenuActionConfig) {
  isNew.value = false;
  editing.value = {
    id: config.id,
    label: config.label,
    icon: config.icon ?? '',
    enabled: config.enabled,
    kind: config.kind,
    match: { target: config.match.target },
  };
  editingNodeTypes.value = [...(config.match.nodeTypes ?? [])];
  editingEdgeTypes.value = [...(config.match.relationshipTypes ?? [])];
  editingConditions.value = (config.match.propertyConditions ?? []).map((c) => ({ ...c }));
  editingUrlTemplate.value = config.kind === 'open-url' ? config.urlTemplate : '';
  editingOpenIn.value = config.kind === 'open-url' ? config.openIn : 'new-tab';
  editingTextTemplate.value = config.kind === 'copy-text' ? config.textTemplate : '';
  editingTemplateId.value = config.kind === 'run-query-template' ? config.templateId : '';
  editingBindings.value =
    config.kind === 'run-query-template' ? { ...config.paramBindings } : {};
  editingResultMode.value = config.kind === 'run-query-template' && config.resultMode === 'table' ? 'table' : 'graph';
  editingField.value = config.kind === 'show-same-value' ? config.field : '';
  editingMode.value = config.kind === 'show-same-value' ? config.mode : 'same';
  loadCanvasSource(config.kind === 'show-table' ? config.source : undefined);
  if (config.kind === 'show-table') editingBindings.value = { ...(config.paramBindings ?? {}) };
  loadProvider(config.kind === 'run-table-provider' ? config : undefined);
}

function addCondition() {
  editingConditions.value.push({ property: '', operator: 'not-empty' });
}

function buildConfig(): ContextMenuActionConfig | null {
  const draft = editing.value;
  if (!draft) return null;
  const base = {
    id: draft.id,
    label: draft.label.trim(),
    icon: draft.icon.trim() || undefined,
    enabled: draft.enabled,
    match: {
      target: draft.match.target,
      nodeTypes: editingNodeTypes.value.length > 0 ? [...editingNodeTypes.value] : undefined,
      relationshipTypes:
        editingEdgeTypes.value.length > 0 ? [...editingEdgeTypes.value] : undefined,
      propertyConditions:
        editingConditions.value.filter((c) => c.property.trim() !== '').length > 0
          ? editingConditions.value
              .filter((c) => c.property.trim() !== '')
              .map((c) => ({ ...c, property: c.property.trim() }))
          : undefined,
    },
  };
  if (draft.kind === 'open-url') {
    return {
      ...base,
      kind: 'open-url',
      urlTemplate: editingUrlTemplate.value.trim(),
      openIn: editingOpenIn.value,
    };
  }
  if (draft.kind === 'copy-text') {
    return { ...base, kind: 'copy-text', textTemplate: editingTextTemplate.value };
  }
  if (draft.kind === 'show-same-value') {
    return { ...base, kind: 'show-same-value', field: editingField.value.trim(), mode: editingMode.value };
  }
  if (draft.kind === 'show-table') {
    const source = canvasSource.value;
    if (typeof source === 'string') return null;
    const ids = new Set(source.type === 'program' ? (source.params ?? []).map((p) => p.id) : []);
    const bindings = Object.fromEntries(
      Object.entries(editingBindings.value).filter(([k, v]) => ids.has(k) && v.trim() !== ''),
    );
    return { ...base, kind: 'show-table', source, ...(Object.keys(bindings).length ? { paramBindings: bindings } : {}) };
  }
  if (draft.kind === 'run-table-provider') {
    const source = selectedSource.value;
    // Only what the context opened; a source not usable here keeps what the action had.
    const names = source?.registered ? source.params.map((p) => p.name) : Object.keys(editingProviderHow.value);
    const pick = (how: 'bind' | 'fixed') =>
      Object.fromEntries(
        names
          .filter((n) => editingProviderHow.value[n] === how && (editingProviderText.value[n] ?? '').trim() !== '')
          .map((n) => [n, editingProviderText.value[n].trim()]),
      );
    const bindings = pick('bind');
    const fixed = paramValues(source?.registered ? source.params : undefined, pick('fixed'));
    return {
      ...base,
      kind: 'run-table-provider',
      source: editingSource.value,
      ...(Object.keys(bindings).length ? { paramBindings: bindings } : {}),
      ...(Object.keys(fixed).length ? { params: fixed } : {}),
    };
  }
  return {
    ...base,
    kind: 'run-query-template',
    templateId: editingTemplateId.value,
    templateName: selectedTemplate.value?.name,
    paramBindings: Object.fromEntries(
      Object.entries(editingBindings.value).filter(([, v]) => v.trim() !== ''),
    ),
    // Absent means graph: configs saved before table results stay as they were.
    ...(editingResultMode.value === 'table' ? { resultMode: 'table' as const } : {}),
  };
}

function save() {
  const config = buildConfig();
  if (!config) return;
  if (isNew.value) store.addConfig(config);
  else store.updateConfig(config);
  editing.value = null;
  success(isNew.value ? 'Action added' : 'Action updated');
}

function duplicate(config: ContextMenuActionConfig) {
  store.addConfig({
    ...JSON.parse(JSON.stringify(config)),
    id: crypto.randomUUID(),
    label: `${config.label} (copy)`,
  });
}

function remove(config: ContextMenuActionConfig) {
  store.removeConfig(config.id);
  if (editing.value?.id === config.id) editing.value = null;
}

// ---------------------------------------------------------------------------
// Import JSON (Ask-AI return leg)
// ---------------------------------------------------------------------------

const showImport = ref(false);
const importText = ref('');
const importError = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function sourceSchema() {
  return buildSourceSchema({
    context: graphStore.currentContext,
    loadedNodeTypes: graphStore.nodeTypes,
    loadedEdgeTypes: graphStore.edgeTypes,
    templates: templatesStore.templates,
  });
}

/** Download every configured action as a portable JSON file. */
function exportActions() {
  const payload: PortableContextMenuActions = {
    graphlagoon_export: 'context-menu-actions',
    export_version: PORTABLE_EXPORT_VERSION,
    source: sourceSchema(),
    actions: store.actionConfigs,
  };
  downloadJson(safeFilename(`actions-${graphStore.currentContext?.title || 'context'}`), payload);
}

/** Parsed view of the Import box; null while it holds nothing. */
const parsedImport = computed(() => {
  const text = importText.value.trim();
  return text ? parseImportedActionConfigs(text, tableSources.value) : null;
});

const importedSource = computed(() =>
  parsedImport.value?.ok ? parsedImport.value.source : undefined,
);

/** Types, properties and template ids the pasted actions use that this graph lacks. */
const importWarnings = computed(() => {
  if (!parsedImport.value?.ok) return null;
  const schema = sourceSchema();
  const w = actionCompatibilityWarnings(parsedImport.value.configs, {
    nodeTypes: schema.node_types,
    edgeTypes: schema.relationship_types,
    nodeProperties: schema.node_properties,
    edgeProperties: schema.edge_properties,
    templateIds: templatesStore.templates.map((t) => t.id),
    tableSources: tableSources.value,
  });
  return hasActionCompatibilityWarnings(w) ? w : null;
});

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = null;
  try {
    importText.value = await readFileAsText(file);
  } catch {
    importError.value = 'Could not read the file';
  } finally {
    input.value = '';
  }
}

function applyImport() {
  importError.value = null;
  const result = parseImportedActionConfigs(importText.value, tableSources.value);
  if (!result.ok) {
    importError.value = result.error;
    return;
  }
  for (const config of result.configs) {
    store.addConfig(config);
  }
  importText.value = '';
  showImport.value = false;
  success(`Imported ${result.configs.length} action${result.configs.length > 1 ? 's' : ''}`);
}

const showSkill = ref(false);

function close() {
  editing.value = null;
  emit('update:modelValue', false);
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-container {
  background: var(--vt-c-bg, #ffffff);
  border-radius: 12px;
  width: 90%;
  max-width: 760px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--vt-c-divider, #e0e0e0);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--vt-c-text-1, #222);
}

.header-actions {
  display: flex;
  gap: 6px;
}

.btn-icon-only {
  background: none;
  border: none;
  color: var(--vt-c-text-2, #888);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 4px;
}

.btn-icon-only:hover {
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-1, #222);
}

.modal-content {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.readonly-note {
  margin: 0;
  padding: 8px 12px;
  background: var(--vt-c-bg-soft, #f6f6f6);
  border-radius: 6px;
  font-size: 0.85rem;
  color: var(--vt-c-text-2, #555);
}

.section-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--vt-c-text-1, #222);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.subsection-title {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--vt-c-text-2, #555);
  margin: 10px 0 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.empty-note,
.hint {
  font-size: 0.8rem;
  color: var(--vt-c-text-2, #777);
  margin: 4px 0;
}

.hint.warning {
  color: #b45309;
}

.warning-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid #b45309;
  border-radius: 6px;
}

.warning-block p,
.warning-block ul {
  margin: 0;
}

.warning-block ul {
  padding-left: 18px;
}

.warning-block .btn-secondary,
.list-actions .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.file-input {
  display: none;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--vt-c-divider, #e5e5e5);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 0.85rem;
}

.action-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vt-c-text-1, #222);
}

.kind-badge,
.target-badge {
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-2, #666);
  white-space: nowrap;
}

.row-buttons {
  display: flex;
  gap: 4px;
}

.btn-small {
  font-size: 0.72rem;
  padding: 3px 8px;
  border: 1px solid var(--vt-c-divider, #ddd);
  background: var(--vt-c-bg, #fff);
  color: var(--vt-c-text-1, #333);
  border-radius: 4px;
  cursor: pointer;
}

.btn-small.danger {
  color: #c0392b;
}

.list-actions,
.form-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.btn-primary {
  background: var(--color-primary, #42b883);
  color: #fff;
  border: none;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-1, #333);
  border: 1px solid var(--vt-c-divider, #ddd);
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
}

.form-section {
  border: 1px solid var(--vt-c-divider, #e0e0e0);
  border-radius: 8px;
  padding: 14px;
}

.form-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px 10px;
  align-items: center;
  font-size: 0.85rem;
}

.form-grid label {
  color: var(--vt-c-text-2, #555);
}

.form-grid input,
.form-grid select,
.kind-fields input,
.kind-fields select,
.condition-row input,
.condition-row select,
.binding-row input,
.import-textarea {
  padding: 6px 8px;
  border: 1px solid var(--vt-c-divider, #ddd);
  border-radius: 4px;
  font-size: 0.85rem;
  background: var(--vt-c-bg, #fff);
  color: var(--vt-c-text-1, #222);
  width: 100%;
  box-sizing: border-box;
}

.icon-input {
  max-width: 80px;
}

.type-filter {
  margin-top: 8px;
}

.type-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 0.82rem;
}

.type-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--vt-c-text-1, #333);
}

.condition-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  align-items: center;
}

.condition-property {
  flex: 1;
}

.condition-value {
  flex: 1;
}

.kind-fields {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}

.kind-fields > label {
  color: var(--vt-c-text-2, #555);
}

.inline-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.inline-fields label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hint-inline {
  font-weight: normal;
  font-size: 11px;
  color: var(--text-muted, #666);
}
.params-json {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.test-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.test-preview {
  border: 1px solid var(--border-color, #eee);
  border-radius: 4px;
  padding: 6px 8px;
}
.preview-scroll {
  max-height: 200px;
  overflow: auto;
}
.preview-scroll table {
  border-collapse: collapse;
  font-size: 12px;
}
.preview-scroll th,
.preview-scroll td {
  padding: 2px 8px;
  border-bottom: 1px solid var(--border-color, #eee);
  text-align: left;
  white-space: nowrap;
}
.radio-row {
  display: flex;
  gap: 18px;
}

.radio-row label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.provider-param {
  margin-bottom: 8px;
}

.provider-param-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.provider-param .binding-row > select,
.provider-param .binding-row > input {
  flex: 1 1 0;
  min-width: 0;
  width: auto;
}

.binding-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.binding-param {
  min-width: 110px;
  font-family: monospace;
  font-size: 0.8rem;
}

.required {
  color: #c0392b;
}

.field-error {
  color: #c0392b;
  font-size: 0.78rem;
  margin: 2px 0;
}

.import-section {
  border: 1px dashed var(--vt-c-divider, #ccc);
  border-radius: 8px;
  padding: 12px;
}

.import-textarea {
  font-family: monospace;
  resize: vertical;
}
</style>
