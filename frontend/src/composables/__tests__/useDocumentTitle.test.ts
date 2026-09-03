import { describe, it, expect } from 'vitest';
import { buildDocumentTitle, APP_NAME } from '@/composables/useDocumentTitle';

describe('buildDocumentTitle', () => {
  it('is the app name off the graph page', () => {
    expect(buildDocumentTitle({ isGraphPage: false, context: 'Ctx' })).toBe(APP_NAME);
  });

  it('is the app name on the graph page before the context loads', () => {
    expect(buildDocumentTitle({ isGraphPage: true })).toBe(APP_NAME);
  });

  it('names the context', () => {
    expect(buildDocumentTitle({ isGraphPage: true, context: 'Banking' })).toBe(
      `Banking — ${APP_NAME}`,
    );
  });

  it('puts the exploration first — a tab strip shows the start of the title', () => {
    expect(
      buildDocumentTitle({ isGraphPage: true, context: 'Banking', exploration: 'Centrality' }),
    ).toBe(`Centrality · Banking — ${APP_NAME}`);
  });

  it('marks unsaved changes with the dot the toolbar uses', () => {
    expect(
      buildDocumentTitle({
        isGraphPage: true, context: 'Banking', exploration: 'Centrality', dirty: true,
      }),
    ).toBe(`● Centrality · Banking — ${APP_NAME}`);
  });
});
