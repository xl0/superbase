<script lang="ts">
	import { Check, Download, Plus, Radio, RotateCw, Settings2, Trash2, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import InsertRow from './InsertRow.svelte';
	import FilterBar from './FilterBar.svelte';
	import SortMenu from './SortMenu.svelte';

	let { onedit }: { onedit: (mode: SchemaEditMode, anchor: HTMLElement) => void } = $props();
	let deleteOpen = $state(false);
	let deleteTrigger = $state<HTMLButtonElement | null>(null);
	let refreshButton = $state<HTMLButtonElement | null>(null);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	const exactCount = $derived(!editor.loading && !editor.error && editor.rowsPage === 0 && !editor.hasMore
		? editor.rows.length : null);

	function exportRows(options: boolean, anchor: HTMLElement) {
		onedit({ kind: 'exportCsv', options, query: {
			search: '', sort: editor.sort.map((rule) => ({ ...rule })),
			filters: editor.filters.map((filter) => ({ ...filter })),
			...(editor.filter ? { filter: { ...editor.filter } } : {})
		} }, anchor);
	}

	async function deleteRows() {
		if (blocked || !editor.tableEditable) return;
		await editor.deleteSelected();
		deleteOpen = false;
	}
</script>

<header class="shrink-0 border-b border-border bg-background">
	<div class="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
		<div class="flex min-w-0 items-baseline gap-1.5 font-mono text-xs">
			<span class="text-muted-foreground">{editor.table.schema}</span><span class="text-muted-foreground">/</span>
			<span class="truncate font-medium">{editor.table.name}</span>
		</div>
		{#if !editor.hasFilters && editor.table.rowCount >= 0}
			<Badge variant="outline" class="text-[10px] font-normal text-muted-foreground"
				title={exactCount === null ? 'PostgreSQL row estimate; statistics may be stale.' : 'Exact row count from the last loaded page.'}>
				{exactCount === null ? `~${editor.table.rowCount.toLocaleString()}` : exactCount.toLocaleString()} rows
			</Badge>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			{#if editor.busy}
				<span role="status" class="text-[11px] text-muted-foreground">Saving…</span>
			{:else if editor.savedAt}
				<span class="flex items-center gap-1 text-[11px] text-primary"><Check class="size-3" /> Saved</span>
			{/if}
		</div>
	</div>
		<div class="flex flex-wrap items-start gap-2 px-3 py-2">
			<FilterBar />
			<div class="ml-auto flex flex-wrap items-center gap-2">
				<SortMenu />
				<div class="flex shrink-0">
					<Button variant="outline" size="icon-sm" class="rounded-r-none" disabled={blocked || !editor.table.columns.length}
						aria-label="Export query results" title="Download all matching rows and columns as CSV"
						onclick={(event) => exportRows(false, event.currentTarget)}><Download /></Button>
					<Button variant="outline" size="icon-sm" class="rounded-l-none border-l-0"
						disabled={blocked || !editor.table.columns.length} aria-label="Query export options" title="Choose export columns"
						onclick={(event) => exportRows(true, event.currentTarget)}><Settings2 /></Button>
				</div>
				<Button variant={editor.live ? 'secondary' : 'outline'} size="sm" class="text-xs" aria-label="Live updates" aria-pressed={editor.live}
					title="Check for changes every 5 seconds while this tab is visible" onclick={() => editor.setLive(!editor.live)}>
					<Radio class={editor.live ? 'text-primary' : ''} />Live
				</Button>
				<Button variant="outline" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => editor.startInsert()}><Plus />Insert row</Button>
				{#if editor.selectedCount > 0}
					<Button variant="ghost" size="icon-sm" disabled={editor.busy} aria-label="Clear row selection" onclick={() => editor.clearRowSelection()}><X /></Button>
					<Button bind:ref={deleteTrigger} variant="destructive" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => (deleteOpen = true)}><Trash2 />Delete {editor.selectedCount}</Button>
				{/if}
				<Button bind:ref={refreshButton} variant="outline" size="icon-sm" disabled={blocked} aria-label="Refresh database" onclick={() => void editor.reload()}><RotateCw /></Button>
			</div>
		</div>
		{#if editor.filter}
			<div class="flex items-center gap-2 border-t px-3 py-2 text-xs">
				<span class="shrink-0 text-muted-foreground">Referenced record:</span>
				<span class="min-w-0 truncate font-mono">{Object.entries(editor.filter).map(([name, value]) => `${name} = ${value ?? 'NULL'}`).join(' · ')}</span>
				<Button variant="outline" size="xs" class="ml-auto shrink-0" disabled={blocked} onclick={() => void editor.clearFilters()}>Show all rows</Button>
			</div>
		{/if}
</header>

<Dialog.Root open={deleteOpen} onOpenChange={(value) => { if (!editor.busy) deleteOpen = value; }}>
	<Dialog.Content showCloseButton={!editor.busy}
		onEscapeKeydown={(event) => { if (editor.busy) event.preventDefault(); }}
		onInteractOutside={(event) => { if (editor.busy) event.preventDefault(); }}
		onCloseAutoFocus={(event) => { event.preventDefault(); (deleteTrigger?.isConnected ? deleteTrigger : refreshButton)?.focus(); }}>
		<Dialog.Header>
			<Dialog.Title>Delete {editor.selectedCount} selected rows?</Dialog.Title>
			<Dialog.Description>This deletion is irreversible. All {editor.selectedCount} selected rows in this table will be deleted, including selections on other pages.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" disabled={editor.busy} onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={blocked || !editor.selectedCount || !editor.tableEditable} onclick={() => void deleteRows()}>{editor.busy ? 'Deleting…' : `Delete ${editor.selectedCount} rows`}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if editor.inserting}
	<InsertRow table={editor.table} onclose={() => editor.inserting = false} />
{/if}
