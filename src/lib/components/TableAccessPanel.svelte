<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { policies } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Policies } from '#lib/database.js';
	import type { Table } from '#lib/types.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ResizableSheet from './ResizableSheet.svelte';
	import TableAccess from './TableAccess.svelte';

	/** The table editor's side panel for one table's RLS, policies and privileges. */
	let { table, onclose }: { table: Table; onclose: () => void } = $props();
	const id = $props.id();
	let data = $state.raw<Policies | null>(null);
	let error = $state('');
	let changed = false;
	const entry = $derived(data?.tables.find((candidate) => candidate.schema === table.schema && candidate.table === table.name));

	async function load() {
		try { data = await fresh(policies({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function close() {
		onclose();
		// The RLS flag drives the Role menu; reload the metadata once the panel no longer blocks navigation.
		if (changed) queueMicrotask(() => void editor.reload());
	}
</script>

<ResizableSheet open onOpenChange={(open) => { if (!open) close(); }} width={640} label="Resize access panel" aria-labelledby={`${id}-title`}
	class="gap-0 overflow-y-auto p-0">
	<div class="flex items-center border-b px-4 py-3">
		<div class="min-w-0 flex-1">
			<h2 id={`${id}-title`} class="text-sm font-medium">Policies & access</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{table.schema}.{table.name}</p>
		</div>
		<Button variant="ghost" size="icon-sm" aria-label="Close access panel" onclick={close}><X /></Button>
	</div>
	{#if error}<p role="alert" class="p-4 text-xs text-destructive">{error}</p>{/if}
	{#if entry && data}
		<TableAccess table={entry} roles={data.roles} role={data.role} bypass={data.bypass} privilegesOpen
			onapplied={async () => { changed = true; await load(); }} />
	{:else if data}
		<p class="p-4 text-xs text-muted-foreground">This table was not found; refresh the table list.</p>
	{:else if !error}
		<p class="p-4 text-xs text-muted-foreground">Loading…</p>
	{/if}
</ResizableSheet>
