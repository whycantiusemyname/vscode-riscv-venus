import * as assert from 'assert';
import * as helpers from '../../venusHelpers';

suite('Venus value and register name parsing', () => {
  test('parses the literal forms Venus accepts for a register value', () => {
    assert.strictEqual(helpers.parseVenusLiteralInt('0x2a'), 42);
    assert.strictEqual(helpers.parseVenusLiteralInt('0X2A'), 42);
    assert.strictEqual(helpers.parseVenusLiteralInt('0b101010'), 42);
    assert.strictEqual(helpers.parseVenusLiteralInt('-0x1'), -1);
    assert.strictEqual(helpers.parseVenusLiteralInt('42'), 42);
    assert.strictEqual(helpers.parseVenusLiteralInt('-42'), -42);
    assert.strictEqual(helpers.parseVenusLiteralInt("'a'"), 97);
    assert.strictEqual(helpers.parseVenusLiteralInt("'\\n'"), 10);
    // two's complement truncation, exactly like Venus' userStringToInt
    assert.strictEqual(helpers.parseVenusLiteralInt('0xffffffff'), -1);
    assert.strictEqual(helpers.parseVenusLiteralInt(''), undefined);
    assert.strictEqual(helpers.parseVenusLiteralInt('0x'), undefined);
    assert.strictEqual(helpers.parseVenusLiteralInt('zz'), undefined);
  });

  test('reads unprefixed values in the displayed number format', () => {
    // The Variables view prints hex, so a user typing back the shown digits
    // must not silently get a decimal interpretation.
    assert.strictEqual(helpers.parseVenusValue('2a', 'hex'), 42);
    assert.strictEqual(helpers.parseVenusValue('101010', 'binary'), 42);
    assert.strictEqual(helpers.parseVenusValue('42', 'decimal'), 42);
    assert.strictEqual(helpers.parseVenusValue("'a'", 'hex'), 97);
    // explicit prefixes win in every format
    assert.strictEqual(helpers.parseVenusValue('0x2a', 'binary'), 42);
    assert.strictEqual(helpers.parseVenusValue('0b101010', 'hex'), 42);
    assert.strictEqual(helpers.parseVenusValue('2a', 'binary'), undefined);
    assert.strictEqual(helpers.parseVenusValue('abc', 'hex'), 2748);
  });

  test('packs ascii values in the order the ascii format prints them', () => {
    assert.strictEqual(helpers.parsePackedAscii('A'), 0x41);
    assert.strictEqual(helpers.parsePackedAscii('AB'), 0x4142);
    assert.strictEqual(helpers.parsePackedAscii('ABCD'), 0x41424344);
    assert.strictEqual(helpers.parsePackedAscii('abcde'), undefined);
    assert.strictEqual(helpers.parseVenusValue('AB', 'ascii'), 0x4142);
  });

  test('resolves the register names that the debugger frontend sends', () => {
    // the integer Variables view labels registers "x05 (t0)   "
    assert.deepStrictEqual(helpers.parseRegisterName('x05 (t0)   '), { kind: 'integer', id: 5 });
    assert.deepStrictEqual(helpers.parseRegisterName('x28 (t3) '), { kind: 'integer', id: 28 });
    assert.deepStrictEqual(helpers.parseRegisterName('x5'), { kind: 'integer', id: 5 });
    assert.deepStrictEqual(helpers.parseRegisterName('t0'), { kind: 'integer', id: 5 });
    assert.deepStrictEqual(helpers.parseRegisterName('sp'), { kind: 'integer', id: 2 });
    assert.deepStrictEqual(helpers.parseRegisterName('f05'), { kind: 'float', id: 5 });
    assert.strictEqual(helpers.parseRegisterName('x32'), undefined);
    assert.strictEqual(helpers.parseRegisterName('x100'), undefined);
    assert.strictEqual(helpers.parseRegisterName('PC'), undefined);
    assert.strictEqual(helpers.parseRegisterName('mstatus '), undefined);
  });

  test('interprets DAP memory references in bytes', () => {
    assert.strictEqual(helpers.parseMemoryAddress('0x10000000'), 0x10000000);
    assert.strictEqual(helpers.parseMemoryAddress('0x10000000', 4), 0x10000004);
    assert.strictEqual(helpers.parseMemoryAddress('0x10000004', -4), 0x10000000);
    assert.strictEqual(helpers.parseMemoryAddress('4096'), 4096);
    assert.strictEqual(helpers.parseMemoryAddress('nonsense'), undefined);
    assert.strictEqual(helpers.formatAddress(0x10000000), '0x10000000');
    // stack addresses stay unsigned in the response
    assert.strictEqual(helpers.formatAddress(0x7ffffff0 | 0), '0x7ffffff0');
  });

  test('flags writes that would change immutable text', () => {
    const textEnd = 0x20;
    assert.strictEqual(helpers.overlapsImmutableText(textEnd, 0x00, 4), true);
    assert.strictEqual(helpers.overlapsImmutableText(textEnd, 0x1c, 4), true);
    // Venus protects up to and including maxPC
    assert.strictEqual(helpers.overlapsImmutableText(textEnd, textEnd, 4), true);
    assert.strictEqual(helpers.overlapsImmutableText(textEnd, textEnd + 1, 4), false);
    assert.strictEqual(helpers.overlapsImmutableText(textEnd, 0x10000000, 4), false);
    assert.strictEqual(helpers.overlapsImmutableText(textEnd, (0x7ffffff0 | 0), 4), false);
  });
});
