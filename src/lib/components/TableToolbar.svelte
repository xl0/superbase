<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ArrowDown, ArrowUp, Check, Plus, RotateCw, Search, Trash2, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	let { tab = $bindable('data') }: { tab: 'data' | 'definition' } = $props();
	let search = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deleteOpen = $state(false);
	let deleteTrigger = $state<HTMLButtonElement | null>(null);
	let refreshButton = $state<HTMLButtonElement | null>(null);
	const blocked = $derived(editor.busy || editor.loading);

	$effect(() => {
		// Cancel a pending filter whenever its navigation context changes.
		void [editor.tableKey, editor.page, editor.pageSize, editor.sort, editor.busy, tab];
		clearTimeout(timer);
		search = editor.search;
	});
	onDestroy(() => clearTimeout(timer));

	function filter(value: string) {
		search = value;
		clearTimeout(timer);
		const key = editor.tableKey;
		timer = setTimeout(() => {
			if (editor.tableKey === key && !editor.busy) void editor.setSearch(value);
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
		{#if !editor.search && editor.table.rowCount >= 0}
			<Badge variant="outline" class="text-[10px] font-normal text-muted-foreground">~{editor.table.rowCount.toLocaleString()} rows</Badge>
		{/if}
		{#if editor.draftCount > 0}<Badge variant="secondary" class="text-[10px]">{editor.draftCount} new</Badge>{/if}
		<div class="ml-2 flex items-center rounded-md border border-border p-0.5" aria-label="Table view">
			<Button variant={tab === 'data' ? 'secondary' : 'ghost'} size="xs" disabled={editor.busy} aria-pressed={tab === 'data'} onclick={() => (tab = 'data')}>Data</Button>
			<Button variant={tab === 'definition' ? 'secondary' : 'ghost'} size="xs" disabled={editor.busy} aria-pressed={tab === 'definition'} onclick={() => (tab = 'definition')}>Definition</Button>
		</div>
		<div class="ml-auto flex items-center gap-2">
			{#if editor.hasChanges}
				<span class="text-[11px] text-muted-foreground">Unsaved changes</span>
				<Button variant="outline" size="xs" disabled={blocked} onclick={() => { if (window.confirm('Discard unsaved changes in this table?')) editor.revert(); }}>Revert</Button>
				<Button size="xs" disabled={blocked || !editor.tableEditable} onclick={() => void editor.save()}><Check />{editor.busy ? 'Working…' : 'Save'}</Button>
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
			<NativeSelect.Root size="sm" aria-label="Sort by column" value={editor.sort?.column ?? ''} disabled={blocked}
				onchange={(event) => void editor.setSort(event.currentTarget.value)}>
				<NativeSelect.Option value="">Sort by…</NativeSelect.Option>
				{#each editor.table.columns as column (column.name)}<NativeSelect.Option value={column.name}>{column.name}</NativeSelect.Option>{/each}
			</NativeSelect.Root>
			<Button variant="outline" size="icon-sm" disabled={blocked || !editor.sort} aria-label={editor.sort?.direction === 'asc' ? 'Sort descending' : 'Sort ascending'} onclick={() => void editor.toggleSortDirection()}>
				{#if editor.sort?.direction === 'desc'}<ArrowDown />{:else}<ArrowUp />{/if}
			</Button>
			<div class="ml-auto flex items-center gap-2">
				<Button variant="outline" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => editor.insertRow()}><Plus />Insert row</Button>
				{#if editor.selectedCount > 0}
					<Button variant="ghost" size="icon-sm" disabled={editor.busy} aria-label="Clear row selection" onclick={() => editor.clearRowSelection()}><X /></Button>
					<Button bind:ref={deleteTrigger} variant="destructive" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => (deleteOpen = true)}><Trash2 />Delete {editor.selectedCount}</Button>
				{/if}
				<Button bind:ref={refreshButton} variant="outline" size="icon-sm" disabled={blocked} aria-label="Refresh database" onclick={() => { clearTimeout(timer); search = editor.search; void editor.reload(); }}><RotateCw class={editor.loading ? 'animate-spin' : ''} /></Button>
			</div>
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
			<Dialog.Description>This deletion is irreversible. All {editor.selectedCount} selected rows in this table will be deleted, including selections on other pages. Selected unsaved drafts will be removed.</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" disabled={editor.busy} onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={blocked || !editor.selectedCount || !editor.tableEditable} onclick={() => void deleteRows()}>{editor.busy ? 'Deleting…' : `Delete ${editor.selectedCount} rows`}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
