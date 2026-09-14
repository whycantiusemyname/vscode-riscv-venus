import { spawn } from 'child_process';

export interface VenusCourseProcessResult {
	exitCode: number | undefined;
	output: string;
}

/**
 * Runs one course check and resolves with the process exit code, so callers can
 * report `venus.jar`'s own status (a failing memcheck/CC run exits non-zero)
 * instead of swallowing it.
 *
 * `spawn` is used with an argv array and no shell, which is what makes paths
 * containing spaces behave identically on Windows, Linux and macOS.
 */
export function runVenusCourseProcess(
	executable: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void } = {}
): Promise<VenusCourseProcessResult> {
	return new Promise((resolve, reject) => {
		let output = '';
		let child;
		try {
			child = spawn(executable, args, {
				cwd: options.cwd,
				env: options.env,
				windowsHide: true
			});
		} catch (error) {
			reject(error);
			return;
		}

		const collect = (chunk: Buffer | string) => {
			const text = chunk.toString();
			output += text;
			if (options.onOutput) { options.onOutput(text); }
		};

		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.on('error', reject);
		child.on('close', code => resolve({ exitCode: typeof code === 'number' ? code : undefined, output }));
	});
}
