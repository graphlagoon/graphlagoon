/**
 * Runtime config refresh for the dev login flow.
 *
 * `window.__GRAPH_LAGOON_CONFIG__` is computed per user by the backend
 * (`is_superuser` in particular). In production the proxy identity is fixed
 * for the page lifetime, but in dev mode the user picks an e-mail on the
 * login page *after* the config was fetched/injected — so the flag would be
 * stale until a reload. Re-fetching after login/logout keeps the Admin link
 * and the `/admin` guard honest for the identity actually in use.
 */

const API_URL = window.__GRAPH_LAGOON_API_URL__ || import.meta.env.VITE_API_URL || '';

export async function refreshRuntimeConfig(email: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/config`, {
      headers: email ? { 'X-Forwarded-Email': email } : {},
    });
    if (!res.ok) return false;
    const fresh = await res.json();
    // Keep SPA-only fields the template injected (router_base, identity).
    window.__GRAPH_LAGOON_CONFIG__ = { ...(window.__GRAPH_LAGOON_CONFIG__ || {}), ...fresh };
    return true;
  } catch {
    return false;
  }
}
