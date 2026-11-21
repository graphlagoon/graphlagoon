import { describe, it, expect, vi, afterEach } from 'vitest';
import { openRoute, wantsNewTab } from '../openRoute';

const router = { push: vi.fn(), resolve: vi.fn(() => ({ href: '/graph/c1' })) } as never;
afterEach(() => { vi.restoreAllMocks(); });

describe('openRoute', () => {
  it('pushes on a plain click', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openRoute(router, '/graph/c1', new MouseEvent('click'));
    expect((router as any).push).toHaveBeenCalledWith('/graph/c1');
    expect(open).not.toHaveBeenCalled();
  });
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }])('opens a new tab with %o', (mod) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openRoute(router, '/graph/c1', new MouseEvent('click', mod));
    expect(open).toHaveBeenCalledWith('/graph/c1', '_blank', 'noopener');
  });
  it('treats middle click as new tab', () => {
    expect(wantsNewTab(new MouseEvent('auxclick', { button: 1 }))).toBe(true);
  });
});
