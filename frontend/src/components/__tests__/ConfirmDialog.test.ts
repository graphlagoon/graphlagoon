import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { nextTick } from 'vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { confirmAction } from '@/composables/useConfirm';

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function flush() {
  await nextTick();
  await nextTick();
}

describe('ConfirmDialog + useConfirm', () => {
  let unmount: (() => void) | null = null;
  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = '';
  });

  it('falls back to window.confirm when no dialog is mounted', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await expect(confirmAction({ title: 'Delete x?', message: 'gone' })).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('Delete x?\n\ngone');
    spy.mockRestore();
  });

  it('renders the question and resolves true on accept', async () => {
    ({ unmount } = render(ConfirmDialog));
    const p = confirmAction({ title: 'Delete “p1”?', message: 'Links stop working.', confirmLabel: 'Delete', danger: true });
    await flush();

    expect(q('confirm-dialog')).not.toBeNull();
    expect(q('confirm-dialog')!.textContent).toContain('Delete “p1”?');
    expect(q('confirm-dialog')!.textContent).toContain('Links stop working.');
    expect(q('confirm-dialog-accept')!.textContent!.trim()).toBe('Delete');
    // Destructive: focus lands on Cancel so Enter cannot delete by reflex.
    expect(document.activeElement).toBe(q('confirm-dialog-cancel'));

    await fireEvent.click(q('confirm-dialog-accept')!);
    await expect(p).resolves.toBe(true);
    expect(q('confirm-dialog')).toBeNull();
  });

  it('resolves false on cancel, backdrop click and Escape', async () => {
    ({ unmount } = render(ConfirmDialog));

    let p = confirmAction({ title: 'A' });
    await flush();
    await fireEvent.click(q('confirm-dialog-cancel')!);
    await expect(p).resolves.toBe(false);

    p = confirmAction({ title: 'B' });
    await flush();
    await fireEvent.click(q('confirm-dialog')!);
    await expect(p).resolves.toBe(false);

    p = confirmAction({ title: 'C' });
    await flush();
    await fireEvent.keyDown(q('confirm-dialog')!, { key: 'Escape' });
    await expect(p).resolves.toBe(false);
  });

  it('a second question cancels the first instead of stacking', async () => {
    ({ unmount } = render(ConfirmDialog));
    const first = confirmAction({ title: 'first' });
    const second = confirmAction({ title: 'second' });
    await flush();
    await expect(first).resolves.toBe(false);
    expect(q('confirm-dialog')!.textContent).toContain('second');
    await fireEvent.click(q('confirm-dialog-accept')!);
    await expect(second).resolves.toBe(true);
  });
});
