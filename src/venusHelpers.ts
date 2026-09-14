import * as path from 'path';

/**
 * Converts a path to a posix path.
 * 
 * @param p a path
 * @returns the path formatted with posix seperator /
 */
export function toPosixPath(p: string) : string {
	return p.split(path.sep).join(path.posix.sep);
}

/**
 * Return the stable source identifier used by Venus and the debug adapter.
 *
 * Venus reports POSIX-style paths even on Windows. VS Code may send the same
 * path with backslashes or a differently-cased drive letter, so comparing the
 * raw strings makes imported-file breakpoints unreliable.
 */
export function canonicalSourcePath(p: string): string {
	const nativePath = p.split(path.posix.sep).join(path.sep);
	const absolutePath = path.normalize(path.resolve(nativePath));
	const comparablePath = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
	return toPosixPath(comparablePath);
}

/**
 * ABI names of the 32 integer registers, indexed by register number. Native
 * Venus labels the integer registers with both the ABI name and the `xN`
 * number, and CS61C programs are written with the ABI names, so both spellings
 * have to be accepted when a register is written.
 */
export const integerRegisterAbiNames: string[] = [
	'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
	's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
	'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
	's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'
];

/** Number of integer and float registers that the simulator exposes. */
export const registerCount = 32;

export interface RegisterTarget {
	kind: 'integer' | 'float';
	id: number;
}

/**
 * Resolves a register name coming from the debugger frontend.
 *
 * The Variables view labels integer registers `x05 (t0)` (the ABI name is
 * padded to a fixed width) and float registers `f05`. Explicit user input may
 * also use the plain `x5` or the ABI name `t0`.
 *
 * @returns the register addressed by the name, or undefined if the name does
 * not address a register of the simulated machine.
 */
export function parseRegisterName(rawName: string): RegisterTarget | undefined {
	if (typeof rawName !== 'string') { return undefined; }
	const name = rawName.trim().toLowerCase();
	if (name.length === 0) { return undefined; }

	const numbered = /^([xf])(\d{1,2})(?![0-9])/.exec(name);
	if (numbered !== null) {
		const id = parseInt(numbered[2], 10);
		if (id >= registerCount) { return undefined; }
		return { kind: numbered[1] === 'f' ? 'float' : 'integer', id };
	}

	const abiId = integerRegisterAbiNames.indexOf(name);
	if (abiId >= 0) {
		return { kind: 'integer', id: abiId };
	}
	return undefined;
}

const characterEscapes: { [escape: string]: number } = {
	'0': 0, 'n': 10, 'r': 13, 't': 9, '\\': 92, '\'': 39, '"': 34
};

function parseDigits(text: string, radix: number): number | undefined {
	if (text.length === 0) { return undefined; }
	const pattern = radix === 16 ? /^[0-9a-fA-F]+$/
		: radix === 2 ? /^[01]+$/
		: radix === 10 ? /^[0-9]+$/
		: /^[0-9a-zA-Z]+$/;
	if (!pattern.test(text)) { return undefined; }
	const magnitude = parseInt(text, radix);
	return Number.isFinite(magnitude) ? magnitude : undefined;
}

function splitSign(text: string): { sign: number, body: string } {
	if (text.startsWith('-')) { return { sign: -1, body: text.slice(1) }; }
	if (text.startsWith('+')) { return { sign: 1, body: text.slice(1) }; }
	return { sign: 1, body: text };
}

function parseCharacterLiteral(literal: string): number | undefined {
	const body = literal.slice(1, -1);
	if (body.length === 0) { return undefined; }
	if (body.startsWith('\\')) {
		return characterEscapes[body.slice(1)];
	}
	if ([...body].length !== 1) { return undefined; }
	return body.codePointAt(0);
}

/**
 * Parses the literal forms that Venus' `userStringToInt` accepts: a single
 * character literal, a `0x`/`0b` prefixed value with an optional sign, or a
 * plain decimal value. The result is truncated to a 32 bit two's complement
 * integer, exactly like Venus does when it stores into a register.
 */
