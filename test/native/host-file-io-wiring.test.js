#!/usr/bin/env node
/*
 * Static wiring check for the debugger side of the native host file I/O bridge.
 *
 * The end to end test in test/native/host-file-io.test.js needs the patched, rebuilt Venus core;
 * this check only reads src/venusRuntime.ts and asserts the source level contract:
 *
 *   * assemble() opts the core into host file mode with the effective working directory;
 *   * the opt in is guarded, so a core without the new API keeps its previous behaviour;
 *   * stop() resets the backend, again guarded.
 *
 * See test/native/HOST-BINARY-FILE-IO.md.
 *
 * Usage: node test/native/host-file-io-wiring.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runtimePath = path.join(__dirname, '..', '..', 'src', 'venusRuntime.ts');
const source = fs.readFileSync(runtimePath, 'utf8');

/** Returns the `{...}` body of the first member whose signature contains [signature]. */
function memberBody(signature) {
    const start = source.indexOf(signature);
    assert.notStrictEqual(start, -1, 'missing member: ' + signature);
    const open = source.indexOf('{', start);
    assert.notStrictEqual(open, -1, 'missing body of: ' + signature);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') { depth += 1; }
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) { return source.slice(open, i + 1); }
        }
    }
    throw new Error('unbalanced braces after: ' + signature);
}

const enableBody = memberBody('private enableHostFileIO(');
const disableBody = memberBody('private disableHostFileIO(');
const assembleBody = memberBody('public assemble(');
const stopBody = memberBody('public stop()');

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('assemble() points the core at the effective working directory', () => {
    assert.ok(assembleBody.indexOf('const effectiveWorkingDirectory = workingDirectory ?? dirname(fpath)') !== -1,
        'an explicit launch cwd must win over the program directory');
    assert.ok(assembleBody.indexOf('this.enableHostFileIO(effectiveWorkingDirectory)') !== -1,
        'assemble() must call this.enableHostFileIO(effectiveWorkingDirectory)');
    assert.ok(assembleBody.indexOf('this.enableHostFileIO(effectiveWorkingDirectory)') < assembleBody.indexOf('externalAssemble('),
        'host file mode must be enabled before assembling, because .import resolves during assembly');
    assert.ok(assembleBody.indexOf('this.setWorkingDirectory(effectiveWorkingDirectory)') !== -1,
        'the reported working directory must be the same effective directory');
});

test('the opt in is guarded and drives both entry points of the core API', () => {
    assert.ok(enableBody.indexOf("typeof driver.setHostFileCwd !== 'function'") !== -1,
        'setHostFileCwd must be looked up defensively');
    assert.ok(enableBody.indexOf("typeof driver.enableHostFileIO !== 'function'") !== -1,
        'enableHostFileIO must be looked up defensively');
    assert.ok(/typeof driver[\s\S]*?return;/.test(enableBody),
        'an unpatched core must be left alone');
    assert.ok(enableBody.indexOf('driver.setHostFileCwd(workingDirectory)') !== -1,
        'the effective working directory must be forwarded');
    assert.ok(enableBody.indexOf('driver.enableHostFileIO(true)') !== -1, 'host file mode must be enabled');
});

test('a failed assemble resets host file mode', () => {
    const failure = assembleBody.slice(assembleBody.indexOf('if (!success)'));
    assert.ok(failure.indexOf('this.disableHostFileIO()') !== -1,
        'a failed assemble must not leave host file mode enabled with a stale directory');
});

test('stop() resets host file mode for the next session', () => {
    assert.ok(stopBody.indexOf('this.disableHostFileIO()') !== -1,
        'stop() must call this.disableHostFileIO()');
    assert.ok(disableBody.indexOf('driver.enableHostFileIO(false)') !== -1,
        'the reset must disable host file mode');
    assert.ok(disableBody.indexOf("typeof driver.enableHostFileIO === 'function'") !== -1,
        'the reset must be guarded too');
});

test('host file mode is only switched on from the guarded helper', () => {
    const calls = source.split('driver.enableHostFileIO(true)').length - 1;
    assert.strictEqual(calls, 1, 'expected exactly one enableHostFileIO(true) call');
});

let failures = 0;
for (const current of tests) {
    try {
        current.fn();
        console.log('ok - ' + current.name);
    } catch (e) {
        failures += 1;
        console.error('not ok - ' + current.name);
        console.error('  ' + ((e && e.stack) ? e.stack : String(e)));
    }
}
if (failures > 0) {
    console.error(failures + ' of ' + tests.length + ' tests failed');
    process.exit(1);
}
console.log('all ' + tests.length + ' tests passed');