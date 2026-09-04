<script setup lang="ts">
import { ref, computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useGraphStore } from '@/stores/graph';
import { useAuthStore } from '@/stores/auth';
import { useToolbarStore } from '@/stores/toolbar';
import { usePersistence } from '@/composables/usePersistence';
import { usePermissions } from '@/composables/usePermissions';
import { useToast } from '@/composables/useToast';
import { api } from '@/services/api';
import { getErrorMessage } from '@/utils/errorMessage';
import type { Exploration } from '@/types/graph';
import type { ExportPNGOptions } from '@/stores/toolbar';
import ExportModal from '@/components/ExportModal.vue';
import { downloadJson } from '@/utils/portableExport';
import { GRAPH_SHORTCUTS } from '@/utils/shortcuts';
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
  DatabaseZap,
  Download,
  User,
  Loader2,
  X,
  Info,
  ExternalLink,
  Shield,
  FlaskConical,
  LogOut,
} from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const graphStore = useGraphStore();
const authStore = useAuthStore();
const toolbarStore = useToolbarStore();
const toast = useToast();
const { devMode, isSuperuser } = usePersistence();
const { canSaveExplorations } = usePermissions();

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
    toast.error(getErrorMessage(e, 'Failed to load explorations'));
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
  // Save affordances are hidden without the permission; the exploration-name
  // chip stays visible (it identifies what is loaded), so its click lands
  // here and gets an explanation instead of a hidden modal.
  if (!canSaveExplorations.value) {
    toast.info("You don't have the Save explorations permission — ask an administrator.");
    return;
  }
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
  downloadJson(`${graphStore.currentContext?.title || 'graph'}.json`, data);
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
      </RouterLink>

      <span class="title-sep" aria-hidden="true"></span>

      <RouterLink to="/contexts" class="nav-link" data-testid="nav-contexts">Contexts</RouterLink>
      <span class="title-sep" aria-hidden="true"></span>
      <RouterLink to="/explorations" class="nav-link" data-testid="nav-explorations">Explorations</RouterLink>

      <template v-if="isGraphPage">
        <span class="title-sep" aria-hidden="true"></span>
        <!-- The name is truncated by CSS, so the full one has to live somewhere:
             without the title a long context name is unrecoverable. -->
        <span
          class="context-title"
          data-testid="toolbar-context-title"
          :title="graphStore.currentContext?.title"
        >{{ graphStore.currentContext?.title }}</span>
        <span
          v-if="graphStore.enhancedHasMultiEdges"
          class="multi-edge-badge"
          :title="`Multi-graph: ${graphStore.enhancedMultiEdgeStats.multiEdgePairCount} pairs with ${graphStore.enhancedMultiEdgeStats.totalMultiEdges} edges`"
        >
          Multi
        </span>
        <span class="title-sep" aria-hidden="true"></span>
        <!-- The save state is the control, not a label: "Unsaved" used to be
             inert text while the only way to act on it was a button in a
             different group at the other end of the bar. -->
        <button
          v-if="graphStore.currentExploration"
          class="exploration-state exploration-name"
          :class="{ dirty: graphStore.isExplorationDirty }"
          data-testid="toolbar-exploration-name"
          :title="graphStore.isExplorationDirty
            ? `“${graphStore.currentExploration.title}” has unsaved changes — click to save them`
            : `Saved as “${graphStore.currentExploration.title}” — click to update it`"
          @click="openSaveModal"
        >
          <!-- Stands in for the name once the bar is too narrow to show a
               legible part of it: the save affordance and the dirty dot must
               survive widths where the text cannot. -->
          <Save :size="14" class="exploration-icon" aria-hidden="true" />
          <!-- The title is in its own span so the ellipsis eats only the name:
               applied to the button it would clip the dirty dot too, hiding the
               unsaved indicator on exactly the long names that need it. -->
          <span class="exploration-label">{{ graphStore.currentExploration.title }}</span>
          <!-- A dot, not the word "modified": it sits in a dense bar and the
               tooltip carries the sentence. -->
          <span
            v-if="graphStore.isExplorationDirty"
            class="dirty-dot"
            data-testid="toolbar-exploration-dirty"
            aria-hidden="true"
          >●</span>
          <span v-if="graphStore.isExplorationDirty" class="sr-only">has unsaved changes</span>
        </button>
        <button
          v-else-if="canSaveExplorations"
          class="exploration-state exploration-unsaved"
          data-testid="toolbar-exploration-unsaved"
          title="This view is not saved. Click to save it as an exploration."
          @click="openSaveModal"
        >
          Unsaved
        </button>
      </template>
    </div>

    <!-- Center: action buttons (graph page only) -->
    <!-- The panel toggles stay put while a query runs: a toolbar that
         disappears mid-query reads as a broken page, and the panels
         (filters, style, labels…) are all usable while data loads. -->
    <div v-if="isGraphPage && toolbarHandlers" class="toolbar-center">
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
            data-testid="toolbar-query"
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
            v-if="canSaveExplorations && (graphStore.graphQuery || graphStore.currentExploration)"
            class="toolbar-btn toolbar-btn--primary"
            title="Save Exploration"
            @click="openSaveModal"
          >
            <Save :size="15" /><span class="btn-text">Save</span>
          </button>

        </div>
    </div>

    <!-- Right: export + about + user -->
    <div class="toolbar-right">
      <span v-if="isGraphPage && graphStore.loading" class="loading-indicator" data-testid="toolbar-loading">
        <Loader2 :size="14" class="spin" />
        <span class="btn-text">Loading…</span>
      </span>
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

      <!-- The account menu also holds everything role-gated: DEV, Admin and
           Precomputed are used by a minority, rarely, and each one cost the
           toolbar permanent width — measured at 874px for the left group with
           DEV and Admin showing, which is what pushed the panel toggles off
           the screen. The menu renders for everyone now, not only in dev mode:
           it is the only way to reach Admin. -->
      <div class="user-menu-container">
        <button
          class="btn-user-icon"
          :aria-expanded="showUserMenu"
          title="User menu"
          data-testid="user-menu-btn"
          @click="showUserMenu = !showUserMenu"
        >
          <User :size="18" />
        </button>
        <div v-if="showUserMenu" class="user-menu-dropdown" @click.stop>
          <div v-if="authStore.email" class="user-menu-email">{{ authStore.email }}</div>

          <RouterLink
            v-if="isSuperuser"
            to="/admin"
            class="user-menu-item"
            data-testid="nav-admin"
            @click="showUserMenu = false"
          >
            <Shield :size="14" /> Admin area
          </RouterLink>

          <!-- Reading a precomputed graph never needs this panel — it is a URL.
               Only superusers can publish one, so it is gated on that; whether
               any provider is actually writable is a second question the panel
               answers from the server. -->
          <button
            v-if="isSuperuser && isGraphPage && toolbarHandlers"
            class="user-menu-item"
            :class="{ active: toolbarStore.activePanels.has('precomputed') }"
            data-testid="toolbar-precomputed"
            @click="toolbarHandlers.onTogglePrecomputed(); showUserMenu = false"
          >
            <DatabaseZap :size="14" /> Precomputed graphs
          </button>

          <RouterLink
            v-if="devMode"
            to="/dev/generator"
            class="user-menu-item dev-item"
            data-testid="nav-dev"
            @click="showUserMenu = false"
          >
            <FlaskConical :size="14" /> DEV generator
          </RouterLink>

          <button v-if="devMode" class="user-menu-item" @click="logout(); showUserMenu = false">
            <LogOut :size="14" /> Logout
          </button>
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

          </div>

          <div class="about-shortcuts" data-testid="about-shortcuts">
            <div class="about-shortcuts-title">Graph shortcuts</div>
            <dl class="shortcut-list">
              <template v-for="s in GRAPH_SHORTCUTS" :key="s.label">
                <dt>
                  <template v-for="(k, i) in s.keys" :key="k">
                    <kbd>{{ k }}</kbd><span v-if="i < s.keys.length - 1" class="shortcut-plus">+</span>
                  </template>
                </dt>
                <dd>{{ s.label }}</dd>
              </template>
            </dl>
          </div>

          <div class="about-footer">
            <span>MIT License</span>
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
  /* min-height rather than height: the bar wraps to two rows under 768px.
     Deliberately NOT flex-wrap here — wrapping makes flex move a group to the
     next line instead of shrinking the left group, which is what has to give. */
  min-height: 52px;
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

