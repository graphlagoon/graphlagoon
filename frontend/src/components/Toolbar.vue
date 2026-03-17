<script setup lang="ts">
import { ref, computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useGraphStore } from '@/stores/graph';
import { useAuthStore } from '@/stores/auth';
import { useToolbarStore } from '@/stores/toolbar';
import { usePersistence } from '@/composables/usePersistence';
import { api } from '@/services/api';
import type { Exploration } from '@/types/graph';
import type { ExportPNGOptions } from '@/stores/toolbar';
import ExportModal from '@/components/ExportModal.vue';
import {
  Filter,
  Sliders,
  Search,
  BarChart2,
  Palette,
  Tag,
  Hexagon,
  FileText,
  FolderOpen,
  Save,
  Download,
  User,
  Loader2,
  X,
  Info,
  ExternalLink,
} from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const graphStore = useGraphStore();
const authStore = useAuthStore();
const toolbarStore = useToolbarStore();
const { devMode } = usePersistence();

const isGraphPage = computed(() => route.name === 'graph');
const toolbarHandlers = computed(() => toolbarStore.handlers);

function logout() {
  authStore.logout();
  router.push('/login');
}

const showAboutModal = ref(false);
const showUserMenu = ref(false);
const showSaveModal = ref(false);
const showExplorationSelector = ref(false);
const showExportModal = ref(false);
const explorations = ref<Exploration[]>([]);
const saveTitle = ref('');
const saveError = ref<string | null>(null);

async function loadExplorations() {
  if (!graphStore.currentContext) return;
  try {
    explorations.value = await api.getExplorations(graphStore.currentContext.id);
    showExplorationSelector.value = true;
  } catch (e) {
    console.error(e);
  }
}

async function selectExploration(exploration: Exploration) {
  await graphStore.loadExploration(exploration.id);
  showExplorationSelector.value = false;
  if (graphStore.currentContext?.id) {
    router.replace({
      name: 'graph',
      params: { contextId: graphStore.currentContext.id },
      query: { exploration: exploration.id },
    });
  }
}

function openSaveModal() {
  saveTitle.value = graphStore.currentExploration?.title || '';
  saveError.value = null;
  showSaveModal.value = true;
}

async function saveExploration() {
  if (!saveTitle.value) return;
  saveError.value = null;
  const result = await graphStore.saveExploration(saveTitle.value);
  if (result.success) {
    showSaveModal.value = false;
    if (graphStore.currentExploration?.id && graphStore.currentContext?.id) {
      router.replace({
        name: 'graph',
        params: { contextId: graphStore.currentContext.id },
        query: { exploration: graphStore.currentExploration.id },
      });
    }
  } else {
    saveError.value = result.error || 'Failed to save exploration';
  }
}

