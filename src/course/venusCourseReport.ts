import { VenusCourseMode } from './venusCourseArgs';

export interface VenusCourseSummary {
	/** True when the check found nothing to report. */
	ok: boolean;
	/** Number of memcheck violations found in the JAR's output. */
	violations: number;
	/** One-line summary suitable for a notification or the output channel. */
	message: string;
}

const MEMCHECK_VIOLATION = /\[memcheck\] Invalid memory access/g;

/**
 * Counts the diagnostics the course JAR prints for memcheck violations.
 *
 * The pinned JAR reports violations but keeps simulating and exits with the
 * program's own code, so a zero exit code alone does not mean `-mc`/`-mcv`
 * passed.
 */
export function countMemcheckViolations(output: string): number {
	const matches = output.match(MEMCHECK_VIOLATION);
	return matches ? matches.length : 0;
}

function isMemcheckMode(mode: VenusCourseMode): boolean {
	return mode === 'memcheck' || mode === 'memcheckVerbose';
}

/**
 * Turns a finished course check into the summary the extension reports.
 *
 * `exitCode` is the JAR's own status: calling-convention violations and
 * simulator errors exit non-zero, so a missing or non-zero code always fails.
 * A zero exit code still needs the output inspected, because memcheck
 * violations are printed without changing the exit code.
 */
export function summariseVenusCourseResult(
	mode: VenusCourseMode,
	exitCode: number | undefined,
	output: string
): VenusCourseSummary {
	const violations = countMemcheckViolations(output);

	if (exitCode !== 0) {
		const status = exitCode === undefined
			? 'did not report an exit code'
			: `reported a non-zero exit code (${exitCode})`;
		return { ok: false, violations, message: `venus.jar ${status}.` };
	}

	if (isMemcheckMode(mode) && violations > 0) {
		const plural = violations === 1 ? '' : 's';
		return {
			ok: false,
			violations,
			message: `venus.jar reported ${violations} invalid memory access${plural === '' ? '' : 'es'}.`
		};
	}

	return {
		ok: true,
		violations,
		message: violations > 0
			? `finished (exit code 0); the output mentions ${violations} memcheck violation${violations === 1 ? '' : 's'}.`
			: 'finished (exit code 0).'
	};
}