export function parseVenusLiteralInt(rawValue: string): number | undefined {
	if (typeof rawValue !== 'string') { return undefined; }
	const text = rawValue.trim();
	if (text.length === 0) { return undefined; }
	if (text.length >= 2 && text.startsWith('\'') && text.endsWith('\'')) {
		return parseCharacterLiteral(text);
	}

	const { sign, body } = splitSign(text);
	let radix = 10;
	let digits = body;
	if (/^0x/i.test(body)) { radix = 16; digits = body.slice(2); }
	else if (/^0b/i.test(body)) { radix = 2; digits = body.slice(2); }

	const magnitude = parseDigits(digits, radix);
	if (magnitude === undefined) { return undefined; }
	return (sign * magnitude) | 0;
}

/**
 * Packs up to four characters the way the `ascii` variable format prints a
 * word: Venus prints the most significant byte first, so the last character
 * typed becomes the least significant byte.
 */
export function parsePackedAscii(text: string): number | undefined {
	if (typeof text !== 'string' || text.length === 0 || text.length > 4) { return undefined; }
	let packed = 0;
	for (let i = 0; i < text.length; i++) {
		packed = (packed << 8) | (text.charCodeAt(i) & 0xff);
	}
	return packed | 0;
}

/**
 * Parses a value typed into the Variables view.
 *
 * Explicit Venus literals (`0x1f`, `0b101`, `'a'`) always win. Everything else
 * is read in the number format that is currently displayed, so a value the
 * user sees (for example `2a` in hex mode or `00101010` in binary mode) can be
 * typed back in unmodified.
 *
 * @param format the configured `riscv-venus.variableFormat`
 */
export function parseVenusValue(rawValue: string, format?: string): number | undefined {
	if (typeof rawValue !== 'string') { return undefined; }
	const text = rawValue.trim();
	if (text.length === 0) { return undefined; }

	const explicitPrefix = /^[-+]?0[xb]/i.test(text);
	const characterLiteral = text.length >= 2 && text.startsWith('\'') && text.endsWith('\'');
	if (explicitPrefix || characterLiteral) {
		return parseVenusLiteralInt(text);
	}

	if (format === 'ascii') {
		const packed = parsePackedAscii(text);
		if (packed !== undefined) { return packed; }
	}

	const { sign, body } = splitSign(text);
	const radix = format === 'binary' ? 2 : format === 'hex' ? 16 : 10;
	const magnitude = parseDigits(body, radix);
	if (magnitude === undefined) {
		// Fall back to the Venus literal rules (an unprefixed value is decimal).
		return parseVenusLiteralInt(text);
	}
	return (sign * magnitude) | 0;
}

/**
 * Interprets a DAP memory reference. The protocol treats references prefixed
 * with `0x` as hex and everything else as decimal; the offset is applied in
 * bytes and the result is normalized to a 32 bit address, which is also the
 * key form Venus uses internally.
 */
export function parseMemoryAddress(reference: string, offset?: number): number | undefined {
	const base = parseVenusLiteralInt(reference);
	if (base === undefined) { return undefined; }
	const delta = (offset === undefined || !Number.isFinite(offset)) ? 0 : Math.trunc(offset);
	return (base + delta) | 0;
}

/** Formats an address the way the debug adapter reports memory locations. */
export function formatAddress(address: number): string {
	return '0x' + (address >>> 0).toString(16);
}

/**
 * Venus refuses to write the text segment while `mutableText` is disabled
 * (`Simulator.storeWordwCache` raises a StoreError). The debug adapter applies
 * the same rule to writes coming from the memory view.
 *
 * @param textEnd exclusive end of the assembled text segment
 * @param address first byte of the write
 * @param byteCount number of bytes written
 */
export function overlapsImmutableText(textEnd: number, address: number, byteCount: number): boolean {
	return address <= textEnd && address + byteCount > 0;
}

