#!/usr/bin/env node
'use strict';

/**
 * Differential acceptance tests for the CS61C course `venus.jar` bridge
 * (`src/course/*`).
 *
 * The pinned course JAR is authoritative for calling-convention checking,
 * memcheck, `-ms`, exit codes, and it performs real host file I/O. Every case
 * runs the same program twice:
 *
 *   1. directly, with the argv the JAR documents, and
 *   2. through the extension bridge (`buildVenusJarArgv` +
 *      `runVenusCourseProcess`, i.e. the same code the VS Code commands call),
 *
 * then compares the planned argv, the process exit code, the combined output,
 * and the host files that were written. A bug in argument construction, working
 * directory handling, output collection, or exit-code reporting shows up as a
 * mismatch.
 *
 * Usage:
 *   npm run compile                        # the harness loads out/course/*.js
 *   node scripts/ci/venus-course-parity.js [--jar <path>] [--require-jar]
 *
 * Environment:
 *   VENUS_COURSE_JAR        path to the pinned course venus.jar
 *   VENUS_COURSE_JAVA       java executable to use (else JAVA_HOME, else PATH)
 *   VENUS_COURSE_REQUIRE=1  fail instead of skipping when no course JAR is found
 *
 * Exit status: 0 when every observed difference is explained, 1 on a failed
 * check, 2 when the harness cannot run (missing build output or java).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'venus-course');
const BRIDGE_OUT_DIR = path.join(REPO_ROOT, 'out', 'course');
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function info(message) { process.stdout.write(message + '\n'); }

/** Normalises line endings and trailing whitespace before comparing output. */
function normalise(text) {
	return String(text === undefined || text === null ? '' : text)
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

function firstDifference(expected, actual) {
	const left = normalise(expected).split('\n');
	const right = normalise(actual).split('\n');
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		if (left[i] !== right[i]) {
			return `line ${i + 1}\n         direct: ${JSON.stringify(left[i])}\n         bridge: ${JSON.stringify(right[i])}`;
		}
	}
	return 'outputs differ only in trailing whitespace';
}

/**
 * The Node exit status for a JVM `System.exit(code)` on this platform.
 * The JVM forwards the value as-is; Windows keeps all 32 bits (unsigned),
 * POSIX truncates to the low byte.
 */
function jvmExitCode(code) {
	if (IS_WINDOWS) { return code >>> 0; }
	return ((code % 256) + 256) % 256;
}

class Report {
	constructor() { this.checks = []; }

	pass(name, note) {
		this.checks.push({ name, ok: true, note });
		info(`  ok   ${name}${note ? ` (${note})` : ''}`);
	}

	fail(name, detail) {
		this.checks.push({ name, ok: false, detail });
		info(`  FAIL ${name}`);
		info(`       ${String(detail).replace(/\n/g, '\n       ')}`);
	}

	assert(name, condition, detail) {
		if (condition) { this.pass(name); } else { this.fail(name, detail); }
	}

	get failures() { return this.checks.filter(check => !check.ok); }
}

