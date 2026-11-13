/**
 * Share targets: the `shared_with` values of a context, exploration or case are
 * principals, not only e-mails — `*` (public), `*@domain` and `group:<uuid>`
 * (an admin-managed group). Mirrors `api/graphlagoon/utils/sharing.py`.
 */

export const PUBLIC_SHARE_EMAIL = '*';
export const GROUP_SHARE_PREFIX = 'group:';

export type ShareKind = 'public' | 'domain' | 'group' | 'person';
/** Whether the group list a label resolves against has been fetched. */
export type GroupListState = 'idle' | 'loading' | 'loaded' | 'failed';

export function isGroupShare(value: string): boolean {
  return value.toLowerCase().startsWith(GROUP_SHARE_PREFIX);
}

/** The canonical share value for a group id (what the API stores). */
export function groupShareValue(groupId: string): string {
  return `${GROUP_SHARE_PREFIX}${groupId.trim().toLowerCase()}`;
}

export function groupIdOfShare(value: string): string | null {
  if (!isGroupShare(value)) return null;
  const id = value.slice(GROUP_SHARE_PREFIX.length).trim().toLowerCase();
  return id || null;
}

export function shareKind(value: string): ShareKind {
  if (value === PUBLIC_SHARE_EMAIL) return 'public';
  if (value.startsWith('*@')) return 'domain';
  if (isGroupShare(value)) return 'group';
  return 'person';
}

/** What to print for a share value; `nameOf` resolves a group id to its name.
 * An unresolved group says why: still loading, the list failed, or the group is gone. */
export function shareLabel(
  value: string,
  nameOf: (groupId: string) => string | undefined,
  listState: GroupListState = 'loaded',
): string {
  switch (shareKind(value)) {
    case 'public':
      return 'Everyone (public)';
    case 'group': {
      const id = groupIdOfShare(value) ?? '';
      const name = nameOf(id);
      if (name) return name;
      if (listState === 'loaded') return 'Group (no longer exists)';
      if (listState === 'failed') return `Group ${id.slice(0, 8)}… (groups could not be loaded)`;
      return 'Loading group…';
    }
    default:
      return value;
  }
}
