/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import simulator = require('./runtime/riscvSimulator');
import range from 'lodash/range';
import { VenusRenderer } from './venusRenderer';
import { MemoryUI } from './memoryui/memoryUI';
import { clearTimeout } from 'timers';
import * as helpers from './venusHelpers';

import SortedSet from 'js-sorted-set';

export interface VenusBreakpoint {
	id: number;
	line: number;
	verified: boolean;
	path: string;
}

export interface Register {
	id: number;
	value: number;
}

export class VenusSettings {
	alignedAddress: boolean | undefined;
    mutableText: boolean | undefined;
    ecallOnlyExit: boolean | undefined;
    setRegesOnInit: boolean | undefined;
    maxSteps: number | undefined;
    allowAccessBtnStackHeap: boolean | undefined;
	onlyShowUsedRegs: boolean | undefined;
}
/**
 * This interface holds the data that a AssemblyLine contains
 */
export interface AssemblyLine {
	pc: number;
    mCode: number;
	basicCode: string;
	assemblyViewLine: number;
	sourcePath: string;
	sourceLine: number;
}

export interface CallStackItem {
	index: number;
	name: string;
	file: string;
	line: number;
}

enum EscapeCondidtion {
	continue,
	stepOver,
	stepOut,
}

/**
 * This Runtime communicates between vscode and the venus Simulator
 */
export class VenusRuntime extends EventEmitter {

	// the initial file we are 'debugging'
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	// This stack keeps track of the functions we jumped from
	private _functionStack = new Array<CallStackItem>();
	// A stack snapshot for every instruction executed through this runtime.  The
	// simulator can undo registers and memory, but it has no notion of the
	// debugger's source-level call stack, so restoring this snapshot is the only
	// reliable way to unwind it (rather than trying to infer a call from the
	// instruction at the new PC).
	private _stackHistory = new Array<CallStackItem[]>();
	// Snapshots are small, but an unbounded run must not grow the history without
	// limit.  Dropping the *oldest* snapshots keeps step back correct: Prev always
	// rewinds the newest step first, and once the retained window is exhausted the
	// request is refused instead of restoring an unrelated call stack.
	private static readonly _maxStackHistory = 20000;

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, VenusBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _onlyShowUsedRegs = false;

	private _usedRegisters = new SortedSet();

	private _maximumLineNumber = new Map<string, number>();
	private _activeBreakpointPcs = new Map<number, number>();
	private _pauseRequested = false;

	// Program invocation state. The simulator owns argv/argc, but the debugger
	// keeps its own copy so launch parameters can be observed (and asserted)
	// through the adapter instead of re-reading the shared fake DOM.
	private _programArguments: string[] = [];
	private _workingDirectory: string | undefined;

	constructor() {
		super();
		VenusRenderer.getInstance().setRuntime(this);
	}

	private _stopAtBreakpoint = true;

	private sourceLineToPc: Map<string, number[]> = new Map<string, number[]>();
	private pcToAssemblyLine: Map<number, AssemblyLine> = new Map<number, AssemblyLine>();

