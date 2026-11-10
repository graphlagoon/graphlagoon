/**
 * A context's default look (`default_behaviors.look`): set from the context
 * modal by importing a preset, and worn by the graph when the context opens
 * with no exploration.
 */
import { test, expect } from '../fixtures/test-fixtures';
import { MOCK_CONTEXT } from '../fixtures/mock-data';
import { seedContexts, seedStylePresets } from '../helpers/api-mocks';
import { waitForNodeVisualState } from '../helpers/graph-hooks';

const RED = { nodeTypeColors: { Person: '#ff0000' } };

test.describe('Context default look', () => {
  test('the context opens with its default look', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [{ ...MOCK_CONTEXT, default_behaviors: { autoLoadOnOpen: true, look: { ...RED, source: 'json' } } }]);
    await page.goto(`/graph/${MOCK_CONTEXT.id}`);

    const person = await waitForNodeVisualState(page, 'n1');
    const company = await waitForNodeVisualState(page, 'n4');
    expect(person.color.toLowerCase()).toContain('ff0000');
    expect(company.color.toLowerCase()).not.toContain('ff0000');
    // A look is not a style preset: no ?style= chip.
    await expect(page.getByTestId('graph-status-style')).toHaveCount(0);
  });

  test('the context modal imports a preset as the default look', async ({ authenticatedPage: page }) => {
    await seedContexts(page, [MOCK_CONTEXT]);
    await seedStylePresets(page, MOCK_CONTEXT.id, { vermelho: { ...RED, behaviors: { viewMode: '3d' } } });

    await page.goto('/contexts');
    await page.getByTestId('edit-context-btn').first().click();
    await page.getByTestId('context-default-look-open-import').click();
    await page.getByTestId('context-default-look-source').selectOption('preset:vermelho');
    await page.getByTestId('context-default-look-import').click();
    await expect(page.getByTestId('context-default-look-summary')).toContainText('preset “vermelho”');

    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/graph-contexts/${MOCK_CONTEXT.id}`));
    await page.getByTestId('create-context-submit').click();
    const body = (await put).postDataJSON();
    expect(body.default_behaviors).toEqual({ autoLoadOnOpen: true, look: { ...RED, source: 'preset:vermelho' } });
  });
});
