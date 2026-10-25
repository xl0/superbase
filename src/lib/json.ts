import { jsonLanguage } from '@codemirror/lang-json';

/** Format only JSON whitespace; retain literal spelling, key order and duplicate keys.
 * Parser recovery means malformed/incomplete text is returned byte-for-byte unchanged.
 */
export function prettyJSON(source: string): string {
	const cursor = jsonLanguage.parser.parse(source).cursor();
	const tokens: string[] = [];
	do {
		if (cursor.type.isError) return source;
		if (!cursor.node.firstChild) tokens.push(source.slice(cursor.from, cursor.to));
	} while (cursor.next());

	const output: string[] = [];
	let depth = 0;
	const newline = () => output.push('\n', '  '.repeat(depth));
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === '{' || token === '[') {
			output.push(token);
			depth++;
			if (tokens[i + 1] !== '}' && tokens[i + 1] !== ']') newline();
		} else if (token === '}' || token === ']') {
			depth--;
			if (tokens[i - 1] !== '{' && tokens[i - 1] !== '[') newline();
			output.push(token);
		} else if (token === ',') {
			output.push(token);
			newline();
		} else if (token === ':') output.push(': ');
		else output.push(token);
	}
	return output.join('');
}