function exportJSON() {
  const data = { nodes: graphStore.nodes, edges: graphStore.edges };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = `${graphStore.currentContext?.title || 'graph'}.json`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

function handleExportPng(options: ExportPNGOptions) {
  toolbarHandlers.value?.onExportPNG(options);
}
</script>

<template>
  <div class="toolbar">
    <!-- Left: brand + navigation + context breadcrumb -->
    <div class="toolbar-left">
      <RouterLink to="/" class="brand" aria-label="Graph Lagoon home">
        <svg class="brand-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2 17c2-4 4-6 6-6s4 4 6 4 4-3 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>
          <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="0.7"/>
        </svg>
        <span class="brand-name">Graph Lagoon</span>
      </RouterLink>

      <span class="title-sep" aria-hidden="true"></span>

      <RouterLink to="/contexts" class="nav-link" data-testid="nav-contexts">Contexts</RouterLink>
      <span class="title-sep" aria-hidden="true"></span>
      <RouterLink to="/explorations" class="nav-link" data-testid="nav-explorations">Explorations</RouterLink>
      <RouterLink v-if="devMode" to="/dev/generator" class="nav-link dev-link" data-testid="nav-dev">DEV</RouterLink>

      <template v-if="isGraphPage">
        <span class="title-sep" aria-hidden="true"></span>
        <span class="context-title" data-testid="toolbar-context-title">{{ graphStore.currentContext?.title }}</span>
        <span
          v-if="graphStore.enhancedHasMultiEdges"
          class="multi-edge-badge"
          :title="`Multi-graph: ${graphStore.enhancedMultiEdgeStats.multiEdgePairCount} pairs with ${graphStore.enhancedMultiEdgeStats.totalMultiEdges} edges`"
        >
          Multi
        </span>
        <span class="title-sep" aria-hidden="true"></span>
        <span v-if="graphStore.currentExploration" class="exploration-name">
          {{ graphStore.currentExploration.title }}
        </span>
        <span v-else class="exploration-unsaved">Unsaved</span>
      </template>
    </div>

    <!-- Center: action buttons (graph page only) -->
    <div v-if="isGraphPage && toolbarHandlers" class="toolbar-center">
      <template v-if="graphStore.loading">
        <span class="loading-indicator">
          <Loader2 :size="14" class="spin" />
          Loading…
        </span>
      </template>

      <template v-else>
        <!-- Group 1: Explore -->
        <div class="btn-group" role="group" aria-label="Explore">
          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('filters') }"
            :aria-pressed="toolbarStore.activePanels.has('filters')"
            title="Filters"
            @click="toolbarHandlers?.onToggleFilters()"
          >
            <Filter :size="15" /><span class="btn-text">Filters</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('query') }"
            :aria-pressed="toolbarStore.activePanels.has('query')"
            title="Query"
            @click="toolbarHandlers?.onToggleQuery()"
          >
            <Search :size="15" /><span class="btn-text">Query</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('templates') }"
            :aria-pressed="toolbarStore.activePanels.has('templates')"
            title="Query Templates"
            @click="toolbarHandlers?.onToggleTemplates()"
          >
            <FileText :size="15" /><span class="btn-text">Templates</span>
          </button>
        </div>

        <div class="btn-group-sep" aria-hidden="true"></div>

        <!-- Group 2: Visualize -->
        <div class="btn-group" role="group" aria-label="Visualize">
          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('aesthetics') }"
            :aria-pressed="toolbarStore.activePanels.has('aesthetics')"
            title="Style"
            @click="toolbarHandlers?.onToggleAesthetics()"
          >
            <Palette :size="15" /><span class="btn-text">Style</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('labels') }"
            :aria-pressed="toolbarStore.activePanels.has('labels')"
            title="Labels"
            @click="toolbarHandlers?.onToggleLabels()"
          >
            <Tag :size="15" /><span class="btn-text">Labels</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('metrics') }"
            :aria-pressed="toolbarStore.activePanels.has('metrics')"
            title="Metrics"
            @click="toolbarHandlers?.onToggleMetrics()"
          >
            <BarChart2 :size="15" /><span class="btn-text">Metrics</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('clusters') }"
            :aria-pressed="toolbarStore.activePanels.has('clusters')"
            title="Clusters"
            @click="toolbarHandlers?.onToggleClusterPrograms()"
          >
            <Hexagon :size="15" /><span class="btn-text">Clusters</span>
          </button>
        </div>

        <div class="btn-group-sep" aria-hidden="true"></div>

        <!-- Group 3: Config -->
        <div class="btn-group" role="group" aria-label="Config">
          <button
            class="toolbar-btn"
            :class="{ active: toolbarStore.activePanels.has('behaviors') }"
            :aria-pressed="toolbarStore.activePanels.has('behaviors')"
            title="Behaviors"
            @click="toolbarHandlers?.onToggleBehaviors()"
          >
            <Sliders :size="15" /><span class="btn-text">Behaviors</span>
          </button>
        </div>

        <div class="btn-group-sep" aria-hidden="true"></div>

        <!-- Group 4: File -->
        <div class="btn-group" role="group" aria-label="File">
          <button class="toolbar-btn" title="Load Exploration" @click="loadExplorations">
            <FolderOpen :size="15" /><span class="btn-text">Load</span>
          </button>

          <button
            v-if="graphStore.graphQuery || graphStore.currentExploration"
            class="toolbar-btn toolbar-btn--primary"
            title="Save Exploration"
            @click="openSaveModal"
          >
            <Save :size="15" /><span class="btn-text">Save</span>
          </button>
        </div>
      </template>
    </div>

    <!-- Right: export + about + user -->
    <div class="toolbar-right">
      <button
        v-if="isGraphPage && toolbarHandlers && !graphStore.loading"
        class="toolbar-btn"
        title="Export"
        @click="showExportModal = true"
      >
        <Download :size="15" /><span class="btn-text">Export</span>
      </button>

      <button
        class="toolbar-btn"
        title="About Graph Lagoon Studio"
        @click="showAboutModal = true"
      >
        <Info :size="15" />
      </button>

      <div v-if="devMode" class="user-menu-container">
        <button class="btn-user-icon" :aria-expanded="showUserMenu" title="User menu" @click="showUserMenu = !showUserMenu">
          <User :size="18" />
        </button>
        <div v-if="showUserMenu" class="user-menu-dropdown" @click.stop>
          <div class="user-menu-email">{{ authStore.email }}</div>
          <button class="user-menu-item" @click="logout(); showUserMenu = false">Logout</button>
        </div>
        <div v-if="showUserMenu" class="user-menu-backdrop" @click="showUserMenu = false"></div>
      </div>
    </div>

    <!-- Save Modal -->
    <div v-if="showSaveModal" class="modal-overlay" @click.self="showSaveModal = false">
      <div class="modal">
        <div class="modal-header">
          <h2>Save Exploration</h2>
          <button class="modal-close" aria-label="Close" @click="showSaveModal = false">
            <X :size="16" />
          </button>
        </div>
        <form @submit.prevent="saveExploration">
          <div class="form-group">
            <label>Title</label>
            <input v-model="saveTitle" class="form-control" required />
          </div>
          <div v-if="saveError" class="save-error">{{ saveError }}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" @click="showSaveModal = false">Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Load Exploration Modal -->
    <div v-if="showExplorationSelector" class="modal-overlay" @click.self="showExplorationSelector = false">
      <div class="modal">
        <div class="modal-header">
          <h2>Load Exploration</h2>
          <button class="modal-close" aria-label="Close" @click="showExplorationSelector = false">
            <X :size="16" />
          </button>
        </div>
        <div v-if="explorations.length === 0" class="empty-state">No saved explorations</div>
        <div v-else class="exploration-list">
          <button
            v-for="exp in explorations"
            :key="exp.id"
            class="exploration-item"
            @click="selectExploration(exp)"
          >
            <span class="exploration-title">{{ exp.title }}</span>
            <span class="exploration-date">{{ new Date(exp.updated_at).toLocaleDateString() }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Export Modal -->
    <ExportModal
      :visible="showExportModal"
      :canvas-width="toolbarStore.canvasWidth"
      :canvas-height="toolbarStore.canvasHeight"
      @close="showExportModal = false"
      @export-png="handleExportPng"
      @export-json="exportJSON"
    />

    <!-- About Modal -->
    <div v-if="showAboutModal" class="modal-overlay" @click.self="showAboutModal = false">
      <div class="modal about-modal">
        <div class="modal-header">
          <h2>About Graph Lagoon Studio</h2>
          <button class="modal-close" aria-label="Close" @click="showAboutModal = false">
            <X :size="16" />
          </button>
        </div>

        <div class="about-content">
          <div class="about-brand">
            <svg class="about-brand-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M2 17c2-4 4-6 6-6s4 4 6 4 4-3 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>
              <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="0.7"/>
            </svg>
            <div>
              <div class="about-title">Graph Lagoon Studio</div>
              <div class="about-version">v{{ api.appVersion }}</div>
            </div>
          </div>

          <p class="about-description">
            Interactive graph visualization and exploration tool for large-scale relational data.
          </p>

          <div class="about-links">
            <a href="https://github.com/graphlagoon/graphlagoon" target="_blank" rel="noopener noreferrer" class="about-link">
              <ExternalLink :size="14" />
              GitHub Repository
            </a>
            <a href="https://github.com/graphlagoon/graphlagoon/issues" target="_blank" rel="noopener noreferrer" class="about-link">
              <ExternalLink :size="14" />
              Report an Issue
            </a>
            <a href="https://github.com/graphlagoon/graphlagoon/discussions" target="_blank" rel="noopener noreferrer" class="about-link">
              <ExternalLink :size="14" />
              Community & Support
            </a>
          </div>

          <div class="about-footer">
            <span>AGPL-3.0 License</span>
            <span class="about-sep">·</span>
            <span>Bruno Messias</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-4);
  height: 52px;
  background: var(--color-toolbar-bg);
  border-bottom: 1px solid var(--color-toolbar-border);
  gap: var(--space-3);
  flex-shrink: 0;
}

