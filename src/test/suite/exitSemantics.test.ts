import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import { DapMessage, DebugTranscript } from './debugSupport';

/**
 * Native exit semantics for the course programs:
 *
 *   - a finished program reports the simulator's exit status exactly once, as a
 *     DAP `exited` event, and always before `terminated`;
 *   - `ecall` 10 finishes with 0, `ecall` 17 with the status in a0;
 *   - a launch that never assembled (missing `.import`, missing program file)
 *     or a program that is stopped before exiting reports no exit status at all,
 *     so no stale code from an earlier run can leak into the session.
 *
 * The DAP transcript is the only observable used here, so the tests do not
 * depend on a session still being alive when a fast program is already done.
 */

const fixtureRoot = path.resolve(__dirname, '../../../src/test/fixtures/project with spaces');
const driverRoot = path.join(fixtureRoot, 'test-src');

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

suite('CS61C Venus exit semantics acceptance', () => {
	let transcript: DebugTranscript;
	let tracker: vscode.Disposable;

	setup(() => {
		transcript = new DebugTranscript();
		tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
			createDebugAdapterTracker: () => transcript.tracker()
		});
	});

	teardown(async () => {
		tracker.dispose();
		await vscode.debug.stopDebugging();
		vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
	});

	function events(event: string): DapMessage[] {
		return transcript.messages.filter(message => message.type === 'event' && message.event === event);
	}

	function indexOfEvent(event: string): number {
		return transcript.messages.findIndex(message => message.type === 'event' && message.event === event);
	}

	async function launch(program: string, stopOnEntry: boolean): Promise<void> {
		try {
			await vscode.debug.startDebugging(undefined, {
				type: 'venus',
				request: 'launch',
				name: `CS61C exit acceptance: ${path.basename(program)}`,
				program,
				stopOnEntry,
				stopAtBreakpoints: true
			} as vscode.DebugConfiguration);
		} catch (error) {
			// A rejected launch is one of the outcomes under test.
		}
	}

	function waitForEvent(event: string): Promise<DapMessage> {
		return transcript.waitFor(message => message.type === 'event' && message.event === event);
	}

	async function assertSingleExitBeforeTermination(expectedCode: number): Promise<void> {
		const exited = await waitForEvent('exited');
		assert.strictEqual(exited.body.exitCode, expectedCode, 'the reported exit code must be the simulator status');

		await waitForEvent('terminated');

		// Give the adapter the chance to send a duplicate before counting.
		await delay(50);
		assert.strictEqual(events('exited').length, 1, 'a run must report exactly one exited event');
		assert.ok(
			indexOfEvent('exited') < indexOfEvent('terminated'),
			'the exit code must be reported before the session terminates'
		);
	}

	test('normal exit: ecall 10 reports exit code 0 exactly once before terminated', async () => {
		await launch(path.join(driverRoot, 'exit_ok.s'), false);
		await assertSingleExitBeforeTermination(0);
	});

	test('ecall 17: the status in a0 is reported as the exit code', async () => {
		await launch(path.join(driverRoot, 'exit_17.s'), false);
		await assertSingleExitBeforeTermination(17);
	});

	test('normal exit: an imported program that runs to the end reports code 0', async () => {
		await launch(path.join(driverRoot, 'test_abs_one.s'), false);
		await assertSingleExitBeforeTermination(0);
	});

	test('assembly failure: a missing .import reports no exit code at all', async () => {
		await launch(path.join(driverRoot, 'import_missing.s'), true);

		const failure = await transcript.waitFor(message =>
			message.type === 'response' && message.command === 'launch' && message.success === false);
		assert.ok(
			String(failure.message).includes('Unable to assemble'),
			`the failed launch must explain the assembly failure, got: ${failure.message}`
		);

		await waitForEvent('terminated');
		await delay(50);
		assert.strictEqual(events('exited').length, 0, 'a launch that never assembled must not report an exit code');
		assert.strictEqual(events('stopped').length, 0, 'a failed launch must not stop inside a program');
	});

	test('launch failure: a missing program file reports no exit code at all', async () => {
		await launch(path.join(driverRoot, 'does_not_exist.s'), true);

		const failure = await transcript.waitFor(message =>
			message.type === 'response' && message.command === 'launch' && message.success === false);
		assert.ok(
			String(failure.message).includes('Unable to assemble'),
			`a missing program must fail the launch, got: ${failure.message}`
		);

		await waitForEvent('terminated');
		await delay(50);
		assert.strictEqual(events('exited').length, 0, 'a failed launch must not report an exit code');
	});

	test('stop before exit: pausing at entry and stopping reports no exit code', async () => {
		await launch(path.join(fixtureRoot, 'loop.s'), true);
		await transcript.waitFor(message =>
			message.type === 'event' && message.event === 'stopped' && message.body.reason === 'entry');

		await vscode.debug.stopDebugging();
		await delay(50);
		assert.strictEqual(events('exited').length, 0, 'a program stopped before exiting has no exit status');
	});
});
