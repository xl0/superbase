<script lang="ts">
	import { Plus, Trash2 } from '@lucide/svelte';
	import type { SchemaChange, SchemaDefinition, SchemaIndex } from '#lib/schema.js';
	import { ident, qualify } from '#lib/ddl.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import ColumnChoice from './ColumnChoice.svelte';

	let { definition, disabled, change = $bindable() }: { definition: SchemaDefinition; disabled: boolean; change: SchemaChange | null } = $props();
	const id = $props.id();
	const METHODS = ['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'];
	let draft = $state<{ name: string; method: string; unique: boolean; columns: string[] } | null>(null);
	let dropping = $state<SchemaIndex | null>(null);
	const table = $derived(qualify(definition.schema, definition.table));
	$effect(() => {
		change = draft?.name && draft.columns.length ? {
			sql: `create ${draft.unique ? 'unique ' : ''}index ${ident(draft.name)} on ${table} using ${draft.method} (${draft.columns.map(ident).join(', ')});`
		} : dropping ? { sql: `drop index ${qualify(definition.schema, dropping.name)};`, destructive: true } : null;
	});
</script>

{#if draft}
	<div class="space-y-2">
		<Label for={`${id}-name`}>Index name</Label>
		<Input id={`${id}-name`} bind:value={draft.name} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
	</div>
	<div class="flex flex-wrap items-end gap-4">
		<div class="min-w-0 flex-1 space-y-2">
			<Label for={`${id}-method`}>Method</Label>
			<Select.Root type="single" bind:value={draft.method} {disabled} allowDeselect={false}>
				<Select.Trigger id={`${id}-method`} class="w-full text-xs">{draft.method}</Select.Trigger>
				<Select.Content>{#each METHODS as method}<Select.Item value={method} label={method} />{/each}</Select.Content>
			</Select.Root>
		</div>
		<div class="flex h-9 items-center gap-2">
			<Checkbox id={`${id}-unique`} bind:checked={draft.unique} {disabled} />
			<Label for={`${id}-unique`} class="text-xs">Unique</Label>
		</div>
	</div>
	<ColumnChoice label="Key columns" columns={definition.columns.map((column) => column.name)} bind:selected={draft.columns} {disabled} />
	<p class="text-xs text-muted-foreground">Building an index locks writes to the table. Use the SQL editor for expressions, partial or concurrent indexes.</p>
{:else if dropping}
	<pre class="whitespace-pre-wrap break-all font-mono text-xs">{dropping.definition}</pre>
	<p class="text-sm text-destructive">Drop this index? Table data is not affected.</p>
{:else}
	<div class="flex items-center justify-between gap-3">
		<p class="text-sm">{definition.indexes.length} {definition.indexes.length === 1 ? 'index' : 'indexes'}</p>
		<Button variant="outline" size="sm" disabled={disabled || !definition.columns.length}
			onclick={() => draft = { name: '', method: 'btree', unique: false, columns: [] }}><Plus />Create index</Button>
	</div>
	{#each definition.indexes as index (index.name)}
		<section class="space-y-2 rounded-md border p-3" aria-label={`Index ${index.name}`}>
			<div class="flex items-start gap-3">
				<h3 class="min-w-0 flex-1 break-all font-mono text-xs font-medium">{index.name}</h3>
				<Button variant="ghost" size="icon-sm" disabled={disabled || !!index.constraint} aria-label={`Drop index ${index.name}`}
					title={index.constraint ? `Owned by constraint ${index.constraint}` : 'Drop index'} onclick={() => dropping = index}><Trash2 /></Button>
			</div>
			<p class="break-all font-mono text-xs text-muted-foreground">{index.definition}</p>
		</section>
	{/each}
{/if}
