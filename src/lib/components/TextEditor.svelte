<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Annotation, EditorState, StateEffect } from '@codemirror/state';
	import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers, placeholder as editorPlaceholder } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
	import { HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
	import { json } from '@codemirror/lang-json';
	import { PostgreSQL, sql } from '@codemirror/lang-sql';
	import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
	import { tags } from '@lezer/highlight';
	import { jsonValue, prettyJSON, setJSONValue } from '#lib/json.js';
	import type { CellValue } from '#lib/types.js';

	let {
		value, onchange, language = 'text', readonly = false, label, id, placeholder = '', class: className = '',
		state: editorState = $bindable<EditorState | null>(null), ref = $bindable<EditorView | null>(null)
	}: {
		value: CellValue | undefined;
		onchange: (value: CellValue | undefined) => void;
		/** Chosen from column metadata, never inferred from the document. */
		language?: 'text' | 'json' | 'sql';
		readonly?: boolean;
		label: string;
		id?: string;
		placeholder?: string;
		class?: string;
		/** Persist across remounts to retain the displayed document, selection and undo history. */
		state?: EditorState | null;
		/** The current mounted view, for focus and selection commands. */
		ref?: EditorView | null;
	} = $props();

	let host: HTMLDivElement;
	let mounted = $state.raw<EditorView | null>(null);
	let lastValue: CellValue | undefined;
	const external = Annotation.define<boolean>();
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
				sql({ dialect: PostgreSQL }), autocompletion(),
				keymap.of([{ key: 'Tab', run: acceptCompletion }, indentWithTab]),
				lineNumbers(), indentUnit.of('  '), indentOnInput(), highlighting
			]
				: language === 'json' ? [json(), indentUnit.of('  '), indentOnInput(), highlighting] : [EditorView.lineWrapping],
			// Split only LF, retaining CR characters even in mixed line endings.
			EditorState.lineSeparator.of('\n'), highlightSpecialChars({ addSpecialChars: /\r/g }),
			jsonValue, history(), drawSelection(), theme,
			// Cell editors keep native Tab navigation; apply/cancel belong to their enclosing editor.
			keymap.of([...defaultKeymap.filter(({ key }) => key !== 'Mod-Enter' && key !== 'Escape'), ...historyKeymap]),
			EditorState.readOnly.of(readonly),
			EditorView.contentAttributes.of({ ...(id ? { id } : {}), 'aria-label': label, 'aria-readonly': String(readonly), spellcheck: 'false' }),
			editorPlaceholder(placeholder)
		];
	}

	onMount(() => {
		lastValue = value;
		const initialValue = value;
		const configured = extensions();
		const view = new EditorView({
			parent: host,
			state: editorState
				? editorState.update({ effects: StateEffect.reconfigure.of(configured) }).state
				: EditorState.create({
					doc: language === 'json' ? prettyJSON(initialValue ?? '') : initialValue ?? '',
					extensions: [configured, jsonValue.init(() => initialValue)]
				}),
			// A view-local dispatcher avoids retaining callbacks from a destroyed component in state.
			dispatchTransactions(transactions, view) {
				view.update(transactions);
				// Animated outgoing editors may still receive blur/selection transactions.
				if (ref !== view) return;
				if (editorState !== view.state) editorState = view.state;
				if (transactions.some((transaction) => !transaction.annotation(external) && (
					transaction.docChanged || transaction.startState.field(jsonValue) !== transaction.state.field(jsonValue)
				))) {
					lastValue = view.state.field(jsonValue);
					onchange(lastValue);
				}
			}
		});
		mounted = ref = view;
		editorState = view.state;
		return () => {
			if (ref === view) ref = null;
			view.destroy();
		};
	});

	$effect(() => {
		const view = mounted;
		const next = value;
		if (!view || ref !== view || next === lastValue) return;
		lastValue = next;
		untrack(() => {
			const doc = language === 'json' ? prettyJSON(next ?? '') : next ?? '';
			view.dispatch({
				changes: doc === view.state.doc.toString() ? undefined : { from: 0, to: view.state.doc.length, insert: doc },
				effects: setJSONValue.of({ value: next }),
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
