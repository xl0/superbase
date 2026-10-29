<script lang="ts">
	import { Plus, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { REFERENTIAL_ACTIONS, type SchemaChange, type SchemaConstraint, type SchemaDefinition } from '#lib/schema.js';
	import { constraintSql, ident, qualify, type ConstraintSpec } from '#lib/ddl.js';
	import { tableKey } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import ColumnChoice from './ColumnChoice.svelte';
	import TextEditor from './TextEditor.svelte';

	let { definition, disabled, change = $bindable() }: { definition: SchemaDefinition; disabled: boolean; change: SchemaChange | null } = $props();
	const id = $props.id();
	const KIND = { u: 'UNIQUE', c: 'CHECK', f: 'FOREIGN KEY', x: 'EXCLUDE' };
	/** A new constraint, built from a form. */
	let draft = $state<{ spec: ConstraintSpec } | null>(null);
	/**
	 * An existing constraint, edited as its full definition so clauses the form doesn't model (DEFERRABLE, NOT VALID,
	 * NULLS NOT DISTINCT, INCLUDE, MATCH FULL…) survive. A new definition is drop + add; a new name alone is a rename.
	 */
	let editing = $state<{ original: SchemaConstraint; name: string; definition: string } | null>(null);
	let dropping = $state<SchemaConstraint | null>(null);
	const table = $derived(qualify(definition.schema, definition.table));
	const columns = $derived(definition.columns.map((column) => column.name));
	const target = $derived.by(() => {
		const spec = draft?.spec;
		return spec?.kind === 'foreignKey' ? editor.tables.find((table) => table.schema === spec.reference.schema && table.name === spec.reference.table) : undefined;
	});

	function complete(spec: ConstraintSpec) {
		if (spec.kind === 'check') return !!spec.expression.trim();
		if (spec.kind === 'unique') return spec.columns.length > 0;
		return spec.columns.length > 0 && spec.columns.every(Boolean) && spec.reference.columns.every(Boolean);
	}
	const drop = (constraint: SchemaConstraint) => `alter table ${table} drop constraint ${ident(constraint.name)};`;
	$effect(() => {
		if (editing) {
			const { original } = editing, name = editing.name.trim(), definition = editing.definition.trim();
			change = !name || !definition || (name === original.name && definition === original.definition) ? null
				: definition === original.definition ? { sql: `alter table ${table} rename constraint ${ident(original.name)} to ${ident(name)};` }
				: { sql: `${drop(original)}\nalter table ${table} add constraint ${ident(name)} ${definition};` };
		} else if (draft) {
			change = draft.spec.name && complete(draft.spec) ? { sql: `alter table ${table} add constraint ${ident(draft.spec.name)} ${constraintSql(draft.spec)};` } : null;
		} else change = dropping ? { sql: drop(dropping), destructive: true } : null;
	});

	function chooseTarget(key: string) {
		const table = editor.tables.find((table) => tableKey(table.schema, table.name) === key);
		if (!table || draft?.spec.kind !== 'foreignKey') return;
		const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
		draft.spec.reference = { schema: table.schema, table: table.name, columns: pk.length ? pk : [''] };
		draft.spec.columns = draft.spec.reference.columns.map(() => '');
	}
</script>

{#if editing}
	<div class="space-y-2">
		<Label for={`${id}-name`}>Constraint name</Label>
		<Input id={`${id}-name`} bind:value={editing.name} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
	</div>
	<div class="space-y-2">
		<Label>Definition</Label>
		<TextEditor value={editing.definition} language="sql" readonly={disabled} label="Constraint definition" class="h-32"
			onchange={(value) => { if (editing) editing.definition = value; }} />
		<p class="text-xs text-muted-foreground">As PostgreSQL prints it. A changed definition replaces the constraint (drop + add in one transaction).</p>
	</div>
{:else if draft}
	{@const spec = draft.spec}
	<div class="space-y-2">
		<Label for={`${id}-name`}>Constraint name</Label>
		<Input id={`${id}-name`} bind:value={spec.name} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
	</div>
	{#if spec.kind === 'unique'}
		<ColumnChoice label="Unique columns" {columns} bind:selected={spec.columns} {disabled} />
	{:else if spec.kind === 'check'}
		<div class="space-y-2">
			<Label>CHECK expression</Label>
			<TextEditor value={spec.expression} language="sql" readonly={disabled} label="CHECK expression" placeholder="price >= 0" class="h-32"
				onchange={(value) => { if (spec.kind === 'check') spec.expression = value; }} />
			<p class="text-xs text-muted-foreground">A boolean expression. NULL results pass the check.</p>
		</div>
	{:else}
		<div class="space-y-2">
			<Label for={`${id}-table`}>Referenced table</Label>
			<Select.Root type="single" value={tableKey(spec.reference.schema, spec.reference.table)} allowDeselect={false} {disabled} onValueChange={chooseTarget}>
				<Select.Trigger id={`${id}-table`} class="w-full min-w-0 text-xs"><span class="truncate">{spec.reference.table ? `${spec.reference.schema}.${spec.reference.table}` : 'Choose a table…'}</span></Select.Trigger>
				<Select.Content class="max-h-72">
					{#each editor.tables as table}<Select.Item value={tableKey(table.schema, table.name)} label={`${table.schema}.${table.name}`} />{/each}
				</Select.Content>
			</Select.Root>
		</div>
		{#if spec.reference.table}
			<div class="space-y-2">
				<p class="text-xs font-medium">Columns → referenced key</p>
				{#each spec.reference.columns as _, i}
					<div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
						<Select.Root type="single" bind:value={spec.columns[i]} allowDeselect={false} {disabled}>
							<Select.Trigger aria-label={`Column ${i + 1}`} class="w-full min-w-0 text-xs"><span class="truncate">{spec.columns[i] || 'Column…'}</span></Select.Trigger>
							<Select.Content class="max-h-72">{#each columns as column}<Select.Item value={column} label={column} />{/each}</Select.Content>
						</Select.Root>
						<span aria-hidden="true" class="text-muted-foreground">→</span>
						<Select.Root type="single" bind:value={spec.reference.columns[i]} allowDeselect={false} {disabled}>
							<Select.Trigger aria-label={`Referenced column ${i + 1}`} class="w-full min-w-0 text-xs"><span class="truncate">{spec.reference.columns[i] || 'Column…'}</span></Select.Trigger>
							<Select.Content class="max-h-72">{#each target?.columns ?? [] as column}<Select.Item value={column.name} label={column.name} />{/each}</Select.Content>
						</Select.Root>
						<Button variant="ghost" size="icon-xs" aria-label={`Remove pair ${i + 1}`} disabled={disabled || spec.columns.length === 1}
							onclick={() => { spec.columns.splice(i, 1); spec.reference.columns.splice(i, 1); }}><X /></Button>
					</div>
				{/each}
				<Button variant="ghost" size="xs" {disabled} onclick={() => { spec.columns.push(''); spec.reference.columns.push(''); }}><Plus />Add column pair</Button>
			</div>
			<div class="grid grid-cols-2 gap-4">
				{#each ['onUpdate', 'onDelete'] as const as action}
					<div class="space-y-2">
						<Label for={`${id}-${action}`}>{action === 'onUpdate' ? 'On update' : 'On delete'}</Label>
						<Select.Root type="single" bind:value={spec[action]} allowDeselect={false} {disabled}>
							<Select.Trigger id={`${id}-${action}`} class="w-full text-xs">{spec[action]}</Select.Trigger>
							<Select.Content>{#each REFERENTIAL_ACTIONS as choice}<Select.Item value={choice} label={choice} />{/each}</Select.Content>
						</Select.Root>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
{:else if dropping}
	<pre class="whitespace-pre-wrap break-all font-mono text-xs">{dropping.definition}</pre>
	<p class="text-sm text-destructive">Drop this constraint? Table data is not affected.</p>
{:else}
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm">{definition.constraints.length} {definition.constraints.length === 1 ? 'constraint' : 'constraints'}</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" {disabled} onclick={() => draft = { spec: { kind: 'unique', name: `${definition.table}_key`, columns: [] } }}><Plus />UNIQUE</Button>
			<Button variant="outline" size="sm" {disabled} onclick={() => draft = { spec: { kind: 'check', name: `${definition.table}_check`, expression: '' } }}><Plus />CHECK</Button>
			<Button variant="outline" size="sm" {disabled} onclick={() => draft = { spec: { kind: 'foreignKey', name: `${definition.table}_fkey`, columns: [],
				reference: { schema: definition.schema, table: '', columns: [] }, onUpdate: 'no action', onDelete: 'no action' } }}><Plus />Foreign key</Button>
		</div>
	</div>
	{#each definition.constraints as constraint (constraint.name)}
		<section class="space-y-2 rounded-md border p-3" aria-label={`Constraint ${constraint.name}`}>
			<div class="flex items-start gap-2">
				<div class="min-w-0 flex-1">
					<h3 class="break-all font-mono text-xs font-medium">{constraint.name}</h3>
					<p class="text-[11px] text-muted-foreground">{KIND[constraint.kind]}</p>
				</div>
				<Button variant="ghost" size="sm" {disabled} onclick={() => editing = { original: constraint, name: constraint.name, definition: constraint.definition }}>Edit</Button>
				<Button variant="ghost" size="sm" {disabled} class="text-destructive" onclick={() => dropping = constraint}>Drop</Button>
			</div>
			<p class="break-all font-mono text-xs text-muted-foreground">{constraint.definition}</p>
		</section>
	{/each}
{/if}