/* ── Sections ─────────────────────────────────────────────── */
.toolbar-left,
.toolbar-center,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* Left shrinks (both names ellipsise), right never does (Save / Export / user
   menu must stay reachable), and the centre asks for its buttons.
   `min-width: min-content` on the centre is what makes the left group yield:
   with `min-width: 0` the centre accepted any width and hid the overflow
   behind a scrollbar it also hides, so the flex algorithm never saw a shortage
   and never asked the left group — 874px wide with DEV and Admin showing — for
   anything. The measured result was Filters and Query clipped away even at
   1920px. */
.toolbar-left { flex-shrink: 1; min-width: 0; }
.toolbar-right { flex-shrink: 0; }
.toolbar-center {
  flex: 1;
  min-width: min-content;
  justify-content: center;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  /* room for the focus ring, which overflow-x:auto would otherwise clip */
  padding-block: 3px;
}
.toolbar-center::-webkit-scrollbar { display: none; }

/* ── Navigation ───────────────────────────────────────────── */
.nav-link {
  font-weight: var(--font-medium);
  font-size: var(--text-base);
  color: var(--color-toolbar-text-muted);
  text-decoration: none;
  /* Under pressure the names truncate; the nav must not wrap to two lines
     inside a 52px bar. */
  flex-shrink: 0;
  white-space: nowrap;
  padding: 4px var(--space-2);
  border-radius: var(--radius-sm);
  transition: color var(--transition-fast), background-color var(--transition-fast);
}
.nav-link:hover { color: var(--color-toolbar-text); background: var(--color-toolbar-hover-bg); }
.nav-link.router-link-active { color: var(--color-primary); font-weight: var(--font-semibold); }
.nav-link:focus-visible { outline: none; box-shadow: var(--focus-ring); }


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
  min-width: 4rem;
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

