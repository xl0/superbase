import { PostgreSQL } from '@codemirror/lang-sql';
import { classHighlighter, highlightCode } from '@lezer/highlight';

/** Read-only SQL as `tok-*` spans (styled under `.sql-code` in app.css), parsed like the SQL editor. */
export function highlightSql(sql: string): { text: string; class: string }[] {
	const spans: { text: string; class: string }[] = [];
	highlightCode(sql, PostgreSQL.language.parser.parse(sql), classHighlighter,
		(text, classes) => spans.push({ text, class: classes }), () => spans.push({ text: '\n', class: '' }));
	return spans;
}