/* ── Brand ────────────────────────────────────────────────── */
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  text-decoration: none;
  color: var(--color-primary);
  font-weight: var(--font-semibold);
  font-size: var(--text-md);
  letter-spacing: -0.01em;
  flex-shrink: 0;
}
.brand:hover { opacity: 0.85; }
.brand-icon { flex-shrink: 0; }
.brand-name { white-space: nowrap; }

/* ── Sections ─────────────────────────────────────────────── */
.toolbar-left,
.toolbar-center,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.toolbar-left { flex-shrink: 0; }
.toolbar-right { flex-shrink: 0; }
.toolbar-center { flex: 1; justify-content: center; flex-wrap: nowrap; }

/* ── Navigation ───────────────────────────────────────────── */
.nav-link {
  font-weight: var(--font-medium);
  font-size: var(--text-base);
  color: var(--color-toolbar-text-muted);
  text-decoration: none;
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast), background-color var(--transition-fast);
}
.nav-link:hover { color: var(--color-toolbar-text); background: var(--color-toolbar-hover-bg); }
.nav-link.router-link-active { color: var(--color-primary); font-weight: var(--font-semibold); }
.nav-link:focus-visible { outline: none; box-shadow: var(--focus-ring); }

.dev-link { color: #f59e0b !important; }

.title-sep {
  width: 1px;
  height: 16px;
  background: var(--color-toolbar-sep);
  flex-shrink: 0;
}

.context-title {
  font-weight: var(--font-semibold);
  font-size: var(--text-md);
  color: var(--color-toolbar-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.exploration-name {
  font-weight: var(--font-medium);
  font-size: var(--text-base);
  color: var(--color-toolbar-text-muted);
  white-space: nowrap;
}

.exploration-unsaved {
  font-size: var(--text-base);
  color: var(--color-warning);
  font-style: italic;
}

.multi-edge-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #fff;
  background: #6366f1;
  border-radius: var(--radius-sm);
  cursor: help;
}

/* ── Button groups ────────────────────────────────────────── */
.btn-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.btn-group-sep {
  width: 1px;
  height: 20px;
  background: var(--color-toolbar-sep);
  margin: 0 var(--space-1);
  flex-shrink: 0;
}

/* ── Toolbar button ───────────────────────────────────────── */
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px var(--space-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
  color: var(--color-toolbar-text-muted);
  transition: background-color var(--transition-fast), color var(--transition-fast),
              border-color var(--transition-fast);
  white-space: nowrap;
}

.toolbar-btn:hover {
  background: var(--color-toolbar-hover-bg);
  color: var(--color-toolbar-text);
  border-color: transparent;
}

.toolbar-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* Active state: panel is open */
.toolbar-btn.active {
  background: var(--color-toolbar-active-bg);
  color: var(--color-primary);
  border-color: transparent;
}
.toolbar-btn.active:hover {
  background: rgba(20, 184, 166, 0.25);
}

/* Primary variant for Save */
.toolbar-btn--primary {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}
.toolbar-btn--primary:hover {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
  color: white;
}
.toolbar-btn--primary.active {
  background: var(--color-primary);
  color: white;
}

/* ── Loading indicator ────────────────────────────────────── */
.loading-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-primary);
  background: var(--color-toolbar-active-bg);
  border-radius: var(--radius-md);
}

