<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import { Play, Save, Square, RotateCcw } from '@lucide/svelte';
	import type { SQLNamespace } from '@codemirror/lang-sql';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import type { SqlState } from '#lib/state/sql.svelte.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import SqlLibrary from './SqlLibrary.svelte';
	import TextEditor from './TextEditor.svelte';
	import Workspace from './Workspace.svelte';

	let { state: sql, active }: { state: SqlState; active: boolean } = $props();
	const id = $props.id();
	let view = $state.raw<EditorView | null>(null);
	let library: SqlLibrary;
	let selectedResult = $state(0);
	let page = $state(0);
	let editorHeight = $state(280);
	let windowHeight = $state(800);
	let resize: { y: number; height: number } | null = null;
	const height = $derived(Math.min(editorHeight, Math.max(120, windowHeight * 0.55)));
	const result = $derived(sql.result?.results[selectedResult]);
	const pageSize = 100;
	/** schema → table → columns, for autocompletion. */
	const sqlSchema = $derived(editor.tables.reduce<Record<string, Record<string, string[]>>>((namespace, table) => {
		(namespace[table.schema] ??= {})[table.name] = table.columns.map((column) => column.name);
		return namespace;
	}, {}) as SQLNamespace);
	const transactionLabel = $derived(sql.busy ? 'Running…'
		: sql.transaction === 'transaction' ? 'Transaction open'
		: sql.transaction === 'failed' ? 'Transaction failed'
		: sql.needsReset ? 'Session closed' : 'Idle');

	$effect(() => { sql.result; selectedResult = 0; page = 0; });
	// Committed DDL changes what the table list and autocomplete show: reload the metadata.
	$effect(() => {
		const result = sql.result;
		if (result?.transaction === 'idle' && result.results.some(({ command }) => /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|COMMIT)\b/.test(command))) {
			untrack(() => void editor.reload());
		}
	});
	$effect(() => { if (active) void tick().then(() => view?.requestMeasure()); });

	function run() {
		if (!view || !active) return;
		const selection = view.state.selection.main;
		// A selection is sent verbatim, including incomplete statements; PostgreSQL decides validity.
		void sql.run(selection.empty ? sql.draft : view.state.sliceDoc(selection.from, selection.to));
	}
	/** Update the open snippet, or save untitled text under its first line and start renaming it. */
	function save() {
		if (!sql.draft.trim()) return;
		try {
			if (sql.current) { sql.save(); return; }
			const firstLine = sql.draft.trim().split('\n')[0].replace(/^--\s*/, '') || 'Untitled';
			sql.save(firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine);
			void library.rename(sql.current!);
		} catch (cause) { window.alert(`Could not save the snippet: ${message(cause)}`); }
	}
	function keydown(event: KeyboardEvent) {
		if (!active || !(event.ctrlKey || event.metaKey)) return;
		if (event.key === 'Enter') { event.preventDefault(); run(); }
		else if (event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
	}
	async function finishTransaction(command: 'COMMIT' | 'ROLLBACK', trigger: HTMLElement) {
		await sql.run(command);
		await tick();
		if (active && !trigger.isConnected && document.activeElement === document.body) view?.focus();
	}
	function reset() {
		if (window.confirm('Close this SQL session? Uncommitted work will be rolled back; temporary tables and session settings will be lost. Your SQL draft stays.')) {
			void sql.reset();
		}
	}
</script>

<svelte:window onkeydown={keydown} bind:innerHeight={windowHeight} />

<Workspace label="SQL snippets">
{#snippet sidebar()}<SqlLibrary bind:this={library} state={sql} />{/snippet}
<section aria-label="SQL workspace" class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
	<div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
		<Button size="sm" disabled={sql.busy || sql.needsReset || !sql.draft.trim()} onclick={run}
			title="Run selection, or the entire buffer when nothing is selected (Ctrl/Cmd+Enter)">
			<Play class="size-3.5" />{sql.busy ? 'Running…' : 'Run'}
		</Button>
		{#if sql.running}
			<Button size="sm" variant="outline" disabled={sql.cancelling} onclick={() => void sql.cancel()}><Square class="size-3" />{sql.cancelling ? 'Cancelling…' : 'Cancel'}</Button>
		{/if}
		<Button size="sm" variant="ghost" disabled={!sql.draft.trim() || (!!sql.current && !sql.unsaved)} onclick={save}
			title={sql.current ? `Save “${sql.current.name}” (Ctrl/Cmd+S)` : 'Save as a new snippet (Ctrl/Cmd+S)'}><Save class="size-3.5" />Save</Button>
		<Button size="sm" variant="ghost" disabled={sql.busy || !sql.session} onclick={reset} title="Close the connection and roll back uncommitted work; keep the draft">
			<RotateCcw class="size-3.5" />Reset session
		</Button>
		<span class="ml-auto truncate text-xs text-muted-foreground">{sql.current ? `${sql.current.name}${sql.unsaved ? ' •' : ''}` : 'Untitled'}</span>
		<div class="flex shrink-0 items-center gap-2">
			<Checkbox id={`${id}-completion`} checked={sql.completion} onCheckedChange={(checked) => sql.setCompletion(checked)} />
			<Label for={`${id}-completion`} class="text-xs font-normal text-muted-foreground" title="Suggest keywords, schemas, tables and columns">Autocomplete</Label>
		</div>
	</div>
	<div class="shrink-0 px-3 pt-3" style:height={`${height}px`}>
		<TextEditor value={sql.draft} onchange={(value) => sql.updateDraft(value)} language="sql" tabIndent completion={sql.completion} {sqlSchema} label="SQL query"
			placeholder="SELECT current_database();" class="h-full rounded-b-none" bind:ref={view} />
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Keyboard-adjustable separator.) -->
	<div role="separator" tabindex="0" aria-label="Resize SQL editor" aria-orientation="horizontal"
		aria-valuemin={120} aria-valuemax={Math.max(120, Math.floor(windowHeight * 0.55))} aria-valuenow={Math.round(height)}
		class="mx-3 h-2 shrink-0 cursor-row-resize touch-none rounded-b border border-t-0 bg-muted/40 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
		onkeydown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); editorHeight = Math.max(120, Math.min(windowHeight * 0.55, height + (event.key === 'ArrowDown' ? 24 : -24))); } }}
		onpointerdown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize = { y: event.clientY, height }; }}
		onpointermove={(event) => { if (resize) editorHeight = Math.max(120, Math.min(windowHeight * 0.55, resize.height + event.clientY - resize.y)); }}
		onpointerup={() => resize = null} onlostpointercapture={() => resize = null}></div>
	<div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-[11px]">
		<span role="status" class:text-amber-300={sql.transaction === 'transaction' || sql.transaction === 'failed'}>{transactionLabel}</span>
		{#if sql.transaction === 'transaction' || sql.transaction === 'failed'}
			<div class="flex gap-1">
				<Button size="xs" disabled={sql.busy || sql.transaction === 'failed'} onclick={(event) => void finishTransaction('COMMIT', event.currentTarget)}>Commit</Button>
				<Button size="xs" variant="outline" disabled={sql.busy} onclick={(event) => void finishTransaction('ROLLBACK', event.currentTarget)}>Rollback</Button>
			</div>
		{/if}
		{#if sql.result}<span class="text-muted-foreground">{sql.result.durationMs.toLocaleString()} ms</span>{/if}
	</div>
	<!-- Keep results reachable when the workspace itself must scroll on short screens. -->
	<div class="min-h-40 flex-1 overflow-auto" aria-busy={sql.busy}>
		{#if sql.error || sql.result?.error}
			<div role="alert" class="space-y-1 border-b border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
				<p class="whitespace-pre-wrap break-words">{sql.error || sql.result?.error}</p>
				<!-- Only when statements before the failing one completed: their explicit commits may have happened. -->
				{#if sql.result?.error && sql.result.results.length}
					<p class="text-muted-foreground">Earlier explicit commits may have succeeded. Results below are not proof of a commit.</p>
				{/if}
			</div>
		{/if}
		{#if sql.result?.notices.length}
			<details class="border-b px-3 py-2 text-xs">
				<summary class="cursor-pointer text-muted-foreground">Messages ({sql.result.notices.length})</summary>
				{#each sql.result.notices as notice}<pre class="mt-2 font-mono whitespace-pre-wrap break-words">{notice}</pre>{/each}
			</details>
		{/if}
		{#if sql.result?.truncated}
			<p role="status" class="border-b px-3 py-2 text-xs text-amber-300">Preview incomplete: some rows, results or messages were omitted. Preview limits do not limit SQL execution.</p>
		{/if}
		{#if sql.result?.results.length}
			<div aria-label="Result sets" class="flex flex-wrap gap-1 border-b px-3 py-2">
				{#each sql.result.results as item, index}
					<Button size="xs" variant={index === selectedResult ? 'secondary' : 'ghost'} aria-pressed={index === selectedResult}
						onclick={() => { selectedResult = index; page = 0; }}>{index + 1}. {item.command || 'Result'}</Button>
				{/each}
			</div>
		{/if}
		{#if result}
			<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
				<span>{result.command || 'Result'}{result.rowCount !== null ? ` · ${result.rowCount.toLocaleString()} rows` : ''}</span>
				{#if result.fields.length}<span>· {result.rows.length.toLocaleString()} in preview{result.truncated ? ' (truncated)' : ''}</span>{/if}
				{#if result.rows.length > pageSize}
					<Button size="xs" variant="outline" disabled={page === 0} onclick={() => page--}>Previous</Button>
					<span>{page + 1} / {Math.ceil(result.rows.length / pageSize)}</span>
					<Button size="xs" variant="outline" disabled={(page + 1) * pageSize >= result.rows.length} onclick={() => page++}>Next</Button>
				{/if}
			</div>
			{#if result.fields.length}
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-left font-mono text-xs" aria-label={`SQL result ${selectedResult + 1}`}>
						<thead class="bg-card text-muted-foreground"><tr>
							{#each result.fields as field}<th scope="col" class="border-r border-b px-3 py-2 font-medium whitespace-pre" title={`PostgreSQL type OID ${field.typeOid}`}>{field.name}</th>{/each}
						</tr></thead>
						<tbody>{#each result.rows.slice(page * pageSize, (page + 1) * pageSize) as row}<tr>
							{#each row as value}<td class="max-w-xl border-r border-b px-3 py-2 align-top whitespace-pre-wrap break-words">{#if value === null}<span class="text-muted-foreground italic">NULL</span>{:else if value === ''}<span aria-label="Empty text" class="text-muted-foreground">''</span>{:else}{value}{/if}</td>{/each}
						</tr>{/each}</tbody>
					</table>
				</div>
				{#if !result.rows.length}<p class="p-4 text-xs text-muted-foreground">{result.truncated ? 'No rows fit in the preview.' : 'No rows returned.'}</p>{/if}
			{:else}<p class="p-4 text-xs text-muted-foreground">Command completed.</p>{/if}
		{:else if !sql.busy && !sql.error && !sql.result?.error}
			<p class="p-4 text-xs text-muted-foreground">{sql.result ? 'Query completed without a result set.' : 'No results yet.'}</p>
		{/if}
	</div>
</section>
</Workspace>
