import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useEscapeToCloseModals } from '@/composables/useEscapeToCloseModals';
import HelpTip from '@/components/admin/HelpTip.vue';

// A modal with a help popover inside: Escape closes the popover first, the modal next.
const Host = defineComponent({
  setup() {
    useEscapeToCloseModals();
    const open = ref(true);
    return () =>
      open.value
        ? h('div', { class: 'modal-overlay', onClick: (e: MouseEvent) => e.target === e.currentTarget && (open.value = false) }, [
            h('div', { class: 'modal', 'data-testid': 'modal' }, [h(HelpTip, { title: 'Normalizing', testid: 'tip' }, () => 'text')]),
          ])
        : null;
  },
});

const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('useEscapeToCloseModals', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lets an open help popover take Escape before its modal', async () => {
    const wrapper = mount(Host, { attachTo: document.body });
    await wrapper.get('[data-testid="help-tip"]').trigger('click');
    expect(wrapper.find('[data-testid="help-tip-text"]').exists()).toBe(true);

    escape();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="help-tip-text"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="modal"]').exists()).toBe(true);

    escape();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