.spin {
  animation: spin 0.8s linear infinite;
}

/* ── User menu ────────────────────────────────────────────── */
.user-menu-container { position: relative; }

.btn-user-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-circle);
  border: 1px solid rgba(20, 184, 166, 0.3);
  background: rgba(20, 184, 166, 0.1);
  cursor: pointer;
  color: var(--color-toolbar-text-muted);
  transition: background-color var(--transition-fast), color var(--transition-fast),
              border-color var(--transition-fast);
}
.btn-user-icon:hover {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}
.btn-user-icon:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.user-menu-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  min-width: 200px;
  z-index: var(--z-dropdown);
  overflow: hidden;
}

.user-menu-email {
  padding: 10px 14px;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  word-break: break-all;
}

.user-menu-item {
  display: block;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: none;
  text-align: left;
  font-size: var(--text-base);
  cursor: pointer;
  color: var(--color-text);
  transition: background-color var(--transition-fast);
}
.user-menu-item:hover { background: var(--color-bg-muted); }

.user-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-dropdown) - 1);
}

/* ── Exploration list (in modal) ──────────────────────────── */
.exploration-list {
  max-height: 300px;
  overflow-y: auto;
}

.exploration-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  background: none;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  transition: background-color var(--transition-fast);
}
.exploration-item:last-child { border-bottom: none; }
.exploration-item:hover { background: var(--color-bg); }

