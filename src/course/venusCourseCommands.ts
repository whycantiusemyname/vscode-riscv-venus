import * as path from 'path';
import * as vscode from 'vscode';

import {
	VenusCourseInvocation,
	VenusCourseMode,
	planVenusCourseRun,
	resolveWorkingDirectory,
	selectProjectRoot,
	VENUS_COURSE_MODES,
	venusCourseModeDefinition
} from './venusCourseArgs';
import { javaExecutableExists, locateVenusJar, resolveJavaExecutable } from './venusJarLocator';
import { runVenusCourseProcess, VenusCourseProcessResult } from './venusCourseProcess';
import { summariseVenusCourseResult } from './venusCourseReport';

export const VENUS_COURSE_CONFIG_SECTION = 'riscv-venus.course';
export const VENUS_COURSE_OUTPUT_CHANNEL = 'Venus Course Checks';

export interface VenusCourseSettings {
	jarPath?: string;
	javaPath?: string;
	workingDirectory?: string;
	programArgs?: string[];
	coverageFile?: string;
	defines?: string[];
	maxSteps?: number;
	immutableText?: boolean;
	ecallOnlyExit?: boolean;
	allowStackHeap?: boolean;
}

export function readVenusCourseSettings(): VenusCourseSettings {
	const configuration = vscode.workspace.getConfiguration(VENUS_COURSE_CONFIG_SECTION);
	return {
		jarPath: configuration.get<string>('jarPath'),
		javaPath: configuration.get<string>('javaPath'),
		workingDirectory: configuration.get<string>('workingDirectory'),
		programArgs: configuration.get<string[]>('programArgs') || [],
		coverageFile: configuration.get<string>('coverageFile'),
		defines: configuration.get<string[]>('defines') || [],
		// Defaults mirror the Project 2 framework: --immutableText and
		// --maxsteps -1 (no upper bound on the number of steps).
		maxSteps: configuration.get<number>('maxSteps') ?? -1,
		immutableText: configuration.get<boolean>('immutableText') ?? true,
		ecallOnlyExit: configuration.get<boolean>('ecallOnlyExit'),
		allowStackHeap: configuration.get<boolean>('allowStackHeap')
	};
}

export function workspaceRootPaths(): string[] {
	return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}

function isAssemblyDocument(document: vscode.TextDocument): boolean {
	if (document.isUntitled || document.uri.scheme !== 'file') { return false; }
	if (document.languageId === 'riscv') { return true; }
	return /\.s$/i.test(document.uri.fsPath);
}

/**
 * Resolves the `.s` file to run. The active editor wins so "run the current
 * file" works without any prompt; otherwise the user picks from the workspace.
 */
export async function resolveCourseProgramPath(): Promise<string | undefined> {
	const active = vscode.window.activeTextEditor;
	if (active && isAssemblyDocument(active.document)) {
		return active.document.uri.fsPath;
	}

	const found = await vscode.workspace.findFiles('**/*.s', '**/node_modules/**', 50);
	if (found.length === 0) { return undefined; }
	if (found.length === 1) { return found[0].fsPath; }

	const picked = await vscode.window.showQuickPick(
		found.map(uri => ({ label: vscode.workspace.asRelativePath(uri), detail: uri.fsPath, uri })),
		{ placeHolder: 'Select the RISC-V assembly file to run with the course venus.jar' }
	);
	return picked ? picked.uri.fsPath : undefined;
}

