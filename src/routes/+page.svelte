<script lang="ts">
	import { database } from '#lib/db.remote.js';
	import DataGrid from '#lib/components/DataGrid.svelte';
	import GridFooter from '#lib/components/GridFooter.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import TableDefinition from '#lib/components/TableDefinition.svelte';
	import TableToolbar from '#lib/components/TableToolbar.svelte';
	import { editor } from '#lib/state/editor.svelte.js';

	const databaseQuery = database();

	let tab = $state<'data' | 'definition'>('data');

	const errorText = $derived.by(() => {
		const error = databaseQuery.error;
		if (!error) return '';
		if (error instanceof Error) return error.message;
		if (typeof error === 'object' && 'message' in error) {
			return String((error as { message: unknown }).message);
		}
		return String(error);
	});

	$effect(() => {
		if (databaseQuery.ready && databaseQuery.current) {
			editor.init(databaseQuery.current);
		}
	});
</script>

{#if databaseQuery.error}
	<div class="grid h-dvh place-items-center bg-bg p-6">
		<div class="w-full max-w-xl">
			<p class="mb-2 font-mono text-[10px] tracking-[0.08em] text-danger uppercase">
				Connection failed
			</p>
			<h1 class="text-lg font-semibold tracking-tight">Cannot reach Postgres</h1>
			<p class="mt-2 text-[12.5px] text-muted">{errorText}</p>
			<pre
				class="mt-4 overflow-auto rounded-md border border-line bg-panel px-3 py-2 font-mono text-[11px] text-muted">DATABASE_URL=postgresql://user:password@host:5432/database</pre>
			<p class="mt-3 text-[11.5px] text-faint">
				Set <span class="font-mono text-muted">DATABASE_URL</span> in <span
					class="font-mono text-muted">.env</span
				>, then restart the server.
			</p>
			<button
				onclick={() => window.location.reload()}
				class="mt-4 h-8 rounded-md bg-accent px-3 text-[12px] font-medium text-[#08130d] hover:bg-accent-dim"
			>
				Retry
			</button>
		</div>
	</div>
{:else if !databaseQuery.ready}
	<div class="grid h-dvh place-items-center bg-bg">
		<div class="flex items-center gap-2 text-xs text-muted">
			<span class="size-1.5 animate-pulse rounded-full bg-accent"></span>
			Connecting to Postgres…
		</div>
	</div>
{:else if databaseQuery.current.tables.length === 0}
	<div class="grid h-dvh place-items-center bg-bg">
		<div class="text-center">
			<p class="text-sm font-medium">No tables yet</p>
			<p class="mt-1 text-xs text-faint">
				Create a table in <span class="font-mono">{databaseQuery.current.server.database}</span> and
				refresh.
			</p>
		</div>
	</div>
{:else if editor.tables.length === 0}
	<div class="grid h-dvh place-items-center bg-bg">
		<div class="flex items-center gap-2 text-xs text-muted">
			<span class="size-1.5 animate-pulse rounded-full bg-accent"></span>
			Loading tables…
		</div>
	</div>
{:else}
	<div class="flex h-dvh">
		<Sidebar />

		<main class="flex min-w-0 flex-1 flex-col">
			<TableToolbar bind:tab />

			{#if editor.error}
				<div
					class="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/8 px-3.5 py-1.5 text-[11.5px] text-danger"
				>
					<span class="truncate">{editor.error}</span>
					<button
						onclick={() => void editor.fetch()}
						class="ml-auto shrink-0 rounded border border-danger/35 px-2 py-0.5 text-[10.5px] hover:bg-danger/15"
					>
						Retry
					</button>
				</div>
			{/if}

			{#if tab === 'data'}
				<div class="relative min-h-0 flex-1">
					{#key editor.tableKey}
						<DataGrid
							table={editor.table}
							rows={editor.pageRows}
							rowOffset={editor.page * editor.pageSize}
							draftCount={editor.page === 0 ? editor.draftCount : 0}
						/>
					{/key}
					{#if editor.loading}
						<div class="absolute inset-x-0 top-0 z-30 h-0.5 animate-pulse bg-accent"></div>
					{/if}
				</div>
				<GridFooter />
			{:else}
				<div class="min-h-0 flex-1">
					<TableDefinition />
				</div>
			{/if}
		</main>
	</div>
{/if}
