/**
 * API for frontend/debugger
 * 	-	atm this communicates with the DOM
 * 		rn DOM functions as a layer of persistance where data gets exchanged between former venus-frontend and simulator
 * 		e.g. most of the values int the settings view (VENUS-UI => Venus Tab => Settings)
 * 	-	//TODO in the future DOM gets substituted to get rid of fakeDOM
 */

const {document} = require("./fakeDOM")

function setText(txt: string) {
	const editor = document.getElementById("asm-editor") as HTMLTextAreaElement
	editor.value = txt
}

function setMaxSteps(steps: number) {
	const form = document.getElementById("tmaxsteps-val") as HTMLInputElement
	form.value = steps.toString()
}

/**
 * Encodes one program argument for the ArgsList input.
 *
 * Venus lexes that input with a simple quote aware splitter: a backslash
 * escapes the next character and surrounding quotes group spaces. JSON's
 * control character escapes (\n, \t, ...) do not survive that splitter, so
 * the raw argument text is quoted and only backslashes and quotes are escaped.
 * (An empty argument still cannot be represented, because the lexer drops
 * empty tokens.)
 */
function encodeArg(arg: string): string {
	return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function setArgs(args: string[]) {
	const form = document.getElementById("ArgsList") as HTMLInputElement;
	form.value = args.map(encodeArg).join(' ');
}

export {
	setText,
	setMaxSteps,
	setArgs
}
