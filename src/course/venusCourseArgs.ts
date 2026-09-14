import * as path from 'path';

/**
 * Flags of the course `venus.jar` for the checks CS61C labs, Project 2 and
 * Project 3 ask students to run.
 *
 * Short/long forms were verified against the pinned course JAR
 * (`course-fa24/projects/proj2-cs61classify/tools/venus.jar --help`):
 *
 *   -cc,  --callingConvention  Runs the calling convention checker.
 *   -mc,  --memcheck           Memory checks for unallocated stack/heap memory.
 *   -mcv, --memcheckVerbose    Verbose version of --memcheck.
 *   -ms,  --maxsteps           Max number of steps to allow (negative = no limit).
 *   -wd,  --workingDirectory   Change the working directory of Venus.
 *   -it,  --immutableText      Error when the text segment is modified.
 *   -eoe, --ecallOnlyExit      Exit only on an ecall.
 *   -ahs, --AllowHSAccess      Allow load/store between stack and heap (incompatible with -mc/-mcv).
 *
 * Positional arguments are `file` followed by `simulatorArgs`, i.e. the
 * arguments handed to the simulated program. Venus takes everything after the
 * file name as simulatorArgs, so no `--` separator is inserted (verified
 * against the course JAR and `framework.py`).
 */
export interface VenusCourseFlags {
	callingConvention?: boolean;
	memcheck?: boolean;
	memcheckVerbose?: boolean;
	immutableText?: boolean;
	allowStackHeap?: boolean;
	ecallOnlyExit?: boolean;
	maxSteps?: number;
}

export interface VenusCourseInvocation extends VenusCourseFlags {
	/** Absolute path of the `.s` file to assemble and simulate. */
	program: string;
	/**
	 * Working directory of the JVM process. Forwarded to Venus through `-wd`
	 * when `passWorkingDirectoryFlag` is set.
	 */
	workingDirectory?: string;
	/** Emit `-wd <workingDirectory>` in addition to setting the process cwd. */
	passWorkingDirectoryFlag?: boolean;
	/** Arguments handed to the simulated program (`a0`/`a1` = argc/argv). */
	programArgs?: string[];
}

export interface VenusJarCandidateOptions {
	/** `riscv-venus.course.jarPath`, absolute or relative to a workspace root. */
	configuredJarPath?: string;
	/** Absolute path of the active/selected `.s` file. */
	programPath?: string;
	/** Workspace folder paths, most specific first. */
	workspaceRoots?: string[];
}

export interface VenusCourseRunPlan {
	/** Argument vector passed to the `java` executable. */
	javaArgs: string[];
	/** Fully resolved argv, executable first. */
	argv: string[];
	/** Command line for display or for a shell/terminal. */
	commandLine: string;
}

export type VenusCourseMode = 'run' | 'callingConvention' | 'memcheck' | 'memcheckVerbose';

export interface VenusCourseModeDefinition {
	/** Command id contributed in package.json. */
	command: string;
	mode: VenusCourseMode;
	/** Flags this command adds on top of the shared invocation options. */
	flags: VenusCourseFlags;
	/** Human readable label used in output and notifications. */
	label: string;
}

const WINDOWS_UNSAFE = /["%!^&|<>()\s]/;
const POSIX_UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

/**
 * The four course checks the extension bridges to the authoritative JAR. Each
 * entry maps to exactly one command contributed in package.json.
 */
export const VENUS_COURSE_MODES: VenusCourseModeDefinition[] = [
	{
		command: 'riscv-venus.course.run',
		mode: 'run',
		flags: {},
		label: 'Venus Run'
	},
	{
		command: 'riscv-venus.course.callingConvention',
		mode: 'callingConvention',
		flags: { callingConvention: true },
		label: 'Venus Calling Convention Check (-cc)'
	},
	{
		command: 'riscv-venus.course.memcheck',
		mode: 'memcheck',
		flags: { memcheck: true },
		label: 'Venus Memcheck (-mc)'
	},
	{
		command: 'riscv-venus.course.memcheckVerbose',
		mode: 'memcheckVerbose',
		flags: { memcheckVerbose: true },
		label: 'Venus Verbose Memcheck (-mcv)'
	}
];

export function venusCourseModeDefinition(mode: VenusCourseMode): VenusCourseModeDefinition {
	const definition = VENUS_COURSE_MODES.find(candidate => candidate.mode === mode);
	if (!definition) { throw new Error(`Unknown Venus course mode: ${mode}`); }
	return definition;
}

/** Merges a mode's flags onto the user-provided invocation options. */
export function invocationForMode(
	mode: VenusCourseMode,
	base: Omit<VenusCourseInvocation, 'program'> & { program: string }
): VenusCourseInvocation {
	return { ...base, ...venusCourseModeDefinition(mode).flags };
}

/**
 * Quotes a single argv entry so it survives a shell round trip.
 *
 * The extension runs `java` through `child_process.spawn` with an argv array,
 * so no quoting is needed on that path. This helper exists for the places that
 * hand a command line to a shell (task/terminal output), where a working
 * directory such as `project with spaces` would otherwise be split.
 */
export function quoteShellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === 'win32') {
		if (!WINDOWS_UNSAFE.test(arg)) { return arg; }
		// cmd.exe escapes an embedded double quote by doubling it.
		return `"${arg.replace(/"/g, '""')}"`;
	}
	if (!POSIX_UNSAFE.test(arg)) { return arg; }
	// POSIX single quotes cannot contain a single quote; leave and re-enter.
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Renders an executable plus argv as one shell-safe command line. */
export function formatCommandLine(
	executable: string,
	args: string[],
	platform: NodeJS.Platform = process.platform
): string {
	return [executable, ...args].map(part => quoteShellArg(part, platform)).join(' ');
}

