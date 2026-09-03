import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import EmptyValuesHint from '@/components/EmptyValuesHint.vue';

describe('EmptyValuesHint', () => {
  it('stays out of the way when nothing was hidden', () => {
    const { container } = render(EmptyValuesHint, {
      props: { hidden: 0, revealed: false },
    });

    expect(container.querySelector('[data-testid="empty-values-hint"]')).toBeNull();
  });

  it('reports the count and offers a way to see them', () => {
    const { container } = render(EmptyValuesHint, {
      props: { hidden: 3, revealed: false },
    });

    const hint = container.querySelector('[data-testid="empty-values-hint"]');
    expect(hint?.textContent).toContain('3 empty hidden');
    expect(hint?.textContent).toContain('Show');
  });

  it('keeps the way back once revealed, when the count has dropped to zero', () => {
    const { container } = render(EmptyValuesHint, {
      props: { hidden: 0, revealed: true },
    });

    const hint = container.querySelector('[data-testid="empty-values-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('Hide empty');
    expect(hint?.textContent).not.toContain('empty hidden');
  });

  it('emits toggle when clicked', async () => {
    const { container, emitted } = render(EmptyValuesHint, {
      props: { hidden: 2, revealed: false },
    });

    await fireEvent.click(
      container.querySelector('[data-testid="empty-values-toggle"]')!,
    );

    expect(emitted().toggle).toHaveLength(1);
  });
});
