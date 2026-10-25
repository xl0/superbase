<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { schemaDefinition } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { REFERENTIAL_ACTIONS, type ConstraintSpec, type SchemaDefinition } from '#lib/schema.js';
	import { message } from '#lib/utils.js';
	import { displayIdentifier } from '#lib/schema-forms.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let { value = $bindable(), definition, connection, disabled }: {
		value: Extract<ConstraintSpec, { kind: 'foreignKey' }>;
		definition: SchemaDefinition; connection: string; disabled: boolean;
	} = $props();
	const id = $props.id();
	let referenced = $state<SchemaDefinition | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let request = 0;
	const tableKey = (schema: string, table: string) => JSON.stringify([schema, table]);
	const keyEligible = (columns: string[]) => columns.length > 0 && !!referenced?.indexes.some((index) => index.referenceable
		&& index.columns.length === columns.length && columns.every((column) => index.columns.includes(column)));
	const choices = $derived.by(() => {
		const keys = new Map<string, string[]>();
		for (const index of referenced?.indexes ?? []) if (index.referenceable) keys.set(JSON.stringify(index.columns), index.columns);
		if (keyEligible(value.reference.columns)) keys.set(JSON.stringify(value.reference.columns), value.reference.columns);
		return [...keys.values()];
	});

	async function load(acceptCurrent = false) {
		const read = ++request;
		const target = { connection, schema: value.reference.schema, table: value.reference.table };
		const expectedOid = value.reference.oid, expectedVersion = value.reference.version;
		value.reference.version = '';
		referenced = null; error = null;
		if (!target.schema || !target.table) { loading = false; return; }
		loading = true;
		try {
			const result = schemaDefinition(target);
			await result.refresh();
			if (read !== request) return;
			if (result.error) throw result.error;
			const next = result.current;
			if (!next) throw new Error('No referenced table definition');
			if (expectedOid && expectedOid !== next.oid) {
				if (!acceptCurrent || !window.confirm('The referenced table was replaced. Use the replacement table’s current definition?')) {
					throw new Error('Referenced table was replaced. Reload the target to review the replacement.');
				}
			} else if (expectedVersion && expectedVersion !== next.version && !acceptCurrent) {
				throw new Error('Referenced definition changed. Reload the target and review its key before staging.');
			}
			referenced = next;
			if (!next.editable) throw new Error(next.reason ?? 'Only ordinary standalone reference tables are supported');
			value.reference.oid = next.oid;
			if (!keyEligible(value.reference.columns)) {
				// Keep an unavailable key visible rather than silently replacing the mapping.
				if (value.reference.columns.length) error = 'The selected referenced key is unavailable. Choose an eligible key.';
			}
			if (!value.reference.columns.length || keyEligible(value.reference.columns)) value.reference.version = next.version;
		} catch (cause) { if (read === request) error = message(cause); }
		finally { if (read === request) loading = false; }
	}

	function chooseTable(key: string) {
		const table = editor.tables.find((table) => tableKey(table.schema, table.name) === key);
		if (!table || disabled) return;
		value.reference = { ...value.reference, schema: table.schema, table: table.name, oid: '', version: '' };
		void load();
	}
	function chooseKey(key: string) {
		const columns = choices.find((columns) => JSON.stringify(columns) === key);
		if (!columns || disabled) return;
		value.reference.columns = [...columns];
		value.reference.version = referenced!.version;
		value.columns = Array.from({ length: Math.max(value.columns.length, columns.length) }, (_, i) => value.columns[i] ?? '');
		error = null;
	}
	onMount(() => { void load(); });
	onDestroy(() => { request++; });
</script>

