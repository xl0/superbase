<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ArrowDown, ArrowUp, Check, Plus, Radio, RotateCw, Search, Trash2, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import InsertRow from './InsertRow.svelte';

	let { tab = $bindable('data') }: { tab: 'data' | 'definition' } = $props();
	let search = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deleteOpen = $state(false);
	let deleteTrigger = $state<HTMLButtonElement | null>(null);
	let refreshButton = $state<HTMLButtonElement | null>(null);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	const exactCount = $derived(!editor.loading && !editor.error && editor.rowsPage === 0 && !editor.hasMore
		? editor.rows.length : null);

	$effect(() => {
		// A queued search must not replace rows underneath an open cell editor.
		void [editor.tableKey, editor.page, editor.pageSize, editor.sort, editor.filter, editor.busy, editor.editing, editor.inserting, tab];
		clearTimeout(timer);
		search = editor.search;
	});
	onDestroy(() => clearTimeout(timer));

	function filter(value: string) {
		search = value;
		clearTimeout(timer);
		const key = editor.tableKey;
		timer = setTimeout(() => {
			if (editor.tableKey === key && !editor.navigationBlocked) void editor.setSearch(value);
		}, 250);
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
		{#if !editor.search && !editor.filter && editor.table.rowCount >= 0}
			<Badge variant="outline" class="text-[10px] font-normal text-muted-foreground"
				title={exactCount === null ? 'PostgreSQL row estimate; statistics may be stale.' : 'Exact row count from the last loaded page.'}>
				{exactCount === null ? `~${editor.table.rowCount.toLocaleString()}` : exactCount.toLocaleString()} rows
			</Badge>
		{/if}
		<div class="ml-2 flex items-center rounded-md border border-border p-0.5" aria-label="Table view">
			<Button variant={tab === 'data' ? 'secondary' : 'ghost'} size="xs" disabled={editor.navigationBlocked} aria-pressed={tab === 'data'} onclick={() => (tab = 'data')}>Data</Button>
			<Button variant={tab === 'definition' ? 'secondary' : 'ghost'} size="xs" disabled={editor.navigationBlocked} aria-pressed={tab === 'definition'} onclick={() => (tab = 'definition')}>Definition</Button>
		</div>
		<div class="ml-auto flex items-center gap-2">
			{#if editor.busy}
				<span role="status" class="text-[11px] text-muted-foreground">Saving…</span>
			{:else if editor.savedAt}
				<span class="flex items-center gap-1 text-[11px] text-primary"><Check class="size-3" /> Saved</span>
			{/if}
		</div>
	</div>
	{#if tab === 'data'}
		<div class="flex flex-wrap items-center gap-2 px-3 pb-2">
			<div class="relative w-56">
				<Search class="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
				<Input value={search} oninput={(event) => filter(event.currentTarget.value)} disabled={editor.busy}
					aria-label="Filter rows" placeholder="Filter rows…" spellcheck={false} class="h-8 pr-7 pl-7 text-xs" />
				{#if search}
					<Button variant="ghost" size="icon-xs" class="absolute top-1 right-1" disabled={editor.busy} aria-label="Clear filter"
						onclick={() => { clearTimeout(timer); search = ''; void editor.setSearch(''); }}><X /></Button>
				{/if}
			</div>
			<Select.Root type="single" value={editor.sort ? `column:${editor.sort.column}` : 'none'} disabled={blocked} allowDeselect={false}
				onValueChange={(value) => { if (value) void editor.setSort(value === 'none' ? '' : value.slice(7)); }}>
				<Select.Trigger size="sm" aria-label="Sort by column" class="text-xs">{editor.sort?.column ?? 'Sort by…'}</Select.Trigger>
				<Select.Content>
					<Select.Item value="none" label="No sorting" />
					{#each editor.table.columns as column (column.name)}<Select.Item value={`column:${column.name}`} label={column.name} />{/each}
				</Select.Content>
			</Select.Root>
			<Button variant="outline" size="icon-sm" disabled={blocked || !editor.sort} aria-label={editor.sort?.direction === 'asc' ? 'Sort descending' : 'Sort ascending'} onclick={() => void editor.toggleSortDirection()}>
				{#if editor.sort?.direction === 'desc'}<ArrowDown />{:else}<ArrowUp />{/if}
			</Button>
			<div class="ml-auto flex items-center gap-2">
				<Button variant={editor.live ? 'secondary' : 'outline'} size="sm" class="text-xs" aria-label="Live updates" aria-pressed={editor.live}
					title="Check for changes every 5 seconds while this tab is visible" onclick={() => editor.setLive(!editor.live)}>
					<Radio class={editor.live ? 'text-primary' : ''} />Live
				</Button>
				<Button variant="outline" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => editor.startInsert()}><Plus />Insert row</Button>
				{#if editor.selectedCount > 0}
					<Button variant="ghost" size="icon-sm" disabled={editor.busy} aria-label="Clear row selection" onclick={() => editor.clearRowSelection()}><X /></Button>
					<Button bind:ref={deleteTrigger} variant="destructive" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => (deleteOpen = true)}><Trash2 />Delete {editor.selectedCount}</Button>
				{/if}
				<Button bind:ref={refreshButton} variant="outline" size="icon-sm" disabled={blocked} aria-label="Refresh database" onclick={() => { clearTimeout(timer); search = editor.search; void editor.reload(); }}><RotateCw /></Button>
			</div>
		</div>
		{#if editor.filter}
			<div class="flex items-center gap-2 border-t px-3 py-2 text-xs">
				<span class="shrink-0 text-muted-foreground">Referenced record:</span>
				<span class="min-w-0 truncate font-mono">{Object.entries(editor.filter).map(([name, value]) => `${name} = ${value ?? 'NULL'}`).join(' · ')}</span>
				<Button variant="outline" size="xs" class="ml-auto shrink-0" disabled={blocked} onclick={() => void editor.clearFilter()}>Show all rows</Button>
			</div>
		{/if}
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
