#!/usr/bin/env node
/*
 * Node executable test for the native host file I/O bridge (ecalls 13/14/15/16).
 *
 * The VS Code extension builds this core for Node.js (`npm run compileAll`, which runs
 * `./gradlew runDceKotlinJs` here). This test loads that build, points host file mode at a
 * temporary working directory and checks that:
 *
 *   * every byte value 0x00..0xff survives a read/write round trip, which is what the
 *     Project 2 input matrices need;
 *   * relative paths are resolved against the configured working directory, and absolute paths
 *     (including directories with spaces) work as well;
 *   * permission bits, end of file and error returns match the JVM reference implementation
 *     (`venus.jar` from the course tools directory), whose FilesHandler/FileDescriptor
 *     semantics this code mirrors;
 *   * the VFS path is untouched while host mode is disabled.
 *
 * Usage:
 *   node test/native/host-file-io.test.js [build-dir]
 *
 * `build-dir` defaults to `<extension>/src/runtime/venus/build/kotlin-js-min/main` (the output
 * directory of `./gradlew runDceKotlinJs`, i.e. of `npm run compileAll`) and must contain `venus.js`
 * plus its `kotlin.js`.
 *
 * A missing build, or a core without the host file I/O API, is reported as a skip (exit 0) so
 * that this test can live here while the core patch is applied and built in CI. Set
 * VENUS_REQUIRE_HOST_FILE_IO=1 to turn those skips into failures.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const buildDir = process.argv[2] ||
    path.join(__dirname, '..', '..', 'src', 'runtime', 'venus', 'build', 'kotlin-js-min', 'main');

/*
 * A missing core build, or a core build without the host file I/O API, is reported as a skip
 * (exit 0) so that this test can be committed before the core patches are applied and built.
 * Set VENUS_REQUIRE_HOST_FILE_IO=1 to turn those skips into failures.
 */
function skip(reason) {
    console.log('skip - ' + reason);
    if (process.env.VENUS_REQUIRE_HOST_FILE_IO) {
        console.error('VENUS_REQUIRE_HOST_FILE_IO is set, so a missing capability is a failure');
        process.exit(1);
    }
    process.exit(0);
}

/* ------------------------------------------------------------------------------------------- *
 * Loading the compiled core
 * ------------------------------------------------------------------------------------------- */

function fakeElement(id) {
    return {
        id: id || '',
        innerHTML: '',
        textContent: '',
        value: '',
        style: {},
        children: [],
        files: [],
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild(child) { this.children.push(child); return child; },
        insertBefore(child) { this.children.push(child); return child; },
        removeChild(child) { return child; },
        remove() {},
        setAttribute() {},
        getAttribute() { return null; },
        hasAttribute() { return false; },
        addEventListener() {},
        removeEventListener() {},
        focus() {},
        blur() {},
        click() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getElementsByTagName() { return []; },
        contains() { return false; },
        scrollIntoView() {},
    };
}

