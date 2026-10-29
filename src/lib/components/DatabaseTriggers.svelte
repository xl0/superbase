<script lang="ts">
	import { onMount } from 'svelte';
	import { ChevronRight, Trash2 } from '@lucide/svelte';
	import { triggers } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Trigger } from '#lib/database.js';
	import { ident, qualify } from '#lib/ddl.js';
	import { highlightSql } from '#lib/sql-highlight.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import SchemaFilter, { picked } from './SchemaFilter.svelte';
	import SqlDialog from './SqlDialog.svelte';

	let list = $state.raw<Trigger[] | null>(null);
	let error = $state('');
	let schema = $state(picked.schema || editor.activeSchema || 'public');
	let query = $state('');
	/** `table.name` of the expanded row. */
	let expanded = $state<string | null>(null);
	let dropping = $state.raw<Trigger | null>(null);
	const shown = $derived((list ?? []).filter((trigger) => trigger.schema === schema
		&& `${trigger.name} ${trigger.table} ${trigger.function}`.toLowerCase().includes(query.trim().toLowerCase())));
	const key = (trigger: Trigger) => `${trigger.table}.${trigger.name}`;

	async function load() {
		try { list = await fresh(triggers({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);
</script>

{#snippet code(text: string)}
	<pre class="sql-code max-h-96 overflow-auto rounded-md border bg-background p-3 font-mono text-xs">{#each highlightSql(text) as span}<span class={span.class}>{span.text}</span>{/each}</pre>
{/snippet}

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<SchemaFilter bind:schema bind:query label="Search triggers" />
		<p class="ml-auto text-xs text-muted-foreground">Create, enable and disable triggers in the SQL editor.</p>
	</div>
	{#if error}<p role="alert" class="text-xs break-words text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Name</th><th class="p-3 font-medium">Table</th><th class="p-3 font-medium">Fires</th>
				<th class="p-3 font-medium">Function</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as trigger (key(trigger))}
					{@const open = expanded === key(trigger)}
					<tr>
						<td class="p-3 font-mono">
							<button class="inline-flex items-center gap-1 hover:underline" aria-expanded={open}
								onclick={() => expanded = open ? null : key(trigger)}>
								<ChevronRight class={['size-3.5 transition-transform', open && 'rotate-90']} />{trigger.name}
							</button>
							{#if !trigger.enabled}<span class="ml-2 rounded border px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground uppercase">disabled</span>{/if}
						</td>
						<td class="p-3 font-mono">{trigger.table}</td>
						<td class="p-3">{trigger.timing} {trigger.events.join(', ')} · {trigger.forEachRow ? 'row' : 'statement'}</td>
						<td class="p-3 font-mono text-muted-foreground">{trigger.function}</td>
						<td class="p-2 text-right">
							<Button variant="ghost" size="icon-sm" aria-label={`Drop trigger ${trigger.name}`} onclick={() => dropping = trigger}><Trash2 /></Button>
						</td>
					</tr>
					{#if open}
						<tr><td colspan="5" class="space-y-2 bg-muted/20 p-3">
							{@render code(`${trigger.definition};`)}
							{@render code(trigger.functionDefinition)}
						</td></tr>
					{/if}
				{:else}
					<tr><td colspan="5" class="p-3 text-muted-foreground">{list === null ? 'Loading…' : query ? 'No matching triggers.' : 'No triggers in this schema.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<SqlDialog open={!!dropping} title="Drop trigger" subject={dropping?.name} description={`The function ${dropping?.function} stays.`}
	sql={dropping ? `drop trigger ${ident(dropping.name)} on ${qualify(dropping.schema, dropping.table)};` : ''} destructive action="Drop"
	onclose={() => dropping = null} onapplied={load} />
