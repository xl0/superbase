<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Database, Settings2, SquareTerminal, Table2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { ConnectionStatus, Table, TableTarget } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectionDialog from './ConnectionDialog.svelte';
	import DataGrid from './DataGrid.svelte';
	import SchemaEditor from './SchemaEditor.svelte';
	import GridFooter from './GridFooter.svelte';
	import Sidebar from './Sidebar.svelte';
	import TableToolbar from './TableToolbar.svelte';
	import LoadingShell from './LoadingShell.svelte';
	import SqlEditor from './SqlEditor.svelte';
	import { SqlState } from '#lib/state/sql.svelte.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	let { status }: { status: ConnectionStatus } = $props();
	let connectOpen = $state(false);
	let workspace = $state<'tables' | 'sql'>('tables');
	let sqlOpened = $state(false);
	const sql = new SqlState(untrack(() => status.connection!));
	let workspaceChosen = false;

	function switchWorkspace(next: 'tables' | 'sql') {
		if (editor.navigationBlocked) return;
		workspaceChosen = true;
		workspace = next;
		if (next === 'sql') sqlOpened = true;
	}
	let schemaEdit = $state.raw<{ mode: SchemaEditMode; target: TableTarget; anchor: HTMLElement | null } | null>(null);

	function openSchema(mode: SchemaEditMode, anchor?: HTMLElement | null, table?: Table) {
		if (editor.navigationBlocked || editor.loading) return;
		editor.schemaEditing = true;
		schemaEdit = {
			mode, anchor: anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
			target: { connection: editor.connection, schema: table?.schema ?? editor.activeSchema, table: table?.name ?? editor.activeTableName }
		};
	}

	const liveActive = () => document.visibilityState === 'visible' && !connectOpen && workspace === 'tables' && !sql.busy;

	onMount(() => {
		void sql.restoreDraft().then(() => {
			if (!workspaceChosen && sql.draft) { workspace = 'sql'; sqlOpened = true; }
		});
		if (status.connection) void editor.initialize(status.connection.id);
		const poll = () => { void editor.poll(liveActive); };
		const timer = window.setInterval(poll, 5_000);
		document.addEventListener('visibilitychange', poll);
		return () => { sql.pauseDraft(); window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
	});

	function beforeUnload(event: BeforeUnloadEvent) {
		sql.checkDraft();
		if (editor.navigationBlocked || sql.reloadBlocked) {
			event.preventDefault();
			event.returnValue = '';
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} onpagehide={(event) => {
	// Best effort on reload/close; the server idle limit also covers crashes and offline tabs.
	if (!event.persisted && sql.session) navigator.sendBeacon('/sql/close', new Blob([
		JSON.stringify({ connection: sql.connection, session: sql.session })
	], { type: 'application/json' }));
	sql.pauseDraft();
}} onpageshow={(event) => { if (event.persisted) void sql.restoreDraft(true); }}
onstorage={(event) => sql.checkDraft(event.key)} />

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
		<nav aria-label="Workspace" class="flex w-12 shrink-0 flex-col items-center gap-2 border-r bg-card py-2">
			<div class="mb-2 flex h-8 items-center" title="superbase"><Database class="size-5 text-muted-foreground" /><span class="sr-only">superbase</span></div>
			<Button variant={workspace === 'tables' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Table editor" title="Table editor"
				aria-pressed={workspace === 'tables'} disabled={editor.navigationBlocked} onclick={() => switchWorkspace('tables')}><Table2 /></Button>
			<Button variant={workspace === 'sql' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="SQL editor" title={sql.busy ? 'SQL editor — running' : 'SQL editor'}
				aria-pressed={workspace === 'sql'} disabled={editor.navigationBlocked} onclick={() => switchWorkspace('sql')}><SquareTerminal class={sql.busy || sql.transaction === 'transaction' || sql.transaction === 'failed' ? 'text-amber-300' : ''} /></Button>
			<Button variant="ghost" size="icon-sm" class="mt-auto" aria-label="Database connection" title="Database connection"
				disabled={editor.busy || sql.busy} onclick={() => connectOpen = true}><Settings2 /></Button>
		</nav>
		<div class="min-w-0 flex-1" style:display={workspace === 'tables' ? 'flex' : 'none'} hidden={workspace !== 'tables'}>
		<Sidebar connection={status.connection!} oncreate={() => openSchema({ kind: 'createTable' })} onedit={openSchema} />
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
				<TableToolbar />
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
					<p class="border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Read-only: this table has no primary key. Use the table’s ⋮ menu in the sidebar to add one and enable row editing.</p>
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
		{#if sqlOpened}
			<main class="min-w-0 flex-1" style:display={workspace === 'sql' ? 'block' : 'none'} hidden={workspace !== 'sql'}>
				<SqlEditor state={sql} active={workspace === 'sql' && !connectOpen} database={status.connection!.database} />
			</main>
		{/if}
	</div>
{/if}

<ConnectionDialog bind:open={connectOpen} {status} sqlProtected={() => { sql.checkDraft(); return sql.protectedWork; }} sqlBusy={sql.busy || sql.cancelling}
	onsuccess={() => sql.prepareReload()} />
{#if schemaEdit}<SchemaEditor mode={schemaEdit.mode} target={schemaEdit.target} returnFocus={schemaEdit.anchor} onclose={() => schemaEdit = null} />{/if}
