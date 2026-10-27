<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Check, Database, Server, SquareTerminal, Table2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { databaseHref, databaseId, sqlHref, tablesHref } from '#lib/links.js';
	import { parseViewHash, type TableView } from '#lib/view.js';
	import type { ConnectionInfo, Table } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import ConnectionDialog from './ConnectionDialog.svelte';
	import DataGrid from './DataGrid.svelte';
	import SchemaEditor from './SchemaEditor.svelte';
	import GridFooter from './GridFooter.svelte';
	import Sidebar from './Sidebar.svelte';
	import TableToolbar from './TableToolbar.svelte';
	import LoadingShell from './LoadingShell.svelte';
	import SqlEditor from './SqlEditor.svelte';
	import DatabaseWorkspace from './DatabaseWorkspace.svelte';
	import Workspace from './Workspace.svelte';
	import TableAccessPanel from './TableAccessPanel.svelte';
	import TableDefinitionPanel from './TableDefinitionPanel.svelte';
	import { SqlState } from '#lib/state/sql.svelte.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	let { connection, locked }: { connection: ConnectionInfo; locked: boolean } = $props();
	let connectionsActive = $state(false);
	let leaving = false;
	const sql = new SqlState(untrack(() => connection));
	const db = untrack(() => databaseId(connection));
	// The route picks the workspace; all three stay mounted below.
	const workspace = $derived(page.route.id?.startsWith('/db/[db]/sql') ? 'sql' : page.route.id?.startsWith('/db/[db]/database') ? 'database' : 'tables');
	let sqlOpened = $state(false);
	let databaseSection = $state<string | undefined>(undefined);
	$effect(() => {
		if (workspace === 'sql') sqlOpened = true;
		if (workspace === 'database') databaseSection = page.params.section;
	});

	/** The table view the URL names (no table: the schema's first, or none in an empty schema); null off the tables workspace or before a schema is named. */
	const urlView = $derived<TableView | null>(workspace === 'tables' && page.params.schema
		? { schema: page.params.schema, table: page.params.table ?? '', ...parseViewHash(page.url.hash) } : null);
	// URL → editor: links, Back/Forward, typed URLs. While edits are open the URL may run ahead;
	// the view applies once they finish.
	$effect(() => {
		const view = urlView;
		if (view && editor.ready && !editor.navigationBlocked) untrack(() => void editor.show(view));
	});
	// Editor → URL: sorting, filtering, paging, FK jumps and schema changes add history entries.
	// show() updates the state synchronously, so a URL-driven change finds the URL already matching.
	$effect(() => {
		if (workspace !== 'tables' || !editor.ready || !editor.activeSchema) return;
		const href = tablesHref(db, editor.view);
		// Untracked URL: a URL change alone (Back while edits are open) must not push the old view again.
		untrack(() => {
			const target = new URL(href, page.url.href);
			if (target.pathname === page.url.pathname && target.hash === page.url.hash) return;
			// Canonicalizing a bare or stale URL (no or unknown table) replaces it.
			const named = urlView && (urlView.table ? editor.tables.some((table) => table.schema === urlView.schema && table.name === urlView.table)
				: editor.schemas.includes(urlView.schema) && !editor.tables.some((table) => table.schema === urlView.schema));
			void goto(target, { replace: !named, reset: false });
		});
	});
	let schemaEdit = $state.raw<{ mode: Exclude<SchemaEditMode, { kind: 'access' | 'definition' }>; table: Table; anchor: HTMLElement | null } | null>(null);
	let sidePanel = $state.raw<{ kind: 'access' | 'definition'; table: Table } | null>(null);

	/** Menus pass their own table, so actions on an inactive sidebar table never retarget the grid. */
	function openSchema(mode: SchemaEditMode, anchor?: HTMLElement | null, table: Table = editor.table) {
		if (editor.navigationBlocked || editor.loading) return;
		const trigger = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		if (mode.kind === 'definition') { sidePanel = { kind: 'definition', table }; return; } // Read-only: blocks nothing.
		editor.schemaEditing = true;
		if (mode.kind === 'access') sidePanel = { kind: 'access', table };
		else schemaEdit = { mode, anchor: trigger, table };
	}

	const liveActive = () => document.visibilityState === 'visible' && !connectionsActive && workspace === 'tables' && !sql.busy;

	onMount(() => {
		void editor.initialize(connection.key, urlView ?? undefined);
		// Realtime tables refresh on their notifications while the stream is up, polled only every 30 s as a safety net
		// (a notification arriving mid-save or mid-load is skipped). A tab becoming visible always catches up.
		let tick = 0;
		const timer = window.setInterval(() => {
			if (!(editor.realtime && editor.table.realtime) || ++tick % 6 === 0) void editor.poll(liveActive);
		}, 5_000);
		const visible = () => { void editor.poll(liveActive); };
		document.addEventListener('visibilitychange', visible);
		return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
	});

	// Realtime: one event stream per database while any table has the trigger (not in the static demo).
	// Bursts coalesce in editor.poll: one read at a time, plus one more if changes arrived meanwhile.
	const anyRealtime = $derived(import.meta.env.MODE !== 'demo' && editor.tables.some((table) => table.realtime));
	$effect(() => {
		if (!anyRealtime) return;
		const source = new EventSource(`${resolve('/events')}?connection=${encodeURIComponent(connection.key)}`);
		source.onopen = () => { editor.realtime = true; };
		source.onerror = () => { editor.realtime = false; };
		// Notifications proved undeliverable (e.g. a transaction pooler): stop retrying and keep polling.
		source.addEventListener('unavailable', (event) => { editor.realtimeIssue = event.data; editor.realtime = false; source.close(); });
		source.onmessage = (event) => {
			const change: { schema: string; table: string } = JSON.parse(event.data);
			if (change.schema === editor.activeSchema && change.table === editor.activeTableName) void editor.poll(liveActive);
		};
		return () => { source.close(); editor.realtime = false; };
	});

	const unsavedWork = () => editor.navigationBlocked || sql.protectedWork;
	// A complete, unfiltered first page is an exact count; otherwise show the catalog estimate.
	const exactCount = $derived(!editor.loading && !editor.error && editor.rowsPage === 0 && !editor.hasMore ? editor.rows.length : null);
