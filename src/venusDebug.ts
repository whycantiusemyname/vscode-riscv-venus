/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, ExitedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, Variable, ContinuedEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import path, { basename } from 'path';
import { VenusBreakpoint, VenusRuntime, VenusSettings } from './venusRuntime';
import { workspace, languages, Disposable, window, ViewColumn, TextEditor, commands, Uri, TextDocument } from 'vscode';
import { AssemblyView, riscvDisassemblyProvider } from './assemblyView';
import { DisassemblyDecoratorProvider } from './assemblyDecorator';
import * as helpers from './venusHelpers';
import { VenusRenderer } from './venusRenderer';
import { VenusLedMatrixUI, Color, LedMatrix, UIState } from './ledmatrix/venusLedMatrixUI';
import { VenusRobotUI } from './robot/venusRobotUI';
import { VenusSevenSegBoardUI } from './sevensegboard/venusSevenSegBoardUI';
import { MemoryUI } from './memoryui/memoryUI';
import { venusTerminal } from './terminal/venusTerminal';
import { JsonObjectExpression } from 'typescript';
import { Subject } from 'await-notify';

const riscvAsmScheme = 'venus_asm';

// Label -> ABI name for the integer registers of the Variables view. The
// labels are shown as "x05 (t0)" and the same table is used to resolve the ABI
// names that CS61C programs are written with.
const regNames = new Map(helpers.integerRegisterAbiNames.map(
	(name, id) => [id.toString(), name] as [string, string]
));

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * This interface describes the debug-specific launch attributes (which are not
 * part of the Debug Adapter Protocol). The schema for these attributes lives in
 * the package.json of the extension. The interface should always match this
 * schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** If we should stop at Breakpoints. If set false the program executes without debugging. */
	stopAtBreakpoints?: boolean;
	/** Arguments passed to the simulated program. */
	args?: string[];
	/** Working directory used to resolve relative program paths and file access. */
	cwd?: string;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** open views on start */
	openViews?: string[];
	/** The ledMatrix Size as an Json Object in the format {"x": 10, "y": 10} */
	ledMatrixSize?;
}

