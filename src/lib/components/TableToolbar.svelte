<script lang="ts">
	import { LockKeyhole, LockKeyholeOpen, Plus, Radio, RotateCw, Trash2, X, Zap } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import CsvExport from './CsvExport.svelte';
	import InsertRow from './InsertRow.svelte';
	import FilterBar from './FilterBar.svelte';
	import SortMenu from './SortMenu.svelte';
	import RoleMenu from './RoleMenu.svelte';

	let { onedit }: { onedit: (mode: SchemaEditMode, anchor: HTMLElement) => void } = $props();
	let deleteOpen = $state(false);
	let deleteTrigger = $state<HTMLButtonElement | null>(null);
	let refreshButton = $state<HTMLButtonElement | null>(null);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	/** Realtime is a trigger, so tables only; the static demo has no event stream. */
	const realtimeControl = $derived(editor.table.kind === 'table' && import.meta.env.MODE !== 'demo');

	async function deleteRows() {
		if (blocked || !editor.tableEditable) return;
		await editor.deleteSelected();
		deleteOpen = false;
	}
</script>

<header class="shrink-0 border-b border-border bg-background">
		<div class="flex flex-wrap items-start gap-2 px-3 py-2">
			<FilterBar />
			<div class="ml-auto flex flex-wrap items-center gap-2">
				{#if editor.table.kind === 'table'}
					<Button variant="outline" size="sm" class={['text-xs', editor.table.rls && 'text-primary']} disabled={blocked}
						title="Row-level security, policies and table privileges" onclick={(event) => onedit({ kind: 'access' }, event.currentTarget)}>
						{#if editor.table.rls}<LockKeyhole />RLS on{:else}<LockKeyholeOpen />RLS off{/if}
					</Button>
				{/if}
				<!-- Shown for RLS tables, and while acting as a role so it can be switched back. -->
				{#if editor.table.rls || editor.viewAs}<RoleMenu />{/if}
				<SortMenu />
				<CsvExport />
				<!-- Live: this tab's auto-refresh. ⚡: the table's realtime trigger (a database change, applied at once). -->
				<div class="flex shrink-0">
					<Button variant={editor.live ? 'secondary' : 'outline'} size="sm" class={['text-xs', realtimeControl && 'rounded-r-none']}
						aria-label="Live updates" aria-pressed={editor.live} onclick={() => editor.setLive(!editor.live)}
						title={editor.realtime && editor.table.realtime ? 'Live: refreshes as soon as the table changes (realtime)' : 'Live: checks for changes every 5 seconds while this tab is visible'}>
						<Radio class={editor.live ? 'text-primary' : ''} />Live
					</Button>
					{#if realtimeControl}
						<Button variant={editor.table.realtime ? 'secondary' : 'outline'} size="icon-sm" class="rounded-l-none border-l-0" disabled={blocked}
							aria-label="Realtime" aria-pressed={editor.table.realtime} onclick={() => void editor.setRealtime(!editor.table.realtime)}
							title={editor.realtimeIssue ?? (editor.table.realtime ? 'Realtime on: changes are pushed at once. Click to drop the trigger and poll instead.'
								: 'Turn on realtime: adds a notify trigger to this table so open editors refresh instantly.')}>
							<Zap class={editor.table.realtime ? editor.realtimeIssue ? 'text-amber-300' : 'text-primary' : ''} />
						</Button>
					{/if}
				</div>
				<Button variant="outline" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => editor.startInsert()}><Plus />Insert row</Button>
				{#if editor.selectedCount > 0}
					<Button variant="ghost" size="icon-sm" disabled={editor.busy} aria-label="Clear row selection" onclick={() => editor.clearRowSelection()}><X /></Button>
					<Button bind:ref={deleteTrigger} variant="destructive" size="sm" class="text-xs" disabled={blocked || !editor.tableEditable} onclick={() => (deleteOpen = true)}><Trash2 />Delete {editor.selectedCount}</Button>
				{/if}
				<Button bind:ref={refreshButton} variant="outline" size="icon-sm" disabled={blocked} aria-label="Refresh database" onclick={() => void editor.reload()}><RotateCw /></Button>
			</div>
		</div>
		{#if editor.reference}
			<div class="flex items-center gap-2 border-t px-3 py-2 text-xs">
				<span class="shrink-0 text-muted-foreground">Referenced record:</span>
				<span class="min-w-0 truncate font-mono">{Object.entries(editor.reference).map(([name, value]) => `${name} = ${value ?? 'NULL'}`).join(' · ')}</span>
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
