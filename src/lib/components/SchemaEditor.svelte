<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { Plus, Trash2, X } from '@lucide/svelte';
	import { schemaCatalog, schemaDefinition } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { SchemaCatalog, SchemaChange, SchemaDefinition, SchemaEditMode } from '#lib/schema.js';
	import type { Table } from '#lib/types.js';
	import * as ddl from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import ColumnChoice from './ColumnChoice.svelte';
	import ResizableSheet from './ResizableSheet.svelte';
	import SchemaColumnFields from './SchemaColumnFields.svelte';
	import SchemaConstraints from './SchemaConstraints.svelte';
	import SchemaIndexes from './SchemaIndexes.svelte';

	/** Every form produces one SchemaChange: SQL that is previewed, then applied in one transaction. */
	let { mode, table: initialTable, onclose, returnFocus }: {
		mode: Exclude<SchemaEditMode, { kind: 'access' | 'definition' }>; table: Table; onclose: () => void; returnFocus?: HTMLElement | null;
	} = $props();
	const intent = untrack(() => mode);
	const table = untrack(() => initialTable);
	const anchor = untrack(() => returnFocus);
	const id = $props.id();
	const creating = intent.kind === 'createTable';
	const qualified = ddl.qualify(table.schema, table.name);
	const title = { createTable: 'Create table', renameTable: 'Rename table', dropTable: `Delete ${table.kind}`, duplicateTable: 'Duplicate table',
		addColumn: 'Add column', alterColumn: 'Edit column', dropColumn: 'Delete column', addPrimaryKey: 'Add primary key',
		indexes: 'Indexes', constraints: 'Constraints', refreshView: 'Refresh materialized view' }[intent.kind];
	let catalog = $state<SchemaCatalog | null>(null);
	let definition = $state<SchemaDefinition | null>(null);
	let schema = $state(table.schema || editor.activeSchema); // No open table in an empty schema.
	let name = $state(intent.kind === 'renameTable' ? table.name : '');
	let columns = $state<ddl.ColumnSpec[]>([]);
	let keys = $state<string[]>([]);
	let includeRows = $state(false);
	let confirmation = $state('');
	let childChange = $state<SchemaChange | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let baseline = '';
	let panel = $state<HTMLElement | null>(null);
	const existing = $derived.by(() => {
		const column = intent.kind === 'alterColumn' ? definition?.columns.find((column) => column.name === intent.column) : undefined;
		return column && { ...column, primaryKey: definition!.primaryKey.includes(column.name) };
	});
	const built = $derived.by((): { change: SchemaChange | null; problem?: string } => {
		try { return { change: build() }; } catch (cause) { return { change: null, problem: message(cause) }; }
	});
	const dirty = $derived(!loading && JSON.stringify(built.change) !== baseline);

	function build(): SchemaChange | null {
		const types = catalog?.types ?? [];
		for (const value of [name, ...columns.map((column) => column.name)]) ddl.checkName(value);
		switch (intent.kind) {
			case 'createTable':
				return name && columns.every((column) => column.name) ? { sql: ddl.createTable(schema, name, columns, types), select: { schema, table: name } } : null;
			case 'renameTable':
				return name && name !== table.name ? { sql: `alter table ${qualified} rename to ${ddl.ident(name)};`, select: { schema: table.schema, table: name } } : null;
			case 'duplicateTable':
				return name && definition ? { sql: ddl.duplicateTable(definition, name, includeRows), select: { schema: table.schema, table: name } } : null;
			case 'dropTable':
				return confirmation === table.name ? { sql: `drop ${table.kind} ${qualified};`, destructive: true } : null;
			case 'refreshView':
				return { sql: `refresh materialized view ${qualified};` };
			case 'addColumn':
				return columns[0]?.name ? { sql: ddl.addColumn(qualified, columns[0], types) } : null;
			case 'alterColumn': {
				const sql = existing && columns[0]?.name ? ddl.alterColumn(qualified, existing, columns[0], types) : '';
				// A type change rewrites every value: conversions can round, truncate or drop parts of them.
				return sql ? { sql, destructive: columns[0].typeOid !== null } : null;
			}
			case 'dropColumn':
				return confirmation === intent.column ? { sql: `alter table ${qualified} drop column ${ddl.ident(intent.column)};`, destructive: true } : null;
			case 'addPrimaryKey':
				return keys.length ? { sql: `alter table ${qualified} add primary key (${keys.map(ddl.ident).join(', ')});` } : null;
			case 'indexes': case 'constraints':
				return childChange;
		}
	}

	function newColumn(id = false): ddl.ColumnSpec {
		const type = catalog!.types.find((type) => type.schema === 'pg_catalog' && type.name === (id ? 'int8' : 'text'))!;
		return { name: id ? 'id' : '', typeOid: type.oid, typeModifiers: '', nullable: !id, default: { kind: id ? 'identity' : 'none' }, comment: '', primaryKey: id };
	}

	onMount(() => {
		void (async () => {
			try {
				const needsCatalog = creating || intent.kind === 'addColumn' || intent.kind === 'alterColumn';
				const needsDefinition = intent.kind === 'alterColumn' || intent.kind === 'duplicateTable' || intent.kind === 'indexes' || intent.kind === 'constraints';
				[catalog, definition] = await Promise.all([
					needsCatalog ? fresh(schemaCatalog({ connection: editor.connection })) : null,
					needsDefinition ? fresh(schemaDefinition({ connection: editor.connection, schema: table.schema, table: table.name })) : null
				]);
				if (creating) {
					if (!catalog!.schemas.includes(schema)) schema = catalog!.schemas.includes('public') ? 'public' : catalog!.schemas[0];
					columns = [newColumn(true)];
				} else if (intent.kind === 'addColumn') columns = [newColumn()];
				else if (intent.kind === 'alterColumn') {
					if (!existing) throw new Error('This column no longer exists; refresh the table.');
					columns = [{ name: existing.name, typeOid: null, typeModifiers: '', nullable: existing.nullable, default: { kind: 'keep' },
						comment: existing.comment ?? '', primaryKey: existing.primaryKey }];
				}
			} catch (cause) { error = message(cause); }
			loading = false;
			await tick();
			baseline = JSON.stringify(built.change);
			focusFirst();
		})();
	});

	function focusFirst() {
		panel?.querySelector<HTMLElement>('[data-schema-fields] :is(input, textarea, button):not(:disabled)')?.focus();
	}

	function cancel() {
		if (saving || (dirty && !window.confirm('Discard these unapplied schema changes?'))) return;
		onclose();
	}

	async function apply() {
		const change = built.change;
		if (!change || saving || loading) return;
		saving = true;
		error = null;
		try {
			await editor.applySchema(change);
			onclose();
		} catch (cause) { error = message(cause); }
		finally { saving = false; }
	}