export class VenusDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static _threadId = 1;
	// Upper bound for a single memory request. VS Code asks for one page at a
	// time, and Venus memory is a hash map, so an unbounded read would be a
	// cheap way to hang the adapter.
	private static readonly MAX_MEMORY_BYTES_PER_REQUEST = 4096;
	// a Mock runtime (or debugger)
	private _runtime: VenusRuntime;
	private _variableHandles = new Handles<string>();
	private _configurationDone = new Subject();

	private _cancelationTokens = new Map<number, boolean>();
	//private _isLongrunning = new Map<number, boolean>();

	private _reportProgress = false;
	private _progressId = 10000;
	private _cancelledProgressId: string | undefined = undefined;
	private _isProgressCancellable = true;

	// A session reports the exit status once. The flag is cleared for every
	// launch so a newly assembled program cannot inherit the previous status.
	private _exitCodeReported = false;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses 1-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(false);
		this._runtime = new VenusRuntime();

		workspace.onDidChangeConfiguration(e => {
			if (e != null) {
				this.sendEvent(new StoppedEvent('settings changed', VenusDebugSession._threadId));
			}
		});
		// setup event handlers
		// Can listen to this events with DebugAdapterTracker: https://code.visualstudio.com/api/references/vscode-api#DebugAdapterTracker
		this._runtime.on('stopOnEntry', () => {
			this.updateAssemblyViewDecorator();
			this.sendEvent(new StoppedEvent('entry', VenusDebugSession._threadId));
		});
		this._runtime.on('stopOnStep', () => {
			this.updateAssemblyViewDecorator();
			this.sendEvent(new StoppedEvent('step', VenusDebugSession._threadId));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.updateAssemblyViewDecorator();
			this.sendEvent(new StoppedEvent('breakpoint', VenusDebugSession._threadId));
		});
		this._runtime.on('stopOnPause', () => {
			this.updateAssemblyViewDecorator();
			this.sendEvent(new StoppedEvent('pause', VenusDebugSession._threadId));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', VenusDebugSession._threadId));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', VenusDebugSession._threadId));
		});
		this._runtime.on('breakpointValidated', (bp: VenusBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('continue', () => {
			this.sendEvent(new ContinuedEvent(VenusDebugSession._threadId, true));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);

			if (text === 'start' || text === 'startCollapsed' || text === 'end') {
				e.body.group = text;
				e.body.output = `group-${text}\n`;
			}

			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			const exitCode = this._runtime.getExitCode();
			if (exitCode !== null && !this._exitCodeReported) {
				this._exitCodeReported = true;
				this.sendEvent(new ExitedEvent(exitCode));
			}
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 * https://microsoft.github.io/debug-adapter-protocol/specification
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// the adapter supports changing register values.
		response.body.supportsSetVariable = true;

		// the adapter implements the memory requests that VS Code's memory view
		// (and the hex editor) uses to display and edit simulator memory.
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = false;

		// TODO Test if this works reliably now
		response.body.supportsRestartRequest = false;
		// Doesn't seem to be supported for now
		// response.body.supportsDisassembleRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// Every launch starts a new program, so it gets a fresh exit status.
		this._exitCodeReported = false;

		venusTerminal.appendText('\n');
		venusTerminal.appendText(`-------------------------------------------------------------------------------------------\n`);
		venusTerminal.appendText(`Starting program ${args.program}\n`);
		venusTerminal.appendText('\n');

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// Sometimes the Venus Options Menu is not shown.(Vscode Bug?) This makes sure it is shown at least when we start debug
		commands.executeCommand('setContext', 'venus:showOptionsMenu', true);

		// Resolve the program against the configured working directory so that a
		// relative program behaves like `venus.jar -wd <dir> <program>`.
		const cwd = args.cwd ? path.resolve(args.cwd) : undefined;
		const program = path.isAbsolute(args.program) ? args.program : path.resolve(cwd ?? process.cwd(), args.program);

		// Here we send to programm to be assembled
		const assembled = this._runtime.assemble(program, basename(program), this.getSettings(), args.args || [], cwd);
		if (!assembled) {
			response.success = false;
			response.message = `Unable to assemble ${args.program}`;
			this.sendResponse(response);
			this.sendEvent(new TerminatedEvent());
			return;
		}
		this._runtime.setStopAtBreakpoint(args.stopAtBreakpoints !== false);

		if (args.ledMatrixSize && args.ledMatrixSize.x && args.ledMatrixSize.y) {
			VenusLedMatrixUI.createNewInstance(undefined, new UIState(new LedMatrix(args.ledMatrixSize.x, args.ledMatrixSize.y)));
		}

		VenusRuntime.registerECallReceiver(this.receiveEcall);
		this.resetViews();

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(5000);

		args.openViews?.forEach(view => {
			this.openView(view);
		});

		// start the program in the runtime
		this._runtime.start(args.stopOnEntry ? args.stopOnEntry : false);

		response.success = true;
		this.sendResponse(response);


	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path = helpers.toPosixPath(<string>args.source.path);
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id= id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(VenusDebugSession._threadId, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stk = this._runtime.stack(startFrame, endFrame);

		response.body = {
			stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
			totalFrames: stk.count
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("PC", this._variableHandles.create("pc"), false),
				new Scope("PRIV", this._variableHandles.create("priv"), false),
				new Scope("CSR", this._variableHandles.create("csr"), false),
				new Scope("Integer", this._variableHandles.create("integer"), false),
				new Scope("Float", this._variableHandles.create("float"), false)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];
		let format = workspace.getConfiguration('riscv-venus').get('variableFormat');
		let formatFunction: (para: number) => string = this.getFormatFunction();
		let floatFormatFunction: (decimal: any) => string = this.getFloatFormatFunction();

		const id = this._variableHandles.get(args.variablesReference);

		if (id === "integer") {
			const registers = this._runtime.getRegisters();
			registers.forEach(reg => {
				variables.push({
					name: "x" + reg.id.toString().padStart(2,'0') + (" (" + regNames.get(reg.id.toString()) + ")").padEnd(7, " "),
					type: "hex",
					value: formatFunction(reg.value),
					variablesReference: 0,
					indexedVariables: 0,
					namedVariables: 0,
				});
			});
		} else if (id === "float") {

			const fRegisters = this._runtime.getFRegisters();
			var value;
			fRegisters.forEach(reg => {
				if (reg.value.isFloat) {
					value = reg.value.float;
				} else {
					value = reg.value.double;
				}
				variables.push({
					name: "f" + reg.id.toString().padStart(2,'0'),
					type: "hex",
					value: floatFormatFunction(reg.value),
					variablesReference: 0,
					indexedVariables: 0,
					namedVariables: 0,
				});
			});
		} else if (id === "pc") {
			variables.push({
				name: "PC",
				type: "hex",
				value: formatFunction(this._runtime.getPC()),
				variablesReference: 0,
				indexedVariables: 0,
				namedVariables: 0,
			 });
		} else if (id === "priv") {
			variables.push({
				name: "PRIV",
				type: "hex",
				value: "0x" + this._runtime.getPRIV().toString(),
				variablesReference: 0,
				indexedVariables: 0,
				namedVariables: 0,
			});
		} 
		else if (id === "csr") {
			 const registers = this._runtime.getCsrRegisters();
			 registers.forEach(reg => {
				 variables.push({
					 name: reg.name.padEnd(8, " "),
					 type: "hex",
					 value: formatFunction(reg.value),
					 variablesReference: 0,
					 indexedVariables: 0,
					 namedVariables: 0,
				 });
			 });			 
		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void {
		// The names come from the Variables view, which labels integer
		// registers "x05 (t0)   ", float registers "f05" and CSRs "mstatus ".
		const format = workspace.getConfiguration('riscv-venus').get<string>('variableFormat');
		const register = helpers.parseRegisterName(args.name);

		if (register !== undefined && register.kind === 'integer') {
			const parsedInt = helpers.parseVenusValue(args.value, format);
			if (parsedInt === undefined) {
				response.success = false;
				response.message = `The specified value '${args.value}' for the register could not be interpreted as an integer in the '${format}' number format`;
			} else {
				this._runtime.setRegister(register.id, parsedInt);
				// Report the value that the simulator really holds, so editing
				// x0 (which the ISA hardwires to zero) shows the truth.
				response.body = { value: this.getFormatFunction()(this._runtime.getRegister(register.id).value) };
			}
		} else if (register !== undefined) {
			const parsedFloat = parseFloat(args.value);
			if (isNaN(parsedFloat)) {
				response.success = false;
				response.message = `The specified value '${args.value}' for the register could not be interpreted as a float`;
			} else {
				this._runtime.setFRegister(register.id, parsedFloat);
				response.body = { value: this.getFloatFormatFunction()(this._runtime.getFRegister(register.id).value) };
			}
		} else if (this.getCsrName(args.name) !== undefined) {
			const csr = this.getCsrName(args.name)!;
			const parsedInt = helpers.parseVenusValue(args.value, format);
			if (parsedInt === undefined) {
				response.success = false;
				response.message = `The specified value '${args.value}' for the register could not be interpreted as an integer in the '${format}' number format`;
			} else {
				this._runtime.setCsrRegisterByName(csr, parsedInt);
				response.body = { value: this.getFormatFunction()(this._runtime.getCsrRegisterByName(csr)) };
			}
		} else {
			response.success = false;
			response.message = `'${args.name}' is not a writable register: only integer registers (x0-x31 or their ABI names) and float registers (f0-f31) can be changed`;
		}
		this.sendResponse(response);
		if (response.success) {
			this.sendEvent(new StoppedEvent('setVariable', VenusDebugSession._threadId));
		}
	}

	/**
	 * Reads bytes of the simulated memory. This is the request behind VS
	 * Code's memory/hex view. Venus addresses memory by byte (little endian),
	 * so the returned bytes are exactly the bytes `lw`/`sw` operate on.
	 */
	protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request): void {
		const address = helpers.parseMemoryAddress(args.memoryReference, args.offset);
		const count = Math.floor(args.count);
		if (address === undefined) {
			response.success = false;
			response.message = `Cannot interpret '${args.memoryReference}' as a memory address`;
		} else if (!Number.isFinite(count) || count < 0) {
			response.success = false;
			response.message = `Cannot read '${args.count}' bytes of memory`;
		} else {
			const readable = Math.min(count, VenusDebugSession.MAX_MEMORY_BYTES_PER_REQUEST);
			const body: { address: string, data: string, unreadableBytes?: number } = {
				address: helpers.formatAddress(address),
				data: this._runtime.readMemoryBytes(address, readable).toString('base64'),
			};
			if (readable < count) {
				// The protocol uses this to tell the client where memory stops.
				body.unreadableBytes = count - readable;
			}
			response.body = body;
		}
		this.sendResponse(response);
	}

	/**
	 * Writes bytes of the simulated memory, i.e. the memory view's edit path.
	 * Writes are byte granular so that editing a single byte works, and they
	 * are visible to the program: a word written here is the value the next
	 * `lw` from the same address returns.
	 */
	protected writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments, request?: DebugProtocol.Request): void {
		const address = helpers.parseMemoryAddress(args.memoryReference, args.offset);
		const data = Buffer.from(args.data === undefined ? '' : args.data, 'base64');

		if (address === undefined) {
			response.success = false;
			response.message = `Cannot interpret '${args.memoryReference}' as a memory address`;
		} else if (data.length === 0) {
			response.success = false;
			response.message = 'No bytes to write';
		} else if (this._runtime.isRunning()) {
			response.success = false;
			response.message = 'Memory can only be edited while the program is paused';
		} else if (!this._runtime.canWriteMemoryAt(address, data.length)) {
			response.success = false;
			response.message = `The text segment is immutable (riscv-venus.mutableText is disabled), so '${helpers.formatAddress(address)}' cannot be written`;
		} else {
			response.body = {
				offset: 0,
				bytesWritten: this._runtime.writeMemoryBytes(address, data),
			};
		}
		this.sendResponse(response);
	}

	/** Resolves a CSR name as it appears in the "CSR" scope (e.g. "mstatus "). */
	private getCsrName(name: string): string | undefined {
		const candidate = name.trim().split(/\s+/)[0];
		if (candidate.length === 0) { return undefined; }
		return this._runtime.getCsrRegisterIdByName(candidate) !== -1 ? candidate : undefined;
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		response.body = { allThreadsContinued: true };
		this._runtime.run();
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) {
		this._runtime.pause();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) {
		this._runtime.stepOut();
		this.sendResponse(response);
	}

	/*
		Not yet supported
		see: https://gitlab.lrz.de/riscv/debugger/-/issues/9 Note: old issue
		Supported by the backend but need to make sure that frotend and venusRuntime are compatible.
		Also unclear if we actually need this feature.
	*/
	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		// Reverse continue is deliberately not advertised or emulated.  Running
		// forward here is particularly surprising when the user asked to go back.
		response.success = false;
		response.message = "Reverse Continue is not supported";
		this.sendResponse(response);
 	}

	 /*
	 	Called when clicking step over
	 */
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.stepOver();
		this.sendResponse(response);
	}

	/*
		Called when clicking Prev: the simulator undoes the last executed instruction
		(PC, registers and memory) and venusRuntime restores the source level call stack
		snapshot taken before that instruction. Reverse continue stays unsupported.
	*/
	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		if (!this._runtime.step(true)) {
			// Report the miss instead of silently doing nothing: a client that asked
			// to go back must not be told that it moved.
			response.success = false;
			response.message = 'Step back is not available: the simulator has no recorded instruction to undo.';
		}
		this.sendResponse(response);
	}

	/**
	 * Responsible for showing the value of a register if we hover over it in the editor.
	 * Right now only supports registers.
	 * TODO: Support label and memory addresses in the future
	 */
	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		let reply: string | null = null;
		let regId: number | null = null;

		if (args.context === 'hover') {	
			if (args.expression.startsWith('f')) { // float registers
				if (!isNaN(parseInt(args.expression.replace("f", "")))) {
					let formatFunction = this.getFloatFormatFunction();
					reply = formatFunction(this._runtime.getFRegister(parseInt(args.expression.replace("f", ""))).value);
				}
			} else if (args.expression.startsWith('x')) { // starting with x
				if (!isNaN(parseInt(args.expression.replace("x", "")))) {
					let formatFunction = this.getFormatFunction();
					reply = formatFunction(this._runtime.getRegister(parseInt(args.expression.replace("x", ""))).value);
				}
			} else if (args.expression.startsWith("m")) {
				let name = args.expression.split(/ /)
				if (name != null) {
					if(this._runtime.getCsrRegisterIdByName(name[0]) != -1 ) {
						// now we really have a valid CSR (e.g. avoid showing stuff on all labels starting with 'm')
						let formatFunction = this.getFormatFunction();
						reply = formatFunction(this._runtime.getCsrRegisterByName(name[0]));
					}
				}
			} else if (!args.expression.match(new RegExp('^\d'))) { // Alternative register labels
				for (let [key, value] of regNames.entries()) {
					if (value === args.expression) {
						regId = parseInt(key);
						break;
					}
				}
				if (regId != null) {
					let formatFunction = this.getFormatFunction();
					reply = formatFunction(this._runtime.getRegister(regId).value);
				}
			}
		}

		response.body = {
			result: reply ? reply : `${args.expression}`,
			variablesReference: 0
		};
		this.sendResponse(response);
	}

	// Unused right now
	private async progressSequence() {

		const ID = '' + this._progressId++;

		await timeout(100);

		const title = this._isProgressCancellable ? 'Cancellable operation' : 'Long running operation';
		const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(ID, title);
		startEvent.body.cancellable = this._isProgressCancellable;
		this._isProgressCancellable = !this._isProgressCancellable;
		this.sendEvent(startEvent);
		this.sendEvent(new OutputEvent(`start progress: ${ID}\n`));

		let endMessage = 'progress ended';

		for (let i = 0; i < 100; i++) {
			await timeout(500);
			this.sendEvent(new ProgressUpdateEvent(ID, `progress: ${i}`));
			if (this._cancelledProgressId === ID) {
				endMessage = 'progress cancelled';
				this._cancelledProgressId = undefined;
				this.sendEvent(new OutputEvent(`cancel progress: ${ID}\n`));
				break;
			}
		}
		this.sendEvent(new ProgressEndEvent(ID, endMessage));
		this.sendEvent(new OutputEvent(`end progress: ${ID}\n`));

		this._cancelledProgressId = undefined;
	}

	// Unused right now
	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
            dataId: null,
            description: "cannot break on data access",
            accessTypes: undefined,
            canPersist: false
        };

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = [ "read" ];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}


	// Unused right now
	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01"
				},
				{
					label: "item 2",
					sortText: "02"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancelationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId= args.progressId;
		}
	}
	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
		
		this._runtime.stop(); // stops current run => stops execution!

		AssemblyView.getInstance().close();		
		
		venusTerminal.appendText('\n');
		venusTerminal.appendText(`Stop program execution!\n`);
		venusTerminal.appendText(`-------------------------------------------------------------------------------------------\n`);		
		venusTerminal.appendText('\n');		
		
		this.sendResponse(response);
	}

	/**
	 * Extension specific introspection used by the acceptance suite and by the
	 * integration layer. It reports the invocation state (entry file, argv and
	 * working directory) the runtime was actually initialised with.
	 */
	protected customRequest(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request): void {
		if (command === 'venus/runtimeInfo') {
			response.body = {
				program: this._runtime.sourceFile,
				programArguments: this._runtime.getProgramArguments(),
				workingDirectory: this._runtime.getWorkingDirectory()
			};
			this.sendResponse(response);
			return;
		}
		super.customRequest(command, response, args, request);
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'venus-adapter-data');
	}

	private async resetViews() {
		VenusLedMatrixUI.getInstance().resetLedMatrix();
		MemoryUI.getInstance().resetMemory();
		VenusRobotUI.getInstance().resetLedMatrix();
		AssemblyView.getInstance().updateDisassemblyView(this._runtime, false);
	}

	/** Opens the view given in "view". The paremeter view maps to the view launch paramter in package.json
	 * TODO: Make the ViewColumn an option.
	*/
	private async openView(view: string) {

		if (view === "LED Matrix")
			{VenusLedMatrixUI.getInstance().show(ViewColumn.Two);}
		else if (view === "Robot")
			{VenusRobotUI.getInstance().show(ViewColumn.Two);}
		else if (view === "Seven Segment Board")
			{VenusSevenSegBoardUI.getInstance().show(ViewColumn.Two);}
		else if (view === "Assembly")
			{AssemblyView.getInstance().show(ViewColumn.Two);}
		else if (view === "Memory")
			{MemoryUI.getInstance().show();}
	}

	/** Updates the Decorators in Assemblyview. This means lines are marked, for example the current active line that is debugged. */
	private updateAssemblyViewDecorator() {
		AssemblyView.getInstance().updateDecorators();
	}

	/**
	 * Takes a (register) value as a number and formats it according to the specified variable Format.
	 * @returns The formated value as string
	 */
	private getFormatFunction(): (para: number) => string{
		let format = workspace.getConfiguration('riscv-venus').get('variableFormat');
		let formatFunction: (para: number) => string;
		switch (format) {
			case "hex": {
				formatFunction = (para: number) => {
					return "0x" + ((para >>> 0).toString(16).toUpperCase().padStart(8, '0'));
				};
				break;
			}
			case "binary": {
				formatFunction = (para: number) => {
					return ((para >>> 0).toString(2).padStart(32, '0'));
				};
				break;
			}
			case "decimal": {
				formatFunction = (para: number) => {
					return para.toString(10);
				};
				break;
			}
			case "ascii": {
				formatFunction = (para: number) => {
					let binary = (para >>> 0).toString(2).padStart(32, '0');
					// Split string into
					let asciiBin = binary.match(/.{8}/g);
					if (asciiBin != null) {
						return String.fromCharCode(parseInt(asciiBin[0], 2)) + String.fromCharCode(parseInt(asciiBin[1], 2)) +
							String.fromCharCode(parseInt(asciiBin[2], 2)) + String.fromCharCode(parseInt(asciiBin[3], 2));
					}
					return '';
				};
				break;
			}
			default: {
				formatFunction = (para: number) => {
					return "0x" + (para >>> 0).toString(16);
				};
				break;
			}
		}

		return formatFunction;
	}

	/**
	 * Takes a float (register) value as a number and formats it according to the specified variable Format.
	 * @returns The formated float value as string
	 */
	private getFloatFormatFunction(): (decimal: any) => string{
		let format = workspace.getConfiguration('riscv-venus').get('variableFormat');
		let floatFormatFunction: (decimal: any) => string;
		switch (format) {
			case "hex": {
				floatFormatFunction = (decimal: any) => {
					return decimal.toHex();
				};
				break;
			}
			case "binary": {
				floatFormatFunction = (decimal: any) => {
					return decimal.toHex();
				};
				break;
			}
			case "decimal": {
				floatFormatFunction = (decimal: any) => {
					return decimal.toDecimal();
				};
				break;
			}
			case "ascii": {
				floatFormatFunction = (decimal: any) => {
					return decimal.toAscii();
				};
				break;
			}
			default: {
				floatFormatFunction = (decimal: any) => {
					return decimal.toHex();
				};
				break;
			}
		}
		return floatFormatFunction;
	}


	/**
	 * 
	 * This function is called by the backend to handle the ecall.
	 * When the ecalled is handled sends back a json with new values (optional) for registers a0 and a1.
	 * 
	 * @param json A json with information about the ecall
	 * @returns A Json with values for registers a0 and a1
	 */
	private receiveEcall(json: string) : string {
		let jString = json;
		let jsonObj = JSON.parse(jString);
		let result = {};
		if ((jsonObj.id >= 0x100) && (jsonObj.id <= 0x101)) {
			result = VenusLedMatrixUI.getInstance().ecall(jsonObj.id, jsonObj.params);
			result["handlerFound"] = true
		} else if (jsonObj.id === 0x110) {
			result = VenusRobotUI.getInstance().ecall(jsonObj.id, jsonObj.params);
			result["handlerFound"] = true
		} else if ((jsonObj.id >= 0x120) && (jsonObj.id < 0x123)) {
			result = VenusSevenSegBoardUI.getInstance().ecall(jsonObj.id, jsonObj.params);
			result["handlerFound"] = true
		} else if (jsonObj.id === 0x130) {
			venusTerminal.activateInput();
			venusTerminal.show();
			result["handlerFound"] = true
		} else if (jsonObj.id === 0x131) {
			let char = venusTerminal.consumeInputBuffer();
			if (char === null) {
				if (venusTerminal.waitingForInput()) {
					result = {"a0": 0x00000001};
				} else {
					result = {"a0": 0x00000000};
				}
			} else {
				let charCode = char.charCodeAt(0) & 0x0FFFFFFF;
				result = {"a0": 0x00000002,
						"a1": charCode | 0x00000000,};
			}
			result["handlerFound"] = true
		}
		else {
			result["handlerFound"] = false
		}

		return JSON.stringify(result);
	}

	/**
	 * Reads the configuration of the extension settings and wraps it into a VenusSettings object.
	 * Note: Reads the extension settings, not the launch attributes in launch.json.
	 * 
	 * @returns A initialized VenusSettings object
	 */
	private getSettings(): VenusSettings{
		let simSettings: VenusSettings = new VenusSettings();

		simSettings.alignedAddress = workspace.getConfiguration('riscv-venus').get('forceAlignedAddressing');
		simSettings.mutableText = workspace.getConfiguration('riscv-venus').get('mutableText');
		simSettings.ecallOnlyExit = workspace.getConfiguration('riscv-venus').get('ecallOnlyExit');
		simSettings.setRegesOnInit = workspace.getConfiguration('riscv-venus').get('setRegesOnInit');
		simSettings.allowAccessBtnStackHeap = workspace.getConfiguration('riscv-venus').get('allowAccessBtnStackHeap');
		simSettings.maxSteps = workspace.getConfiguration('riscv-venus').get('maxSteps');
		simSettings.onlyShowUsedRegs = workspace.getConfiguration('riscv-venus').get('onlyShowUsedRegs');

		return simSettings;
	}
}