	/**
	 * Start executing the given program.
	 */
	public start(stopOnEntry: boolean) {
		if (stopOnEntry) {
			this.updateStack();
			this.sendEvent('stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.run();
		}
	}

	public assemble(fpath: string, fName: string, settings: VenusSettings, programArgs: string[] = [], workingDirectory?: string): boolean {
		try {
			this.applySettings(settings);
			// argv is initialised by the Venus core from the ArgsList DOM value,
			// so record the exact arguments handed to it. The working directory
			// defaults to the program directory: that is the directory the
			// course test-src drivers expect relative paths in.
			this._programArguments = programArgs.slice();
			this.setWorkingDirectory(workingDirectory ?? dirname(fpath));
			simulator.frontendAPI.setArgs(this._programArguments);
			let text: string = readFileSync(fpath).toString();
			// Feed Venus the same canonical path we use for source maps. On Windows
			// this also normalizes an uppercase drive (C:) to the drive form handled
			// by the legacy VFS when resolving relative .import directives.
			let posixPath = helpers.canonicalSourcePath(fpath);
			// Project 2 programs read and write real files (ecalls 13/14/15/16) and .import files
			// live next to the program, so point the core at that directory before assembling.
			this.enableHostFileIO(fpath);
			var[success, error, warnings] = simulator.driver.externalAssemble(text, posixPath, fName);
			if (!success) {
				VenusRenderer.getInstance().showErrorWithPopup(error);
				return false;
			}
			for (let warn of warnings.toArray()) {
				VenusRenderer.getInstance().printWarning(warn.toString());
			}

			this.getAssemblyLines();
			this._sourceFile = fpath;
			this._functionStack = [];
			this._stackHistory = [];
			this.reapplyBreakpoints();
			return true;
		} catch (e: unknown) {
			VenusRenderer.getInstance().showErrorWithPopup(e);
			return false;
		}
	}

	/**
	 * Opts the Venus core into host file I/O for the session that is about to be assembled.
	 *
	 * The binary-safe host file bridge only exists once the patches in test/native/patches have
	 * been applied and the core rebuilt; see test/native/HOST-BINARY-FILE-IO.md. Both entry points
	 * are looked up defensively, so a core without them keeps its previous behaviour: ecalls
	 * 13/14/15/16 and .import stay on the in-memory VFS.
	 */
	private enableHostFileIO(fpath: string) {
		const driver: any = simulator.driver;
		if (typeof driver.setHostFileCwd !== 'function' || typeof driver.enableHostFileIO !== 'function') {
			return;
		}
		const cwd = dirname(fpath);
		if (cwd) {
			driver.setHostFileCwd(cwd);
		}
		driver.enableHostFileIO(true);
	}

	/** Restores the default VFS file backend; harmless on a core without the host file API. */
	private disableHostFileIO() {
		const driver: any = simulator.driver;
		if (typeof driver.enableHostFileIO === 'function') {
			driver.enableHostFileIO(false);
		}
	}

	private applySettings(settings: VenusSettings) {
		if (settings.alignedAddress !== undefined) {
			simulator.driver.simSettings.alignedAddress = settings.alignedAddress;
		}
		if (settings.mutableText !== undefined) {
			simulator.driver.simSettings.mutableText = settings.mutableText;
		}
		if (settings.ecallOnlyExit !== undefined) {
			simulator.driver.simSettings.ecallOnlyExit = settings.ecallOnlyExit;
		}
		if (settings.setRegesOnInit !== undefined) {
			simulator.driver.simSettings.setRegesOnInit = settings.setRegesOnInit;
		}
		if (settings.maxSteps !== undefined) {
			simulator.driver.simSettings.maxSteps = settings.maxSteps;
		}
		if (settings.allowAccessBtnStackHeap !== undefined) {
			simulator.driver.simSettings.allowAccessBtnStackHeap = settings.allowAccessBtnStackHeap;
		}

		if (settings.onlyShowUsedRegs !== undefined) {
			this._onlyShowUsedRegs = settings.onlyShowUsedRegs;
		}
	}



	private getAssemblyLines(){
		this.pcToAssemblyLine.clear();
		this.sourceLineToPc.clear();
		this._maximumLineNumber.clear();
		// externalAssemble creates a new Simulator, whose breakpoint set is empty.
		this._activeBreakpointPcs.clear();
		let instructions = simulator.driver.getInstructions();

		for (let i = 0; i < instructions.length; i++) {
			const sourcePath = helpers.canonicalSourcePath(instructions[i].sourceFile);
			const currentMaximumLine = this._maximumLineNumber.get(sourcePath);
			if(!currentMaximumLine || currentMaximumLine < instructions[i].line) {
				this._maximumLineNumber.set(sourcePath, instructions[i].line);
			}
			let assemblyLine: AssemblyLine = {pc: instructions[i].pc, mCode: instructions[i].mcode, basicCode: instructions[i].basicCode, assemblyViewLine: 0, sourceLine: instructions[i].line, sourcePath};
			this.pcToAssemblyLine.set(instructions[i].pc, assemblyLine);
			let sourceIdent = this.createSourcelineString(sourcePath, instructions[i].line);
			if (this.sourceLineToPc.has(sourceIdent)) {
				this.sourceLineToPc.get(sourceIdent)!.push(instructions[i].pc);
			} else {
				this.sourceLineToPc.set(sourceIdent, [instructions[i].pc]);
			}
		}
	}


	/** Creates a sourceLine identifier for debugging: C://exampledir/example.file:5 5 == linenumber */
	private createSourcelineString(path: string, line: number): string {
		return helpers.canonicalSourcePath(path) + ':' + Math.round(line).toString();
	}

	public getPcToAssemblyLine(): Map<number, AssemblyLine> {
		return this.pcToAssemblyLine;
	}

	public getCurrentAssemlyLineNo(): number {
		if (this.pcToAssemblyLine.has(simulator.driver.sim.getPC())) {
			return this.pcToAssemblyLine.get(simulator.driver.sim.getPC())!.assemblyViewLine;
		} else {
			return 0;
		}
	}

	public getPC(): number {
		return simulator.driver.sim.getPC();
	}

	public getPRIV(): number {
		return simulator.driver.sim.getPRIV();
	}

	/**
	 * The program arguments the last assemble was initialised with. The
	 * simulated program sees these as argv (argv[0] is the program name).
	 */
	public getProgramArguments(): string[] {
		return this._programArguments.slice();
	}

	/**
	 * The working directory relative program paths are resolved against. The
	 * host-disk bridge consumes this value as well.
	 */
	public getWorkingDirectory(): string | undefined {
		return this._workingDirectory;
	}

	/**
	 * Sets the working directory used for relative path resolution. The value is
	 * canonicalised like source paths so it can be compared with the paths the
	 * simulator reports.
	 */
	public setWorkingDirectory(dir: string): void {
		if (!dir) { return; }
		this._workingDirectory = helpers.canonicalSourcePath(dir);
		try {
			// Publish the value on the driver so the (separately owned) host file
			// bridge can pick it up without another plumbing channel.
			(simulator.driver as any).workingDirectory = this._workingDirectory;
		} catch (e) {
			// The driver is a compiled Kotlin object; this is best effort only.
		}
	}

	public useRegister(id: number) {
		if (!this._usedRegisters.contains(id)) {
			this._usedRegisters.insert(id);
		}
	}

	/**
	 * Returns the common registers
	 * No float registeres included
	 */
	public getRegisters(): Register[] {
		if (this._onlyShowUsedRegs) {
			return this._usedRegisters.map(id => {
				return {
					id,
					value: simulator.driver.getRegister(id)
				};
			});				
		} else {
			return range(0,32).map(id => {
				return {
					id,
					value: simulator.driver.getRegister(id)
				};
			});	
		}
	}


	public getRegister(id: number): Register {
		return {
			id,
			value: simulator.driver.getRegister(id)
		};
	}

	/**
	 * Returns the float registers
	 */
	public getFRegisters() {
		return range(0,32).map(id => {
			return {
				id,
				value: simulator.driver.getFRegister(id)
			};
		});
	}

	public getFRegister(id: number): Register {
		return {
			id,
			value: simulator.driver.getFRegister(id)
		};
	}

	/**
	 * Returns all the CSR registers
	 */
	public getCsrRegisters() {
		var csrRegs = simulator.driver.getCsrRegisterNames();
		return csrRegs.map(name => {
			return {
				name: name,
				value: simulator.driver.getCsrRegisterByName(name)
			};
		});
	}

	/**
	 * Get a CSR Register from the simulator.
	 * 
	 * @param id The CSR register id (addr)
	 */
	// public getCsrRegister(id: number): Register {
	// 	return {
	// 		id,
	// 		value: simulator.driver.getCsrRegister(id)
	// 	};
	// }

	/**
	 * Get a CSR Register value by Name.
	 * 
	 * @param name The CSR register name
	 */
	 public getCsrRegisterByName(name: string): number {
		return simulator.driver.getCsrRegisterByName(name);
	}
	
	/**
	 * Get a CSR Register id (addr) by Name.
	 * 
	 * @param id The CSR register id (name)
	 */
	public getCsrRegisterIdByName(name: string): number {
		return simulator.driver.getCsrRegisterIdByName(name);
	}
	
	
	/**
	 * Get a CSR Register names.
	 * 
	 * @param id The CSR register id (name)
	 */
	//  public getCsrRegisterNames(): Array<String> {
	// 	return simulator.driver.getCsrRegisterNames();
	// }

	/**
	 * Sets an int Register in the simulator.
	 * Automatically transforms value into an 32bit signed integer
	 * If value is bigger then INT_MAXVALUE the value is wrapping around according to two-complement format.
	 * @param reg The register with value
	 */
	public setRegister(id: number, value: number) {
		if (Number.isInteger(id) && Number.isInteger(value)) {
			let pureInt = value;
			let twoComplementInt = ~~pureInt; // ~~ "Trick" taken from https://stackoverflow.com/a/37022667
			simulator.driver.setRegister(id, twoComplementInt);
		}
	}

	/**
	 * Sets a float Register in the simulator.
	 * Make sure the register value is float.
	 * @param reg The register with value
	 */
	public setFRegister(id: number, value: number) {
		if (Number.isInteger(id) && Number.isFinite(value)) {
			simulator.driver.setFRegister(id, value);
		}
	}

	/**
	 * Sets an CSR Register in the simulator.
	 * Automatically transforms value into an 32bit signed integer
	 * If value is bigger then INT_MAXVALUE the value is wrapping around according to two-complement format.
	 * @param reg The register with value
	 */
	//  public setCsrRegister(id: number, value: number) {
	// 	if (Number.isInteger(id) && Number.isInteger(value)) {
	// 		let pureInt = value;
	// 		let twoComplementInt = ~~pureInt; // ~~ "Trick" taken from https://stackoverflow.com/a/37022667
	// 		simulator.driver.setCsrRegister(id, twoComplementInt);
	// 	}
	// }	

	/**
	 * Sets an CSR Register by Name in the simulator.
	 * Automatically transforms value into an 32bit signed integer
	 * If value is bigger then INT_MAXVALUE the value is wrapping around according to two-complement format.
	 * @param reg The register with value
	 */
	 public setCsrRegisterByName(name: string, value: number) {
		let pureInt = value;
		let twoComplementInt = ~~pureInt; // ~~ "Trick" taken from https://stackoverflow.com/a/37022667
		simulator.driver.setCsrRegisterByName(name, twoComplementInt);
	}

	/** True while the simulator runs, i.e. while its state must not be edited. */
	public isRunning(): boolean {
		return simulator.driver.currentlyRunning();
	}

	/**
	 * Exclusive end of the assembled text segment, or undefined when nothing
	 * has been assembled yet.
	 */
	public getTextEnd(): number | undefined {
		let textEnd: number | undefined = undefined;
		this.pcToAssemblyLine.forEach(line => {
			const end = line.pc + 4;
			if (textEnd === undefined || end > textEnd) {
				textEnd = end;
			}
		});
		return textEnd;
	}

	/** Whether Venus is allowed to overwrite the text segment. */
	public isMutableText(): boolean {
		return simulator.driver.simSettings.mutableText !== false;
	}

	/**
	 * Mirrors Venus' immutable-text rule for writes that come from the
	 * debugger: the text segment may only be changed while the text is mutable.
	 */
	public canWriteMemoryAt(address: number, byteCount: number): boolean {
		if (this.isMutableText()) { return true; }
		const textEnd = this.getTextEnd();
		return textEnd === undefined || !helpers.overlapsImmutableText(textEnd, address, byteCount);
	}

	/**
	 * Reads raw bytes from the simulator memory. Venus memory is byte addressed
	 * and little endian, so these bytes are exactly the bytes that `lw`/`sw`
	 * operate on.
	 */
	public readMemoryBytes(address: number, byteCount: number): Buffer {
		const count = Math.max(0, Math.floor(byteCount));
		const bytes = Buffer.alloc(count);
		for (let i = 0; i < count; i++) {
			bytes[i] = simulator.driver.loadByte((address + i) | 0) & 0xff;
		}
		return bytes;
	}

	/**
	 * Writes raw bytes into the simulator memory (byte granular, little
	 * endian), then refreshes the memory view.
	 *
	 * @returns the number of bytes written
	 */
	public writeMemoryBytes(address: number, data: Buffer): number {
		for (let i = 0; i < data.length; i++) {
			simulator.driver.storeByte((address + i) | 0, data[i]);
		}
		this.updateMemory();
		return data.length;
	}

	/**
	 * Sets if the runtime should stop at Breakpoints
	 * @param value If true the runtime stops at Breakpoints
	 */
	public setStopAtBreakpoint(value: boolean) {
		this._stopAtBreakpoint = value;
	}


	/**
	 * Step to the next/previous non empty line. Also steps into functions
	 * @returns false when a reverse step was requested but cannot be honoured
	 */
	public step(reverse = false): boolean {
		// A step request can arrive while a run loop is still scheduled. Stop
		// that loop silently first so exactly one instruction is executed.
		this.cancelRun();
		this._pauseRequested = false;
		if (reverse) {
			if (!this.canStepBack()) {
				return false;
			}
			simulator.driver.undo();
			this._functionStack = this._stackHistory.pop()!;
			this.reindexStack();
		} else {
			this.executeStep();
		}
		this.updateMemory();
		if (simulator.driver.isFinished()) {
			this.sendEvent('end');
		} else {
			this.sendEvent('stopOnStep');
		}
		return true;
	}

	/**
	 * True when the previously executed instruction can be undone.  Both histories
	 * have to agree: without a snapshot for that instruction the source level call
	 * stack cannot be unwound, and without an entry in the simulator's own undo
	 * history (empty, trimmed, or disabled through the Venus history limit) there is
	 * no register/memory state to restore.
	 */
	public canStepBack(): boolean {
		return this._stackHistory.length > 0 && simulator.driver.sim.canUndo();
	}

	/**
	 * Steps to the next instruction. Doesn't jump into functions
	 */
	public stepOver() {		
		this.initiateRun(EscapeCondidtion.stepOver);
	}

	/**
	 * Step out of the current function
	 */
	public stepOut() {
		this.initiateRun(EscapeCondidtion.stepOut);
	}

	/** Run until end or breakpoint */
	public run() {
        this.initiateRun(EscapeCondidtion.continue);
    }

	/** Pause a running program without terminating the debug session. */
	public pause() {
		if (simulator.driver.timer == null) {
			// Nothing is running: do not latch a pause flag that would abort a
			// later run and make the following continue look like a no-op.
			return;
		}
		this._pauseRequested = true;
		this.runEnd(true);
	}

	/** Stops the scheduled run loop without reporting a stop to the frontend. */
	private cancelRun() {
		if (simulator.driver.timer != null) {
			clearTimeout(simulator.driver.timer);
			simulator.driver.timer = null;
		}
	}

	/**
	 * Stop execution
	 */
	public stop() {
		this.disableHostFileIO();
        simulator.driver.handleNotExitOver();
		this.cancelRun();
		this._pauseRequested = false;
		this.sendEvent('end');
	}

	// In the following the run functions are declared
	// The run operation is split into multiple functions because we can't block the Javascript event loop
	// If we block the event loop the simulator can't respond

	static readonly _timeoutTime = 10;
	static readonly _timeoutCycles = 100;

	/** This starts a long running code sequence, for example when clickling continue in the UI */
	public initiateRun(escapeCondition: EscapeCondidtion) {
        if (simulator.driver.timer != null) {
			// A run loop is already scheduled. A duplicate resume/step request
			// must not stop the program or emit a bogus stop event: the target
			// is already running exactly as requested.
			return;
        }
		this._pauseRequested = false;
        try {
				switch (escapeCondition) {
					case EscapeCondidtion.continue:
						this.runStep(); // walk past breakpoint
                		simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime._timeoutTime, EscapeCondidtion.continue);
						break;
					case EscapeCondidtion.stepOver:
						let desiredStackDepth = this._functionStack.length; // Need to set desired stack depth before stepping. Stack size can change when stepping
						this.runStep(); // walk past breakpoint
						simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime._timeoutTime, EscapeCondidtion.stepOver, desiredStackDepth);
						break;
					case EscapeCondidtion.stepOut:
						let desStackDepth = this._functionStack.length - 1; // Need to set desired stack depth before stepping. Stack size can change when stepping
						this.runStep(); // walk past breakpoint
						if (desStackDepth <= 0) { // If we are in the main function we can't step out, we run with continue. TODO: Evaluate if this is the wanted behaviour
							simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime._timeoutTime, EscapeCondidtion.continue);
						} else {
							simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime._timeoutTime, EscapeCondidtion.stepOut, desStackDepth);
						}
						break;
				}
			// Tell the frontend the target is running again; otherwise the
			// thread stays marked as stopped until the next stop event.
			this.sendEvent('continue');
            } catch (e) {
                this.runEnd();
                simulator.driver.handleError("initiateRun", e);
            }
    }

	/** Runs a long running code sequence. Timeouts from time to time to not block the event loop */
	private runStart(escapeCondition: EscapeCondidtion, wantedStackDepth?: number) {
        try {
            var cycles = 0;
            while (cycles < VenusRuntime._timeoutCycles) {
				if (this._pauseRequested) {
					this.runEnd(true);
					return;
				}
                switch (escapeCondition) {
					case EscapeCondidtion.continue:
						if (simulator.driver.sim.isDone() || (simulator.driver.sim.atBreakpoint() && this._stopAtBreakpoint)) {
							simulator.driver.exitcodecheck();
							this.runEnd();
							return;
						}
						break;
					case EscapeCondidtion.stepOver:
						if (simulator.driver.isFinished() || (this._functionStack.length <= wantedStackDepth!)) {
							simulator.driver.exitcodecheck();
							this.runEnd();
							return;
						}
						break;
					case EscapeCondidtion.stepOut:
						if (simulator.driver.isFinished() || (this._functionStack.length <= wantedStackDepth!)) {
							simulator.driver.exitcodecheck();
							this.runEnd();
							return;
						}
						break;
                }

                simulator.driver.handleNotExitOver();
                this.runStep();
                cycles++;
            }

            simulator.driver.timer = setTimeout(this.runStart.bind(this), VenusRuntime._timeoutTime, escapeCondition, wantedStackDepth);
        } catch (e) {
            this.runEnd();
            simulator.driver.handleError("RunStart", e);
        }
    }

	/** Ends a long running code sequence*/
    private runEnd(paused = false) {
        simulator.driver.handleNotExitOver();
		this.cancelRun();
		this._pauseRequested = false;
		this.updateMemory();
		if (paused) {
			this.sendEvent('stopOnPause');
		} else if (simulator.driver.sim.isDone()) {
			this.sendEvent('end');
		} else if (simulator.driver.sim.atBreakpoint()) {
			this.sendEvent('stopOnBreakpoint');
		} else {
			this.sendEvent('stopOnStep');
		}
	}

	/** A wrapper for the simulator step function. Everything that should be updated when stepping is additionally called here. */
	private runStep() {
		this.executeStep();
	}

	private executeStep() {
		const previousStack = this._functionStack.map(frame => ({ ...frame }));
		simulator.driver.sim.step();
		this.recordStackHistory(previousStack);
		this.updateStack();
	}

	/** Keeps the call stack snapshots in lockstep with the simulator undo history. */
	private recordStackHistory(snapshot: CallStackItem[]) {
		this._stackHistory.push(snapshot);
		while (this._stackHistory.length > VenusRuntime._maxStackHistory) {
			this._stackHistory.shift();
		}
	}

	private updateStack() {
		const jumpRegex = new RegExp("jalr?\\sx1");

		let instInfo = simulator.driver.getCurrentInstruction();

		var assemblyLine: AssemblyLine = {pc: instInfo.pc, mCode: instInfo.mcode, basicCode: instInfo.basicCode, assemblyViewLine: 0, sourceLine: 0, sourcePath: "unkown"};

		let pc = simulator.driver.sim.getPC();
		let instruction = this.pcToAssemblyLine.get(pc);
		if (instruction) {
			assemblyLine.assemblyViewLine = instruction.assemblyViewLine;
			assemblyLine.sourceLine = instruction.sourceLine;
			assemblyLine.sourcePath = instruction.sourcePath;
		}
		const lineadditive = 0;


		if (assemblyLine) {
			const lineContent = assemblyLine.basicCode;

			if (this._functionStack.length > 0 && this._functionStack[0].name.startsWith("jalr x0")) {
				this._functionStack.shift();
				this._functionStack.shift();
			} else if (this._functionStack.length > 0 && jumpRegex.test(this._functionStack[0].name)) {
				// if there is a jump we keep the jump on the stack
			} else {
				this._functionStack.shift();
			}

			this._functionStack.unshift({
					index: 0,
					name: lineContent,
					file: assemblyLine.sourcePath,
					line: assemblyLine.sourceLine + lineadditive // the top element on the stack defines the highlighted line in the editor!!!
				});
			this.reindexStack();

		}
	}

	private reindexStack() {
		this._functionStack.forEach((frame, index) => frame.index = index);
	}

	/**
	 * Returns a stacktrace which is build at each execution step. This function just returns it.
	 */
	public stack(startFrame: number, endFrame: number): any {

		const frames = this._functionStack.slice(startFrame, endFrame);
		return { frames, count: this._functionStack.length };

	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number) : VenusBreakpoint {
		path = helpers.canonicalSourcePath(path);
		const bp = <VenusBreakpoint> { verified: false, line, id: this._breakpointId++, path };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<VenusBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoint(bp);
		this.activateBreakpoint(bp);

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : VenusBreakpoint | undefined {
		path = helpers.canonicalSourcePath(path);
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				this.deactivateBreakpoint(bp);
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		path = helpers.canonicalSourcePath(path);
		const bps = this._breakPoints.get(path);
		if (bps) {
			bps.forEach(bp => this.deactivateBreakpoint(bp));
		}
		this._breakPoints.delete(path);
	}


	// private methods

	private resolveBreakpointPcs(path: string, line: number): number[] | undefined {
		path = helpers.canonicalSourcePath(path);
		let pcs = this.sourceLineToPc.get(this.createSourcelineString(path, line));
		const maximumLineNumber = this._maximumLineNumber.get(path);
		let realLine = line;
		while ((!pcs || pcs.length === 0) && maximumLineNumber && realLine < maximumLineNumber) {
			realLine++;
			pcs = this.sourceLineToPc.get(this.createSourcelineString(path, realLine));
		}
		return pcs && pcs.length > 0 ? pcs : undefined;
	}

	private verifyBreakpoint(bp: VenusBreakpoint): void {
		const wasVerified = bp.verified;
		bp.verified = this.resolveBreakpointPcs(bp.path, bp.line) !== undefined;
		if (bp.verified !== wasVerified) {
			this.sendEvent('breakpointValidated', bp);
		}
	}

	private activateBreakpoint(bp: VenusBreakpoint): void {
		const pcs = this.resolveBreakpointPcs(bp.path, bp.line);
		if (!pcs) { return; }
		pcs.forEach(pc => {
			const references = this._activeBreakpointPcs.get(pc) || 0;
			if (references === 0) {
				simulator.driver.toggleBreakpoint(pc);
			}
			this._activeBreakpointPcs.set(pc, references + 1);
		});
	}

	private deactivateBreakpoint(bp: VenusBreakpoint): void {
		const pcs = this.resolveBreakpointPcs(bp.path, bp.line);
		if (!pcs) { return; }
		pcs.forEach(pc => {
			const references = this._activeBreakpointPcs.get(pc) || 0;
			if (references === 1) {
				simulator.driver.toggleBreakpoint(pc);
				this._activeBreakpointPcs.delete(pc);
			} else if (references > 1) {
				this._activeBreakpointPcs.set(pc, references - 1);
			}
		});
	}

	private reapplyBreakpoints(): void {
		this._breakPoints.forEach(bps => bps.forEach(bp => {
			this.verifyBreakpoint(bp);
			this.activateBreakpoint(bp);
		}));
	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	public static registerECallReceiver(func: (json: string) => void) {
		simulator.driver.registerECallReceiver(func);
	}

	private updateMemory() {
		MemoryUI.getInstance().update();
	}

}
