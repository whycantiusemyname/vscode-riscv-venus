import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type Direction = 'toAdapter' | 'fromAdapter';

type DapMessage = {
  type: string;
  direction: Direction;
  event?: string;
  command?: string;
  seq?: number;
  request_seq?: number;
  success?: boolean;
  arguments?: any;
  body?: any;
};

/**
 * Records both directions of the Debug Adapter Protocol traffic, so the
 * acceptance can prove that the editor really asked the adapter for a
 * breakpoint in the imported file and that the adapter really verified it.
 */
class DebugTranscript {
  readonly messages: DapMessage[] = [];

  tracker(): vscode.DebugAdapterTracker {
    return {
      onWillReceiveMessage: message => this.messages.push(this.record(message, 'toAdapter')),
      onDidSendMessage: message => this.messages.push(this.record(message, 'fromAdapter'))
    };
  }

  private record(message: any, direction: Direction): DapMessage {
    return Object.assign({ direction }, message) as DapMessage;
  }

  mark(): number {
    return this.messages.length;
  }

  async waitFor(
    predicate: (message: DapMessage) => boolean,
    from = 0,
    timeoutMs = 20000
  ): Promise<DapMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.slice(from).find(predicate);
      if (found) { return found; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for DAP message. Transcript: ${JSON.stringify(this.messages, null, 2)}`);
  }

  receivedStopped(reason: string): boolean {
    return this.messages.some(message =>
      message.direction === 'fromAdapter' &&
      message.type === 'event' &&
      message.event === 'stopped' &&
      message.body.reason === reason);
  }

  eventCount(event: string): number {
    return this.messages.filter(message => message.type === 'event' && message.event === event).length;
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

/** The in-repo Project 2 shape used when the suite is not driven by runTest.js. */
const FIXTURE_PROJECT = path.resolve(__dirname, '../../../src/test/fixtures/project with spaces');

function environmentOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/** Same normalization the debug adapter uses for source paths. */
function canonical(target: string): string {
  const absolute = path.normalize(path.resolve(target));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function canonicalize(pathValue: string | undefined): string {
  return canonical(pathValue || '');
}

/** True for a line that a debugger can actually stop on. */
function isInstruction(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) { return false; }
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) { return false; }
  if (trimmed.startsWith('.')) { return false; }
  if (/^[A-Za-z_.$][\w.$]*\s*:/.test(trimmed)) { return false; }
  return true;
}

/**
 * Fallback for the breakpoint line: the first instruction after `label:`, which
 * is where a user would click when they set a breakpoint at the start of a
 * routine. Comments, directives and nested labels are skipped.
 */
function firstInstructionLine(file: string, label: string): number | undefined {
  const labelPattern = new RegExp('^\\s*' + label + '\\s*:');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!labelPattern.test(lines[index])) {
      continue;
    }
    for (let candidate = index + 1; candidate < lines.length; candidate++) {
      const line = lines[candidate].trim();
      if (line.length === 0 || line.startsWith('#') || line.startsWith('//') || line.startsWith('.')) {
        continue;
      }
      if (/^[A-Za-z_.$][\w.$]*\s*:/.test(line)) {
        continue;
      }
      return candidate + 1;
    }
  }
  return undefined;
}

suite('CS61C Project 2 acceptance', () => {
  const scenario = environmentOrDefault('CS61C_ACCEPTANCE_SCENARIO', 'fixture-default');
  const workspaceRoot = environmentOrDefault('CS61C_ACCEPTANCE_WORKSPACE', FIXTURE_PROJECT);
  const fixtureRoot = workspaceRoot;
  const programRelative = environmentOrDefault('CS61C_ACCEPTANCE_PROGRAM', 'test-src/test_abs_one.s');
  const importDirective = environmentOrDefault('CS61C_ACCEPTANCE_IMPORT_DIRECTIVE', '../src/abs.s');
  const importedRelative = environmentOrDefault('CS61C_ACCEPTANCE_IMPORTED', 'src/abs.s');
  const entrySymbol = environmentOrDefault('CS61C_ACCEPTANCE_ENTRY_SYMBOL', 'abs');
  const pauseProgram = environmentOrDefault(
    'CS61C_ACCEPTANCE_PAUSE_PROGRAM',
    path.join(workspaceRoot, 'loop.s')
  );

  const program = path.resolve(workspaceRoot, programRelative);
  const importedSource = path.resolve(workspaceRoot, importedRelative);

  const breakpointLine = (() => {
    const configured = process.env.CS61C_ACCEPTANCE_IMPORT_LINE;
    if (configured && configured.length > 0) {
      const parsed = Number(configured);
      assert.ok(
        Number.isInteger(parsed) && parsed > 0,
        `CS61C_ACCEPTANCE_IMPORT_LINE must be a positive line number, got "${configured}"`
      );
      return parsed;
    }
    const derived = firstInstructionLine(importedSource, entrySymbol);
    assert.ok(derived, `could not derive the first instruction of ${entrySymbol} from ${importedSource}`);
    return derived!;
  })();

  let transcript: DebugTranscript;

  setup(() => {
    transcript = new DebugTranscript();
  });

  teardown(async () => {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.debug.stopDebugging();
  });

  test('opens the Project 2 root as the single workspace folder', () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders, `scenario "${scenario}" must open a workspace folder (${workspaceRoot})`);
    assert.strictEqual(folders!.length, 1, `scenario "${scenario}" must open exactly one workspace folder`);
    assert.strictEqual(
      canonical(folders![0].uri.fsPath),
      canonical(workspaceRoot),
      `scenario "${scenario}" must open ${workspaceRoot}`
    );
  });

  test('test_abs_one.s imports the abs routine from the imported source', async () => {
    assert.ok(fs.existsSync(program), `the driver ${program} must exist`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(program));
    assert.strictEqual(document.languageId, 'riscv', `${programRelative} must be edited as RISC-V assembly`);
    const directives = document.getText().split(/\r?\n/).map(line => line.trim());
    assert.ok(
      directives.indexOf(`.import ${importDirective}`) >= 0,
      `${programRelative} must contain the directive ".import ${importDirective}"`
    );
    assert.ok(fs.existsSync(importedSource), `the imported source ${importedSource} must exist`);
    await vscode.window.showTextDocument(document, { preview: false });
  });

  test('hits a source breakpoint in the imported file after stepping and continuing', async () => {
    const extension = vscode.extensions.getExtension('hm.riscv-venus');
    assert.ok(extension, 'the Venus extension must be loaded from the extension development path');
    await extension!.activate();

    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

    const importedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(importedSource));
    assert.strictEqual(importedDocument.languageId, 'riscv', `${importedRelative} must be edited as RISC-V assembly`);
    assert.ok(
      breakpointLine >= 1 && breakpointLine <= importedDocument.lineCount,
      `expected a breakpoint line inside ${importedRelative}, got ${breakpointLine}`
    );
    const entryLine = importedDocument.lineAt(breakpointLine - 1).text;
    assert.ok(
      isInstruction(entryLine),
      `line ${breakpointLine} of ${importedRelative} must be the first instruction of ${entrySymbol}, saw "${entryLine}"`
    );
    await vscode.window.showTextDocument(importedDocument, { preview: false });

    const sourceBreakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(importedSource), new vscode.Position(breakpointLine - 1, 0))
    );
    vscode.debug.addBreakpoints([sourceBreakpoint]);

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    try {
      const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
        type: 'venus',
        request: 'launch',
        name: `CS61C ${scenario}`,
        program,
        stopOnEntry: true,
        stopAtBreakpoints: true,
        args: ['argument with spaces']
      });
      assert.strictEqual(started, true, 'the Venus debug session must start');

      // The editor has to forward our source breakpoint to the adapter, and the
      // adapter has to verify it against the assembled imported file.
      const breakpointRequest = await transcript.waitFor(message =>
        message.direction === 'toAdapter' &&
        message.type === 'request' &&
        message.command === 'setBreakpoints' &&
        !!message.arguments &&
        canonicalize(message.arguments.source && message.arguments.source.path) === canonical(importedSource) &&
        (message.arguments.lines || []).indexOf(breakpointLine) >= 0);
      const breakpointResponse = await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'response' &&
        message.command === 'setBreakpoints' &&
        message.request_seq === breakpointRequest.seq);
      assert.strictEqual(breakpointResponse.success, true, 'the setBreakpoints request must succeed');
      assert.strictEqual(
        breakpointResponse.body.breakpoints[0].verified,
        true,
        `the breakpoint at ${importedRelative}:${breakpointLine} must be verified`
      );
      assert.strictEqual(breakpointResponse.body.breakpoints[0].line, breakpointLine);

      await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'event' &&
        message.event === 'stopped' &&
        message.body.reason === 'entry');

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session must be active');
      assert.strictEqual(session!.type, 'venus');

      const entryStack = await session!.customRequest('stackTrace', { threadId: 1 });
      assert.ok(entryStack.stackFrames.length >= 1, 'stop on entry must report a stack frame');
      assert.strictEqual(
        canonicalize(entryStack.stackFrames[0].source.path),
        canonical(program),
        `stop on entry must report ${programRelative}`
      );

      const stepMark = transcript.mark();
      await session!.customRequest('next', { threadId: 1 });
      await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'event' &&
        message.event === 'stopped' &&
        message.body.reason === 'step', stepMark);

      const continueMark = transcript.mark();
      await session!.customRequest('continue', { threadId: 1 });
      await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'event' &&
        message.event === 'stopped' &&
        message.body.reason === 'breakpoint', continueMark);
      assert.ok(
        transcript.receivedStopped('breakpoint'),
        `continuing from ${programRelative} must stop at the breakpoint in ${importedRelative}`
      );

      const stoppedStack = await session!.customRequest('stackTrace', { threadId: 1 });
      const stoppedFrame = stoppedStack.stackFrames[0];
      assert.strictEqual(
        canonicalize(stoppedFrame.source.path),
        canonical(importedSource),
        `the breakpoint must stop inside ${importedRelative}, not in ${stoppedFrame.source.path}`
      );
      assert.strictEqual(stoppedFrame.source.name, path.basename(importedSource));
      assert.strictEqual(
        stoppedFrame.line,
        breakpointLine,
        `the breakpoint must stop at ${importedRelative}:${breakpointLine}`
      );

      const importedStepMark = transcript.mark();
      await session!.customRequest('next', { threadId: 1 });
      await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'event' &&
        message.event === 'stopped' &&
        message.body.reason === 'step', importedStepMark);
      const importedStack = await session!.customRequest('stackTrace', { threadId: 1 });
      assert.strictEqual(
        canonicalize(importedStack.stackFrames[0].source.path),
        canonical(importedSource),
        `stepping must stay inside ${importedRelative}`
      );
      assert.strictEqual(
        importedStack.stackFrames[0].line,
        breakpointLine + 1,
        `stepping from ${importedRelative}:${breakpointLine} must reach the next line`
      );

      const scopes = await session!.customRequest('scopes', { frameId: 0 });
      const integerScope = scopes.scopes.find((scope: any) => scope.name === 'Integer');
      assert.ok(integerScope, 'the Integer register scope must be exposed');
      await session!.customRequest('setVariable', {
        variablesReference: integerScope.variablesReference,
        name: 'x5',
        value: '0x2a'
      });
      const variables = await session!.customRequest('variables', {
        variablesReference: integerScope.variablesReference
      });
      const t0 = variables.variables.find((variable: any) => variable.name.startsWith('x05'));
      assert.ok(t0, 't0 must be visible in the Integer scope');
      assert.strictEqual(String(t0.value).toLowerCase(), '0x0000002a');
    } finally {
      tracker.dispose();
    }
  });

  test('pause interrupts a running program without terminating the session', async () => {
    assert.ok(fs.existsSync(pauseProgram), `the endless program ${pauseProgram} must exist`);
    await vscode.workspace.openTextDocument(vscode.Uri.file(pauseProgram));

    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('venus', {
      createDebugAdapterTracker: () => transcript.tracker()
    });

    try {
      const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
        type: 'venus',
        request: 'launch',
        name: `CS61C ${scenario} pause`,
        program: pauseProgram,
        stopOnEntry: false,
        stopAtBreakpoints: true
      });
      assert.strictEqual(started, true, 'the Venus debug session must start');

      const session = vscode.debug.activeDebugSession;
      assert.ok(session, 'a Venus debug session must be active');

      const pauseMark = transcript.mark();
      await session!.customRequest('pause', { threadId: 1 });
      await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'event' &&
        message.event === 'stopped' &&
        message.body.reason === 'pause', pauseMark);

      assert.strictEqual(
        transcript.eventCount('terminated'),
        0,
        'pausing a running program must not terminate the debug session'
      );
      assert.strictEqual(
        vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.id,
        session!.id,
        'the paused session must stay the active session'
      );

      const pausedStack = await session!.customRequest('stackTrace', { threadId: 1 });
      assert.ok(pausedStack.stackFrames.length >= 1, 'a paused program must still report a stack frame');
      assert.strictEqual(
        canonicalize(pausedStack.stackFrames[0].source.path),
        canonical(pauseProgram),
        'the paused program must be reported at its own source'
      );

      const resumeStepMark = transcript.mark();
      await session!.customRequest('next', { threadId: 1 });
      await transcript.waitFor(message =>
        message.direction === 'fromAdapter' &&
        message.type === 'event' &&
        message.event === 'stopped' &&
        message.body.reason === 'step', resumeStepMark);
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
        program: pauseProgram,
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
