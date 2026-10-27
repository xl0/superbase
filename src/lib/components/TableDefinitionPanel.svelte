<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Copy, X } from '@lucide/svelte';
	import { tableDefinition } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { highlightSql } from '#lib/sql-highlight.js';
	import type { Table } from '#lib/types.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ResizableSheet from './ResizableSheet.svelte';

	/** The table editor's side panel with a table's or view's DDL, rebuilt from the catalogs. */
	let { table, onclose }: { table: Table; onclose: () => void } = $props();
	const id = $props.id();
	let sql = $state<string | null>(null);
	let error = $state('');
	let copied = $state(false);

	onMount(async () => {
		try { sql = await fresh(tableDefinition({ connection: editor.connection, schema: table.schema, table: table.name })); }
		catch (cause) { error = message(cause); }
	});

	async function copy() {
		try { await navigator.clipboard.writeText(sql!); copied = true; setTimeout(() => copied = false, 1500); }
		catch (cause) { error = message(cause); }
	}
</script>

<ResizableSheet open onOpenChange={(open) => { if (!open) onclose(); }} width={640} label="Resize definition panel" aria-labelledby={`${id}-title`}
	class="gap-0 p-0">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<div class="min-w-0 flex-1">
			<h2 id={`${id}-title`} class="text-sm font-medium">Definition</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{table.schema}.{table.name}</p>
		</div>
		<Button variant="outline" size="sm" disabled={!sql} onclick={copy}>{#if copied}<Check />Copied{:else}<Copy />Copy{/if}</Button>
		<Button variant="ghost" size="icon-sm" aria-label="Close definition panel" onclick={onclose}><X /></Button>
	</div>
	{#if error}<p role="alert" class="p-4 text-xs break-words text-destructive">{error}</p>{/if}
	{#if sql !== null}
		<pre class="sql-code min-h-0 flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap break-words">{#each highlightSql(sql) as span}<span class={span.class}>{span.text}</span>{/each}</pre>
		<p class="border-t px-4 py-2 text-[11px] text-muted-foreground">Rebuilt from the catalogs for reading; grants, partitions, inheritance and storage options are left out.</p>
	{:else if !error}
		<p class="p-4 text-xs text-muted-foreground">Loading…</p>
	{/if}
</ResizableSheet>