.exploration-title { font-weight: var(--font-medium); }
.exploration-date {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

/* ── Save error ───────────────────────────────────────────── */
.save-error {
  margin: 0 0 var(--space-3);
  padding: 10px var(--space-3);
  background: #fff1f0;
  border: 1px solid #ffcdd2;
  border-radius: var(--radius-sm);
  color: #c62828;
  font-size: var(--text-sm);
}

/* ── About modal ─────────────────────────────────────────── */
.about-modal {
  max-width: 420px;
}

.about-content {
  padding: var(--space-4);
}

.about-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.about-brand-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}

.about-title {
  font-size: var(--text-lg);
  font-weight: var(--font-semibold);
  color: var(--color-text);
}

.about-version {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  font-family: monospace;
}

.about-description {
  font-size: var(--text-base);
  color: var(--color-text-muted);
  line-height: 1.5;
  margin-bottom: var(--space-4);
}

.about-links {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.about-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-primary);
  text-decoration: none;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  transition: background-color var(--transition-fast);
}
.about-link:hover {
  background: var(--color-bg-muted);
}

.about-footer {
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.about-sep {
  opacity: 0.4;
}

/* ── Responsive ───────────────────────────────────────────── */
@media (max-width: 1400px) {
  .toolbar-center .btn-text { display: none; }
  .toolbar-btn { padding: 6px 7px; }
}

@media (max-width: 1100px) {
  .toolbar-center { gap: 2px; }
  .btn-group-sep { margin: 0; }
}

@media (max-width: 768px) {
  .toolbar { height: auto; flex-wrap: wrap; padding: var(--space-2) var(--space-3); }
  .toolbar-left { order: 1; flex: 1; }
  .toolbar-right { order: 2; }
  .toolbar-center { order: 3; width: 100%; justify-content: flex-start; padding-top: var(--space-2); border-top: 1px solid var(--color-toolbar-sep); }
  .context-title, .exploration-name, .exploration-unsaved, .multi-edge-badge { display: none; }
  .brand-name { display: none; }
}
</style>
