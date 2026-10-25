<script lang="ts">
	import { tick } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import { Info, Play, Square, RotateCcw } from '@lucide/svelte';
	import { SQL_MAX_BYTES, SQL_MAX_RESULTS, SQL_MAX_ROWS } from '#lib/sql.js';
	import type { SqlState } from '#lib/state/sql.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import TextEditor from './TextEditor.svelte';

	let { state: sql, active, database }: { state: SqlState; active: boolean; database: string } = $props();
	let view = $state.raw<EditorView | null>(null);
	let selectedResult = $state(0);
	let page = $state(0);
	let infoOpen = $state(false);
	let editorHeight = $state(280);
	let windowHeight = $state(800);
	let resize: { y: number; height: number } | null = null;
	const height = $derived(Math.min(editorHeight, Math.max(120, windowHeight * 0.55)));
	const result = $derived(sql.result?.results[selectedResult]);
	const pageSize = 100;
	const transactionLabel = $derived(sql.busy ? 'Running…'
		: sql.transaction === 'transaction' ? 'Transaction open'
		: sql.transaction === 'failed' ? 'Transaction failed'
		: sql.needsReset ? 'Session closed' : 'Idle');

	$effect(() => { sql.result; selectedResult = 0; page = 0; });
	$effect(() => {
		if (active) void tick().then(() => view?.requestMeasure());
		else infoOpen = false;
	});

	function run() {
		if (!view || !active || !sql.draftReady) return;
		const selection = view.state.selection.main;
		// A selection is sent verbatim, including incomplete statements; PostgreSQL decides validity.
		void sql.run(selection.empty ? sql.draft : view.state.sliceDoc(selection.from, selection.to));
	}
	function keydown(event: KeyboardEvent) {
		if (active && !infoOpen && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			event.preventDefault();
			run();
		}
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

<section aria-label="SQL workspace" class="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
	<header class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
		<h1 class="shrink-0 text-sm font-semibold">SQL editor</h1>
		<span class="truncate font-mono text-xs text-muted-foreground" title={database}>{database}</span>
		<Popover.Root bind:open={infoOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-sm" class="ml-auto text-muted-foreground" aria-label="SQL editor info" title="SQL editor info"><Info /></Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="end" class="max-h-[calc(100dvh-80px)] w-80 max-w-[calc(100vw-24px)] gap-3 overflow-y-auto text-xs" aria-label="SQL editor info">
				<Popover.Title class="font-medium">SQL editor</Popover.Title>
				<p>Run executes the selection or whole buffer unchanged. PostgreSQL handles transactions; BEGIN can span runs.</p>
				<p>Preview: {SQL_MAX_ROWS.toLocaleString()} rows/result, {SQL_MAX_RESULTS} results, {SQL_MAX_BYTES / 1_000_000} MB total. Preview limits do not limit execution or writes.</p>
				<p>Sessions close after 15 min idle; idle transactions default to 5 min. Reset closes the session and rolls back uncommitted work, keeping the draft.</p>
				<p>Statements default to 30 s; the connection closes after 60 s. A lost connection leaves the execution outcome uncertain.</p>
				<p>SQL drafts autosave unencrypted in this browser, separately per database and tab. Only text is restored, never executed; sessions and results are not restored. Stored SQL may contain sensitive values.</p>
				<p>Refresh Tables after schema changes. Keep client_encoding at UTF8; COPY streams, binary cursors and psql commands are unsupported.</p>
			</Popover.Content>
		</Popover.Root>
	</header>
	<div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
		<Button size="sm" disabled={!sql.draftReady || sql.busy || sql.cancelling || sql.needsReset || !sql.draft.trim()} onclick={run}
			title="Run selection, or the entire buffer when nothing is selected (Ctrl/Cmd+Enter)">
			<Play class="size-3.5" />{sql.busy ? sql.running ? 'Running…' : 'Working…' : 'Run'}
		</Button>
		{#if sql.running}
			<Button size="sm" variant="outline" disabled={sql.cancelling} onclick={() => void sql.cancel()}><Square class="size-3" />{sql.cancelling ? 'Cancelling…' : 'Cancel'}</Button>
		{/if}
		<Button size="sm" variant="ghost" disabled={sql.busy || sql.cancelling || !sql.session} onclick={reset} title="Close the connection and roll back uncommitted work; keep the draft">
			<RotateCcw class="size-3.5" />Reset session
		</Button>
	</div>
	{#if sql.draftError}<p role="alert" class="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{sql.draftError}</p>{/if}
	<div class="shrink-0 px-3 pt-3" style:height={`${height}px`}>
		<TextEditor value={sql.draft} onchange={(value) => sql.updateDraft(value ?? '')} readonly={!sql.draftReady} language="sql" tabIndent label="SQL query"
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
				<Button size="xs" disabled={sql.busy || sql.cancelling || sql.transaction === 'failed'} onclick={(event) => void finishTransaction('COMMIT', event.currentTarget)}>Commit</Button>
				<Button size="xs" variant="outline" disabled={sql.busy || sql.cancelling} onclick={(event) => void finishTransaction('ROLLBACK', event.currentTarget)}>Rollback</Button>
			</div>
		{/if}
		{#if sql.result}<span class="text-muted-foreground">{sql.result.durationMs.toLocaleString()} ms</span>{/if}
	</div>
	<!-- Keep results reachable when the workspace itself must scroll on short screens. -->
	<div class="min-h-40 flex-1 overflow-auto" aria-busy={sql.busy}>
		{#if sql.error || sql.result?.error}
			<div role="alert" class="space-y-1 border-b border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
				<p class="whitespace-pre-wrap break-words">{sql.error || sql.result?.error}</p>
				<p class="text-muted-foreground">Earlier explicit commits may have succeeded. Results below are not proof of a commit.</p>
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
