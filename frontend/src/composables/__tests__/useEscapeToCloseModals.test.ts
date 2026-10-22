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

  it('closes a side drawer, and a modal over it first (UX-1)', async () => {
    const Drawer = defineComponent({
      setup() {
        useEscapeToCloseModals();
        const drawer = ref(true);
        const modal = ref(true);
        const close = (flag: typeof drawer) => (e: MouseEvent) => e.target === e.currentTarget && (flag.value = false);
        return () => [
          drawer.value ? h('div', { class: 'drawer-overlay', onClick: close(drawer) }, [h('aside', { 'data-testid': 'drawer' })]) : null,
          modal.value ? h('div', { class: 'modal-overlay', onClick: close(modal) }, [h('div', { 'data-testid': 'over' })]) : null,
        ];
      },
    });
    const wrapper = mount(Drawer, { attachTo: document.body });
    escape();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="over"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="drawer"]').exists()).toBe(true);
    escape();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="drawer"]').exists()).toBe(false);
  });
});
