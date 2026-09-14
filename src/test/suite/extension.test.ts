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

async function registerValue(session: vscode.DebugSession, scopeName: string, variablePrefix: string): Promise<string> {
  const scopes = await session.customRequest('scopes', { frameId: 0 });
  const scope = scopes.scopes.find((entry: any) => entry.name === scopeName);
  assert.ok(scope, `the ${scopeName} scope should be available`);
  const variables = await session.customRequest('variables', { variablesReference: scope.variablesReference });
  const variable = variables.variables.find((entry: any) => entry.name.startsWith(variablePrefix));
  assert.ok(variable, `${variablePrefix} should be visible`);
  return variable.value;
}

function comparablePath(target: string): string {
  const resolved = path.resolve(target).split(path.sep).join('/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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

  test('pause halts a running program and continue resumes it', async () => {
    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C pause regression',
        program: path.join(fixtureRoot, 'loop.s'),
        stopOnEntry: false,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true);

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session should be active');

      // Let the loop run, then pause it.
      await new Promise(resolve => setTimeout(resolve, 300));
      const pauseMark = transcript.mark();
      await session!.customRequest('pause', { threadId: 1 });
      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'pause', pauseMark);

      const frozenValue = await registerValue(session!, 'Integer', 'x05');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.strictEqual(await registerValue(session!, 'Integer', 'x05'), frozenValue,
        'a paused program must not execute another instruction');
      assert.strictEqual(vscode.debug.activeDebugSession?.id, session!.id,
        'pause must not terminate the debug session');

      // Resuming must run the program again and must not report a synthetic stop.
      const continueMark = transcript.mark();
      await session!.customRequest('continue', { threadId: 1 });
      await transcript.waitFor(message => message.type === 'event' && message.event === 'continued', continueMark);
      await new Promise(resolve => setTimeout(resolve, 250));

      const resumeMark = transcript.mark();
      await session!.customRequest('pause', { threadId: 1 });
      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'pause', resumeMark);

      assert.notStrictEqual(await registerValue(session!, 'Integer', 'x05'), frozenValue,
        'continue must resume execution');
      const stoppedReasons = transcript.messages
        .slice(continueMark)
        .filter(message => message.type === 'event' && message.event === 'stopped')
        .map(message => message.body.reason);
      assert.deepStrictEqual(stoppedReasons, ['pause'],
        'continue must not report a synthetic stop before the next pause');
      assert.ok(!transcript.messages.some(message => message.type === 'event' && message.event === 'terminated'),
        'pause and continue must not terminate the session');
    } finally {
      tracker.dispose();
    }
  });

  test('program arguments and working directory are observable at entry', async () => {
    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    const program = path.join(fixtureRoot, 'test-src', 'test_abs_one.s');
    const programArguments = ['argument with spaces', 'tests/input.bin'];

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C argv regression',
        program,
        cwd: fixtureRoot,
        stopOnEntry: true,
        stopAtBreakpoints: true,
        args: programArguments
      });
      assert.strictEqual(started, true);

      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'entry');

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session should be active');

      const runtimeInfo = await session!.customRequest('venus/runtimeInfo');
      assert.deepStrictEqual(runtimeInfo.programArguments, programArguments,
        'program arguments must be forwarded verbatim, including spaces');
      assert.strictEqual(runtimeInfo.workingDirectory, comparablePath(fixtureRoot),
        'the launch cwd must be propagated to the runtime');

      // The simulated program observes argc in a0 and the argv pointer in a1.
      const argc = parseInt((await registerValue(session!, 'Integer', 'x10')).replace(/^0x/i, ''), 16);
      assert.strictEqual(argc, programArguments.length + 1, 'a0 must hold argc (program name plus arguments)');
      const argv = parseInt((await registerValue(session!, 'Integer', 'x11')).replace(/^0x/i, ''), 16);
      assert.notStrictEqual(argv, 0, 'a1 must point at the argv array');
    } finally {
      tracker.dispose();
    }
  });

  test('the program directory is the default working directory', async () => {
    const transcript = new DebugTranscript();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    const program = path.join(fixtureRoot, 'test-src', 'test_abs_one.s');

    try {
      const started = await vscode.debug.startDebugging(undefined, {
        type: 'venus',
        request: 'launch',
        name: 'CS61C default cwd regression',
        program,
        stopOnEntry: true,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true);

      await transcript.waitFor(message =>
        message.type === 'event' && message.event === 'stopped' && message.body.reason === 'entry');

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session should be active');
      const runtimeInfo = await session!.customRequest('venus/runtimeInfo');
      assert.strictEqual(runtimeInfo.workingDirectory, comparablePath(path.dirname(program)),
        'the working directory must default to the program directory');
    } finally {
      tracker.dispose();
    }
  });
});
