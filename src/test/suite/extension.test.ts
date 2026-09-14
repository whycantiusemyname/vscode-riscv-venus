import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

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

suite('CS61C Venus acceptance', () => {
  const fixtureRoot = path.resolve(__dirname, '../../../src/test/fixtures/project with spaces');

  teardown(async () => {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.debug.stopDebugging();
  });

  test('debugs a Project 2 style .import and hits a source breakpoint', async () => {
    const extension = vscode.extensions.getExtension('hm.riscv-venus');
    assert.ok(extension, 'the Venus extension must be installed in the extension host');
    await extension!.activate();

    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    const program = path.join(fixtureRoot, 'test-src', 'test_abs_one.s');
    const importedSource = path.join(fixtureRoot, 'src', 'abs.s');
    const importedUri = vscode.Uri.file(importedSource);
    const sourceBreakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(importedUri, new vscode.Position(3, 0))
    );
    vscode.debug.addBreakpoints([sourceBreakpoint]);

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C import acceptance',
        program,
        stopOnEntry: true,
        stopAtBreakpoints: true,
        args: ['argument with spaces']
      });
      assert.strictEqual(started, true, 'debug session should start');

      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'entry');
      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'breakpoint' && message.body.breakpoint.verified === true);

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session should be active');

      const entryStack = await session!.customRequest('stackTrace', { threadId: 1 });
      assert.ok(entryStack.stackFrames[0].source.path.endsWith('test_abs_one.s'));

      const stepMark = transcript.mark();
      await session!.customRequest('next', { threadId: 1 });
      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'step', stepMark);

      const continueMark = transcript.mark();
      await session!.customRequest('continue', { threadId: 1 });
      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'breakpoint', continueMark);

      const importedStack = await session!.customRequest('stackTrace', { threadId: 1 });
      const stoppedPath = path.normalize(importedStack.stackFrames[0].source.path);
      assert.strictEqual(stoppedPath.toLowerCase(), path.normalize(importedSource).toLowerCase());
      assert.strictEqual(importedStack.stackFrames[0].line, 4);

      const scopes = await session!.customRequest('scopes', { frameId: 0 });
      const integerScope = scopes.scopes.find((scope: any) => scope.name === 'Integer');
      assert.ok(integerScope, 'integer register scope should be available');

      await session!.customRequest('setVariable', {
        variablesReference: integerScope.variablesReference,
        name: 'x5',
        value: '0x2a'
      });

      const variables = await session!.customRequest('variables', {
        variablesReference: integerScope.variablesReference
      });
      const t0 = variables.variables.find((variable: any) => variable.name.startsWith('x05'));
      assert.ok(t0, 't0 should be visible');
      assert.strictEqual(t0.value.toLowerCase(), '0x0000002a');
    } finally {
      tracker.dispose();
    }
  });

  test('pause interrupts a running program without terminating it', async () => {
    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C pause acceptance',
        program: path.join(fixtureRoot, 'loop.s'),
        stopOnEntry: false,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true);

      const session = vscode.debug.activeDebugSession;
      assert.ok(session);
      const pauseMark = transcript.mark();
      await session!.customRequest('pause', { threadId: 1 });
      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'pause', pauseMark);
      assert.strictEqual(vscode.debug.activeDebugSession?.id, session!.id);
    } finally {
      tracker.dispose();
    }
  });
});
