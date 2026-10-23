<script lang="ts">
	import { onMount } from 'svelte';
	import { Database } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { ConnectionStatus } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectionDialog from './ConnectionDialog.svelte';
	import DataGrid from './DataGrid.svelte';
	import GridFooter from './GridFooter.svelte';
	import Sidebar from './Sidebar.svelte';
	import TableDefinition from './TableDefinition.svelte';
	import TableToolbar from './TableToolbar.svelte';

	let { status }: { status: ConnectionStatus } = $props();
	let tab = $state<'data' | 'definition'>('data');
	let connectOpen = $state(false);

	onMount(() => {
		if (status.connection) void editor.initialize(status.connection.id);
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		if (editor.hasAnyChanges || editor.editing) {
			event.preventDefault();
			event.returnValue = '';
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if !editor.ready}
	<main class="grid h-dvh place-items-center bg-background p-6 text-foreground">
		<div class="w-full max-w-lg space-y-3">
			{#if editor.error}
				<h1 class="text-lg font-semibold">Cannot load database</h1>
				<p role="alert" class="text-xs break-words text-destructive">{editor.error}</p>
				<Button size="sm" disabled={editor.busy || editor.loading} onclick={() => void editor.reload()}>Retry</Button>
			{:else}
				<p role="status" class="text-xs text-muted-foreground">Loading database…</p>
			{/if}
			<Button variant="outline" size="sm" disabled={editor.busy} onclick={() => (connectOpen = true)}>Change connection</Button>
		</div>
	</main>
{:else}
	<div class="flex h-dvh bg-background text-foreground">
		<Sidebar connection={status.connection!} onconnect={() => (connectOpen = true)} />
		<main class="flex min-w-0 flex-1 flex-col">
			{#if editor.tables.length === 0}
				<div class="grid flex-1 place-items-center p-6">
					<div class="max-w-md space-y-3 text-center">
						<Database class="mx-auto size-8 text-muted-foreground" />
						<h1 class="text-lg font-semibold">No tables yet</h1>
						<p class="text-xs text-muted-foreground">Create a table in <span class="font-mono">{status.connection?.database}</span>, then refresh.</p>
						{#if editor.error}<p role="alert" class="text-xs break-words text-destructive">{editor.error}</p>{/if}
						<div class="flex justify-center gap-2">
							<Button size="sm" disabled={editor.busy || editor.loading} onclick={() => void editor.reload()}>Refresh</Button>
							<Button variant="outline" size="sm" disabled={editor.busy} onclick={() => (connectOpen = true)}>Change connection</Button>
						</div>
					</div>
				</div>
			{:else}
				<TableToolbar bind:tab />
				{#if editor.error}
					<div role="alert" class="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
						<span class="min-w-0 break-words">{editor.error}</span>
						<Button variant="outline" size="xs" class="ml-auto" disabled={editor.busy || editor.loading} onclick={() => void editor.fetch()}>Retry rows</Button>
					</div>
				{/if}
				{#if !editor.tableEditable}
					<p class="border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Read-only: this table has no primary key. Add a primary key to safely insert, edit, or delete rows.</p>
				{/if}
				{#if tab === 'data'}
					<div class="relative min-h-0 flex-1" aria-busy={editor.loading || editor.busy}>
						{#key editor.tableKey}
							<DataGrid table={editor.table} rows={editor.pageRows} rowOffset={editor.page * editor.pageSize} draftCount={editor.page === 0 ? editor.draftCount : 0} />
						{/key}
						{#if editor.loading}<div role="status" aria-label="Loading rows" class="absolute inset-x-0 top-0 z-30 h-0.5 animate-pulse bg-primary"></div>{/if}
					</div>
					<GridFooter />
				{:else}
					<div class="min-h-0 flex-1"><TableDefinition /></div>
				{/if}
			{/if}
		</main>
	</div>
{/if}

<ConnectionDialog bind:open={connectOpen} {status} />
