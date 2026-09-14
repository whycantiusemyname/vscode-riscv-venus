import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildVenusJarArgv,
	formatCommandLine,
	invocationForMode,
	planVenusCourseRun,
	quoteShellArg,
	resolveWorkingDirectory,
	selectProjectRoot,
	VENUS_COURSE_MODES,
	venusCourseModeDefinition,
	venusJarCandidates
} from '../../course/venusCourseArgs';
import { firstExistingFile, locateVenusJar, resolveJavaExecutable } from '../../course/venusJarLocator';
import { runVenusCourseProcess } from '../../course/venusCourseProcess';

/**
 * Absolute paths that mean the same thing on Windows and POSIX. The suite used
 * to build Windows-style `C:` paths, which are relative on Linux and made the
 * `path.isAbsolute` branches unreachable there.
 */
const PLATFORM_ROOT = path.parse(path.resolve(__dirname)).root;
function absolute(...parts: string[]): string {
	return path.join(PLATFORM_ROOT, ...parts);
}

const JAR = absolute('course fa24', 'projects', 'proj2-cs61classify', 'tools', 'venus.jar');
const PROGRAM = absolute('project with spaces', 'test-src', 'test_abs_one.s');

function build(overrides: Partial<Parameters<typeof buildVenusJarArgv>[1]> = {}): string[] {
	return buildVenusJarArgv(JAR, { program: PROGRAM, ...overrides }).javaArgs;
}

