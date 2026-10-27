<script lang="ts">
	import { onMount } from 'svelte';
	import { Trash2 } from '@lucide/svelte';
	import { indexes } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { DatabaseIndex } from '#lib/database.js';
	import { qualify } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import SchemaFilter from './SchemaFilter.svelte';
	import SqlDialog from './SqlDialog.svelte';

	let list = $state.raw<DatabaseIndex[] | null>(null);
	let error = $state('');
	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	let dropping = $state.raw<DatabaseIndex | null>(null);
	const shown = $derived((list ?? []).filter((index) => index.schema === schema
		&& `${index.table} ${index.name} ${index.columns.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));

	async function load() {
		try { list = await fresh(indexes({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);
</script>

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<SchemaFilter bind:schema bind:query label="Search indexes" />
		<p class="text-xs text-muted-foreground">Create indexes from a table's ⋮ menu → Indexes.</p>
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Table</th><th class="p-3 font-medium">Columns</th><th class="p-3 font-medium">Name</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as index (`${index.schema}.${index.name}`)}
					<tr class="align-top">
						<td class="p-3 font-mono">{index.table}</td>
						<td class="p-3 font-mono">{index.columns.join(', ')}</td>
						<td class="p-3">
							<details><summary class="cursor-pointer font-mono">{index.name}</summary>
								<pre class="mt-2 whitespace-pre-wrap break-all font-mono text-muted-foreground">{index.definition}</pre></details>
						</td>
						<td class="p-2 text-right">
							<Button variant="ghost" size="icon-sm" disabled={!!index.constraint} aria-label={`Drop index ${index.name}`}
								title={index.constraint ? `Owned by constraint ${index.constraint}` : 'Drop index'}
								onclick={() => dropping = index}><Trash2 /></Button>
						</td>
					</tr>
				{:else}
					<tr><td colspan="4" class="p-3 text-muted-foreground">{list === null ? 'Loading…' : query ? 'No matching indexes.' : 'No indexes in this schema.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<SqlDialog open={!!dropping} title="Drop index" subject={dropping?.name} description="Table data is not affected; queries using it may get slower."
	sql={dropping ? `drop index ${qualify(dropping.schema, dropping.name)};` : ''} destructive action="Drop"
	onclose={() => dropping = null} onapplied={load} />
