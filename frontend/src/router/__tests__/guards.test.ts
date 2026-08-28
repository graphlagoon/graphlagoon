import { describe, it, expect } from 'vitest';
import { resolveGuard } from '@/router';

const base = { devMode: true, isAuthenticated: true, isSuperuser: false };

describe('router guard (resolveGuard)', () => {
  it('sends unauthenticated dev users to login', () => {
    expect(resolveGuard({ meta: {} }, { ...base, isAuthenticated: false })).toEqual({ name: 'login' });
  });

  it('lets public routes through without login', () => {
    expect(resolveGuard({ meta: { public: true } }, { ...base, isAuthenticated: false })).toBeNull();
  });

  it('does not require login in production (proxy identity)', () => {
    expect(resolveGuard({ meta: {} }, { ...base, devMode: false, isAuthenticated: false })).toBeNull();
  });

  it('redirects non-superusers away from /admin', () => {
    expect(resolveGuard({ meta: { superuserOnly: true } }, base)).toEqual({ name: 'contexts' });
  });

  it('lets superusers into /admin', () => {
    expect(resolveGuard({ meta: { superuserOnly: true } }, { ...base, isSuperuser: true })).toBeNull();
  });

  it('login check wins over the superuser check', () => {
    expect(
      resolveGuard({ meta: { superuserOnly: true } }, { ...base, isAuthenticated: false, isSuperuser: true }),
    ).toEqual({ name: 'login' });
  });

  it('enforces devOnly routes outside dev mode (previously only link-hidden)', () => {
    expect(resolveGuard({ meta: { devOnly: true } }, { ...base, devMode: false })).toEqual({ name: 'contexts' });
    expect(resolveGuard({ meta: { devOnly: true } }, base)).toBeNull();
  });
});
