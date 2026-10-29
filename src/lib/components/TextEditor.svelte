<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Annotation, EditorState, StateEffect } from '@codemirror/state';
	import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers, placeholder as editorPlaceholder } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
	import { HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
	import { json } from '@codemirror/lang-json';
	import { PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
	import { acceptCompletion, autocompletion, closeCompletion } from '@codemirror/autocomplete';
	import { tags } from '@lezer/highlight';
	import { prettyJSON } from '#lib/json.js';
	import type { CellValue } from '#lib/types.js';

	/** CodeMirror for a NULL/DEFAULT/text value. The parent owns the value; edits report document text. */
	let {
		value, onchange, language = 'text', pretty = true, tabIndent = false, readonly = false, completion = true, sqlSchema, label, id, placeholder = '', class: className = '',
		state: editorState = $bindable<EditorState | null>(null), ref = $bindable<EditorView | null>(null)
	}: {
		value: CellValue | undefined;
		onchange: (value: string) => void;
		/** Chosen from column metadata, never inferred from the document. */
		language?: 'text' | 'json' | 'sql';
		/** JSON documents open pretty-printed; `json` columns store text verbatim, so they opt out. */
		pretty?: boolean;
		/** The SQL workspace opts in; form editors keep native Tab focus navigation. */
		tabIndent?: boolean;
		/** SQL autocompletion: keywords, plus schemas/tables/columns from `sqlSchema`. */
		completion?: boolean;
		sqlSchema?: SQLNamespace;
		readonly?: boolean;
		label: string;
		id?: string;
		placeholder?: string;
		class?: string;
		/** Bind to keep the document, selection and undo history across remounts (cell editor expand). */
		state?: EditorState | null;
		/** The mounted view, for focus and selection commands. */
		ref?: EditorView | null;
	} = $props();

	let host: HTMLDivElement;
	let mounted = $state.raw<EditorView | null>(null);
	let lastValue: CellValue | undefined;
	const external = Annotation.define<boolean>();
	const toDoc = (value: CellValue | undefined) => language === 'json' && pretty ? prettyJSON(value ?? '') : value ?? '';
	const theme = EditorView.theme({
		'&': { height: '100%', minHeight: '0', color: 'var(--foreground)', backgroundColor: 'var(--card)', fontSize: '12px' },
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': { overflow: 'auto', minHeight: '0', fontFamily: 'var(--font-mono)' },
		'.cm-content': { padding: '8px 0', caretColor: 'var(--foreground)' },
		'.cm-line': { padding: '0 10px' },
		'.cm-cursor': { borderLeftColor: 'var(--foreground)' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#264f78' },
		'.cm-placeholder': { color: 'var(--muted-foreground)' },
		'.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--muted-foreground)', borderRight: '1px solid var(--border)' },
		'.cm-tooltip': { backgroundColor: 'var(--popover)', border: '1px solid var(--border)' },
		'.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--foreground)' }
	}, { dark: true });
	const highlighting = syntaxHighlighting(HighlightStyle.define([
		{ tag: tags.propertyName, color: '#9cdcfe' },
		{ tag: tags.keyword, color: '#c4b5fd' },
		{ tag: tags.comment, color: '#7f8a82' },
		{ tag: tags.string, color: '#ce9178' },
		{ tag: tags.number, color: '#b5cea8' },
		{ tag: tags.bool, color: '#c4b5fd' },
		{ tag: tags.null, color: '#fda4af' },
		{ tag: [tags.separator, tags.brace, tags.squareBracket], color: 'var(--muted-foreground)' }
	]));

	function extensions() {
		return [
			language === 'sql' ? [
				sql({ dialect: PostgreSQL, schema: sqlSchema, defaultSchema: 'public' }),
				...(completion ? [autocompletion()] : []),
				...(tabIndent ? [keymap.of([...(completion ? [{ key: 'Tab', run: acceptCompletion }] : []), indentWithTab])] : []),
				lineNumbers(), indentUnit.of('  '), indentOnInput(), highlighting
			]
				: language === 'json' ? [json(), indentUnit.of('  '), indentOnInput(), highlighting] : [EditorView.lineWrapping],
			// Split only on LF so CR characters survive (and are shown) in mixed line endings.
			EditorState.lineSeparator.of('\n'), highlightSpecialChars({ addSpecialChars: /\r/g }),
			history(), drawSelection(), theme,
			// Mod-Enter and Escape belong to the enclosing editor (apply/cancel).
			keymap.of([...defaultKeymap.filter(({ key }) => key !== 'Mod-Enter' && key !== 'Escape'), ...historyKeymap]),
			EditorState.readOnly.of(readonly),
			EditorView.contentAttributes.of({ ...(id ? { id } : {}), 'aria-label': label, 'aria-readonly': String(readonly), spellcheck: 'false' }),
			editorPlaceholder(placeholder)
		];
	}

	onMount(() => {
		lastValue = value;
		const configured = extensions();
		const view = new EditorView({
			parent: host,
			state: editorState
				? editorState.update({ effects: StateEffect.reconfigure.of(configured) }).state
				: EditorState.create({ doc: toDoc(value), extensions: configured }),
			dispatchTransactions(transactions, view) {
				view.update(transactions);
				// An outgoing (animating) editor may still receive transactions.
				if (ref !== view) return;
				editorState = view.state;
				if (transactions.some((transaction) => transaction.docChanged && !transaction.annotation(external))) {
					lastValue = view.state.doc.toString();
					onchange(lastValue);
				}
			}
		});
		mounted = ref = view;
		editorState = view.state;
		// Let Escape close the completion list before an enclosing popover/sheet sees it.
		const escapeCompletion = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.isComposing && closeCompletion(view)) {
				event.preventDefault(); event.stopPropagation();
			}
		};
		view.dom.addEventListener('keydown', escapeCompletion, true);
		return () => {
			view.dom.removeEventListener('keydown', escapeCompletion, true);
			if (ref === view) ref = null;
			view.destroy();
		};
	});

	// External value changes (Set to NULL/empty, form resets) replace the document as one undo step.
	$effect(() => {
		const view = mounted;
		const next = value;
		if (!view || ref !== view || next === lastValue) return;
		lastValue = next;
		untrack(() => {
			const doc = toDoc(next);
			if (doc !== view.state.doc.toString()) view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: doc },
				annotations: [external.of(true), isolateHistory.of('full')]
			});
		});
	});

	$effect(() => {
		const configured = extensions();
		const view = mounted;
		if (view && ref === view) untrack(() => view.dispatch({ effects: StateEffect.reconfigure.of(configured) }));
	});
</script>

<div bind:this={host} class={`text-editor min-h-0 min-w-0 overflow-hidden rounded-md border border-input ${className}`}></div>

<style>
	.text-editor { display: flex; flex-direction: column; }
	.text-editor :global(.cm-editor) { flex: 1; min-width: 0; }
	.text-editor:focus-within { border-color: var(--ring); }
</style>