</script>

<svelte:window onbeforeunload={(event) => { if (!leaving && unsavedWork()) event.preventDefault(); }} onpagehide={(event) => {
	// Release the SQL session on close/reload; server idle expiry covers crashes.
	if (!event.persisted && sql.session && import.meta.env.MODE !== 'demo') navigator.sendBeacon('/sql/close', JSON.stringify({ connection: sql.connection, session: sql.session }));
}} />

<div class="flex h-dvh flex-col">
	<header class="flex h-12 shrink-0 items-center gap-2 border-b bg-card pr-3">
		<div class="grid w-12 shrink-0 place-items-center" title="superbase"><Database class="size-5 text-muted-foreground" /><span class="sr-only">superbase</span></div>
		<div class="min-w-0">
			<ConnectionDialog bind:active={connectionsActive} {connection} {locked} disabled={editor.busy || sql.busy}
				approve={() => !unsavedWork() || window.confirm('Discard unsaved edits and close SQL sessions (rolling back uncommitted work)?')}
				onswitch={() => leaving = true} />
		</div>
		{#if editor.version}<span class="shrink-0 font-mono text-[11px] text-muted-foreground">PG {editor.version}</span>{/if}
		{#if import.meta.env.MODE === 'demo'}
			<a href="https://github.com/xl0/superbase" class="shrink-0" title="PostgreSQL (PGlite) runs in this tab; reloading the page resets the data.">
				<Badge variant="outline" class="text-[10px] font-normal text-primary">Demo · in-browser database</Badge></a>
		{/if}
		{#if workspace === 'tables' && editor.table.name}
			<div class="ml-4 flex min-w-0 items-baseline gap-1.5 font-mono text-xs">
				<span class="max-w-48 truncate text-muted-foreground">{editor.table.schema}</span><span class="text-muted-foreground">/</span>
				<span class="truncate font-medium" title={`${editor.table.schema}.${editor.table.name}`}>{editor.table.name}</span>
			</div>
			{#if !editor.hasFilters && editor.table.rowCount >= 0}
				<Badge variant="outline" class="shrink-0 text-[10px] font-normal text-muted-foreground"
					title={exactCount === null ? 'PostgreSQL row estimate; statistics may be stale.' : 'Exact row count.'}>
					{exactCount === null ? `~${editor.table.rowCount.toLocaleString()}` : exactCount.toLocaleString()} rows
				</Badge>
			{/if}
			{#if editor.busy}<span role="status" class="ml-auto shrink-0 text-[11px] text-muted-foreground">Saving…</span>
			{:else if editor.savedAt}<span class="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-primary"><Check class="size-3" />Saved</span>{/if}
		{/if}
	</header>
	<div class="min-h-0 flex-1">
		{#if !editor.ready && !editor.error}
			<LoadingShell contained />
		{:else if !editor.ready}
			<main class="grid h-full place-items-center bg-background p-6 text-foreground">
				<div class="w-full max-w-lg space-y-3">
					<h1 class="text-lg font-semibold">Cannot load database</h1>
					<p role="alert" class="text-xs break-words text-destructive">{editor.error}</p>
					<Button size="sm" disabled={editor.busy || editor.loading} onclick={() => void editor.reload()}>Retry</Button>
				</div>
			</main>
		{:else}
			<div class="flex h-full bg-background text-foreground">
				<nav aria-label="Workspace" class="flex w-12 shrink-0 flex-col items-center gap-2 border-r bg-card py-2">
					<Button variant={workspace === 'tables' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Table editor" title="Table editor"
						aria-current={workspace === 'tables' ? 'page' : undefined} disabled={editor.navigationBlocked} href={tablesHref(db, editor.view)}><Table2 /></Button>
					<Button variant={workspace === 'sql' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="SQL editor" title={sql.busy ? 'SQL editor — running' : 'SQL editor'}
						aria-current={workspace === 'sql' ? 'page' : undefined} disabled={editor.navigationBlocked} href={sqlHref(db)}>
						<SquareTerminal class={sql.busy || sql.transaction === 'transaction' || sql.transaction === 'failed' ? 'text-amber-300' : ''} />
					</Button>
					<Button variant={workspace === 'database' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Database" title="Database: schemas, indexes, enums, triggers, policies, roles, performance, activity, extensions, configuration"
						aria-current={workspace === 'database' ? 'page' : undefined} disabled={editor.navigationBlocked} href={databaseHref(db, databaseSection)}><Server /></Button>
				</nav>
				<!-- Hidden workspaces stay mounted to keep drafts, selections and scroll positions. -->
				<div class="min-w-0 flex-1" style:display={workspace === 'tables' ? 'flex' : 'none'}>
					<Workspace label="Tables">
						{#snippet sidebar()}<Sidebar oncreate={() => openSchema({ kind: 'createTable' })} onedit={openSchema} />{/snippet}
						{#if editor.schemaTables.length === 0}
							<div class="grid flex-1 place-items-center p-6">
								<div class="max-w-md space-y-3 text-center">
									<Database class="mx-auto size-8 text-muted-foreground" />
									<h1 class="text-lg font-semibold">{editor.activeSchema ? `No tables in ${editor.activeSchema}` : 'No tables yet'}</h1>
									{#if editor.error}<p role="alert" class="text-xs break-words text-destructive">{editor.error}</p>{/if}
									<div class="flex justify-center gap-2">
										<Button size="sm" disabled={editor.navigationBlocked || editor.loading} onclick={() => openSchema({ kind: 'createTable' })}>Create table</Button>
										<Button variant="outline" size="sm" disabled={editor.busy || editor.loading} onclick={() => void editor.reload()}>Refresh</Button>
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
									{#if editor.selectedCount || editor.editing || editor.inserting}<span class="text-muted-foreground">Finish editing and clear row selections to refresh.</span>{/if}
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
								<p class="border-b bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{editor.table.kind === 'view' ? 'Read-only: this is a view.'
									: editor.table.kind === 'materialized view' ? 'Read-only: this is a materialized view. Refresh its data from the ⋮ menu.'
									: 'Read-only: this table has no primary key. Add one from the table’s ⋮ menu to enable editing.'}</p>
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
					</Workspace>
				</div>
				{#if workspace === 'database'}
					<div class="flex min-w-0 flex-1"><DatabaseWorkspace /></div>
				{/if}
				{#if sqlOpened}
					<div class="min-w-0 flex-1" style:display={workspace === 'sql' ? 'flex' : 'none'}>
						<SqlEditor state={sql} active={workspace === 'sql' && !connectionsActive} />
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
{#if schemaEdit}<SchemaEditor mode={schemaEdit.mode} table={schemaEdit.table} returnFocus={schemaEdit.anchor} onclose={() => schemaEdit = null} />{/if}
{#if sidePanel?.kind === 'access'}<TableAccessPanel table={sidePanel.table} onclose={() => { sidePanel = null; editor.schemaEditing = false; }} />
{:else if sidePanel?.kind === 'definition'}<TableDefinitionPanel table={sidePanel.table} onclose={() => sidePanel = null} />{/if}
