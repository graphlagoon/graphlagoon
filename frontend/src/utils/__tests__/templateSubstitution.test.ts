/**
 * The single-pass substitution contract.
 *
 * Two of these tests pin fixed bugs from the old sequential split/join in
 * TemplateExecuteModal: the `$node`/`$node_id` prefix collision, and values
 * being re-scanned so `$other` inside a value was substituted again. Both were
 * silent corruption — the query ran, just not the query the author wrote.
 */

import { describe, it, expect } from 'vitest';
import { substituteTemplateParams } from '@/utils/templateSubstitution';

describe('substituteTemplateParams', () => {
  it('substitutes a declared parameter', () => {
    expect(
      substituteTemplateParams('MATCH (n {id: "$node_id"}) RETURN r', ['node_id'], {
        node_id: 'acct-9931',
      }),
    ).toBe('MATCH (n {id: "acct-9931"}) RETURN r');
  });

  it('substitutes every occurrence', () => {
    expect(
      substituteTemplateParams('$a and $a again', ['a'], { a: 'x' }),
    ).toBe('x and x again');
  });

  it('does not corrupt a longer id sharing a prefix with a shorter one', () => {
    // The old sequential replace turned $node_id into "<value>_id" whenever
    // $node was declared first. Longest-first alternation fixes it regardless
    // of declaration order.
    expect(
      substituteTemplateParams('$node vs $node_id', ['node', 'node_id'], {
        node: 'N',
        node_id: 'ID',
      }),
    ).toBe('N vs ID');
    expect(
      substituteTemplateParams('$node vs $node_id', ['node_id', 'node'], {
        node: 'N',
        node_id: 'ID',
      }),
    ).toBe('N vs ID');
  });

  it('never re-substitutes inside a substituted value', () => {
    // A single pass never rescans its own output, so a value mentioning
    // another parameter is inert text.
    expect(
      substituteTemplateParams('$a then $b', ['a', 'b'], { a: 'has $b inside', b: 'B' }),
    ).toBe('has $b inside then B');
  });

  it('leaves a $hash() macro in a value for later layers, untouched', () => {
    expect(
      substituteTemplateParams('WHERE k = $key', ['key'], { key: "$hash('x')" }),
    ).toBe("WHERE k = $hash('x')");
  });

  it('treats replacement-pattern characters in values as literal text', () => {
    // String-form replacements would expand $& into the matched text.
    expect(substituteTemplateParams('v=$a', ['a'], { a: '$&$`$1' })).toBe('v=$&$`$1');
  });

  it('leaves an undeclared $token as written', () => {
    expect(
      substituteTemplateParams('$declared and $hash(k) and $stray', ['declared'], {
        declared: 'D',
      }),
    ).toBe('D and $hash(k) and $stray');
  });

  it('leaves a declared id with no value as written', () => {
    expect(substituteTemplateParams('$a $b', ['a', 'b'], { a: 'A' })).toBe('A $b');
  });

  it('escapes regex metacharacters in ids', () => {
    expect(substituteTemplateParams('$a.b end', ['a.b'], { 'a.b': 'V' })).toBe('V end');
    // The dot is escaped: 'aXb' must not match 'a.b'.
    expect(substituteTemplateParams('$aXb end', ['a.b'], { 'a.b': 'V' })).toBe('$aXb end');
  });

  it('substitutes an empty value as empty text', () => {
    expect(substituteTemplateParams('[$a]', ['a'], { a: '' })).toBe('[]');
  });

  it('is a no-op with no ids or empty text', () => {
    expect(substituteTemplateParams('as written $x', [], {})).toBe('as written $x');
    expect(substituteTemplateParams('', ['a'], { a: 'x' })).toBe('');
  });

  it('ignores values inherited from the prototype', () => {
    const values = Object.create({ sneaky: 'polluted' }) as Record<string, string>;
    values.real = 'R';
    expect(substituteTemplateParams('$real $sneaky', ['real', 'sneaky'], values)).toBe(
      'R $sneaky',
    );
  });
});
