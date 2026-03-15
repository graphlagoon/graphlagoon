import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import JsonValueViewer from '@/components/JsonValueViewer.vue';

function renderViewer(value: unknown, props: Record<string, unknown> = {}) {
  return render(JsonValueViewer, {
    props: { value, ...props },
  });
}

afterEach(() => {
  document.body.querySelectorAll('.table-modal-overlay').forEach(el => el.remove());
});

describe('JsonValueViewer', () => {
  describe('object values → vertical collapsible table', () => {
    it('renders a collapsible details element for objects', () => {
      const { container } = renderViewer({ a: 1, b: 'hello' });
      const details = container.querySelector('details.object-details');
      expect(details).not.toBeNull();
    });

    it('shows total key count in summary', () => {
      const { container } = renderViewer({ x: 1, y: 2, z: 3 });
      const summary = container.querySelector('.object-summary');
      expect(summary?.textContent).toContain('3 keys');
    });

    it('renders vertical table with Key and Value columns', () => {
      const { container } = renderViewer({ name: 'Alice', age: 30 });
      const ths = container.querySelectorAll('.vertical-table th');
      const headers = Array.from(ths).map(th => th.textContent?.trim());
      expect(headers).toEqual(['Key', 'Value']);
    });

    it('renders one row per key-value pair', () => {
      const { container } = renderViewer({ a: 1, b: 2, c: 3 });
      const rows = container.querySelectorAll('.vertical-table tbody tr');
      expect(rows.length).toBe(3);
    });

    it('shows key names and values', () => {
      const { container } = renderViewer({ name: 'Bob' });
      const keyCell = container.querySelector('.vt-key');
      const valCell = container.querySelector('.vt-val');
      expect(keyCell?.textContent?.trim()).toBe('name');
      expect(valCell?.textContent?.trim()).toBe('Bob');
    });

    it('starts open for small objects at depth 0', () => {
      const { container } = renderViewer({ a: 1, b: 2 });
      const details = container.querySelector('details.object-details');
      expect(details?.hasAttribute('open')).toBe(true);
    });

    it('starts collapsed for objects at depth > 0', () => {
      const { container } = renderViewer({ a: 1 }, { depth: 1 });
      const details = container.querySelector('details.object-details');
      expect(details?.hasAttribute('open')).toBe(false);
    });

    it('renders nested objects recursively', () => {
      const { container } = renderViewer({ outer: { inner: 1 } });
      const allDetails = container.querySelectorAll('details.object-details');
      expect(allDetails.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('object with many keys', () => {
    function makeObj(n: number) {
      const obj: Record<string, number> = {};
      for (let i = 0; i < n; i++) obj[`key_${i}`] = i;
      return obj;
    }

    it('shows only first 10 keys by default', () => {
      const { container } = renderViewer(makeObj(20));
      const rows = container.querySelectorAll('.vertical-table tbody tr');
      expect(rows.length).toBe(10);
    });

    it('shows "show more keys" button when keys exceed limit', () => {
      const { container } = renderViewer(makeObj(15));
      const btn = container.querySelector('.show-more-btn');
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toContain('5 more keys');
    });

    it('shows all keys after clicking "show more keys"', async () => {
      const { container } = renderViewer(makeObj(15));
      await fireEvent.click(container.querySelector('.show-more-btn')!);
      const rows = container.querySelectorAll('.vertical-table tbody tr');
      expect(rows.length).toBe(15);
    });

    it('starts collapsed for objects with many keys', () => {
      const { container } = renderViewer(makeObj(20));
      const details = container.querySelector('details.object-details');
      expect(details?.hasAttribute('open')).toBe(false);
    });

    it('still shows total count in summary', () => {
      const { container } = renderViewer(makeObj(25));
      const summary = container.querySelector('.object-summary');
      expect(summary?.textContent).toContain('25 keys');
    });
  });

  describe('depth limit', () => {
    it('falls back to raw JSON at max depth', () => {
      const { container } = renderViewer({ a: 1, b: 2 }, { depth: 4 });
      expect(container.querySelector('.json-block')).not.toBeNull();
      expect(container.querySelector('details.object-details')).toBeNull();
    });

    it('falls back to raw JSON for arrays at max depth', () => {
      const { container } = renderViewer([{ a: 1 }, { a: 2 }], { depth: 4 });
      expect(container.querySelector('.json-block')).not.toBeNull();
      expect(container.querySelector('.open-table-btn')).toBeNull();
    });

    it('renders normally below max depth', () => {
      const { container } = renderViewer({ a: 1 }, { depth: 3 });
      expect(container.querySelector('details.object-details')).not.toBeNull();
    });
  });

  describe('array of uniform objects → table in modal', () => {
    it('renders a "View Table" button for uniform arrays', () => {
      const { container } = renderViewer([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);
      const btn = container.querySelector('.open-table-btn');
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toContain('2 rows');
    });

    it('does not show table inline', () => {
      const { container } = renderViewer([{ x: 1 }, { x: 2 }]);
      expect(container.querySelector('.json-table')).toBeNull();
    });

    it('opens modal when button is clicked', async () => {
      const { container } = renderViewer([{ a: 1 }, { a: 2 }]);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      expect(document.body.querySelector('.table-modal-overlay')).not.toBeNull();
    });

    it('renders table with correct columns in modal', async () => {
      const { container } = renderViewer([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      const ths = document.body.querySelectorAll('.json-table th');
      const headers = Array.from(ths).map(th => th.textContent?.trim());
      expect(headers).toContain('name');
      expect(headers).toContain('age');
    });

    it('renders correct number of rows in modal', async () => {
      const data = Array.from({ length: 5 }, (_, i) => ({ id: i }));
      const { container } = renderViewer(data);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      const rowNums = document.body.querySelectorAll('.row-num');
      expect(rowNums.length).toBe(5);
    });

    it('paginates incrementally with "load more"', async () => {
      const data = Array.from({ length: 120 }, (_, i) => ({ id: i }));
      const { container } = renderViewer(data);
      await fireEvent.click(container.querySelector('.open-table-btn')!);

      // Initially 50 rows
      let rowNums = document.body.querySelectorAll('.row-num');
      expect(rowNums.length).toBe(50);

      // Click load more → 100 rows
      await fireEvent.click(document.body.querySelector('.show-more-btn')!);
      rowNums = document.body.querySelectorAll('.row-num');
      expect(rowNums.length).toBe(100);

      // Click load more again → 120 rows (all)
      await fireEvent.click(document.body.querySelector('.show-more-btn')!);
      rowNums = document.body.querySelectorAll('.row-num');
      expect(rowNums.length).toBe(120);

      // No more button
      expect(document.body.querySelector('.show-more-btn')).toBeNull();
    });

    it('closes modal when clicking overlay', async () => {
      const { container } = renderViewer([{ a: 1 }]);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      expect(document.body.querySelector('.table-modal-overlay')).not.toBeNull();
      await fireEvent.click(document.body.querySelector('.table-modal-overlay')!);
      expect(document.body.querySelector('.table-modal-overlay')).toBeNull();
    });

    it('closes modal when clicking close button', async () => {
      const { container } = renderViewer([{ a: 1 }]);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      await fireEvent.click(document.body.querySelector('.close-btn')!);
      expect(document.body.querySelector('.table-modal-overlay')).toBeNull();
    });

    it('expands complex cells inline in modal', async () => {
      const { container } = renderViewer([
        { name: 'Alice', meta: { role: 'admin', level: 5 } },
      ]);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      const complexCell = document.body.querySelector('.cell-complex')!;
      expect(document.body.querySelector('.expanded-row')).toBeNull();
      await fireEvent.click(complexCell);
      expect(document.body.querySelector('.expanded-row')).not.toBeNull();
    });

    it('collapses expanded cell on second click', async () => {
      const { container } = renderViewer([
        { name: 'Alice', meta: { role: 'admin' } },
      ]);
      await fireEvent.click(container.querySelector('.open-table-btn')!);
      const complexCell = document.body.querySelector('.cell-complex')!;
      await fireEvent.click(complexCell);
      expect(document.body.querySelector('.expanded-row')).not.toBeNull();
      await fireEvent.click(complexCell);
      expect(document.body.querySelector('.expanded-row')).toBeNull();
    });
  });

  describe('string truncation', () => {
    it('truncates long string values in vertical table', () => {
      const longStr = 'x'.repeat(200);
      const { container } = renderViewer({ data: longStr });
      const valCell = container.querySelector('.vt-val span');
      const text = valCell?.textContent || '';
      expect(text.length).toBeLessThan(200);
      expect(text).toContain('...');
    });

    it('preserves short strings unchanged', () => {
      const { container } = renderViewer({ data: 'short' });
      const valCell = container.querySelector('.vt-val span');
      expect(valCell?.textContent?.trim()).toBe('short');
    });
  });

  describe('other values → raw JSON', () => {
    it('shows formatted JSON for array of primitives', () => {
      const { container } = renderViewer([1, 2, 3]);
      const pre = container.querySelector('.json-block');
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toContain('1');
    });

    it('shows formatted JSON for mixed-type arrays', () => {
      const { container } = renderViewer([1, 'hello', { a: 1 }, true]);
      const pre = container.querySelector('.json-block');
      expect(pre).not.toBeNull();
    });
  });
});