suite('Venus course JAR bridge', () => {
	test('maps every contributed command to exactly one mode and flag set', () => {
		const commands = VENUS_COURSE_MODES.map(definition => definition.command);
		assert.deepStrictEqual(commands, [
			'riscv-venus.course.run',
			'riscv-venus.course.callingConvention',
			'riscv-venus.course.memcheck',
			'riscv-venus.course.memcheckVerbose'
		]);
		assert.strictEqual(commands.length, new Set(commands).size, 'command ids must be unique');

		assert.deepStrictEqual(venusCourseModeDefinition('run').flags, {});
		assert.deepStrictEqual(venusCourseModeDefinition('callingConvention').flags, { callingConvention: true });
		assert.deepStrictEqual(venusCourseModeDefinition('memcheck').flags, { memcheck: true });
		assert.deepStrictEqual(venusCourseModeDefinition('memcheckVerbose').flags, { memcheckVerbose: true });
	});

	test('builds a plain run argv with the JAR path kept as one argument', () => {
		assert.deepStrictEqual(build(), ['-jar', JAR, PROGRAM]);
	});

	test('emits -cc for the calling convention check', () => {
		assert.deepStrictEqual(build({ callingConvention: true }), ['-jar', JAR, '-cc', PROGRAM]);
	});

	test('emits -mc for memcheck and -mcv (never both) for verbose memcheck', () => {
		assert.deepStrictEqual(build({ memcheck: true }), ['-jar', JAR, '-mc', PROGRAM]);
		assert.deepStrictEqual(build({ memcheckVerbose: true }), ['-jar', JAR, '-mcv', PROGRAM]);
		assert.deepStrictEqual(
			build({ memcheck: true, memcheckVerbose: true }),
			['-jar', JAR, '-mcv', PROGRAM],
			'-mcv implies -mc, so -mc must be dropped'
		);
	});

	test('drops -ahs when memcheck is active, because the JAR rejects the combination', () => {
		assert.ok(!build({ memcheck: true, allowStackHeap: true }).includes('-ahs'));
		assert.ok(build({ allowStackHeap: true }).includes('-ahs'));
		assert.ok(build({ memcheckVerbose: true, allowStackHeap: true }).includes('-mcv'));
	});

	test('passes -ms for the Project 2 default and other values, including negative ones', () => {
		assert.deepStrictEqual(build({ maxSteps: -1 }), ['-jar', JAR, '-ms', '-1', PROGRAM]);
		assert.deepStrictEqual(build({ maxSteps: 1000 }), ['-jar', JAR, '-ms', '1000', PROGRAM]);
		assert.deepStrictEqual(build(), ['-jar', JAR, PROGRAM], 'no maxSteps means no -ms flag');
	});

	test('emits --coverageFile with the path kept as one argument', () => {
		const coverageFile = absolute('test-src', 'coverage output.txt');
		assert.deepStrictEqual(
			build({ coverageFile }),
			['-jar', JAR, '--coverageFile', coverageFile, PROGRAM]
		);
		assert.ok(!build().includes('--coverageFile'), 'no coverageFile means no flag');
	});

	test('emits one --def whose value joins the entries with ; without splitting key=value', () => {
		assert.deepStrictEqual(
			build({ defines: ['#MALLOC_RETURN_HOOK=li a0 0', 'PRINT_ME=li a1 7'] }),
			['-jar', JAR, '--def', '#MALLOC_RETURN_HOOK=li a0 0;PRINT_ME=li a1 7', PROGRAM],
			'the JAR takes a single --def with ;-separated entries; repeating the flag drops the first list'
		);
		assert.deepStrictEqual(
			build({ defines: ['', 'ONLY=li a1 7', ''] }),
			['-jar', JAR, '--def', 'ONLY=li a1 7', PROGRAM],
			'empty entries are dropped instead of producing empty ; segments'
		);
		assert.deepStrictEqual(build({ defines: [] }), ['-jar', JAR, PROGRAM], 'no defines means no flag');
		assert.deepStrictEqual(build({ defines: [''] }), ['-jar', JAR, PROGRAM], 'empty entries are dropped');
	});

	test('passes program arguments positionally after the file, without a -- separator', () => {
		assert.deepStrictEqual(
			build({ programArgs: ['alpha', 'beta gamma', '-it'] }),
			['-jar', JAR, PROGRAM, 'alpha', 'beta gamma', '-it']
		);
	});

	test('never passes -wd: the JAR rejects absolute host working directories', () => {
		// The working directory is the child process cwd (framework.py:47); the
		// JAR's own -wd rejected the absolute path during differential acceptance.
		const javaArgs = build({ workingDirectory: absolute('projects', 'my project') });
		assert.deepStrictEqual(javaArgs, ['-jar', JAR, PROGRAM]);
	});

	test('places Venus flags before the file and the file before program args', () => {
		const javaArgs = build({
			callingConvention: true,
			memcheckVerbose: true,
			immutableText: true,
			ecallOnlyExit: true,
			maxSteps: 5,
			coverageFile: absolute('coverage with spaces.txt'),
			defines: ['#MALLOC_RETURN_HOOK=li a0 0'],
			workingDirectory: absolute('wd with spaces'),
			programArgs: ['one']
		});
		assert.deepStrictEqual(javaArgs, [
			'-jar', JAR,
			'-cc', '-mcv', '-it', '-eoe', '-ms', '5',
			'--coverageFile', absolute('coverage with spaces.txt'),
			'--def', '#MALLOC_RETURN_HOOK=li a0 0',
			PROGRAM,
			'one'
		]);
	});

	test('defaults the working directory to the folder holding the .s file', () => {
		assert.strictEqual(resolveWorkingDirectory(undefined, PROGRAM), path.dirname(path.resolve(PROGRAM)));
		assert.strictEqual(resolveWorkingDirectory('', PROGRAM), path.dirname(path.resolve(PROGRAM)));
		const explicit = absolute('explicit', 'working directory');
		assert.strictEqual(resolveWorkingDirectory(explicit, PROGRAM), explicit);
		assert.strictEqual(
			resolveWorkingDirectory('test-src', PROGRAM, absolute('project root')),
			absolute('project root', 'test-src')
		);
	});

	test('quotes paths containing spaces for a shell round trip', () => {
		const windows = quoteShellArg('C:\\project with spaces\\test.s', 'win32');
		assert.strictEqual(windows, '"C:\\project with spaces\\test.s"');
		assert.strictEqual(quoteShellArg('C:\\plain\\test.s', 'win32'), 'C:\\plain\\test.s');

		const posix = quoteShellArg('/home/me/project with spaces/test.s', 'linux');
		assert.strictEqual(posix, "'/home/me/project with spaces/test.s'");
		assert.strictEqual(quoteShellArg('/home/me/plain/test.s', 'linux'), '/home/me/plain/test.s');
	});

	test('quotes embedded quotes without breaking the command line', () => {
		assert.strictEqual(quoteShellArg('say "hi"', 'win32'), '"say ""hi"""');
		assert.strictEqual(quoteShellArg("it's here", 'linux'), `'it'\\''s here'`);
		assert.strictEqual(quoteShellArg('plain', 'linux'), 'plain');
	});

	test('renders a displayable command line that keeps spaced paths intact', () => {
		const plan = planVenusCourseRun(JAR, { program: PROGRAM, callingConvention: true }, 'java');
		assert.deepStrictEqual(plan.argv, ['java', ...plan.javaArgs]);
		assert.ok(plan.commandLine.startsWith('java -jar '));
		assert.ok(plan.commandLine.endsWith(quoteShellArg(PROGRAM)));
	});

	test('selects the deepest workspace folder that contains the program', () => {
		const project2 = absolute('CS61C', 'course-fa24', 'projects', 'proj2-cs61classify');
		const workspaceRoot = absolute('CS61C');
		const program = path.join(project2, 'test-src', 'test_abs_one.s');

		assert.strictEqual(selectProjectRoot(program, [workspaceRoot, project2]), project2);
		assert.strictEqual(selectProjectRoot(program, [workspaceRoot]), workspaceRoot);
		assert.strictEqual(selectProjectRoot(program, []), path.dirname(path.resolve(program)));
		assert.strictEqual(selectProjectRoot(undefined, [workspaceRoot]), workspaceRoot);
	});
});