.exploration-label {
  /* A name shrunk past this shows "…" and nothing else — floor it, and drop
     the text entirely (for the icon below) when even the floor will not fit. */
  min-width: 4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.exploration-icon { display: none; flex-shrink: 0; }

.exploration-unsaved {
  font-size: var(--text-base);
  color: var(--color-warning);
  font-style: italic;
}

.exploration-state.dirty { color: var(--color-warning); }

.dirty-dot {
  flex-shrink: 0;
  margin-left: 4px;
  font-size: 9px;
  vertical-align: middle;
  color: var(--color-warning);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* Capped like .context-title: a nowrap child with no max-width sets the whole
   left group's min-content, so a long exploration name could not be shrunk
   away and the space came out of .toolbar-center — whose overflow is scrolled
   with a hidden scrollbar, so the panel toggles just left the screen. */
.exploration-state {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 200px;
  background: none;
  border: none;
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
}
.exploration-state:hover { background: var(--color-toolbar-hover-bg); }
.exploration-state:focus-visible { outline: none; box-shadow: var(--focus-ring); }

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
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: none;
  text-align: left;
  font-size: var(--text-base);
  font-family: inherit;
  cursor: pointer;
  color: var(--color-text);
  text-decoration: none;
  transition: background-color var(--transition-fast);
}
.user-menu-item:hover { background: var(--color-bg-muted); }
.user-menu-item:focus-visible { outline: none; box-shadow: var(--focus-ring); }
/* Same open/closed feedback the panel toggles give in the centre group. */
.user-menu-item.active { color: var(--color-primary); background: var(--color-toolbar-hover-bg); }
.user-menu-item.dev-item { color: var(--color-warning); }

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

.about-shortcuts {
  margin-bottom: var(--space-4);
}
.about-shortcuts-title {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--color-text);
  margin-bottom: var(--space-2);
}
.shortcut-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.shortcut-list dt { white-space: nowrap; }
.shortcut-list dd { margin: 0; }
.shortcut-list kbd {
  display: inline-block;
  padding: 1px 5px;
  font-size: var(--text-xs);
  font-family: inherit;
  color: var(--color-text);
  background: var(--color-bg-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}
.shortcut-plus { margin: 0 3px; }

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
/* Measured: with every label visible the centre group alone is ~800px, so a
   1440px viewport already overflowed by ~190px. Labels go first. */
@media (max-width: 1600px) {
  .toolbar-center .btn-text { display: none; }
  .toolbar-btn { padding: 6px 7px; }
}

@media (max-width: 1100px) {
  .toolbar-center { gap: 2px; }
  .btn-group-sep { margin: 0; }
  .context-title { max-width: 140px; }
  /* Below this the exploration name cannot show enough of itself to be worth
     the width — the chip keeps the dirty dot and the click-to-save, and the
     title attribute keeps the name. */
  .exploration-label { display: none; }
  .exploration-icon { display: inline-flex; }
  .exploration-state { max-width: none; }
}

@media (max-width: 900px) {
  .exploration-name, .exploration-unsaved, .multi-edge-badge { display: none; }
  .context-title { max-width: 110px; }
}

@media (max-width: 768px) {
  .toolbar { height: auto; flex-wrap: wrap; padding: var(--space-2) var(--space-3); }
  /* min-width:0 so the nav can shrink; without it the left group kept its
     content width and slid under the right group (About / user menu). */
  .toolbar-left { order: 1; flex: 1 1 0; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .toolbar-left::-webkit-scrollbar { display: none; }
  .toolbar-right { order: 2; }
  /* flex-basis 100% (not width) — `flex: 1` above sets basis 0, which would
     let the centre squeeze onto the first row next to the nav links. */
  .toolbar-center { order: 3; flex: 1 1 100%; min-width: 100%; justify-content: flex-start; padding-top: var(--space-2); border-top: 1px solid var(--color-toolbar-sep); }
  .context-title, .exploration-name, .exploration-unsaved, .multi-edge-badge { display: none; }
}

/* Phone widths: the separators are decoration the nav cannot afford. */
@media (max-width: 520px) {
  .toolbar-left .title-sep { display: none; }
  .nav-link { padding: 4px var(--space-1); }
}
</style>
