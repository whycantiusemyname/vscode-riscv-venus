import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as helpers from '../../venusHelpers';

type DapMessage = {
  type: string;
  event?: string;
  command?: string;
  body?: any;
};

class DebugTranscript {
  readonly messages: DapMessage[] = [];

  tracker(): vscode.DebugAdapterTracker {
    return {
      onDidSendMessage: message => this.messages.push(message as DapMessage)
    };
  }

  mark(): number {
    return this.messages.length;
  }

  async waitFor(
    predicate: (message: DapMessage) => boolean,
    from = 0,
    timeoutMs = 15000
  ): Promise<DapMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.slice(from).find(predicate);
      if (found) { return found; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for DAP message. Transcript: ${JSON.stringify(this.messages, null, 2)}`);
  }
}

const stopped = (reason: string) => (message: DapMessage) =>
  message.type === 'event' && message.event === 'stopped' && message.body.reason === reason;

async function integerScope(session: vscode.DebugSession): Promise<number> {
  const scopes = await session.customRequest('scopes', { frameId: 0 });
  const scope = scopes.scopes.find((candidate: any) => candidate.name === 'Integer');
  assert.ok(scope, 'integer register scope should be available');
  return scope.variablesReference;
}

async function readRegister(session: vscode.DebugSession, scope: number, label: string): Promise<number> {
  const variables = await session.customRequest('variables', { variablesReference: scope });
  const register = variables.variables.find((variable: any) => variable.name.startsWith(label));
  assert.ok(register, `${label} should be visible`);
  const value = helpers.parseVenusLiteralInt(register.value);
  assert.notStrictEqual(value, undefined, `register ${label} value '${register.value}' should be numeric`);
  return value!;
}

suite('CS61C native register and memory editing', () => {
  const fixtureRoot = path.resolve(__dirname, '../../../src/test/fixtures/project with spaces');
  const program = path.join(fixtureRoot, 'memory_edit.s');
  const programUri = vscode.Uri.file(program);

  teardown(async () => {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.debug.stopDebugging();
  });

  test('register and memory writes drive subsequent reads and execution', async () => {
    const extension = vscode.extensions.getExtension('hm.riscv-venus');
    assert.ok(extension, 'the Venus extension must be installed in the extension host');
    await extension!.activate();

    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    // line 9 consumes t3, line 10 loads the data word that the test edits.
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(programUri, new vscode.Position(8, 0))),
      new vscode.SourceBreakpoint(new vscode.Location(programUri, new vscode.Position(9, 0)))
    ]);

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C editing acceptance',
        program,
        stopOnEntry: true,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true, 'debug session should start');
      await transcript.waitFor(stopped('entry'));

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session should be active');

      let mark = transcript.mark();
      await session!.customRequest('continue', { threadId: 1 });
      await transcript.waitFor(stopped('breakpoint'), mark);

      const scope = await integerScope(session!);
      assert.strictEqual(await readRegister(session!, scope, 'x28'), 7, 't3 holds the value set by the program');

      // Write t3 through the label the Variables view shows and read it back.
      const written = await session!.customRequest('setVariable', {
        variablesReference: scope,
        name: 'x28 (t3) ',
        value: '0x2a'
      });
      assert.strictEqual(written.value.toLowerCase(), '0x0000002a');
      assert.strictEqual(await readRegister(session!, scope, 'x28'), 0x2a);

      // The program must read the poked value on the next instruction.
      mark = transcript.mark();
      await session!.customRequest('stepIn', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x29'), 0x2a, 't4 copied the poked t3');

      const stack = await session!.customRequest('stackTrace', { threadId: 1 });
      assert.strictEqual(stack.stackFrames[0].line, 10, 'stopped in front of the data load');

      // t0 is the address of the .data word, which the loaded word comes from.
      const slotAddress = await readRegister(session!, scope, 'x05');
      const slotReference = helpers.formatAddress(slotAddress);
      const before = await session!.customRequest('readMemory', { memoryReference: slotReference, count: 4 });
      assert.strictEqual(before.address, slotReference);
      assert.deepStrictEqual(Buffer.from(before.data, 'base64'), Buffer.from([0, 0, 0, 0]));

      // little endian byte order, exactly what lw/sw see
      const word = Buffer.from([0x2a, 0x11, 0x00, 0x00]);
      const write = await session!.customRequest('writeMemory', {
        memoryReference: slotReference,
        count: 4,
        data: word.toString('base64')
      });
      assert.strictEqual(write.bytesWritten, 4);

      const after = await session!.customRequest('readMemory', { memoryReference: slotReference, count: 4 });
      assert.deepStrictEqual(Buffer.from(after.data, 'base64'), word, 'the write must be readable');

      mark = transcript.mark();
      await session!.customRequest('stepIn', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x06'), 0x112a, 'lw loaded the written word');

      mark = transcript.mark();
      await session!.customRequest('stepIn', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x07'), 0x112a, 'the word propagates through the program');

      // Byte granular writes only touch the addressed byte.
      const byte = await session!.customRequest('writeMemory', {
        memoryReference: slotReference,
        offset: 1,
        count: 1,
        data: Buffer.from([0xff]).toString('base64')
      });
      assert.strictEqual(byte.bytesWritten, 1);
      const reread = await session!.customRequest('readMemory', { memoryReference: slotReference, count: 4 });
      assert.deepStrictEqual(Buffer.from(reread.data, 'base64'), Buffer.from([0x2a, 0xff, 0x00, 0x00]));

      // Reading stays available while the program runs, editing does not.
      await session!.customRequest('continue', { threadId: 1 });
      const running = await session!.customRequest('readMemory', { memoryReference: slotReference, count: 4 });
      assert.strictEqual(Buffer.from(running.data, 'base64').length, 4);
      await assert.rejects(async () => {
        await session!.customRequest('writeMemory', {
          memoryReference: slotReference,
          count: 4,
          data: word.toString('base64')
        });
      }, 'writing memory while the program runs must be rejected');

      // Register writes go through the same paused-only rule: the simulator
      // discards them while running, so the adapter must not report success.
      await assert.rejects(async () => {
        await session!.customRequest('setVariable', {
          variablesReference: scope,
          name: 'x28 (t3) ',
          value: '0x2a'
        });
      }, 'writing a register while the program runs must be rejected');
    } finally {
      tracker.dispose();
    }
  });

  test('advertises only the editing capabilities that are implemented', async () => {
    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C capability truthfulness',
        program,
        stopOnEntry: true,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true, 'debug session should start');
      await transcript.waitFor(stopped('entry'));

      const response = transcript.messages.find(message =>
        message.type === 'response' && message.command === 'initialize');
      assert.ok(response, 'the adapter must answer the initialize request');
      const body = response!.body || {};
      const capabilities = body.capabilities || body;

      // implemented: configuration, register writes, the memory requests,
      // hovers and Prev
      assert.strictEqual(capabilities.supportsConfigurationDoneRequest, true);
      assert.strictEqual(capabilities.supportsSetVariable, true);
      assert.strictEqual(capabilities.supportsReadMemoryRequest, true);
      assert.strictEqual(capabilities.supportsWriteMemoryRequest, true);
      assert.strictEqual(capabilities.supportsEvaluateForHovers, true);
      assert.strictEqual(capabilities.supportsStepBack, true);
      // not implemented: dataBreakpointInfo never offers a dataId for a
      // register and the simulator has no watchpoints, so no data breakpoint
      // can be armed
      assert.notStrictEqual(capabilities.supportsDataBreakpoints, true,
        'data breakpoints cannot be armed, so the capability must stay off');
      // not implemented: the completion handler has no completion source and
      // the cancel handler has nothing that can be cancelled
      assert.notStrictEqual(capabilities.supportsCompletionsRequest, true,
        'the adapter has no completion source, so it must not offer completions');
      assert.notStrictEqual(capabilities.supportsCancelRequest, true,
        'nothing in the adapter can be cancelled, so it must not offer cancellation');
      assert.notStrictEqual(capabilities.supportsDisassembleRequest, true,
        'the DAP disassemble request is not implemented');
      assert.strictEqual(capabilities.supportsRestartRequest, false);
      assert.strictEqual(capabilities.supportsBreakpointLocationsRequest, false);
    } finally {
      tracker.dispose();
    }
  });

  test('edits survive a Prev that undoes an unrelated instruction', async () => {
    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    // Line 9 "addi t4, t3, 0" is the instruction Prev has to undo.
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(programUri, new vscode.Position(8, 0)))
    ]);

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C edit and Prev coherence',
        program,
        stopOnEntry: true,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true, 'debug session should start');
      await transcript.waitFor(stopped('entry'));

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session should be active');

      let mark = transcript.mark();
      await session!.customRequest('continue', { threadId: 1 });
      await transcript.waitFor(stopped('breakpoint'), mark);

      const scope = await integerScope(session!);
      const slotReference = helpers.formatAddress(await readRegister(session!, scope, 'x05'));
      const word = Buffer.from([0x2a, 0x11, 0x00, 0x00]);

      // Execute the addi once, so Prev has an instruction to undo next.
      mark = transcript.mark();
      await session!.customRequest('step', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x29'), 7, 't4 copied t3');

      // Poke the register the addi reads and the data word the lw will read.
      await session!.customRequest('setVariable', {
        variablesReference: scope,
        name: 'x28 (t3) ',
        value: '0x2a'
      });
      await session!.customRequest('writeMemory', {
        memoryReference: slotReference,
        count: 4,
        data: word.toString('base64')
      });

      // Prev undoes the addi only: it neither wrote t3 nor that memory word, so
      // both pokes have to survive while t4 is restored.
      mark = transcript.mark();
      await session!.customRequest('stepBack', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x29'), 0, 'Prev restores t4');
      assert.strictEqual(await readRegister(session!, scope, 'x28'), 0x2a, 'the register poke is not undone');
      const poked = await session!.customRequest('readMemory', { memoryReference: slotReference, count: 4 });
      assert.deepStrictEqual(Buffer.from(poked.data, 'base64'), word, 'the memory poke is not undone');

      // Editing stays available right after a Prev, and re-executing the
      // instructions consumes both poked values.
      const repoke = await session!.customRequest('setVariable', {
        variablesReference: scope,
        name: 'x28 (t3)',
        value: '0x2a'
      });
      assert.strictEqual(repoke.value.toLowerCase(), '0x0000002a');

      mark = transcript.mark();
      await session!.customRequest('step', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x29'), 0x2a, 'the re-executed add copies the poked t3');

      mark = transcript.mark();
      await session!.customRequest('step', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x06'), 0x112a, 'the re-executed lw loads the poked word');

      // A further Prev (of the lw) must restore the instruction's own effect
      // without resurrecting or discarding the pokes: they never became part of
      // an instruction's undo entry.
      mark = transcript.mark();
      await session!.customRequest('stepBack', { threadId: 1 });
      await transcript.waitFor(stopped('step'), mark);
      assert.strictEqual(await readRegister(session!, scope, 'x06'), 0, 'Prev restores t1');
      assert.strictEqual(await readRegister(session!, scope, 'x28'), 0x2a, 'the register poke survives the second Prev');
      const stillPoked = await session!.customRequest('readMemory', { memoryReference: slotReference, count: 4 });
      assert.deepStrictEqual(Buffer.from(stillPoked.data, 'base64'), word, 'the memory poke survives the second Prev');
    } finally {
      tracker.dispose();
    }
  });
});
