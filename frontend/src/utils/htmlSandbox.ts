/**
 * How a case's HTML (agent reports, slides, an SVG) is shown: in an iframe with
 * `srcdoc` and a sandbox that never includes `allow-same-origin`, so the document
 * has an opaque origin and cannot reach the app (its DOM, storage, cookies, API).
 * What is left is a way out for the document's own data (a request, an image,
 * a form, a navigation); a Content-Security-Policy injected as the first element
 * of its `<head>` closes it. A policy the document carries can only add
 * restrictions to ours, never lift them.
 *
 * Modes (GRAPH_LAGOON_INVESTIGATION_HTML_SCRIPTS):
 * - `none`: no scripts; static HTML and CSS;
 * - `inline`: the document's own scripts, no network;
 * - `cdn`: also scripts, styles and fonts from a few public CDNs.
 */
export type HtmlScriptsMode = 'none' | 'inline' | 'cdn';

export const HTML_SCRIPT_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'];

/** The server's mode; `none` when the server does not say (an older API). */
export function htmlScriptsMode(): HtmlScriptsMode {
  const mode = window.__GRAPH_LAGOON_CONFIG__?.investigation_html_scripts;
  return mode === 'inline' || mode === 'cdn' ? mode : 'none';
}

export function htmlCsp(mode: HtmlScriptsMode): string {
  const cdn = mode === 'cdn' ? HTML_SCRIPT_CDNS : [];
  const directives = [
    "default-src 'none'",
    mode === 'none' ? null : ['script-src', "'unsafe-inline'", "'unsafe-eval'", ...cdn].join(' '),
    ['style-src', "'unsafe-inline'", ...cdn, ...(mode === 'cdn' ? ['https://fonts.googleapis.com'] : [])].join(' '),
    ['font-src', 'data:', ...cdn, ...(mode === 'cdn' ? ['https://fonts.gstatic.com'] : [])].join(' '),
    'img-src data: blob:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ];
  return directives.filter(Boolean).join('; ');
}

export function sandboxHtml(html: string, mode: HtmlScriptsMode = htmlScriptsMode()): { srcdoc: string; sandbox: string } {
  // DOMParser builds an inert document: nothing in it runs or loads here.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', htmlCsp(mode));
  doc.head.prepend(meta);
  return { srcdoc: `<!doctype html>\n${doc.documentElement.outerHTML}`, sandbox: mode === 'none' ? '' : 'allow-scripts' };
}
