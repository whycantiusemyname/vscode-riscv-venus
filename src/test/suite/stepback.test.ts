import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  DebugTranscript,
  StepSnapshot,
  stepBackward,
  stepInto,
  stepOver,
  takeStepSnapshot,
  THREAD_ID
} from './debugSupport';

/**
 * Reverse stepping acceptance for the native debugger. The fixture executes
 * instructions that change registers and memory inside a called function, so one
 * Prev has to restore the program counter and the highlighted source line, the
 * integer registers, the memory word the store overwrote and the source level
 * call stack. Memory is observed through the program itself: after undoing the
 * store the test re-executes the load, which can only return the old word if the
 * simulator rolled the memory back.
 */
suite('CS61C Venus Prev (step back) acceptance', () => {
  const fixtureRoot = path.resolve(__dirname, '../../../src/test/fixtures/project with spaces');
  const program = path.join(fixtureRoot, 'stepback.s');

  teardown(async () => {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.debug.stopDebugging();
  });

  function trackSession(transcript: DebugTranscript): vscode.Disposable {
    return vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });
  }

  async function startStepbackSession(transcript: DebugTranscript): Promise<vscode.DebugSession> {
    const started = await vscode.debug.startDebugging(undefined, {
      type: 'venus',
      request: 'launch',
      name: 'CS61C prev acceptance',
      program,
      stopOnEntry: true,
      stopAtBreakpoints: true
    });
    assert.strictEqual(started, true, 'the debug session should start');
    await transcript.waitFor(message =>
      message.type === 'event' && message.event === 'stopped' && message.body.reason === 'entry');
    const session = vscode.debug.activeDebugSession;
    assert.ok(session, 'a Venus debug session should be active');
    return session!;
  }

  /**
   * Presses Prev once. Returns true when the adapter refused because there was
   * nothing recorded to undo, false when the step back succeeded. The refusal is
   * read from the raw DAP response because a client may either reject the request
   * or hand back the failing response.
   */
  async function stepBackOnce(session: vscode.DebugSession, transcript: DebugTranscript): Promise<boolean> {
    const mark = transcript.mark();
    try {
      await session.customRequest('stepBack', { threadId: THREAD_ID });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Step back is not available/);
      return true;
    }
    const response = transcript.messages.slice(mark)
      .find(message => message.type === 'response' && message.command === 'stepBack');
    assert.ok(response, 'the adapter must respond to a Prev request');
    if (response!.success === false) {
      assert.match(response!.message || '', /Step back is not available/);
      return true;
    }
    await transcript.waitFor(message =>
      message.type === 'event' && message.event === 'stopped' && message.body.reason === 'step', mark);
    return false;
  }

  /** Formats a register value the way the adapter's default (hex) view does. */
  function hex(value: number): string {
    return '0x' + value.toString(16).padStart(8, '0');
  }

  function lower(value: string | undefined): string {
    return value === undefined ? '<missing>' : value.toLowerCase();
  }

  function atLine(state: StepSnapshot, line: number): boolean {
    return state.frames[0].indexOf('stepback.s:' + line) >= 0;
  }

  test('Prev restores PC, registers, memory and the call stack', async () => {
    const transcript = new DebugTranscript();
    const tracker = trackSession(transcript);
    try {
      const session = await startStepbackSession(transcript);

      // 1. Entry: nothing has executed yet, so Prev has to be refused.
      const entry = await takeStepSnapshot(session);
      assert.strictEqual(entry.frameCount, 1, 'entry stops in main');
      assert.ok(atLine(entry, 7), 'entry should be line 7 of main, got ' + entry.frames[0]);
      assert.strictEqual(await stepBackOnce(session, transcript), true,
        'Prev at the first instruction must be refused');
      assert.deepStrictEqual(await takeStepSnapshot(session), entry,
        'a refused Prev must not change the session state');

      // 2. Step into every instruction up to the sw, remembering each stop.
      const forward: StepSnapshot[] = [];
      let beforeStore: StepSnapshot | undefined;
      for (let i = 0; i < 20 && beforeStore === undefined; i++) {
        await stepInto(session, transcript);
        const state = await takeStepSnapshot(session);
        forward.push(state);
        if (atLine(state, 18)) {
          beforeStore = state;
        }
      }
      assert.ok(beforeStore, 'stepping should reach the sw inside inc');
      assert.strictEqual(beforeStore!.frameCount, 2,
        'jal x1 keeps the caller frame while inside inc');
      assert.strictEqual(lower(beforeStore!.registers.x05), hex(1), 't0 = 1 after li t0, 1');
      assert.strictEqual(lower(beforeStore!.registers.x10), hex(0x10000000), 'a0 = &value');
      assert.strictEqual(lower(beforeStore!.registers.x28), hex(8),
        't3 = 8 once the load and the add have run, before the store executes');

      // 3. Execute the store: the ret is next and t3 stays at 8.
      await stepInto(session, transcript);
      const afterStore = await takeStepSnapshot(session);
      assert.ok(atLine(afterStore, 19), 'the next stop is the ret, got ' + afterStore.frames[0]);
      assert.strictEqual(afterStore.frameCount, 2, 'the callee frame is still on the stack');
      assert.strictEqual(lower(afterStore.registers.x28), hex(8), 'the store leaves t3 = 8');

      // 4. One Prev restores PC, registers and the stack frame list.
      await stepBackward(session, transcript);
      assert.deepStrictEqual(await takeStepSnapshot(session), beforeStore,
        'Prev must restore the pre-store state');

      // 5. Stepping forward again reproduces exactly the same state.
      await stepInto(session, transcript);
      assert.deepStrictEqual(await takeStepSnapshot(session), afterStore,
        're-executing the instruction must reproduce the same state');

      // 6. Consecutive Prevs unwind one instruction each.
      await stepBackward(session, transcript);
      assert.deepStrictEqual(await takeStepSnapshot(session), beforeStore,
        'the first of two Prevs unwinds the store');
      await stepBackward(session, transcript);
      const oneInstructionBack = await takeStepSnapshot(session);
      assert.ok(atLine(oneInstructionBack, 17),
        'the second Prev unwinds one more instruction, got ' + oneInstructionBack.frames[0]);
      assert.strictEqual(lower(oneInstructionBack.registers.x28), hex(7),
        'undoing the add restores the value the load produced');
      assert.deepStrictEqual(oneInstructionBack, forward[forward.length - 2],
        'the second Prev matches the state recorded before that instruction');

      // 7. Memory: undoing the sw has to put the old word back. Undo the load as
      //    well and re-execute it. It can only return 7 when the memory was rolled
      //    back; a stale 8 would prove a broken undo.
      await stepBackward(session, transcript);
      const afterUndoLoad = await takeStepSnapshot(session);
      assert.ok(atLine(afterUndoLoad, 16),
        'undoing the load returns to it, got ' + afterUndoLoad.frames[0]);
      assert.strictEqual(lower(afterUndoLoad.registers.x28), hex(0),
        'undoing the load restores t3 = 0');
      await stepInto(session, transcript);
      const reloaded = await takeStepSnapshot(session);
      assert.ok(atLine(reloaded, 17), 'the re-executed load stops at the add, got ' + reloaded.frames[0]);
      assert.strictEqual(lower(reloaded.registers.x28), hex(7),
        'the re-executed load must read the word Prev restored (7, not 8)');

      // 8. Walk forward over the store, the ret and back into main.
      await stepInto(session, transcript);
      assert.deepStrictEqual(await takeStepSnapshot(session), beforeStore);
      await stepInto(session, transcript);
      assert.deepStrictEqual(await takeStepSnapshot(session), afterStore);
      await stepInto(session, transcript);
      const afterReturn = await takeStepSnapshot(session);
      assert.strictEqual(afterReturn.frameCount, 1, 'ret pops the callee frame');
      assert.ok(atLine(afterReturn, 11), 'main continues after the call, got ' + afterReturn.frames[0]);

      // 9. Prev over the ret restores the callee frame that was popped.
      await stepBackward(session, transcript);
      assert.deepStrictEqual(await takeStepSnapshot(session), afterStore,
        'Prev must restore the callee frame');

      // 10. Keep pressing Prev until the history is empty again.
      let rewound = 0;
      while (rewound < 20) {
        const before = await takeStepSnapshot(session);
        if (await stepBackOnce(session, transcript)) {
          assert.deepStrictEqual(await takeStepSnapshot(session), before,
            'a refused Prev must leave the state untouched');
          break;
        }
        rewound++;
      }
      assert.ok(rewound > 0, 'at least one Prev should have succeeded');
      assert.deepStrictEqual(await takeStepSnapshot(session), entry,
        'Prev walks all the way back to the entry state');
    } finally {
      tracker.dispose();
    }
  });

  test('Prev unwinds a step over a call one instruction at a time', async () => {
    const transcript = new DebugTranscript();
    const tracker = trackSession(transcript);
    try {
      const session = await startStepbackSession(transcript);

      let beforeCall: StepSnapshot | undefined;
      for (let i = 0; i < 20 && beforeCall === undefined; i++) {
        await stepInto(session, transcript);
        const state = await takeStepSnapshot(session);
        if (atLine(state, 10)) {
          beforeCall = state;
        }
      }
      assert.ok(beforeCall, 'stepping should reach jal x1, inc');
      assert.strictEqual(beforeCall!.frameCount, 1, 'the call has not been entered yet');

      // next steps over the whole callee and stops back in main. It executes
      // several instructions, each of which records one undo entry.
      await stepOver(session, transcript);
      const afterCall = await takeStepSnapshot(session);
      assert.strictEqual(afterCall.frameCount, 1, 'step over returns to main');
      assert.ok(atLine(afterCall, 11), 'step over stops after the call, got ' + afterCall.frames[0]);

      // Prev undoes the ret, so the callee frame comes back while the store stays
      // applied (the ret does not touch memory).
      assert.strictEqual(await stepBackOnce(session, transcript), false);
      const afterOnePrev = await takeStepSnapshot(session);
      assert.strictEqual(afterOnePrev.frameCount, 2, 'the callee frame is restored');
      assert.ok(atLine(afterOnePrev, 19),
        'Prev stops at the instruction it undid, got ' + afterOnePrev.frames[0]);
      assert.strictEqual(lower(afterOnePrev.registers.x28), hex(8), 'register state is restored too');

      // A second Prev walks further back inside the stepped over call.
      assert.strictEqual(await stepBackOnce(session, transcript), false);
      const afterTwoPrevs = await takeStepSnapshot(session);
      assert.strictEqual(afterTwoPrevs.frameCount, 2);
      assert.ok(atLine(afterTwoPrevs, 18), 'got ' + afterTwoPrevs.frames[0]);
      assert.strictEqual(lower(afterTwoPrevs.registers.x28), hex(8));

      assert.strictEqual(await stepBackOnce(session, transcript), false);
      const afterThreePrevs = await takeStepSnapshot(session);
      assert.ok(atLine(afterThreePrevs, 17), 'got ' + afterThreePrevs.frames[0]);
      assert.strictEqual(lower(afterThreePrevs.registers.x28), hex(7),
        'undoing the add restores the value loaded from memory');
    } finally {
      tracker.dispose();
    }
  });
});