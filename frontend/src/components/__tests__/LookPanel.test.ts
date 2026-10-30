/**
 * The Look panel: style, labels, behaviors and presets behind one header and a
 * tab row, shared by the exploration page and the case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import LookPanel from '@/components/LookPanel.vue';

const stubs = {
  AestheticsPanel: { props: { embedded: Boolean }, template: '<div data-testid="stub-style" :data-embedded="String(embedded)" />' },
  TextFormatPanel: { template: '<div data-testid="stub-labels" />' },
  BehaviorPanel: { template: '<div data-testid="stub-behaviors" />' },
  StylePresetList: { props: ['apply', 'contextId', 'canWrite'], template: '<div data-testid="stub-presets" :data-apply="apply" :data-context="contextId" />' },
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('LookPanel', () => {
  it('opens on the style tab, embeds the sub-panel and asks the host to switch tabs', async () => {
    const { getByTestId, queryByTestId, emitted } = render(LookPanel, {
      props: { presetsApply: 'url', presetsContextId: 'c1' },
      global: { stubs },
    });
    expect(getByTestId('stub-style').getAttribute('data-embedded')).toBe('true');
    expect(queryByTestId('stub-labels')).toBeNull();

    await fireEvent.click(getByTestId('look-tab-labels'));
    expect(emitted('update:tab')?.[0]).toEqual(['labels']);
  });

  it('shows the tab it is given, passes the presets mode and context, and renders a caption and footer', async () => {
    const { getByTestId, emitted } = render(LookPanel, {
      props: { tab: 'presets', presetsApply: 'store', presetsContextId: 'c7', caption: 'Look of “Pix”' },
      slots: { footer: '<button data-testid="footer-btn">Save</button>' },
      global: { stubs },
    });
    expect(getByTestId('stub-presets').getAttribute('data-apply')).toBe('store');
    expect(getByTestId('stub-presets').getAttribute('data-context')).toBe('c7');
    expect(getByTestId('look-caption').textContent).toContain('Pix');
    expect(getByTestId('footer-btn')).toBeTruthy();

    await fireEvent.click(getByTestId('look-close'));
    expect(emitted('close')).toBeTruthy();
  });
});