suite('Venus course JAR discovery', () => {
	test('prefers a configured JAR over the discovered layouts', () => {
		const configured = absolute('custom', 'venus.jar');
		const candidates = venusJarCandidates({
			configuredJarPath: configured,
			programPath: PROGRAM,
			workspaceRoots: [absolute('CS61C')]
		});
		assert.strictEqual(candidates[0], path.resolve(configured));
	});

	test('resolves a relative configured JAR against each workspace root', () => {
		const root = absolute('CS61C');
		const candidates = venusJarCandidates({
			configuredJarPath: 'course-fa24/projects/proj2-cs61classify/tools/venus.jar',
			programPath: PROGRAM,
			workspaceRoots: [root]
		});
		assert.ok(candidates.includes(path.resolve(root, 'course-fa24/projects/proj2-cs61classify/tools/venus.jar')));
	});

	test('finds the Project 2 tools/venus.jar layout from a workspace root', () => {
		const root = absolute('CS61C');
		const candidates = venusJarCandidates({ programPath: PROGRAM, workspaceRoots: [root] });
		assert.ok(candidates.includes(path.join(root, 'tools', 'venus.jar')));
		assert.ok(candidates.includes(path.join(root, 'course-fa24', 'projects', 'proj2-cs61classify', 'tools', 'venus.jar')));
		assert.ok(candidates.includes(path.join(root, 'projects', 'proj2-cs61classify', 'tools', 'venus.jar')));
		assert.strictEqual(candidates.length, new Set(candidates).size, 'candidates must be de-duplicated');
	});

	test('walks up from the assembly file when it is outside the workspaces', () => {
		const root = absolute('checkout');
		const program = path.join(root, 'test-src', 'test_abs_one.s');
		const candidates = venusJarCandidates({ programPath: program, workspaceRoots: [] });
		assert.ok(candidates.includes(path.join(root, 'tools', 'venus.jar')));
	});

	test('locates a JAR that exists on disk and reports the probed paths', () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-course-'));
		try {
			const toolsDir = path.join(tempRoot, 'course-fa24', 'projects', 'proj2-cs61classify', 'tools');
			const jar = path.join(toolsDir, 'venus.jar');
			fs.mkdirSync(toolsDir, { recursive: true });
			fs.writeFileSync(jar, 'not a real jar');
			const program = path.join(tempRoot, 'project with spaces', 'test-src', 'test.s');

			const location = locateVenusJar({ programPath: program, workspaceRoots: [tempRoot] });
			assert.strictEqual(location.jarPath, jar);
			assert.ok(location.probed.includes(jar));
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('returns no JAR but still reports candidates when nothing exists', () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-course-empty-'));
		try {
			const location = locateVenusJar({
				programPath: path.join(tempRoot, 'test.s'),
				workspaceRoots: [tempRoot]
			});
			assert.strictEqual(location.jarPath, undefined);
			assert.ok(location.probed.length > 0);
			assert.strictEqual(firstExistingFile(location.probed), undefined);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('prefers an explicit java path, then JAVA_HOME, then java from PATH', () => {
		assert.strictEqual(resolveJavaExecutable('/opt/jdk/bin/java', '/other/jdk'), '/opt/jdk/bin/java');
		const javaHome = absolute('jdk');
		const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
		assert.strictEqual(
			resolveJavaExecutable('', javaHome),
			path.join(javaHome, 'bin', executableName)
		);
		// The JAVA_HOME default parameter is only consulted when `javaHome` is
		// `undefined`, and CI runners set JAVA_HOME through setup-java, so both
		// states are exercised explicitly instead of assuming it is unset.
		const previousJavaHome = process.env.JAVA_HOME;
		try {
			process.env.JAVA_HOME = javaHome;
			assert.strictEqual(resolveJavaExecutable(undefined), path.join(javaHome, 'bin', executableName));
		} finally {
			if (previousJavaHome === undefined) { delete process.env.JAVA_HOME; }
			else { process.env.JAVA_HOME = previousJavaHome; }
		}
		// PATH fallback: an explicit empty javaHome keeps JAVA_HOME out of the way.
		assert.strictEqual(resolveJavaExecutable(undefined, ''), 'java');
		assert.strictEqual(resolveJavaExecutable('', ''), 'java');
	});
});

suite('Venus course process runner', () => {
	// The extension host runs inside Electron, so `process.execPath` only
	// behaves like node when ELECTRON_RUN_AS_NODE is set.
	const nodeEnv: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

	test('preserves the exit code and the combined output of the child process', async () => {
		const result = await runVenusCourseProcess(
			process.execPath,
			['-e', 'process.stdout.write("out line\\n"); process.stderr.write("err line\\n"); process.exit(7);'],
			{ env: nodeEnv }
		);
		assert.strictEqual(result.exitCode, 7);
		assert.ok(result.output.includes('out line'));
		assert.ok(result.output.includes('err line'));
	});

	test('streams output chunks to the caller as they arrive', async () => {
		let streamed = '';
		const result = await runVenusCourseProcess(
			process.execPath,
			['-e', 'process.stdout.write("streamed");'],
			{ env: nodeEnv, onOutput: chunk => { streamed += chunk; } }
		);
		assert.strictEqual(result.exitCode, 0);
		assert.strictEqual(streamed, 'streamed');
	});

	test('runs in a working directory that contains spaces', async () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'venus course wd '));
		try {
			const result = await runVenusCourseProcess(
				process.execPath,
				['-e', 'process.stdout.write(process.cwd())'],
				{ cwd: tempRoot, env: nodeEnv }
			);
			assert.strictEqual(result.exitCode, 0);
			assert.strictEqual(fs.realpathSync(result.output.trim()), fs.realpathSync(tempRoot));
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('rejects when the executable cannot be started', async () => {
		await assert.rejects(
			runVenusCourseProcess(path.join(os.tmpdir(), 'definitely-not-a-real-executable-12345'), [])
		);
	});
});