function buildInvocation(
	programPath: string,
	mode: VenusCourseMode,
	settings: VenusCourseSettings
): VenusCourseInvocation {
	const explicitWorkingDirectory = settings.workingDirectory && settings.workingDirectory.length > 0
		? resolveWorkingDirectory(
			settings.workingDirectory,
			programPath,
			selectProjectRoot(programPath, workspaceRootPaths())
		)
		: undefined;

	// The JAR resolves --coverageFile against the directory it runs in, so a
	// relative setting is resolved the same way the child process cwd is.
	const coverageFile = settings.coverageFile && settings.coverageFile.length > 0
		? path.resolve(resolveWorkingDirectory(explicitWorkingDirectory, programPath), settings.coverageFile)
		: undefined;

	return {
		program: programPath,
		callingConvention: false,
		memcheck: false,
		memcheckVerbose: false,
		immutableText: settings.immutableText === true,
		allowStackHeap: settings.allowStackHeap === true,
		ecallOnlyExit: settings.ecallOnlyExit === true,
		maxSteps: settings.maxSteps,
		programArgs: settings.programArgs || [],
		coverageFile,
		defines: settings.defines || [],
		workingDirectory: explicitWorkingDirectory,
		passWorkingDirectoryFlag: Boolean(explicitWorkingDirectory),
		...venusCourseModeDefinition(mode).flags
	};
}

function missingJarMessage(probed: string[]): string {
	const looked = probed.slice(0, 6).map(candidate => `  ${candidate}`).join('\n');
	return [
		'Could not find the CS61C course venus.jar.',
		'Set "riscv-venus.course.jarPath" to the JAR (for example course-fa24/projects/proj2-cs61classify/tools/venus.jar).',
		'Checked:',
		looked
	].join('\n');
}

export async function runVenusCourseCheck(
	mode: VenusCourseMode,
	output: vscode.OutputChannel
): Promise<void> {
	const settings = readVenusCourseSettings();
	const programPath = await resolveCourseProgramPath();
	if (!programPath) {
		vscode.window.showErrorMessage('Venus: no .s file is active and none was found in the workspace.');
		return;
	}

	const location = locateVenusJar({
		configuredJarPath: settings.jarPath,
		programPath,
		workspaceRoots: workspaceRootPaths()
	});
	if (!location.jarPath) {
		vscode.window.showErrorMessage(missingJarMessage(location.probed));
		return;
	}

	const javaExecutable = resolveJavaExecutable(settings.javaPath);
	if (!javaExecutableExists(javaExecutable)) {
		vscode.window.showErrorMessage(
			`Venus: java executable not found (${javaExecutable}). Set "riscv-venus.course.javaPath" or JAVA_HOME.`
		);
		return;
	}

	const invocation = buildInvocation(programPath, mode, settings);
	const plan = planVenusCourseRun(location.jarPath, invocation, javaExecutable);
	const definition = venusCourseModeDefinition(mode);
	const cwd = resolveWorkingDirectory(invocation.workingDirectory, programPath);

	output.show(true);
	output.appendLine('');
	output.appendLine(`> ${plan.commandLine}`);
	output.appendLine(`[cwd] ${cwd}`);

	let result: VenusCourseProcessResult;
	try {
		result = await runVenusCourseProcess(javaExecutable, plan.javaArgs, {
			cwd,
			onOutput: chunk => output.append(chunk)
		});
	} catch (error) {
		output.appendLine(`[failed to start] ${String(error)}`);
		vscode.window.showErrorMessage(`Venus: could not start ${javaExecutable}: ${String(error)}`);
		return;
	}

	const summary = summariseVenusCourseResult(mode, result.exitCode, result.output);
	const exitCode = result.exitCode;
	output.appendLine(`[exit code ${exitCode === undefined ? 'unknown' : exitCode}]`);
	output.appendLine(`[${summary.message}]`);

	if (summary.ok) {
		vscode.window.showInformationMessage(`${definition.label}: ${summary.message}`);
	} else {
		const choice = await vscode.window.showWarningMessage(
			`${definition.label}: ${summary.message}`,
			'Show Output'
		);
		if (choice === 'Show Output') { output.show(true); }
	}
}

/** Registers the four course check commands contributed in package.json. */
export function registerVenusCourseCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
	const output = vscode.window.createOutputChannel(VENUS_COURSE_OUTPUT_CHANNEL);
	context.subscriptions.push(output);

	const disposables = VENUS_COURSE_MODES.map(definition =>
		vscode.commands.registerCommand(definition.command, () => runVenusCourseCheck(definition.mode, output))
	);
	disposables.forEach(disposable => context.subscriptions.push(disposable));
	return disposables;
}
