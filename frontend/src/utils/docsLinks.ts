/** The public user guide (VitePress on GitHub Pages), for "Full guide" links in the app. */
export const DOCS_BASE = 'https://graphlagoon.github.io/graphlagoon';

/** `guideUrl('bring-your-own-data', 'drawn-by-hand')` → the page, at that heading. */
export function guideUrl(slug: string, anchor?: string): string {
  return `${DOCS_BASE}/guide/${slug}${anchor ? `#${anchor}` : ''}`;
}