</script>

<ResizableSheet bind:ref={panel} width={720} label="Resize schema panel" class="@container gap-0 p-0" onOpenChange={(open) => { if (!open) cancel(); }}
	onEscapeKeydown={(event) => { event.preventDefault(); cancel(); }}
	onOpenAutoFocus={(event) => event.preventDefault()}
	onkeydown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void apply(); } }}
	onCloseAutoFocus={(event) => { event.preventDefault(); (anchor?.isConnected ? anchor : document.querySelector<HTMLElement>('[role="grid"]'))?.focus(); }}>
	<Sheet.Header class="shrink-0 border-b px-6 py-5">
		<div class="flex items-center gap-3">
			<Sheet.Title class="min-w-0 flex-1 break-words text-base font-medium">{title}{#if 'column' in intent}{' '}<code>{intent.column}</code>{/if}</Sheet.Title>
			<Button variant="ghost" size="icon-sm" disabled={saving} aria-label="Close schema editor" onclick={cancel}><X /></Button>
		</div>
		<Sheet.Description class="break-all font-mono text-xs">{creating ? 'New table' : `${table.schema}.${table.name}`}</Sheet.Description>
	</Sheet.Header>
	<div data-schema-fields class="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6" aria-busy={loading || saving}>
		{#if loading}
			<div role="status" class="space-y-4"><span class="sr-only">Loading schema…</span><Skeleton class="h-8 w-2/3" /><Skeleton class="h-32 w-full" /></div>
		{:else if intent.kind === 'indexes' && definition}
			<SchemaIndexes {definition} disabled={saving} bind:change={childChange} />
		{:else if intent.kind === 'constraints' && definition}
			<SchemaConstraints {definition} disabled={saving} bind:change={childChange} />
		{:else if !error || catalog || definition}
			{#if creating || intent.kind === 'renameTable' || intent.kind === 'duplicateTable'}
				<div class="grid gap-4 @min-[540px]:grid-cols-2">
					{#if creating && catalog}
						<div class="space-y-2">
							<Label for={`${id}-schema`}>Schema</Label>
							<Select.Root type="single" bind:value={schema} disabled={saving} allowDeselect={false}>
								<Select.Trigger id={`${id}-schema`} class="w-full font-mono text-xs">{schema}</Select.Trigger>
								<Select.Content>{#each catalog.schemas as schema}<Select.Item value={schema} label={schema} />{/each}</Select.Content>
							</Select.Root>
						</div>
					{/if}
					<div class="space-y-2">
						<Label for={`${id}-table`}>Table name</Label>
						<Input id={`${id}-table`} bind:value={name} disabled={saving} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
					</div>
				</div>
			{/if}
			{#if intent.kind === 'duplicateTable'}
				<div class="flex items-center gap-2">
					<Checkbox id={`${id}-rows`} bind:checked={includeRows} disabled={saving} />
					<Label for={`${id}-rows`} class="text-xs">Include rows</Label>
				</div>
				<p class="text-xs text-muted-foreground">Copies columns, defaults, constraints, indexes and comments (not foreign keys, triggers, policies or grants). Serial columns keep using the original table's sequence.
					{#if definition?.partitioned}The copy is a plain table, not partitioned.{/if}</p>
			{/if}
			{#if catalog}
				{#each columns as column, i (column)}
					<section class="space-y-4 rounded-lg border p-4" aria-label={`Column ${i + 1}`}>
						{#if creating}
							<div class="flex items-center justify-between">
								<h3 class="text-xs font-medium">Column {i + 1}</h3>
								<Button variant="ghost" size="icon-xs" disabled={saving || columns.length === 1} aria-label={`Remove column ${i + 1}`}
									onclick={() => columns = columns.filter((_, index) => index !== i)}><Trash2 /></Button>
							</div>
						{/if}
						<SchemaColumnFields bind:value={columns[i]} types={catalog.types} {existing} disabled={saving}
							canSetPrimaryKey={creating || !table.columns.some((column) => column.primaryKey)} />
					</section>
				{/each}
				{#if creating}<Button variant="outline" size="sm" disabled={saving} onclick={() => columns = [...columns, newColumn()]}><Plus />Add column</Button>{/if}
			{/if}
			{#if intent.kind === 'addPrimaryKey'}
				<ColumnChoice label="Primary key columns" columns={table.columns.map((column) => column.name)} bind:selected={keys} disabled={saving} />
			{/if}
			{#if intent.kind === 'alterColumn' && columns[0]?.typeOid}
				<p class="text-xs text-destructive">Every value is converted to the new type; the conversion can round, truncate or drop parts of values.</p>
			{/if}
			{#if intent.kind === 'dropTable' || intent.kind === 'dropColumn'}
				{@const target = intent.kind === 'dropColumn' ? intent.column : table.name}
				<p class="text-sm text-destructive">{intent.kind === 'dropColumn' ? 'The column and its data will be permanently deleted, along with its indexes and constraints.'
					: table.kind === 'view' ? 'The view will be permanently deleted; the tables it reads from are not affected.'
					: `The ${table.kind} and all its data will be permanently deleted.`}</p>
				<div class="space-y-2">
					<Label for={`${id}-confirm`} class="break-all text-xs">Type {target} to confirm</Label>
					<Input id={`${id}-confirm`} bind:value={confirmation} disabled={saving} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
				</div>
			{/if}
		{/if}
	</div>
	<div class="shrink-0 space-y-3 border-t px-5 py-4">
		{#if built.change}
			<details open class="text-xs">
				<summary class="cursor-pointer text-muted-foreground">SQL</summary>
				<pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono">{built.change.sql}</pre>
			</details>
		{/if}
		{#if error || built.problem}<p role="alert" class="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">{error ?? built.problem}</p>{/if}
		<div class="flex justify-end gap-2">
			<Button variant="outline" size="sm" disabled={saving} onclick={cancel}>Cancel</Button>
			<Button variant={built.change?.destructive ? 'destructive' : 'default'} size="sm" disabled={!built.change || saving || loading} onclick={apply}>{saving ? 'Applying…' : 'Apply'}</Button>
		</div>
	</div>
</ResizableSheet>
