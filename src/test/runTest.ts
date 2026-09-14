import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

/**
 * CS61C Project 2 acceptance matrix.
 *
 * The driver under test is `test-src/test_abs_one.s`, which pulls in
 * `src/abs.s` through `.import ../src/abs.s`. The suite asserts that a source
 * breakpoint inside that imported file is verified and hit.
 *
 * Two deterministic scenarios run on every invocation:
 *
 *   1. `project-root` - the Project 2 root is opened directly.
 *   2. `spaced-copy`  - the same Project 2 tree is copied to a temporary
 *      directory whose full path contains spaces and is opened from there,
 *      which catches accidental URL-encoding or drive-letter assumptions.
 *
 * A third, opt-in scenario (`course-project2`) runs when `CS61C_PROJ2_ROOT`
 * points at a checkout of `course-fa24/projects/proj2-cs61classify`. That
 * directory is opened read-only; the assignment sources are never copied over
 * or modified.
 */

interface Scenario {
	/** Name used in test output and for the scenario's private VS Code state. */
	label: string;
	/** Absolute path of the folder that has to end up as the workspace root. */
	workspace: string;
	/** Project 2 driver, relative to the workspace root, with forward slashes. */
	program: string;
	/** The `.import` target exactly as written in the driver. */
	importDirective: string;
	/** Imported source, relative to the workspace root, with forward slashes. */
	imported: string;
	/** Label whose first instruction receives the source breakpoint. */
	entrySymbol: string;
	/** Line of that instruction, derived from the imported file. */
	importLine: number;
	/** Absolute path of an endless program used for the pause check. */
	pauseProgram: string;
}

const PROJECT_ROOT = path.resolve(__dirname, '../../src/test/fixtures/project with spaces');
const DRIVER = 'test-src/test_abs_one.s';
const IMPORT_DIRECTIVE = '../src/abs.s';
const IMPORTED = 'src/abs.s';
const ENTRY_SYMBOL = 'abs';
const PAUSE_PROGRAM = 'loop.s';

const ENDLESS_LOOP = [
	'.text',
	'.globl main',
	'main:',
	'    addi t0, t0, 1',
	'    j main',
	''
].join('\n');

function copyTree(source: string, target: string): void {
	fs.mkdirSync(target, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) {
			copyTree(from, to);
		} else {
			fs.copyFileSync(from, to);
		}
	}
}

/**
 * Returns the 1-based line of the first instruction after `label:`, which is
 * what a user would click when they set a breakpoint at the start of a routine.
 * Comments, directives and nested labels are skipped.
 */
function firstInstructionLine(file: string, label: string): number | undefined {
	const labelPattern = new RegExp('^\\s*' + label + '\\s*:');
	const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		if (!labelPattern.test(lines[index])) {
			continue;
		}
		for (let candidate = index + 1; candidate < lines.length; candidate++) {
			const line = lines[candidate].trim();
			if (line.length === 0 || line.startsWith('#') || line.startsWith('//') || line.startsWith('.')) {
				continue;
			}
			if (/^[A-Za-z_.$][\w.$]*\s*:/.test(line)) {
				continue;
			}
			return candidate + 1;
		}
	}
	return undefined;
}

function scenario(label: string, workspace: string, pauseProgram: string): Scenario {
	const importedFile = path.join(workspace, ...IMPORTED.split('/'));
	const importLine = firstInstructionLine(importedFile, ENTRY_SYMBOL);
	if (!importLine) {
		throw new Error(`could not find the first instruction of "${ENTRY_SYMBOL}" in ${importedFile}`);
	}
	return {
		label,
		workspace: path.resolve(workspace),
		program: DRIVER,
		importDirective: IMPORT_DIRECTIVE,
		imported: IMPORTED,
		entrySymbol: ENTRY_SYMBOL,
		importLine,
		pauseProgram: path.resolve(pauseProgram)
	};
}

function buildScenarios(acceptanceRoot: string): Scenario[] {
	const scenarios = [
		scenario('project-root', PROJECT_ROOT, path.join(PROJECT_ROOT, PAUSE_PROGRAM))
	];

	const copy = path.join(acceptanceRoot, 'Project 2 copy with spaces');
	copyTree(PROJECT_ROOT, copy);
	scenarios.push(scenario('spaced-copy', copy, path.join(copy, PAUSE_PROGRAM)));

	const courseProject = process.env.CS61C_PROJ2_ROOT;
	if (courseProject && fs.existsSync(path.join(courseProject, DRIVER))) {
		const pauseProgram = path.join(acceptanceRoot, 'pause loop.s');
		fs.writeFileSync(pauseProgram, ENDLESS_LOOP);
		scenarios.push(scenario('course-project2', courseProject, pauseProgram));
	}

	return scenarios;
}

function environmentFor(target: Scenario): { [key: string]: string } {
	return {
		CS61C_ACCEPTANCE_SCENARIO: target.label,
		CS61C_ACCEPTANCE_WORKSPACE: target.workspace,
		CS61C_ACCEPTANCE_PROGRAM: target.program,
		CS61C_ACCEPTANCE_IMPORT_DIRECTIVE: target.importDirective,
		CS61C_ACCEPTANCE_IMPORTED: target.imported,
		CS61C_ACCEPTANCE_ENTRY_SYMBOL: target.entrySymbol,
		CS61C_ACCEPTANCE_IMPORT_LINE: String(target.importLine),
		CS61C_ACCEPTANCE_PAUSE_PROGRAM: target.pauseProgram
	};
}

async function main() {
	const extensionDevelopmentPath = path.resolve(__dirname, '../../');
	const extensionTestsPath = path.resolve(__dirname, './suite/index');

	// Every scenario gets untouched user data and an empty extensions directory,
	// so an already running VS Code or an installed copy of this extension can
	// never influence the result.
	const acceptanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs61c venus acceptance '));
	console.log(`[acceptance] artifacts: ${acceptanceRoot}`);

	const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
	const scenarios = buildScenarios(acceptanceRoot);

	for (const target of scenarios) {
		console.log(`[acceptance] scenario "${target.label}": opening ${target.workspace}`);
		const stateRoot = path.join(acceptanceRoot, target.label);
		try {
			await runTests({
				extensionDevelopmentPath,
				extensionTestsPath,
				...(vscodeExecutablePath
					? { vscodeExecutablePath }
					: { version: process.env.VSCODE_VERSION || 'stable' }),
				launchArgs: [
					target.workspace,
					`--user-data-dir=${path.join(stateRoot, 'user data')}`,
					`--extensions-dir=${path.join(stateRoot, 'extensions')}`,
					'--disable-workspace-trust',
					'--skip-welcome',
					'--skip-release-notes'
				],
				extensionTestsEnv: environmentFor(target)
			});
		} catch (err) {
			throw new Error(`scenario "${target.label}" failed: ${err}`);
		}
		console.log(`[acceptance] scenario "${target.label}" passed`);
	}

	console.log(`[acceptance] ${scenarios.length} scenario(s) passed`);
}

main().catch(err => {
	console.error('Failed to run tests');
	console.error(err);
	process.exit(1);
});
