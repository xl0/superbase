<script lang="ts">
	import { onMount } from 'svelte';
	import { Database } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { ConnectionStatus } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectionDialog from './ConnectionDialog.svelte';
	import DataGrid from './DataGrid.svelte';
	import SchemaEditor from './SchemaEditor.svelte';
	import GridFooter from './GridFooter.svelte';
	import Sidebar from './Sidebar.svelte';
	import TableToolbar from './TableToolbar.svelte';
	import LoadingShell from './LoadingShell.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	let { status }: { status: ConnectionStatus } = $props();
	let connectOpen = $state(false);
	let schemaEdit = $state<SchemaEditMode | null>(null);

	let schemaAnchor = $state.raw<HTMLElement | null>(null);

	function openSchema(mode: SchemaEditMode, anchor?: HTMLElement | null) {
		if (editor.navigationBlocked || editor.loading) return;
		schemaAnchor = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		editor.schemaEditing = true;
		schemaEdit = mode;
	}

	const liveActive = () => document.visibilityState === 'visible' && !connectOpen;

	onMount(() => {
		if (status.connection) void editor.initialize(status.connection.id);
		const poll = () => { void editor.poll(liveActive); };
		const timer = window.setInterval(poll, 5_000);
		document.addEventListener('visibilitychange', poll);
		return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		if (editor.navigationBlocked) {
			event.preventDefault();
			event.returnValue = '';
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if !editor.ready && !editor.error}
	<LoadingShell />
{:else if !editor.ready}
	<main class="grid h-dvh place-items-center bg-background p-6 text-foreground">
		<div class="w-full max-w-lg space-y-3">
			<h1 class="text-lg font-semibold">Cannot load database</h1>
			<p role="alert" class="text-xs break-words text-destructive">{editor.error}</p>
			<Button size="sm" disabled={editor.busy || editor.loading} onclick={() => void editor.reload()}>Retry</Button>
			<Button variant="outline" size="sm" disabled={editor.busy} onclick={() => (connectOpen = true)}>Change connection</Button>
		</div>
	</main>
{:else}
	<div class="flex h-dvh bg-background text-foreground">
		<Sidebar connection={status.connection!} onconnect={() => (connectOpen = true)} oncreate={() => openSchema({ kind: 'createTable' })} />
		<main class="flex min-w-0 flex-1 flex-col">
			{#if editor.tables.length === 0}
				<div class="grid flex-1 place-items-center p-6">
					<div class="max-w-md space-y-3 text-center">
						<Database class="mx-auto size-8 text-muted-foreground" />
						<h1 class="text-lg font-semibold">No tables yet</h1>
						<p class="text-xs text-muted-foreground">Create your first table in <span class="font-mono">{status.connection?.database}</span>.</p>
						{#if editor.error}<p role="alert" class="text-xs break-words text-destructive">{editor.error}</p>{/if}
						<div class="flex justify-center gap-2">
							<Button size="sm" disabled={editor.navigationBlocked || editor.loading} onclick={() => openSchema({ kind: 'createTable' })}>Create table</Button>
							<Button variant="outline" size="sm" disabled={editor.busy || editor.loading} onclick={() => void editor.reload()}>Refresh</Button>
							<Button variant="outline" size="sm" disabled={editor.busy} onclick={() => (connectOpen = true)}>Change connection</Button>
						</div>
					</div>
				</div>
			{:else}
				<TableToolbar onedit={openSchema} />
				{#if editor.error && (editor.rows.length || editor.loading)}
					<div role="alert" class="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						<span class="min-w-0 break-words">{editor.error}</span>
						<Button variant="outline" size="xs" class="ml-auto" disabled={editor.navigationBlocked || editor.loading} onclick={() => void editor.fetch()}>Retry rows</Button>
					</div>
				{/if}
				{#if editor.externalChange}
					<div role="status" class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/50 px-3 py-2 text-xs">
						<span>Database changed — refresh available.</span>
						{#if editor.selectedCount || editor.editing || editor.inserting}<span class="text-muted-foreground">Finish or cancel editing and clear row selections to refresh.</span>{/if}
						<Button variant="outline" size="xs" class="ml-auto" disabled={editor.navigationBlocked || editor.loading || !!editor.selectedCount}
							onclick={() => void editor.fetch(true)}>Refresh rows</Button>
					</div>
				{/if}
				{#if editor.live && editor.liveError}
					<div role="status" class="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-destructive">
						<span class="min-w-0 break-words">Live update failed: {editor.liveError}</span>
						<Button variant="outline" size="xs" class="ml-auto" disabled={editor.polling || editor.busy || editor.loading} onclick={() => void editor.poll(liveActive)}>Retry</Button>
					</div>
				{/if}
				{#if !editor.tableEditable}
					<p class="border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Read-only: this table has no primary key. Use Table actions to add one and enable row editing.</p>
				{/if}
					<div class="relative min-h-0 flex-1" aria-busy={editor.loading || editor.busy}>
						{#key editor.tableKey}
							<DataGrid table={editor.table} rows={editor.rows} rowOffset={editor.rowsPage * editor.pageSize} onedit={openSchema} />
						{/key}
						{#if editor.loading && editor.rows.length}
							<div role="status" class="pointer-events-none absolute top-12 right-4 z-30 rounded-md border bg-popover px-3 py-3 shadow-md">
								<span class="sr-only">Loading rows…</span><Skeleton class="h-2 w-24" />
							</div>
						{/if}
					</div>
					<GridFooter />
			{/if}
		</main>
	</div>
{/if}

<ConnectionDialog bind:open={connectOpen} {status} />
{#if schemaEdit}<SchemaEditor mode={schemaEdit} returnFocus={schemaAnchor} onclose={() => schemaEdit = null} />{/if}
