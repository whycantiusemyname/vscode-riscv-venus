import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { VenusJarCandidateOptions, venusJarCandidates } from './venusCourseArgs';

export interface VenusJarLocation {
	/** First existing candidate, or undefined when the JAR is missing. */
	jarPath?: string;
	/** Every candidate that was probed, in priority order. */
	probed: string[];
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** First candidate that exists on disk. Pure with respect to ordering; only stats the filesystem. */
export function firstExistingFile(candidates: string[]): string | undefined {
	return candidates.find(isFile);
}

/** Expands a leading `~` so `riscv-venus.course.jarPath` can point into a home directory. */
export function expandHome(p: string): string {
	if (p === '~') { return os.homedir(); }
	if (p.startsWith('~/') || p.startsWith('~' + path.sep)) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Resolves the course JAR from the configured path and the CS61C directory
 * layout. Returns the probed candidates even on failure so the error message
 * can tell the user exactly where the extension looked.
 */
export function locateVenusJar(options: VenusJarCandidateOptions): VenusJarLocation {
	const probed = venusJarCandidates({
		configuredJarPath: options.configuredJarPath ? expandHome(options.configuredJarPath) : undefined,
		programPath: options.programPath,
		workspaceRoots: options.workspaceRoots
	});
	return { jarPath: firstExistingFile(probed), probed };
}

function executableName(): string {
	return process.platform === 'win32' ? 'java.exe' : 'java';
}

/**
 * Resolves the `java` executable: explicit setting first, then `JAVA_HOME`,
 * then `java` from `PATH`.
 */
export function resolveJavaExecutable(configured?: string, javaHome: string | undefined = process.env.JAVA_HOME): string {
	if (configured && configured.trim().length > 0) {
		const expanded = expandHome(configured.trim());
		if (path.isAbsolute(expanded)) { return expanded; }
		return expanded;
	}
	if (javaHome && javaHome.trim().length > 0) {
		return path.join(expandHome(javaHome.trim()), 'bin', executableName());
	}
	return 'java';
}

/** True when the extension can see a usable `java` binary. */
export function javaExecutableExists(javaExecutable: string): boolean {
	if (path.isAbsolute(javaExecutable)) { return isFile(javaExecutable); }
	// A bare command name is resolved by the OS; only a non-empty name is required.
	return javaExecutable.trim().length > 0;
}
