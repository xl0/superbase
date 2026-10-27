<script lang="ts">
	import { onMount } from 'svelte';
	import { policies } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { PolicyTable } from '#lib/database.js';
	import { fresh, message } from '#lib/utils.js';
	import SchemaFilter from './SchemaFilter.svelte';
	import TableAccess from './TableAccess.svelte';

	let data = $state.raw<PolicyTable[] | null>(null);
	let error = $state('');
	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	const tables = $derived((data ?? []).filter((table) => table.schema === schema
		&& `${table.table} ${table.policies.map((policy) => policy.name).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));

	async function load() {
		try { data = await fresh(policies({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);
</script>

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<SchemaFilter bind:schema bind:query label="Search tables and policies" />
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	{#each tables as table (table.table)}
		<section class="rounded-md border" aria-label={`Policies of ${table.table}`}>
			<TableAccess {table}
				onapplied={async () => { await load(); void editor.reload(); }} />
		</section>
	{:else}
		<p class="text-xs text-muted-foreground">{data === null ? 'Loading…' : query ? 'No matching tables.' : 'No tables in this schema.'}</p>
	{/each}
</div>