/**
 * Builds argv for `java`, i.e. everything after the `java` executable.
 *
 * Ordering follows the JAR's argument parser: Venus flags come before the file
 * name, and the simulated program's arguments follow the file name as
 * `simulatorArgs`.
 */
export function buildVenusJarArgv(
	jarPath: string,
	invocation: VenusCourseInvocation,
	javaExecutable = 'java'
): { javaArgs: string[]; argv: string[] } {
	const javaArgs = ['-jar', jarPath];
	const memcheck = Boolean(invocation.memcheck || invocation.memcheckVerbose);

	if (invocation.callingConvention) { javaArgs.push('-cc'); }
	// -mcv implies -mc, so emitting both would be redundant. -mc/-mcv are
	// incompatible with -ahs, so memcheck wins over the stack/heap escape hatch.
	if (invocation.memcheckVerbose) {
		javaArgs.push('-mcv');
	} else if (invocation.memcheck) {
		javaArgs.push('-mc');
	}
	if (invocation.immutableText) { javaArgs.push('-it'); }
	if (invocation.ecallOnlyExit) { javaArgs.push('-eoe'); }
	if (invocation.allowStackHeap && !memcheck) { javaArgs.push('-ahs'); }

	// A negative value is meaningful (`-1` disables the limit) and is what the
	// Project 2 framework passes, so only a non-numeric value omits the flag.
	if (typeof invocation.maxSteps === 'number' && Number.isFinite(invocation.maxSteps)) {
		javaArgs.push('-ms', String(invocation.maxSteps));
	}

	if (invocation.workingDirectory && invocation.passWorkingDirectoryFlag) {
		javaArgs.push('-wd', invocation.workingDirectory);
	}

	javaArgs.push(invocation.program);

	javaArgs.push(...(invocation.programArgs || []));

	return { javaArgs, argv: [javaExecutable, ...javaArgs] };
}

/** Builds everything needed to display and execute one course check. */
export function planVenusCourseRun(
	jarPath: string,
	invocation: VenusCourseInvocation,
	javaExecutable = 'java',
	platform: NodeJS.Platform = process.platform
): VenusCourseRunPlan {
	const { javaArgs, argv } = buildVenusJarArgv(jarPath, invocation, javaExecutable);
	return { javaArgs, argv, commandLine: formatCommandLine(javaExecutable, javaArgs, platform) };
}

function normaliseForCompare(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(normaliseForCompare(parent), normaliseForCompare(child));
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Picks the workspace/project root for a program: the deepest workspace folder
 * containing the `.s` file, otherwise the first workspace folder, otherwise the
 * directory holding the file.
 *
 * A multi-root window that has both `CS61C` and
 * `CS61C/course-fa24/projects/proj2-cs61classify` open must resolve Project 2
 * relative paths against the Project 2 folder, not against `CS61C`.
 */
export function selectProjectRoot(
	programPath: string | undefined,
	workspaceRoots: string[] = []
): string | undefined {
	const roots = workspaceRoots.filter(root => Boolean(root));
	if (roots.length === 0) { return programPath ? path.dirname(path.resolve(programPath)) : undefined; }
	if (!programPath) { return roots[0]; }

	const containing = roots
		.filter(root => isInside(root, programPath))
		.sort((a, b) => b.length - a.length);
	return containing.length > 0 ? containing[0] : roots[0];
}

/** The directory Venus runs in when no explicit working directory is configured. */
export function resolveWorkingDirectory(
	explicitWorkingDirectory: string | undefined,
	programPath: string
): string {
	if (explicitWorkingDirectory && explicitWorkingDirectory.length > 0) { return explicitWorkingDirectory; }
	return path.dirname(path.resolve(programPath));
}

/**
 * Ordered, de-duplicated list of places the course JAR may live.
 *
 * The CS61C tree keeps the authoritative JAR at `<project>/tools/venus.jar`
 * (`course-fa24/projects/proj2-cs61classify/tools/venus.jar`), so the
 * workspace-relative Project 2 layout and the directories above the assembly
 * file are both searched.
 */
export function venusJarCandidates(options: VenusJarCandidateOptions): string[] {
	const roots = (options.workspaceRoots || []).filter(root => Boolean(root));
	const candidates: string[] = [];

	const add = (candidate: string | undefined) => {
		if (!candidate) { return; }
		if (!candidates.includes(candidate)) { candidates.push(candidate); }
	};

	const configuredJarPath = options.configuredJarPath;
	if (configuredJarPath && configuredJarPath.length > 0) {
		if (path.isAbsolute(configuredJarPath) || roots.length === 0) {
			add(path.resolve(configuredJarPath));
		} else {
			roots.forEach(root => add(path.resolve(root, configuredJarPath)));
		}
	}

	const projectRoot = selectProjectRoot(options.programPath, roots);
	const searchRoots = [projectRoot, ...roots].filter((root): root is string => Boolean(root));

	for (const root of searchRoots) {
		add(path.join(root, 'tools', 'venus.jar'));
		add(path.join(root, 'course-fa24', 'projects', 'proj2-cs61classify', 'tools', 'venus.jar'));
		add(path.join(root, 'projects', 'proj2-cs61classify', 'tools', 'venus.jar'));
	}

	if (options.programPath) {
		// Walk upwards from the assembly file so a Project 2 checkout that is not
		// an open workspace folder still finds its own tools/venus.jar.
		let current = path.dirname(path.resolve(options.programPath));
		let previous = '';
		while (current && current !== previous) {
			add(path.join(current, 'tools', 'venus.jar'));
			previous = current;
			current = path.dirname(current);
		}
	}

	return candidates;
}
