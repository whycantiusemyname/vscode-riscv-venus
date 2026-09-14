import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

export type DapMessage = {
  type: string;
  event?: string;
  command?: string;
  success?: boolean;
  message?: string;
  body?: any;
};

/**
 * Records every message the debug adapter sends, so a test can wait for the
 * stopped event that follows a step and can also inspect the raw responses.
 */
export class DebugTranscript {
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
    throw new Error('Timed out waiting for DAP message. Transcript: ' + JSON.stringify(this.messages, null, 2));
  }
}

export const THREAD_ID = 1;

/**
 * Everything Prev is expected to restore for the current stop. The values are
 * kept exactly as the DAP responses report them, so comparing snapshots covers
 * the current source line (top frame), the source level call stack and the
 * integer registers. Memory is checked through the program itself, because
 * registers are the only memory view this adapter reports.
 */
export type StepSnapshot = {
  frameCount: number;
  frames: string[];
  registers: { [register: string]: string };
};

async function readIntegerRegisters(session: vscode.DebugSession): Promise<{ [register: string]: string }> {
  const scopes = await session.customRequest('scopes', { frameId: 0 });
  const integerScope = scopes.scopes.find((scope: any) => scope.name === 'Integer');
  assert.ok(integerScope, 'the Integer register scope should be available');
  const variables = await session.customRequest('variables', {
    variablesReference: integerScope.variablesReference
  });
  const registers: { [register: string]: string } = {};
  for (const variable of variables.variables) {
    const match = /^(x\d\d)/.exec(variable.name);
    if (match) {
      registers[match[1]] = variable.value;
    }
  }
  return registers;
}

export async function takeStepSnapshot(session: vscode.DebugSession): Promise<StepSnapshot> {
  const stack = await session.customRequest('stackTrace', { threadId: THREAD_ID });
  return {
    frameCount: stack.totalFrames,
    frames: stack.stackFrames.map((frame: any) =>
      frame.name + ' @ ' + path.basename(frame.source ? frame.source.path : '') + ':' + frame.line),
    registers: await readIntegerRegisters(session)
  };
}

async function waitForStop(transcript: DebugTranscript, request: () => Thenable<any>): Promise<void> {
  const mark = transcript.mark();
  await request();
  await transcript.waitFor(message =>
    message.type === 'event' && message.event === 'stopped' && message.body.reason === 'step', mark);
}

/** Steps over a call: next runs until the current frame is on top again. */
export async function stepOver(session: vscode.DebugSession, transcript: DebugTranscript): Promise<void> {
  await waitForStop(transcript, () => session.customRequest('next', { threadId: THREAD_ID }));
}

/** Steps a single instruction (F11), so one Prev undoes exactly this step. */
export async function stepInto(session: vscode.DebugSession, transcript: DebugTranscript): Promise<void> {
  await waitForStop(transcript, () => session.customRequest('stepIn', { threadId: THREAD_ID }));
}

/** The DAP request behind the editor Prev button. */
export async function stepBackward(session: vscode.DebugSession, transcript: DebugTranscript): Promise<void> {
  await waitForStop(transcript, () => session.customRequest('stepBack', { threadId: THREAD_ID }));
}