function isFile(candidate) {
	try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function removeFile(candidate) {
	try { fs.rmSync(candidate, { force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// environment discovery
// ---------------------------------------------------------------------------

function cliOption(name) {
	const prefix = `--${name}=`;
	const match = process.argv.find(arg => arg.startsWith(prefix));
	return match ? match.slice(prefix.length) : undefined;
}

/**
 * Locates the pinned course JAR. Explicit configuration wins; otherwise the
 * CS61C directory layout is searched upwards from the repository root.
 */
function locateCourseJar() {
	const explicit = [cliOption('jar'), process.env.VENUS_COURSE_JAR].filter(Boolean);
	if (explicit.length > 0) {
		const resolved = path.resolve(explicit[0]);
		return isFile(resolved) ? resolved : undefined;
	}

	const layouts = [
		path.join('course-fa24', 'projects', 'proj2-cs61classify', 'tools', 'venus.jar'),
		path.join('projects', 'proj2-cs61classify', 'tools', 'venus.jar'),
		path.join('tools', 'venus.jar')
	];

	let current = REPO_ROOT;
	for (let depth = 0; depth < 10; depth++) {
		for (const layout of layouts) {
			const candidate = path.join(current, layout);
			if (isFile(candidate)) { return candidate; }
		}
		const parent = path.dirname(current);
		if (parent === current) { break; }
		current = parent;
	}
	return undefined;
}

function resolveJava(configured) {
	const candidates = [configured, process.env.VENUS_COURSE_JAVA];
	if (process.env.JAVA_HOME) {
		candidates.push(path.join(process.env.JAVA_HOME, 'bin', IS_WINDOWS ? 'java.exe' : 'java'));
	}
	candidates.push(IS_WINDOWS ? 'java.exe' : 'java');
	for (const candidate of candidates) {
		if (!candidate) { continue; }
		const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
		if (probe.status === 0) { return candidate; }
	}
	return undefined;
}

function loadBridge() {
	if (!fs.existsSync(path.join(BRIDGE_OUT_DIR, 'venusCourseArgs.js'))) {
		info('The compiled bridge is missing. Run `npm run compile` first.');
		process.exit(2);
	}
	return {
		args: require(path.join(BRIDGE_OUT_DIR, 'venusCourseArgs.js')),
		process: require(path.join(BRIDGE_OUT_DIR, 'venusCourseProcess.js')),
		locator: require(path.join(BRIDGE_OUT_DIR, 'venusJarLocator.js')),
		report: fs.existsSync(path.join(BRIDGE_OUT_DIR, 'venusCourseReport.js'))
			? require(path.join(BRIDGE_OUT_DIR, 'venusCourseReport.js'))
			: undefined
	};
}

function createSandbox() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus course parity '));
	// Both a directory with spaces and one without, so path handling is covered.
	fs.mkdirSync(path.join(root, 'project with spaces'), { recursive: true });
	fs.mkdirSync(path.join(root, 'plain dir'), { recursive: true });
	return { root };
}

// ---------------------------------------------------------------------------
// case definitions
// ---------------------------------------------------------------------------

/**
 * Every case declares, independently of the bridge:
 *   - `directFlags`: the JAR flags the CLI documents, in the order the bridge
 *     is expected to emit them,
 *   - `invocation`: the bridge invocation those flags must come from,
 *   - `programDir` / `programArg` / `cwd`: where the program lives and runs,
 *   - `expect`: what the pinned JAR is observed to do.
 */
function buildCases(sandbox, jarPath) {
	const fixture = name => path.join(FIXTURE_DIR, name);
	const dirOf = kind => path.join(sandbox.root, kind === 'spaced' ? 'project with spaces' : 'plain dir');
	const spacedDir = dirOf('spaced');

	const cases = [];
	const add = (name, spec) => cases.push(Object.assign({ name }, spec));

	// -- plain run ---------------------------------------------------------
	add('run: framework defaults (-it -ms -1)', {
		program: fixture('hello.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-it', '-ms', '-1'],
		invocation: { immutableText: true, maxSteps: -1 },
		expect: { exitCode: 0, stdoutContains: ['hello from venus'] }
	});

	add('run: exact JAR defaults (no flags)', {
		program: fixture('hello.s'),
		programDir: 'spaced',
		programArg: 'relative',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: { exitCode: 0, stdoutContains: ['hello from venus'] }
	});

	add('run: argv with spaces, where the JAR consumes a flag-shaped argument', {
		program: fixture('argv.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		// Venus takes everything after the file as simulator args but still
		// consumes flag-shaped entries: `venus-reference` says "Flags to
		// configure Venus assembly or simulation behavior can be passed after
		// the name of the file. These arguments will be consumed by the
		// simulator and not passed to the program". The pinned JAR therefore
		// drops `-it` and shifts `omega` into argv[4]; framework.py relies on
		// the same rule by rejecting program args that start with `-`.
		programArgs: ['alpha', 'beta gamma', 'quoted "arg"', '-it', 'omega'],
		expect: {
			exitCode: 0,
			stdoutContains: [
				'argc=5',
				'argv[1]=alpha',
				'argv[2]=beta gamma',
				'argv[3]=quoted "arg"',
				'argv[4]=omega'
			]
		}
	});

	add('run: assembler error is reported', {
		program: fixture('bogus_directive.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: {
			exitCode: jvmExitCode(-1),
			stdoutContains: ['unknown assembler directive'],
			notStdoutContains: ['Exited with error code 0']
		}
	});

	add('run: missing program file', {
		program: fixture('does-not-exist.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: { exitCode: jvmExitCode(-1) }
	});

	// -- exit codes --------------------------------------------------------
	add('exit: ecall 17 with a non-zero code', {
		program: fixture('exit_42.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: { exitCode: 42, stdoutContains: ['Exited with error code 42'] }
	});

	add('exit: ecall 5 atoi feeds ecall 17 (negative)', {
		program: fixture('exit_atoi.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		programArgs: ['-7'],
		expect: { exitCode: jvmExitCode(-7), stdoutContains: ['Exited with error code -7'] }
	});

	// -- calling convention ------------------------------------------------
	add('-cc: exported function saves its callee-saved registers', {
		program: fixture('cc_clean.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-cc'],
		invocation: { callingConvention: true },
		expect: { exitCode: 0, stdoutContains: ['Found 0 warnings!'] }
	});

	add('-cc: violation exits non-zero', {
		program: fixture('cc_violation.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-cc'],
		invocation: { callingConvention: true },
		expect: {
			exitCode: jvmExitCode(-1),
			stdoutContains: ['[CC Violation]', 'Found 2 warnings!']
		}
	});

	// -- memcheck ----------------------------------------------------------
	add('-mc: the course malloc wrapper registers the block, so memcheck is silent', {
		program: fixture('mc_good.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-mc'],
		invocation: { memcheck: true },
		expect: {
			exitCode: 0,
			stdoutContains: ['heap roundtrip ok'],
			notStdoutContains: ['[memcheck] Invalid memory access']
		}
	});

	add('-mc: unallocated stack read is reported', {
		program: fixture('mc_bad.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-mc'],
		invocation: { memcheck: true },
		expect: {
			// The pinned JAR reports the violation, keeps running, and still
			// exits with the program's own code; the bridge must mirror that.
			exitCode: 0,
			stdoutContains: ['[memcheck] Invalid memory access', 'continued-after-memcheck'],
			notStdoutContains: ['[memcheck] data allocs']
		}
	});

	add('-mcv: verbose memcheck adds the allocation dump', {
		program: fixture('mc_bad.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-mcv'],
		invocation: { memcheckVerbose: true },
		expect: {
			exitCode: 0,
			stdoutContains: [
				'[memcheck] data allocs',
				'[memcheck] access:',
				'[memcheck] Invalid memory access'
			]
		}
	});

	add('-mc wins over -ahs, which the JAR rejects together', {
		program: fixture('mc_good.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-mc'],
		invocation: { memcheck: true, allowStackHeap: true },
		expect: { exitCode: 0 }
	});

	// -- -ms ---------------------------------------------------------------
	add('-ms -1: no step limit', {
		program: fixture('ms_long.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-ms', '-1'],
		invocation: { maxSteps: -1 },
		expect: { exitCode: 42 }
	});

	add('-ms 1000: the step limit is enforced', {
		program: fixture('ms_long.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-ms', '1000'],
		invocation: { maxSteps: 1000 },
		expect: {
			exitCode: jvmExitCode(-1),
			stdoutContains: ['Ran for more than the max allowed steps (1000)!']
		}
	});

	add('-ms 5: an infinite program is stopped', {
		program: fixture('ms_limit.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-ms', '5'],
		invocation: { maxSteps: 5 },
		expect: {
			exitCode: jvmExitCode(-1),
			stdoutContains: ['Ran for more than the max allowed steps (5)!']
		}
	});

	// -- immutable text ----------------------------------------------------
	add('-it: text writes are rejected', {
		program: fixture('text_write.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['-it'],
		invocation: { immutableText: true },
		expect: {
			exitCode: jvmExitCode(-1),
			stdoutContains: ['attempting to edit the text']
		}
	});

	add('-it off: text writes are allowed (JAR default)', {
		program: fixture('text_write.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: { immutableText: false },
		expect: { exitCode: 0 }
	});

	// -- defines -----------------------------------------------------------
	add('--def: the assembler substitutes the defined token', {
		program: fixture('defs_hook.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['--def', '#PRINT_HOOK=li a1 7'],
		invocation: { defines: ['#PRINT_HOOK=li a1 7'] },
		expect: {
			exitCode: 0,
			stdoutContains: ['7'],
			notStdoutContains: ['3']
		}
	});

	add('--def off: the hook line stays a plain comment', {
		program: fixture('defs_hook.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: { exitCode: 0, stdoutContains: ['3'] }
	});

	add('--def: several defines are joined into one ;-separated list', {
		program: fixture('defs_hook.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: ['--def', '#PRINT_HOOK=li a1 7;#PRINT_HOOK2=li a1 9'],
		invocation: { defines: ['#PRINT_HOOK=li a1 7', '#PRINT_HOOK2=li a1 9'] },
		expect: {
			// Both hooks have to reach the assembler: the JAR assigns a repeated
			// --def, so a per-entry emission would print 7 and 5, not 7 and 9.
			exitCode: 0,
			stdoutContains: ['7', '9']
		}
	});

	// -- host file I/O -----------------------------------------------------
	add('file io: relative paths land in the working directory', {
		program: fixture('file_io.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: {
			exitCode: 0,
			stdoutContains: ['read bytes=25 feof=0 ferror=0 content=[project2 file io payload'],
			files: [{
				name: 'parity io file with spaces.txt',
				content: 'project2 file io payload\n'
			}]
		}
	});

	add('file io: the process working directory redirects host file paths', {
		program: fixture('file_io.s'),
		programDir: 'plain',
		programArg: 'absolute',
		// framework.py:47 runs Venus with cwd=test-src and never passes -wd; the
		// pinned JAR rejected the absolute -wd the bridge used to add, so the
		// working directory is the child process cwd on both sides.
		cwd: 'spaced',
		directFlags: [],
		invocation: { workingDirectory: spacedDir },
		expect: {
			exitCode: 0,
			files: [{
				name: 'parity io file with spaces.txt',
				content: 'project2 file io payload\n'
			}],
			filesAbsentFrom: ['plain']
		}
	});

	// -- unicode -----------------------------------------------------------
	// The JAR's handling of a non-ASCII `.string` literal depends on the JVM's
	// default charset; on some JDKs it reports an assembler error and exits
	// non-zero. Whatever the platform does, the direct run and the bridge have
	// to agree on argv, exit status and output bytes, so this case asserts only
	// that cross-run parity.
	add('run: non-ASCII source and output stay byte-identical', {
		program: fixture('unicode.s'),
		programDir: 'spaced',
		programArg: 'absolute',
		cwd: 'spaced',
		directFlags: [],
		invocation: {},
		expect: {}
	});

	return cases;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

function resolveLayout(sandbox, spec) {
	const dirOf = kind => path.join(sandbox.root, kind === 'spaced' ? 'project with spaces' : 'plain dir');
	const programDir = dirOf(spec.programDir || 'spaced');
	const programName = path.basename(spec.program);
	const cwd = dirOf(spec.cwd || 'spaced');

	return {
		dirOf,
		programDir,
		programInDir: path.join(programDir, programName),
		programArgPath: spec.programArg === 'relative' ? programName : path.join(programDir, programName),
		cwd,
		directCwd: spec.directCwd ? dirOf(spec.directCwd) : cwd
	};
}

/** Direct stdout/stderr, in both plausible interleavings. */
function directOutputCandidates(direct) {
	const out = String(direct.stdout);
	const err = String(direct.stderr);
	return [normalise(out + err), normalise(err + out)];
}

function outputsMatch(direct, combined) {
	const got = normalise(combined);
	const candidates = directOutputCandidates(direct);
	if (candidates.includes(got)) { return true; }
	const lines = text => normalise(text).split('\n').filter(Boolean).sort();
	const expected = lines(candidates[0]);
	const actual = lines(got);
	return expected.length === actual.length && expected.every((line, i) => line === actual[i]);
}

function firstOutputDifference(direct, combined) {
	return firstDifference(directOutputCandidates(direct)[0], combined);
}

function checkExpectations(report, spec, expectations, result, layout) {
	const output = normalise(result.output);

	if (typeof expectations.exitCode === 'number') {
		report.assert(`${spec.name}: bridge exit code is ${expectations.exitCode}`,
			result.exitCode === expectations.exitCode,
			`actual ${result.exitCode}`);
	}
	for (const needle of expectations.stdoutContains || []) {
		report.assert(`${spec.name}: output contains ${JSON.stringify(needle)}`,
			output.includes(needle), `output was:\n${output}`);
	}
	for (const needle of expectations.notStdoutContains || []) {
		report.assert(`${spec.name}: output omits ${JSON.stringify(needle)}`,
			!output.includes(needle), `output was:\n${output}`);
	}
	for (const file of expectations.files || []) {
		const target = path.join(layout.cwd, file.name);
		let content;
		try {
			content = fs.readFileSync(target, 'utf8');
		} catch {
			content = undefined;
		}
		report.assert(`${spec.name}: host file ${JSON.stringify(file.name)} matches`,
			content === file.content,
			content === undefined
				? `expected ${target} to exist`
				: `expected ${JSON.stringify(file.content)} but found ${JSON.stringify(content)}`);
	}
	for (const kind of expectations.filesAbsentFrom || []) {
		for (const file of expectations.files || []) {
			const target = path.join(layout.dirOf(kind), file.name);
			report.assert(`${spec.name}: no stray file in the ${kind} directory`,
				!isFile(target), `unexpected ${target}`);
		}
	}
}

async function runCase(report, bridge, context, spec, index) {
	info(`\n[${String(index + 1).padStart(2, '0')}] ${spec.name}`);
	const layout = resolveLayout(context.sandbox, spec);
	const expectations = spec.expect || {};

	if (isFile(spec.program)) {
		fs.copyFileSync(spec.program, layout.programInDir);
	}
	for (const file of expectations.files || []) {
		removeFile(path.join(layout.cwd, file.name));
		removeFile(path.join(layout.directCwd, file.name));
	}

	const programArgs = spec.programArgs || [];
	const invocation = Object.assign({ program: layout.programArgPath }, spec.invocation || {});
	if (programArgs.length > 0) { invocation.programArgs = programArgs; }

	const plan = bridge.args.buildVenusJarArgv(context.jarPath, invocation, context.java);
	const expectedArgs = ['-jar', context.jarPath]
		.concat(spec.directFlags || [])
		.concat([layout.programArgPath])
		.concat(programArgs);

	report.assert(`${spec.name}: planned argv matches the documented CLI`,
		JSON.stringify(plan.javaArgs) === JSON.stringify(expectedArgs),
		`expected ${JSON.stringify(expectedArgs)}\n       actual   ${JSON.stringify(plan.javaArgs)}`);

	const direct = spawnSync(context.java, expectedArgs, {
		cwd: layout.directCwd,
		encoding: 'utf8',
		timeout: 180000,
		maxBuffer: 64 * 1024 * 1024
	});
	if (direct.error) {
		report.fail(`${spec.name}: direct java -jar baseline`, String(direct.error));
		return;
	}

	let bridged;
	try {
		bridged = await bridge.process.runVenusCourseProcess(context.java, plan.javaArgs, { cwd: layout.cwd });
	} catch (error) {
		report.fail(`${spec.name}: bridge run`, String(error));
		return;
	}

	report.assert(`${spec.name}: exit code parity`,
		direct.status === bridged.exitCode,
		`direct=${direct.status} bridge=${bridged.exitCode}`);
	report.assert(`${spec.name}: output parity`,
		outputsMatch(direct, bridged.output),
		firstOutputDifference(direct, bridged.output));

	checkExpectations(report, spec, expectations, bridged, layout);
}

// ---------------------------------------------------------------------------
// cross-cutting checks
// ---------------------------------------------------------------------------

/** The command line shown in the output channel must be executable verbatim. */
function checkShellRoundTrip(report, bridge, context) {
	info('\n[shell] the displayed command line runs verbatim');
	const program = path.join(context.sandbox.root, 'project with spaces', 'exit_42.s');
	fs.copyFileSync(path.join(FIXTURE_DIR, 'exit_42.s'), program);
	const cwd = path.dirname(program);
	const plan = bridge.args.planVenusCourseRun(context.jarPath, { program }, context.java);

	const direct = spawnSync(context.java, plan.javaArgs, { cwd, encoding: 'utf8', timeout: 120000 });
	report.assert('shell: direct baseline exits 42', direct.status === 42, `direct exit ${direct.status}`);

	const [shell, args] = IS_WINDOWS
		? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${plan.commandLine}; exit $LASTEXITCODE }`]]
		: ['/bin/sh', ['-c', plan.commandLine]];
	const executed = spawnSync(shell, args, { cwd, encoding: 'utf8', timeout: 120000 });
	if (executed.error) {
		report.fail('shell: command line executes', String(executed.error));
		return;
	}
	report.assert('shell: exit code survives quoting', executed.status === direct.status,
		`shell=${executed.status} direct=${direct.status}`);
	report.assert('shell: output survives quoting',
		normalise(String(executed.stdout) + String(executed.stderr)) === normalise(String(direct.stdout) + String(direct.stderr)),
		firstDifference(String(direct.stdout) + String(direct.stderr), String(executed.stdout) + String(executed.stderr)));
}

/** The JAR locator must find the pinned JAR in the CS61C layout. */
function checkJarDiscovery(report, bridge, context) {
	info('\n[discovery] the bridge finds the pinned course JAR');
	const relative = path.join('course-fa24', 'projects', 'proj2-cs61classify', 'tools', 'venus.jar');
	if (!context.jarPath.endsWith(relative)) {
		report.pass('discovery: skipped (the JAR was configured explicitly)');
		return;
	}

	const cs61cRoot = path.resolve(context.jarPath.slice(0, context.jarPath.length - relative.length - 1));
	const projectRoot = path.join(cs61cRoot, 'course-fa24', 'projects', 'proj2-cs61classify');
	const program = path.join(projectRoot, 'test-src', 'test_abs_one.s');

	const single = bridge.locator.locateVenusJar({ programPath: program, workspaceRoots: [cs61cRoot] });
	report.assert('discovery: CS61C workspace root finds the pinned JAR',
		single.jarPath === context.jarPath,
		`found ${single.jarPath}`);

	const multi = bridge.locator.locateVenusJar({ programPath: program, workspaceRoots: [cs61cRoot, projectRoot] });
	report.assert('discovery: multi-root prefers the Project 2 folder',
		multi.jarPath === context.jarPath,
		`found ${multi.jarPath}`);

	report.assert('discovery: selectProjectRoot picks the deepest containing root',
		bridge.args.selectProjectRoot(program, [cs61cRoot, projectRoot]) === projectRoot,
		`got ${bridge.args.selectProjectRoot(program, [cs61cRoot, projectRoot])}`);
}

/**
 * `riscv-venus.course.workingDirectory` may be relative (Project 2 uses
 * `test-src`). It must be resolved to an absolute path before it is handed to
 * `spawn` as the child cwd; Venus' own `-wd` rejected that absolute path, so the
 * process cwd is the only mechanism.
 */
async function checkRelativeWorkingDirectory(report, bridge, context) {
	info('\n[working directory] a relative working directory resolves against the project root');
	const projectRoot = path.join(context.sandbox.root, 'project with spaces');
	const sourceDir = path.join(projectRoot, 'src');
	fs.mkdirSync(sourceDir, { recursive: true });
	const program = path.join(sourceDir, 'file_io.s');
	fs.copyFileSync(path.join(FIXTURE_DIR, 'file_io.s'), program);

	const unresolved = spawnSync(context.java, ['-jar', context.jarPath, program], {
		cwd: 'test-src', encoding: 'utf8', timeout: 120000
	});
	report.assert('working directory: a raw relative cwd fails (the original bug)',
		Boolean(unresolved.error) || unresolved.status !== 0,
		`expected spawn to fail, got status ${unresolved.status}`);

	const resolved = bridge.args.resolveWorkingDirectory('test-src', program, projectRoot);
	report.assert('working directory: resolveWorkingDirectory returns an absolute path',
		path.isAbsolute(resolved) && resolved === path.join(projectRoot, 'test-src'),
		`got ${resolved}`);

	fs.mkdirSync(resolved, { recursive: true });
	removeFile(path.join(resolved, 'parity io file with spaces.txt'));

	const plan = bridge.args.buildVenusJarArgv(context.jarPath, {
		program,
		workingDirectory: resolved
	}, context.java);
	const result = await bridge.process.runVenusCourseProcess(context.java, plan.javaArgs, { cwd: resolved });
	report.assert('working directory: the program runs from the resolved directory',
		result.exitCode === 0, `exit ${result.exitCode}:\n${result.output}`);
	report.assert('working directory: file I/O lands in the resolved directory',
		isFile(path.join(resolved, 'parity io file with spaces.txt')),
		`expected ${path.join(resolved, 'parity io file with spaces.txt')}`);
}

/**
 * A memcheck violation does not change the JAR's exit code, so the bridge has
 * to read the diagnostics to report the check accurately.
 */
function checkCourseReporting(report, bridge) {
	if (!bridge.report || typeof bridge.report.summariseVenusCourseResult !== 'function') {
		report.pass('reporting: helper not present (baseline)');
		return;
	}

	info('\n[reporting] memcheck diagnostics are reflected in the summary');

	const violation = '[memcheck] Invalid memory access of size 4. Address 0x7FFFFF00 is alloc\'d.';
	const verbose = '[memcheck] data allocs\n[memcheck] access: addr=0x7FFFFF00 size=4\n' + violation;

	const cleanMemcheck = bridge.report.summariseVenusCourseResult('memcheck', 0, 'Exited with error code 0');
	report.assert('reporting: a clean -mc run is ok', cleanMemcheck.ok === true, JSON.stringify(cleanMemcheck));

	const badMemcheck = bridge.report.summariseVenusCourseResult('memcheck', 0, violation + '\nExited with error code 0');
	report.assert('reporting: -mc violations with exit 0 are not ok',
		badMemcheck.ok === false && badMemcheck.violations === 1, JSON.stringify(badMemcheck));

	const verboseMemcheck = bridge.report.summariseVenusCourseResult('memcheckVerbose', 0, verbose);
	report.assert('reporting: -mcv counts every violation',
		verboseMemcheck.ok === false && verboseMemcheck.violations === 1, JSON.stringify(verboseMemcheck));

	const ccWarnings = bridge.report.summariseVenusCourseResult(
		'callingConvention', jvmExitCode(-1), '[CC Violation]: something\nFound 2 warnings!');
	report.assert('reporting: -cc failures surface the exit code',
		ccWarnings.ok === false && /exit code/i.test(ccWarnings.message), JSON.stringify(ccWarnings));

	const plainRun = bridge.report.summariseVenusCourseResult('run', 0, violation);
	report.assert('reporting: memcheck text during a plain run is ignored',
		plainRun.ok === true, JSON.stringify(plainRun));
}

/**
 * Project 2's `bash test.sh coverage` reads the map Venus writes through
 * `--coverageFile`. The bridge has to forward the path (a relative setting is
 * resolved against the working directory) and the JAR has to write the same map
 * it writes for a direct `java -jar` invocation.
 */
async function checkCoverageFile(report, bridge, context) {
	info('\n[coverage] --coverageFile reaches the JAR and writes the same map');
	const project = path.join(context.sandbox.root, 'project with spaces');
	const program = path.join(project, 'coverage.s');
	fs.copyFileSync(path.join(FIXTURE_DIR, 'hello.s'), program);

	const directFile = path.join(project, 'coverage direct.txt');
	const bridgeFile = path.join(project, 'coverage bridge.txt');
	removeFile(directFile);
	removeFile(bridgeFile);

	const direct = spawnSync(
		context.java,
		['-jar', context.jarPath, '--coverageFile', directFile, program],
		{ cwd: project, encoding: 'utf8', timeout: 180000 }
	);
	if (direct.error) {
		report.fail('coverage: direct java -jar baseline', String(direct.error));
		return;
	}
	report.assert('coverage: the direct JAR run writes the coverage file',
		direct.status === 0 && isFile(directFile), `exit ${direct.status}`);
	if (!isFile(directFile)) { return; }

	const plan = bridge.args.buildVenusJarArgv(
		context.jarPath,
		{ program, coverageFile: bridgeFile },
		context.java
	);
	report.assert('coverage: the bridge emits --coverageFile before the program',
		JSON.stringify(plan.javaArgs) === JSON.stringify(
			['-jar', context.jarPath, '--coverageFile', bridgeFile, program]),
		JSON.stringify(plan.javaArgs));

	const bridged = await bridge.process.runVenusCourseProcess(context.java, plan.javaArgs, { cwd: project });
	report.assert('coverage: the bridged run exits like the direct run',
		bridged.exitCode === direct.status,
		`direct=${direct.status} bridge=${bridged.exitCode}`);
	report.assert('coverage: the bridged run writes the coverage file too',
		isFile(bridgeFile), `expected ${bridgeFile}`);

	const directText = isFile(directFile) ? fs.readFileSync(directFile, 'utf8') : '';
	const bridgeText = isFile(bridgeFile) ? fs.readFileSync(bridgeFile, 'utf8') : '';
	report.assert('coverage: both runs write the same coverage map',
		normalise(bridgeText).length > 0 && normalise(directText) === normalise(bridgeText),
		normalise(bridgeText).length === 0
			? 'the coverage file is empty'
			: firstDifference(directText, bridgeText));
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main() {
	info('Venus course JAR differential acceptance');
	const requireJar = process.argv.includes('--require-jar') || process.env.VENUS_COURSE_REQUIRE === '1';

	const jarPath = locateCourseJar();
	if (!jarPath) {
		info('SKIPPED: the pinned course venus.jar was not found (set VENUS_COURSE_JAR or pass --jar=<path>).');
		process.exit(requireJar ? 1 : 0);
	}
	const java = resolveJava(cliOption('java'));
	if (!java) {
		info('No java executable found (set VENUS_COURSE_JAVA or JAVA_HOME).');
		process.exit(2);
	}

	const bridge = loadBridge();
	const sandbox = createSandbox();
	const context = { jarPath, java, sandbox };
	info(`jar:  ${jarPath}`);
	info(`java: ${java}`);
	info(`tmp:  ${sandbox.root}`);

	const report = new Report();
	const cases = buildCases(sandbox, jarPath);
	for (let index = 0; index < cases.length; index++) {
		await runCase(report, bridge, context, cases[index], index);
	}
	checkShellRoundTrip(report, bridge, context);
	checkJarDiscovery(report, bridge, context);
	await checkRelativeWorkingDirectory(report, bridge, context);
	await checkCoverageFile(report, bridge, context);
	checkCourseReporting(report, bridge);

	const failures = report.failures;
	info('');
	info(`${report.checks.length - failures.length}/${report.checks.length} checks passed`);
	if (failures.length > 0) {
		info('Failed checks:');
		for (const failure of failures) { info(`  - ${failure.name}`); }
		process.exit(1);
	}
	info('Differential acceptance passed: the bridge matches direct `java -jar`.');
}

if (require.main === module) {
	main().catch(error => {
		info(String(error && error.stack ? error.stack : error));
		process.exit(2);
	});
}

module.exports = { main, locateCourseJar, normalise, jvmExitCode };