/** Minimal stand in for a browser window, used when jsdom is not installed. */
function makeWindowShim() {
    const elements = new Map();
    const document = {
        body: fakeElement('body'),
        head: fakeElement('head'),
        documentElement: fakeElement('html'),
        createElement() { return fakeElement(); },
        createTextNode() { return {}; },
        getElementById(id) {
            if (!elements.has(id)) { elements.set(id, fakeElement(id)); }
            return elements.get(id);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getElementsByTagName() { return []; },
        getElementsByClassName() { return []; },
        addEventListener() {},
        removeEventListener() {},
    };
    return {
        document,
        navigator: { userAgent: 'node' },
        location: { href: 'http://localhost/', search: '', hash: '' },
        addEventListener() {},
        removeEventListener() {},
        getComputedStyle() { return {}; },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
}

/**
 * The core is browser shaped: it reaches for window/document/localStorage as soon as it is
 * loaded. jsdom is used when it is available (the extension depends on it), otherwise the stub
 * above is enough for the file I/O paths under test.
 */
function installBrowserGlobals() {
    let win = null;
    try {
        const jsdom = require('jsdom');
        win = new jsdom.JSDOM('<!DOCTYPE html>').window;
    } catch (e) {
        win = null;
    }
    if (!win) { win = makeWindowShim(); }

    const store = new Map();
    const storage = {
        getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
        setItem(key, value) { store.set(String(key), String(value)); },
        removeItem(key) { store.delete(String(key)); },
        clear() { store.clear(); },
        key(index) { return store.size > index ? Array.from(store.keys())[index] : null; },
        get length() { return store.size; },
    };
    global.window = win;
    global.document = win.document;
    global.localStorage = storage;
    // Match the extension's riscvSimulator bootstrap before loading the raw Kotlin/JS core.
    // Driver constructs LocalStorage immediately, so the external Kotlin class must already be
    // visible on the Node global object when venus.js is required.
    const { LocalStorageManager } = require(path.join(__dirname, '..', '..', 'src', 'runtime', 'helpers.js'));
    global.LocalStorageManager = LocalStorageManager;
    try {
        Object.defineProperty(win, 'localStorage', { value: storage, configurable: true, writable: true });
    } catch (e) {
        // jsdom exposes localStorage as a read only accessor; its own implementation is fine here.
    }
    global.HTMLElement = win.HTMLElement || function HTMLElement() {};
    global.HTMLButtonElement = win.HTMLButtonElement || function HTMLButtonElement() {};
    global.HTMLInputElement = win.HTMLInputElement || function HTMLInputElement() {};
    global.HTMLSelectElement = win.HTMLSelectElement || function HTMLSelectElement() {};
    global.HTMLTextAreaElement = win.HTMLTextAreaElement || function HTMLTextAreaElement() {};
    global.codeMirror = { refresh() {}, setValue() {}, save() {} };
    global.load_update_message = function () {};
    global.load_done = function () {};
}

function loadVenus(buildDirectory) {
    const coreFile = path.join(buildDirectory, 'venus.js');
    const kotlinFile = path.join(buildDirectory, 'kotlin.js');
    if (!fs.existsSync(coreFile) || !fs.existsSync(kotlinFile)) {
        skip('no Venus core build in ' + buildDirectory + '; run npm run compileAll first');
    }
    installBrowserGlobals();
    // The compiled core requires the standard library under its npm module name. Point that at the
    // kotlin.js that ships with the build instead of requiring an npm package.
    const kotlin = require(kotlinFile);
    if (typeof kotlin.kotlin.Number === 'undefined') {
        kotlin.kotlin.Number = function () {};
        kotlin.kotlin.Number.prototype.call = function () {};
    }
    const load = Module._load;
    Module._load = function (request) {
        if (request === 'kotlin') { return kotlin; }
        return load.apply(this, arguments);
    };
    try {
        return require(coreFile);
    } finally {
        Module._load = load;
    }
}

const venus = loadVenus(buildDir);
const driver = venus.venus.Driver;
const Renderer = venus.venus.Renderer;

if (typeof driver.enableHostFileIO !== 'function') {
    skip('the Venus core build has no host file I/O API; apply test/native/patches/*.patch and rebuild');
}

const messages = [];
Renderer.setEmitter({
    emit(name, payload) {
        messages.push({ name: name, payload: payload === undefined || payload === null ? '' : String(payload) });
        return true;
    },
});

/* ------------------------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------------------------- */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus host file io '));
const binaryFixture = [
    0x00, 0x01, 0x02, 0x41, 0x7f, 0x80, 0x81, 0xc3,
    0xa9, 0xfe, 0xff, 0x00, 0x80, 0xff, 0x2f, 0x5c,
];

function hostFile(name) { return path.join(workDir, name); }
function writeHostFile(name, bytes) { fs.writeFileSync(hostFile(name), Buffer.from(bytes)); }
function readHostFile(name) { return Array.from(fs.readFileSync(hostFile(name))); }
function hostFileExists(name) { return fs.existsSync(hostFile(name)); }

/**
 * Assembles and runs a program on the compiled core. Host file mode is enabled unless the caller
 * turns it off, and the session working directory is the temporary directory created above (which
 * deliberately contains spaces, like many student project directories).
 */
function run(source, options) {
    const opts = options || {};
    messages.length = 0;
    driver.enableHostFileIO(opts.hostMode !== false);
    driver.setHostFileCwd(opts.hostMode === false ? '' : workDir);
    const assembled = driver.externalAssemble(source, path.join(workDir, 'host-file-io-test.s'), 'host-file-io-test.s');
    assert.ok(assembled[0], 'assembly failed: ' + assembled[1]);
    const sim = driver.sim;
    let steps = 0;
    while (!sim.isDone() && steps < 2000000) {
        sim.step();
        steps += 1;
    }
    assert.ok(sim.isDone(), 'program did not finish within ' + steps + ' steps');
    const problems = messages.filter((m) => m.name === 'error' || m.name === 'assembler_error');
    assert.deepStrictEqual(problems.map((m) => m.payload), [], 'the core reported errors');
    return { exitcode: sim.exitcode, steps: steps };
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* ------------------------------------------------------------------------------------------- *
 * Test programs
 * ------------------------------------------------------------------------------------------- */

// Opens in.bin read only, reads 32 bytes, writes them to out.bin and reports the observed
// return values (bytes read, bytes written, both close results) as raw bytes in report.bin.
const programRoundTrip = `
        .data
inpath:     .string "in.bin"
outpath:    .string "out.bin"
reportpath: .string "report.bin"
inbuf:      .space 64
report:     .space 8

        .text
        .globl main
main:
        la a1, inpath
        li a2, 0
        li a0, 13
        ecall
        mv s0, a0
        mv a1, s0
        la a2, inbuf
        li a3, 32
        li a0, 14
        ecall
        mv s1, a0
        la a1, outpath
        li a2, 1
        li a0, 13
        ecall
        mv s2, a0
        mv a1, s2
        la a2, inbuf
        mv a3, s1
        li a4, 1
        li a0, 15
        ecall
        mv s3, a0
        mv a1, s0
        li a0, 16
        ecall
        mv s4, a0
        mv a1, s2
        li a0, 16
        ecall
        mv s5, a0
        la a1, reportpath
        li a2, 1
        li a0, 13
        ecall
        mv s6, a0
        la t0, report
        sb s1, 0(t0)
        sb s3, 1(t0)
        sb s4, 2(t0)
        sb s5, 3(t0)
        mv a1, s6
        la a2, report
        li a3, 4
        li a4, 1
        li a0, 15
        ecall
        mv a1, s6
        li a0, 16
        ecall
        li a0, 10
        ecall
`;

// Exercises the error and end of file behaviour that the course jar defines: missing files and
// directories are rejected, permission bits are honoured, an unknown descriptor is EOF, reading
// past the end of a file is EOF, and feof/ferror/fflush report success.
const programErrors = `
        .data
missing:    .string "no-such-file.bin"
adirpath:   .string "adir"
inpath:     .string "in.bin"
reportpath: .string "report.bin"
report:     .space 32

        .text
        .globl main
main:
        la a1, missing
        li a2, 0
        li a0, 13
        ecall
        mv s0, a0
        la a1, missing
        li a2, 3
        li a0, 13
        ecall
        mv s1, a0
        la a1, adirpath
        li a2, 0
        li a0, 13
        ecall
        mv s2, a0
        la a1, inpath
        li a2, 9
        li a0, 13
        ecall
        mv s3, a0
        li a1, 99
        la a2, report
        li a3, 4
        li a0, 14
        ecall
        mv s4, a0
        li a1, 99
        li a0, 16
        ecall
        mv s5, a0
        la a1, inpath
        li a2, 0
        li a0, 13
        ecall
        mv s6, a0
        mv a1, s6
        la a2, report
        li a3, 4
        li a4, 1
        li a0, 15
        ecall
        mv s7, a0
        mv a1, s6
        li a0, 19
        ecall
        mv s8, a0
        mv a1, s6
        li a0, 20
        ecall
        mv s9, a0
        mv a1, s6
        li a0, 18
        ecall
        mv s10, a0
        mv a1, s6
        la a2, report
        li a3, 16
        li a0, 14
        ecall
        mv s11, a0
        mv a1, s6
        la a2, report
        li a3, 4
        li a0, 14
        ecall
        mv t2, a0
        mv a1, s6
        li a0, 16
        ecall
        mv t3, a0
        mv a1, s6
        li a0, 16
        ecall
        mv t4, a0
        la t0, report
        sb s0, 0(t0)
        sb s1, 1(t0)
        sb s2, 2(t0)
        sb s3, 3(t0)
        sb s4, 4(t0)
        sb s5, 5(t0)
        sb s7, 6(t0)
        sb s8, 7(t0)
        sb s9, 8(t0)
        sb s10, 9(t0)
        sb s11, 10(t0)
        sb t2, 11(t0)
        sb t3, 12(t0)
        sb t4, 13(t0)
        la a1, reportpath
        li a2, 1
        li a0, 13
        ecall
        mv s0, a0
        mv a1, s0
        la a2, report
        li a3, 14
        li a4, 1
        li a0, 15
        ecall
        mv a1, s0
        li a0, 16
        ecall
        li a0, 10
        ecall
`;

// Appends to the same file twice in binary, so that append (2/a) neither truncates nor mangles
// 0x00, 0x80 and 0xff.
const programAppend = `
        .data
path:   .string "app.bin"
buf:    .space 8

        .text
        .globl main
main:
        la t0, buf
        li t1, 0x00
        sb t1, 0(t0)
        li t1, 0x80
        sb t1, 1(t0)
        li t1, 0xff
        sb t1, 2(t0)
        li t1, 0x41
        sb t1, 3(t0)
        li t1, 0x42
        sb t1, 4(t0)
        la a1, path
        li a2, 2
        li a0, 13
        ecall
        mv s0, a0
        mv a1, s0
        la a2, buf
        li a3, 3
        li a4, 1
        li a0, 15
        ecall
        mv a1, s0
        li a0, 16
        ecall
        la a1, path
        li a2, 2
        li a0, 13
        ecall
        mv s1, a0
        mv a1, s1
        la a2, buf
        addi a2, a2, 3
        li a3, 2
        li a4, 1
        li a0, 15
        ecall
        mv a1, s1
        li a0, 16
        ecall
        li a0, 10
        ecall
`;

// Truncates an existing file (1/w) and writes two bytes, one of them 0x00.
const programTruncate = `
        .data
path:   .string "trunc.bin"
buf:    .space 8

        .text
        .globl main
main:
        la t0, buf
        li t1, 0xee
        sb t1, 0(t0)
        li t1, 0x00
        sb t1, 1(t0)
        la a1, path
        li a2, 1
        li a0, 13
        ecall
        mv s0, a0
        mv a1, s0
        la a2, buf
        li a3, 2
        li a4, 1
        li a0, 15
        ecall
        mv a1, s0
        li a0, 16
        ecall
        li a0, 10
        ecall
`;

// Run with host mode disabled against an existing absolute file. The legacy native VFS probes
// absolute paths through Node fs before keeping subsequent writes in memory; using an existing
// file avoids turning that legacy probe into an ENOENT while still proving the host bridge stays
// inert (the real host file must remain byte-for-byte unchanged).
function programVfsOnly(absolutePath) {
    return `
        .data
path:   .string "${absolutePath}"
buf:    .space 8

        .text
        .globl main
main:
        la t0, buf
        li t1, 0x11
        sb t1, 0(t0)
        li t1, 0x22
        sb t1, 1(t0)
        la a1, path
        li a2, 1
        li a0, 13
        ecall
        mv s0, a0
        mv a1, s0
        la a2, buf
        li a3, 2
        li a4, 1
        li a0, 15
        ecall
        mv a1, s0
        li a0, 16
        ecall
        li a0, 10
        ecall
`;
}

// Opens an absolute path (inside a directory with spaces) and writes the first byte back to a
// relative path, which proves both kinds of path resolution in one run.
function programAbsolutePath(absolutePath) {
    return `
        .data
abspath: .string "${absolutePath}"
outpath: .string "abs-out.bin"
buf:     .space 8

        .text
        .globl main
main:
        la a1, abspath
        li a2, 0
        li a0, 13
        ecall
        mv s0, a0
        mv a1, s0
        la a2, buf
        li a3, 1
        li a0, 14
        ecall
        mv a1, s0
        li a0, 16
        ecall
        la a1, outpath
        li a2, 1
        li a0, 13
        ecall
        mv s1, a0
        mv a1, s1
        la a2, buf
        li a3, 1
        li a4, 1
        li a0, 15
        ecall
        mv a1, s1
        li a0, 16
        ecall
        li a0, 10
        ecall
`;
}

/* ------------------------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------------------------- */

test('reads and writes every byte value 0x00..0xff (Project 2 matrices)', () => {
    writeHostFile('in.bin', binaryFixture);
    const result = run(programRoundTrip);
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.deepStrictEqual(readHostFile('out.bin'), binaryFixture, 'out.bin must copy in.bin byte for byte');
    assert.deepStrictEqual(readHostFile('report.bin'), [16, 16, 0, 0], 'bytes read, bytes written, close, close');
});

test('resolves relative paths against the configured working directory', () => {
    // in.bin only exists in the session working directory (which is not the process working
    // directory), so a core that ignored setHostFileCwd could not open it at all.
    writeHostFile('in.bin', binaryFixture);
    const result = run(programRoundTrip);
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.ok(hostFileExists('out.bin'), 'out.bin must be created next to in.bin');
});

test('matches the reference open flags, EOF and error returns', () => {
    writeHostFile('in.bin', binaryFixture);
    fs.mkdirSync(hostFile('adir'), { recursive: true });
    const result = run(programErrors);
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.deepStrictEqual(readHostFile('report.bin'), [
        0xff, // open missing file read only      -> EOF
        0xff, // open missing file read/write     -> EOF
        0xff, // open a directory                 -> EOF
        0xff, // invalid permission bits          -> EOF
        0xff, // read from an unknown descriptor  -> EOF
        0xff, // close an unknown descriptor      -> EOF
        0xff, // write on a read only descriptor  -> EOF
        0x00, // feof                             -> 0
        0x00, // ferror                           -> 0
        0x00, // fflush                           -> 0
        0x10, // read the whole 16 byte file      -> 16
        0xff, // read past the end of the file    -> EOF
        0x00, // close                            -> 0
        0xff, // close again                      -> EOF
    ], 'report.bin');
});

test('append (2/a) keeps existing bytes and writes binary', () => {
    writeHostFile('app.bin', [0x99]);
    const result = run(programAppend);
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.deepStrictEqual(readHostFile('app.bin'), [0x99, 0x00, 0x80, 0xff, 0x41, 0x42], 'app.bin');
});

test('write mode (1/w) truncates an existing file', () => {
    writeHostFile('trunc.bin', [0xde, 0xad, 0xbe, 0xef]);
    const result = run(programTruncate);
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.deepStrictEqual(readHostFile('trunc.bin'), [0xee, 0x00], 'trunc.bin');
});

test('opens absolute paths, including directories with spaces', () => {
    const absolutePath = hostFile('abs-in.bin').replace(/\\/g, '/');
    writeHostFile('abs-in.bin', [0x80, 0x7f]);
    const result = run(programAbsolutePath(absolutePath));
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.deepStrictEqual(readHostFile('abs-out.bin'), [0x80], 'abs-out.bin');
});

test('host mode disabled keeps VFS writes off the host file', () => {
    const original = [0xaa, 0xbb, 0xcc];
    writeHostFile('vfs-only.bin', original);
    const absolutePath = hostFile('vfs-only.bin').replace(/\\/g, '/');
    const result = run(programVfsOnly(absolutePath), { hostMode: false });
    assert.strictEqual(result.exitcode, 0, 'exit code');
    assert.deepStrictEqual(readHostFile('vfs-only.bin'), original,
        'legacy VFS writes must not escape to the host while host mode is disabled');
});

/* ------------------------------------------------------------------------------------------- *
 * Runner
 * ------------------------------------------------------------------------------------------- */

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
try {
    fs.rmSync(workDir, { recursive: true, force: true });
} catch (e) {
    // best effort cleanup
}
if (failures > 0) {
    console.error(failures + ' of ' + tests.length + ' tests failed');
    process.exit(1);
}
console.log('all ' + tests.length + ' tests passed');
