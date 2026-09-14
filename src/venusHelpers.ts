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

