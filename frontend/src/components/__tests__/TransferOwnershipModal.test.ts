import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/vue';
import TransferOwnershipModal from '@/components/admin/TransferOwnershipModal.vue';

// Teleports to body: query document.body, clean up between tests.
afterEach(() => cleanup());

function mount(props: Partial<InstanceType<typeof TransferOwnershipModal>['$props']> = {}) {
  return render(TransferOwnershipModal, {
    props: { open: true, kind: 'context', title: 'Fraud ring', currentOwner: 'owner@x.com', ...props },
  });
}

describe('TransferOwnershipModal', () => {
  it('renders nothing when closed', () => {
    mount({ open: false });
    expect(document.body.querySelector('[data-testid="admin-transfer-modal"]')).toBeNull();
  });

  it('disables confirm until a valid, different e-mail is typed', async () => {
    mount();
    const confirm = document.body.querySelector('[data-testid="admin-transfer-confirm"]') as HTMLButtonElement;
    const input = document.body.querySelector('[data-testid="admin-transfer-input"]') as HTMLInputElement;
    expect(confirm.disabled).toBe(true);

    await fireEvent.update(input, '*@x.com');
    expect(document.body.querySelector('[data-testid="admin-transfer-error"]')?.textContent).toContain('wildcard');
    expect(confirm.disabled).toBe(true);

    await fireEvent.update(input, 'owner@x.com');
    expect(document.body.querySelector('[data-testid="admin-transfer-error"]')?.textContent).toContain('Already');

    await fireEvent.update(input, 'new@x.com');
    expect(document.body.querySelector('[data-testid="admin-transfer-error"]')).toBeNull();
    expect(confirm.disabled).toBe(false);
  });

  it('emits confirm with the trimmed e-mail', async () => {
    const { emitted } = mount();
    const input = document.body.querySelector('[data-testid="admin-transfer-input"]') as HTMLInputElement;
    await fireEvent.update(input, '  new@x.com ');
    await fireEvent.submit(input.closest('form')!);
    expect(emitted().confirm).toEqual([['new@x.com']]);
  });

  it('emits close from the overlay and the cancel button', async () => {
    const { emitted } = mount();
    await fireEvent.click(document.body.querySelector('[aria-label="Close"]')!);
    expect(emitted().close).toHaveLength(1);
  });
});
