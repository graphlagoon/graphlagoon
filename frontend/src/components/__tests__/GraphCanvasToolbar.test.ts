/**
 * The canvas chrome shared by the exploration page and the case: which buttons
 * show is the host's call, what they emit is fixed.
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import GraphCanvasToolbar from '@/components/GraphCanvasToolbar.vue';

describe('GraphCanvasToolbar', () => {
  it('renders the buttons it is given, with the host\'s test ids, and emits per kind', async () => {
    const { getByTestId, queryByTestId, emitted } = render(GraphCanvasToolbar, {
      props: {
        buttons: ['layout', 'table', 'fit', 'export'],
        active: { table: true },
        viewMode: '2d-proj',
        testIds: { layout: 'graph-toolbar-layout' },
      },
    });
    expect(queryByTestId('canvas-toolbar-info')).toBeNull();
    expect(getByTestId('canvas-toolbar-table').getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(getByTestId('graph-toolbar-layout'));
    expect(emitted('toggle')?.[0]).toEqual(['layout']);
    await fireEvent.click(getByTestId('canvas-toolbar-fit'));
    expect(emitted('fit')).toHaveLength(1);
    await fireEvent.click(getByTestId('canvas-toolbar-export'));
    expect(emitted('export')).toHaveLength(1);
    await fireEvent.click(getByTestId('canvas-toolbar-3d'));
    expect(emitted('view-mode')?.[0]).toEqual(['3d']);
    await fireEvent.click(getByTestId('canvas-toolbar-fullscreen'));
    expect(emitted('fullscreen')).toHaveLength(1);
  });

  it('can hide the view mode and fullscreen controls', () => {
    const { queryByTestId } = render(GraphCanvasToolbar, {
      props: { buttons: ['filters'], showViewMode: false, showFullscreen: false },
    });
    expect(queryByTestId('canvas-toolbar-3d')).toBeNull();
    expect(queryByTestId('canvas-toolbar-fullscreen')).toBeNull();
    expect(queryByTestId('canvas-toolbar-filters')).not.toBeNull();
  });

  it('the Clusters button (case toolbar) toggles the clusters panel', async () => {
    const { getByTestId, emitted } = render(GraphCanvasToolbar, {
      props: { buttons: ['clusters'], testIds: { clusters: 'workspace-clusters-btn' } },
    });
    const button = getByTestId('workspace-clusters-btn');
    expect(button.textContent).toContain('Clusters');
    await fireEvent.click(button);
    expect(emitted('toggle')?.[0]).toEqual(['clusters']);
  });
});