<div class="space-y-2">
	<Label for={`${id}-table`}>Referenced table</Label>
	<Select.Root type="single" value={tableKey(value.reference.schema, value.reference.table)} allowDeselect={false} {disabled} onValueChange={chooseTable}>
		<Select.Trigger id={`${id}-table`} class="w-full min-w-0 text-xs"><span class="truncate">{value.reference.table ? `${displayIdentifier(value.reference.schema)}.${displayIdentifier(value.reference.table)}` : 'Choose a table…'}</span></Select.Trigger>
		<Select.Content class="max-h-72">
			{#each editor.tables as table}
				<Select.Item value={tableKey(table.schema, table.name)} label={`${displayIdentifier(table.schema)}.${displayIdentifier(table.name)}`}><span class="max-w-72 truncate">{displayIdentifier(table.schema)}.{displayIdentifier(table.name)}</span></Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
	{#if loading}<p role="status" class="text-xs text-muted-foreground">Loading referenced keys…</p>{/if}
	{#if error}<p role="alert" class="break-words text-xs text-destructive">{error}</p>{/if}
	{#if value.reference.table}<Button size="xs" variant="ghost" disabled={disabled || loading} onclick={() => void load(true)}>Reload target</Button>{/if}
</div>
{#if referenced?.editable}
	<div class="space-y-2">
		<Label for={`${id}-key`}>Referenced key</Label>
		<Select.Root type="single" value={JSON.stringify(value.reference.columns)} allowDeselect={false} disabled={disabled || loading} onValueChange={chooseKey}>
			<Select.Trigger id={`${id}-key`} class="w-full min-w-0 text-xs"><span class="truncate">{value.reference.columns.length ? value.reference.columns.map(displayIdentifier).join(', ') : 'Choose a primary or unique key…'}</span></Select.Trigger>
			<Select.Content>
				{#each choices as columns}<Select.Item value={JSON.stringify(columns)} label={columns.map(displayIdentifier).join(', ')}><span class="max-w-72 truncate">{columns.map(displayIdentifier).join(', ')}</span></Select.Item>{/each}
			</Select.Content>
		</Select.Root>
		{#if !choices.length}<p class="text-xs text-muted-foreground">No eligible primary or unique key. Partial, expression and deferrable indexes cannot be referenced.</p>{/if}
	</div>
{/if}
<div class="space-y-3">
	<p class="text-xs font-medium">Column mapping</p>
	{#each Array.from({ length: Math.max(value.columns.length, value.reference.columns.length) }, (_, i) => i) as i (i)}
		<div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
			<Select.Root type="single" value={value.columns[i] ?? ''} allowDeselect={false} {disabled} onValueChange={(column) => { if (!disabled) value.columns[i] = column; }}>
				<Select.Trigger aria-label={`Source column ${i + 1}`} class="w-full min-w-0 text-xs"><span class="truncate">{value.columns[i] || 'Choose a column…'}</span></Select.Trigger>
				<Select.Content class="max-h-72">{#each definition.columns as column}<Select.Item value={column.name} label={column.name} />{/each}</Select.Content>
			</Select.Root>
			<span aria-hidden="true" class="text-muted-foreground">→</span>
			{#if value.reference.columns[i]}<code class="min-w-0 break-all text-xs">{value.reference.columns[i]}</code>
			{:else if value.reference.columns.length}<Button variant="ghost" size="xs" {disabled} onclick={() => value.columns = value.columns.filter((_, index) => index !== i)}>Remove extra mapping</Button>
			{:else}<span class="text-xs text-muted-foreground">Choose a referenced key</span>{/if}
		</div>
	{/each}
	{#if value.columns.length !== value.reference.columns.length || new Set(value.columns).size !== value.columns.length || value.columns.some((column) => !column)}
		<p class="text-xs text-muted-foreground">Map exactly one distinct source column to each referenced column.</p>
	{/if}
</div>
<div class="grid gap-4 @min-[540px]:grid-cols-2">
	{#each ['onUpdate', 'onDelete'] as action}
		<div class="space-y-2">
			<Label for={`${id}-${action}`}>{action === 'onUpdate' ? 'On update' : 'On delete'}</Label>
			<Select.Root type="single" value={value[action as 'onUpdate' | 'onDelete']} allowDeselect={false} {disabled}
				onValueChange={(next) => { if (REFERENTIAL_ACTIONS.some((choice) => choice === next)) value[action as 'onUpdate' | 'onDelete'] = next as typeof value.onUpdate; }}>
				<Select.Trigger id={`${id}-${action}`} class="w-full text-xs">{value[action as 'onUpdate' | 'onDelete'].toUpperCase()}</Select.Trigger>
				<Select.Content>{#each REFERENTIAL_ACTIONS as choice}<Select.Item value={choice} label={choice.toUpperCase()} />{/each}</Select.Content>
			</Select.Root>
		</div>
	{/each}
	<div class="space-y-2">
		<Label for={`${id}-match`}>Match</Label>
		<Select.Root type="single" bind:value={value.match} allowDeselect={false} {disabled}>
			<Select.Trigger id={`${id}-match`} class="w-full text-xs">{value.match.toUpperCase()}</Select.Trigger>
			<Select.Content><Select.Item value="simple" label="SIMPLE" /><Select.Item value="full" label="FULL" /></Select.Content>
		</Select.Root>
	</div>
</div>
<div class="space-y-3">
	<div class="flex items-start gap-2"><Checkbox id={`${id}-defer`} bind:checked={value.deferrable} {disabled} /><Label for={`${id}-defer`} class="text-xs">Deferrable</Label></div>
	<div class="flex items-start gap-2"><Checkbox id={`${id}-initial`} bind:checked={value.initiallyDeferred} {disabled} /><Label for={`${id}-initial`} class="text-xs">Initially deferred until transaction commit</Label></div>
	{#if value.initiallyDeferred && !value.deferrable}<p class="text-xs text-destructive">Initially deferred requires Deferrable.</p>{/if}
	<div class="flex items-start gap-2"><Checkbox id={`${id}-valid`} bind:checked={value.notValid} {disabled} /><Label for={`${id}-valid`} class="text-xs leading-relaxed">Skip existing rows (NOT VALID); new or updated rows are still checked</Label></div>
</div>
<p class="text-xs text-muted-foreground">CASCADE can change or delete dependent rows later. SET NULL/DEFAULT must also satisfy column constraints. MATCH FULL requires either all or none of a composite tuple to be NULL.</p>
