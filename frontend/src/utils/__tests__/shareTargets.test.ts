import { describe, it, expect } from 'vitest';
import {
  groupIdOfShare,
  groupShareValue,
  isGroupShare,
  shareKind,
  shareLabel,
} from '@/utils/shareTargets';

const ID = '12345678-1234-5678-1234-567812345678';
const nameOf = (id: string) => (id === ID ? 'analysts' : undefined);

describe('shareTargets', () => {
  it('builds and parses the canonical group value', () => {
    expect(groupShareValue(` ${ID.toUpperCase()} `)).toBe(`group:${ID}`);
    expect(isGroupShare(`group:${ID}`)).toBe(true);
    expect(isGroupShare('GROUP:x')).toBe(true);
    expect(isGroupShare('ana@example.com')).toBe(false);
    expect(groupIdOfShare(`group:${ID}`)).toBe(ID);
    expect(groupIdOfShare('group:')).toBeNull();
    expect(groupIdOfShare('*@example.com')).toBeNull();
  });

  it('classifies every kind of share value', () => {
    expect(shareKind('*')).toBe('public');
    expect(shareKind('*@example.com')).toBe('domain');
    expect(shareKind(`group:${ID}`)).toBe('group');
    expect(shareKind('ana@example.com')).toBe('person');
  });

  it('labels a group by its name, else says why it has none', () => {
    const gone = 'group:00000000-0000-0000-0000-000000000000';
    expect(shareLabel(`group:${ID}`, nameOf)).toBe('analysts');
    expect(shareLabel(gone, nameOf)).toBe('Group (no longer exists)');
    expect(shareLabel(gone, nameOf, 'loading')).toBe('Loading group…');
    expect(shareLabel(gone, nameOf, 'failed')).toBe('Group 00000000… (groups could not be loaded)');
    expect(shareLabel('*', nameOf)).toBe('Everyone (public)');
    expect(shareLabel('ana@example.com', nameOf)).toBe('ana@example.com');
  });
});
