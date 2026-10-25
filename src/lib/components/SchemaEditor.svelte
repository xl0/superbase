<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from '@lucide/svelte';
	import { schemaCatalog, schemaDefinition, tableSchema } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { DUPLICATE_NOTICE, INDEX_METHODS, type ColumnSpec, type ColumnConstraintOperation, type ConstraintOperation, type SchemaCatalog, type SchemaDefinition, type SchemaEditMode, type SchemaExport, type SchemaIndex, type SchemaOperation } from '#lib/schema.js';
	import type { TableTarget } from '#lib/types.js';
	import { message } from '#lib/utils.js';
	import { columnOptionsError } from '#lib/schema-options.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import SchemaColumnFields from './SchemaColumnFields.svelte';
	import SchemaConstraints from './SchemaConstraints.svelte';
	import ColumnConstraints from './ColumnConstraints.svelte';
	import { constraintOperationSchema } from '#lib/schema-validation.js';
	import { schemaDraftSnapshot } from '#lib/schema-forms.js';
	import TextEditor from './TextEditor.svelte';

	let { mode, target: initialTarget, onclose, returnFocus }: {
		mode: Exclude<SchemaEditMode, { kind: 'exportCsv' }>; target: TableTarget; onclose: () => void; returnFocus?: HTMLElement | null;
	} = $props();
	const intent = untrack(() => mode);
	const target = untrack(() => ({ ...initialTarget }));
	// Parent props may disappear before the closing animation restores focus.
	const anchor = untrack(() => returnFocus);
	const id = $props.id();
	const title = { createTable: 'Create table', renameTable: 'Rename table', dropTable: 'Delete table',
		addColumn: 'Add column', alterColumn: 'Edit column', dropColumn: 'Delete column', addPrimaryKey: 'Add primary key',
		duplicateTable: 'Duplicate table', copySchema: 'Copy table schema', indexes: 'Indexes', constraints: 'Constraints' }[intent.kind];
	const indexing = intent.kind === 'indexes';
	const constraining = intent.kind === 'constraints';
	const copying = intent.kind === 'copySchema';
	let exported = $state<SchemaExport | null>(null);
	let copied = $state(false);
	let includeRows = $state(false);
	let duplicateApproved = $state(false);
	let catalog = $state<SchemaCatalog | null>(null);
	let definition = $state<SchemaDefinition | null>(null);
	let schema = $state(target.schema);
	let name = $state(intent.kind === 'createTable' || intent.kind === 'duplicateTable' ? '' : target.table);
	let columns = $state<ColumnSpec[]>([]);
	let keys = $state<string[]>([]);
	let indexDraft = $state<Extract<SchemaOperation, { kind: 'createIndex' }> | null>(null);
	let indexToDrop = $state<SchemaIndex | null>(null);
	let indexPicked = $state('');
	let constraintDraft = $state<ConstraintOperation | null>(null);
	let columnConstraints = $state<ColumnConstraintOperation[]>([]);
	let columnConstraintsValid = $state(true);
	const constraintTitle = $derived(constraintDraft ? ('constraint' in constraintDraft
		? `${constraintDraft.kind === 'addConstraint' ? 'Create' : 'Edit'} ${constraintDraft.constraint.kind === 'foreignKey' ? 'FOREIGN KEY' : constraintDraft.constraint.kind.toUpperCase()} constraint`
		: { renameConstraint: 'Rename constraint', validateConstraint: 'Validate constraint', dropConstraint: 'Drop constraint' }[constraintDraft.kind]) : title);
	const selectedConstraint = $derived.by(() => {
		const operation = constraintDraft;
		return operation && 'constraintOid' in operation ? definition?.constraints.find((constraint) => constraint.oid === operation.constraintOid) : undefined;
	});
	let confirmation = $state('');
	let conversionApproved = $state(false);
	let baseline = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let panel = $state<HTMLDivElement | null>(null);
	let width = $state(760);
	let windowWidth = $state(1024);
	let resize: { x: number; width: number } | null = null;
	const panelWidth = $derived(Math.min(windowWidth, Math.max(320, width)));
	const existing = $derived(intent.kind === 'alterColumn' ? definition?.columns.find((column) => column.name === intent.column) : undefined);
	const destructive = $derived(intent.kind === 'dropColumn' || intent.kind === 'dropTable' || !!indexToDrop || constraintDraft?.kind === 'dropConstraint');
	const confirmationName = $derived(indexToDrop?.name ?? (intent.kind === 'dropColumn' ? intent.column : target.table));
	const typeChanged = $derived(intent.kind === 'alterColumn' && columns.length > 0 && columns[0].typeOid !== null);
	const readOnly = $derived(intent.kind !== 'createTable' && !definition?.editable);
	const snapshot = () => schemaDraftSnapshot({ schema, name, columns, keys, includeRows, indexDraft, indexToDrop: indexToDrop?.oid, constraintDraft, columnConstraints, confirmation: indexing || constraining ? confirmation : undefined });
	const dirty = $derived(!!baseline && snapshot() !== baseline);
	const constraintValid = $derived(!!constraintDraft && 'value' in constraintOperationSchema['~standard'].validate(constraintDraft)
		&& (constraintDraft.kind === 'alterConstraint' ? dirty
		: constraintDraft.kind === 'renameConstraint' ? constraintDraft.name !== selectedConstraint?.name
		: constraintDraft.kind === 'dropConstraint' ? !!selectedConstraint && confirmation === selectedConstraint.name : true));
	const valid = $derived(constraining ? constraintValid : indexing ? (indexDraft ? !!indexDraft.name && indexDraft.columns.length > 0
		: !!indexToDrop && confirmation === indexToDrop.name) : intent.kind === 'createTable' ? !!schema && !!name && columns.length > 0 && columns.every((column) => !!column.name && !!column.typeOid)
		: intent.kind === 'duplicateTable' ? !!name && name !== target.table && duplicateApproved
		: intent.kind === 'renameTable' ? !!name && name !== target.table
		: intent.kind === 'addColumn' ? !!columns[0]?.name && !!columns[0]?.typeOid
		: intent.kind === 'alterColumn' ? !!columns[0]?.name && dirty
		: intent.kind === 'addPrimaryKey' ? keys.length > 0 : confirmation === confirmationName);
	const canApply = $derived(!loading && !saving && (!!catalog || indexing || constraining) && !readOnly && valid && columnConstraintsValid && (!typeChanged || conversionApproved)
		&& columns.every((column) => !columnOptionsError(column, catalog?.types ?? [], existing)));

	function newColumn(identity = false): ColumnSpec {
		const type = catalog?.types.find((type) => type.schema === 'pg_catalog' && type.name === (identity ? 'int8' : 'text'));
		if (!type) throw new Error('Required PostgreSQL built-in types are unavailable');
		return { name: identity ? 'id' : '', typeOid: type.oid, typeModifiers: [], nullable: !identity,
			default: { kind: identity ? 'identity' : 'none' }, comment: '', primaryKey: identity };
	}

	onMount(() => {
		editor.schemaEditing = true;
		let cancelled = false;
		void (async () => {
			try {
				if (copying) {
					const result = tableSchema(target);
					await result.refresh();
					if (cancelled) return;
					if (result.error) throw result.error;
					if (!result.current) throw new Error('No schema response from the database');
					exported = result.current;
					return;
				}
				const choices = indexing || constraining ? null : schemaCatalog({ connection: target.connection });
				const details = intent.kind === 'createTable' ? null : schemaDefinition(target);
				await Promise.all([choices?.refresh(), details?.refresh()]);
				if (cancelled) return;
				if (choices?.error) throw choices.error;
				if (details?.error) throw details.error;
				if ((!indexing && !constraining && !choices?.current) || (details && !details.current)) throw new Error('No schema response from the database');
				catalog = choices?.current ?? null;
				definition = details?.current ?? null;
				if (intent.kind === 'createTable') {
					if (!catalog?.schemas.length) throw new Error('No writable schemas are available');
					if (!catalog.schemas.includes(schema)) schema = catalog.schemas.includes('public') ? 'public' : catalog.schemas[0];
					columns = [newColumn(true)];
				} else if (intent.kind === 'addColumn') columns = [newColumn()];
				else if (intent.kind === 'alterColumn') {
					const column = definition!.columns.find((column) => column.name === intent.column);
					if (!column) throw new Error('This column no longer exists; refresh the table definition');
					columns = [{ name: column.name, typeOid: null, typeModifiers: [], nullable: column.nullable, default: { kind: 'keep' },
						comment: column.comment ?? '', primaryKey: column.primaryKey }];
				}
				baseline = snapshot();
			} catch (cause) { if (!cancelled) error = message(cause); }
			finally { if (!cancelled) { loading = false; await focusField(); } }
		})();
		return () => { cancelled = true; };
	});
	onDestroy(() => { editor.schemaEditing = false; });

	function cancel() {
		if (saving) return;
		if (dirty && !window.confirm('Discard these unapplied schema changes?')) return;
		onclose();
	}

	async function copySQL() {
		if (!exported || saving) return;
		saving = true; copied = false; error = null;
		try { await navigator.clipboard.writeText(exported.sql); copied = true; }
		catch (cause) { error = message(cause); }
		finally { saving = false; }
	}

	async function addIndexColumn(name: string) {
		if (saving || !indexDraft || indexDraft.columns.length >= 32 || indexDraft.columns.includes(name)
			|| !definition?.columns.some((column) => column.name === name)) return;
		indexDraft.columns = [...indexDraft.columns, name];
		await tick();
		indexPicked = '';
	}

	function moveIndexColumn(index: number, delta: number) {
		if (saving || !indexDraft) return;
		const next = index + delta;
		if (next < 0 || next >= indexDraft.columns.length) return;
		[indexDraft.columns[index], indexDraft.columns[next]] = [indexDraft.columns[next], indexDraft.columns[index]];
	}

	async function apply() {
		if (!canApply || intent.kind === 'copySchema') return;
		let operation: SchemaOperation;
		switch (intent.kind) {
			case 'createTable': operation = { kind: intent.kind, columns }; break;
			case 'duplicateTable': operation = { kind: intent.kind, name, includeRows }; break;
			case 'renameTable': operation = { kind: intent.kind, name }; break;
			case 'dropTable': operation = { kind: intent.kind }; break;
			case 'addColumn': operation = { kind: intent.kind, column: columns[0] }; break;
			case 'alterColumn': operation = { kind: intent.kind, column: intent.column, changes: columns[0],
				...(columnConstraints.length ? { constraints: columnConstraints } : {}) }; break;
			case 'dropColumn': operation = { kind: intent.kind, column: intent.column }; break;
			case 'addPrimaryKey': operation = { kind: intent.kind, columns: keys }; break;
			case 'constraints':
				if (!constraintDraft) return;
				operation = constraintDraft;
				break;
			case 'indexes':
				if (indexDraft) operation = indexDraft;
				else if (indexToDrop) operation = { kind: 'dropIndex', indexOid: indexToDrop.oid };
				else return;
				break;
		}
		saving = true;
		error = null;
		try {
			await editor.applySchemaChange({ ...target, schema, table: intent.kind === 'createTable' ? name : target.table,
				expected: definition?.version ?? null, operation });
			onclose();
		} catch (cause) { error = message(cause); }
		finally { saving = false; }
	}

	async function focusField(event?: Event) {
		event?.preventDefault();
		await tick();
		(panel?.querySelector<HTMLElement>('[data-schema-fields] input:not(:disabled), [data-schema-fields] button:not(:disabled), [data-copy-schema]:not(:disabled)')
			?? panel?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
	}

	function keydown(event: KeyboardEvent) {
		if (!event.defaultPrevented && !event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault(); event.stopPropagation(); void (copying ? copySQL() : apply());
		}
	}

	function resizeKey(event: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		width = event.key === 'Home' ? 320 : event.key === 'End' ? windowWidth : panelWidth + (event.key === 'ArrowLeft' ? 32 : -32);
		width = Math.min(windowWidth, Math.max(320, width));
	}
</script>

<svelte:window bind:innerWidth={windowWidth} />

<Sheet.Root open onOpenChange={(open) => { if (!open) cancel(); }}>
	<Sheet.Content bind:ref={panel} side="right" showCloseButton={false} class="@container gap-0 p-0"
		style={`width:${panelWidth}px;max-width:100vw;height:100dvh;`}
		onInteractOutside={(event) => event.preventDefault()}
		onEscapeKeydown={(event) => { if (event.defaultPrevented) return; event.preventDefault(); cancel(); }}
		onOpenAutoFocus={focusField} onkeydown={keydown}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			void tick().then(() => (anchor?.isConnected ? anchor
				: document.querySelector<HTMLElement>('[role="grid"]') ?? document.querySelector<HTMLElement>('button[aria-label="Create table"]'))?.focus());
		}}>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Adjustable separator supports keyboard resizing.) -->
		<div role="separator" tabindex="0" aria-label="Resize schema panel" aria-orientation="vertical"
			aria-valuemin={Math.min(320, windowWidth)} aria-valuemax={windowWidth} aria-valuenow={panelWidth}
			class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none"
			onkeydown={resizeKey}
			onpointerdown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize = { x: event.clientX, width: panelWidth }; }}
			onpointermove={(event) => { if (resize) width = Math.min(windowWidth, Math.max(320, resize.width + resize.x - event.clientX)); }}
			onpointerup={() => resize = null} onlostpointercapture={() => resize = null}></div>
		<Sheet.Header class="shrink-0 border-b px-6 py-5">
			<div class="flex items-center gap-3">
				<Sheet.Title class="min-w-0 flex-1 break-words text-base font-medium">{indexDraft ? 'Create index' : indexToDrop ? 'Drop index' : constraintTitle}{#if 'column' in intent}{' '}<code>{intent.column}</code>{/if}</Sheet.Title>
				<Button variant="ghost" size="icon-sm" disabled={saving} aria-label="Close schema editor" onclick={cancel}><X /></Button>
			</div>
			<Sheet.Description class="break-all font-mono text-xs">{intent.kind === 'createTable' ? 'New table' : `${target.schema}.${target.table}`}</Sheet.Description>
		</Sheet.Header>
		<div data-schema-fields class="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6" aria-busy={loading || saving}>
			{#if loading}
				<div role="status" class="space-y-4"><span class="sr-only">Loading schema…</span><Skeleton class="h-8 w-2/3" /><Skeleton class="h-32 w-full" /><Skeleton class="h-32 w-full" /></div>

			{:else if copying && exported}
				<ul class="list-disc space-y-2 pl-4 text-xs text-muted-foreground">
					{#each exported.warnings as warning}<li>{warning}</li>{/each}
				</ul>
				<TextEditor value={exported.sql} language="text" readonly label="Table schema SQL" onchange={() => {}} class="h-[50dvh]" />
			{:else if constraining && definition}
				<SchemaConstraints {definition} connection={target.connection} bind:draft={constraintDraft} bind:confirmation disabled={saving || readOnly}
					onbegin={(operation) => { constraintDraft = operation; confirmation = ''; error = null; baseline = snapshot(); void focusField(); }} />
			{:else if indexing && definition}
				{#if readOnly}<p role="status" class="text-sm text-muted-foreground">{definition.reason}</p>{/if}
				{#if indexDraft}
					<div class="space-y-2">
						<Label for={`${id}-index-name`}>Index name</Label>
						<Input id={`${id}-index-name`} bind:value={indexDraft.name} disabled={saving || readOnly} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
					</div>
					<div class="flex flex-wrap items-end gap-4">
						<div class="min-w-0 flex-1 space-y-2">
							<Label for={`${id}-index-method`}>Method</Label>
							<Select.Root type="single" value={indexDraft.method} disabled={saving || readOnly} allowDeselect={false}
								onValueChange={(value) => { if (indexDraft && INDEX_METHODS.some((method) => method === value)) indexDraft.method = value as typeof indexDraft.method; }}>
								<Select.Trigger id={`${id}-index-method`} class="w-full text-xs">{indexDraft.method.toUpperCase()}</Select.Trigger>
								<Select.Content>{#each INDEX_METHODS as method}<Select.Item value={method} label={method.toUpperCase()} />{/each}</Select.Content>
							</Select.Root>
						</div>
						<div class="flex h-9 items-center gap-2">
							<Checkbox id={`${id}-index-unique`} bind:checked={indexDraft.unique} disabled={saving || readOnly} />
							<Label for={`${id}-index-unique`} class="text-xs">Unique</Label>
						</div>
					</div>
					<div class="space-y-3">
						<p class="text-xs font-medium">Key columns · {indexDraft.columns.length} / 32</p>
						<ol class="space-y-2">
							{#each indexDraft.columns as column, i (column)}
								<li class="flex items-center gap-2 rounded-md border p-2">
									<span class="text-xs text-muted-foreground">{i + 1}.</span>
									<span class="min-w-0 flex-1 truncate font-mono text-xs" title={column}>{column}</span>
									<Button variant="ghost" size="icon-xs" disabled={saving || i === 0} aria-label={`Move ${column} up`} onclick={() => moveIndexColumn(i, -1)}><ArrowUp /></Button>
									<Button variant="ghost" size="icon-xs" disabled={saving || i === indexDraft.columns.length - 1} aria-label={`Move ${column} down`} onclick={() => moveIndexColumn(i, 1)}><ArrowDown /></Button>
									<Button variant="ghost" size="icon-xs" disabled={saving} aria-label={`Remove index column ${column}`} onclick={() => { if (indexDraft) indexDraft.columns = indexDraft.columns.filter((name) => name !== column); }}><X /></Button>
								</li>
							{/each}
						</ol>
						<Select.Root type="single" bind:value={indexPicked} onValueChange={addIndexColumn} allowDeselect={false}
							disabled={saving || readOnly || indexDraft.columns.length >= Math.min(32, definition.columns.length)}>
							<Select.Trigger aria-label="Add index column" class="w-full text-xs">Add a column…</Select.Trigger>
							<Select.Content class="max-h-72">
								{#each definition.columns.filter((column) => !indexDraft!.columns.includes(column.name)) as column (column.name)}
									<Select.Item value={column.name} label={column.name}><span class="max-w-64 truncate">{column.name}</span></Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<p class="text-xs text-muted-foreground">Plain columns with PostgreSQL's default ordering, collations and operator classes. Use SQL for expressions, partial indexes or other advanced options.</p>
					<p class="text-xs text-muted-foreground">Apply locks the table, blocking reads and writes until the build finishes. Use the SQL editor for concurrent builds.</p>
				{:else if indexToDrop}
					<pre class="whitespace-pre-wrap break-all font-mono text-xs">{indexToDrop.definition}</pre>
					<p class="text-sm text-destructive">Drop this index, not the table's data. {indexToDrop.unique ? 'Its uniqueness enforcement will be removed. ' : ''}Dependencies block removal; they are not deleted automatically.</p>
					<div class="space-y-2">
						<Label for={`${id}-confirm`} class="break-all text-xs">Type {indexToDrop.name} to confirm</Label>
						<Input id={`${id}-confirm`} bind:value={confirmation} disabled={saving || readOnly} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
					</div>
				{:else}
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm">{definition.indexes.length} {definition.indexes.length === 1 ? 'index' : 'indexes'}</p>
						<Button variant="outline" size="sm" disabled={readOnly || !definition.columns.length} onclick={() => {
							indexDraft = { kind: 'createIndex', name: '', method: 'btree', unique: false, columns: [] };
							baseline = snapshot(); void focusField();
						}}><Plus />Create index</Button>
					</div>
					{#each definition.indexes as index (index.oid)}
						<section class="space-y-3 rounded-md border p-3" aria-label={`Index ${index.name}`}>
							<div class="flex items-start gap-3">
								<div class="min-w-0 flex-1 space-y-1">
									<h3 class="break-all font-mono text-xs font-medium">{index.name}</h3>
									<p class="text-xs text-muted-foreground">{index.method.toUpperCase()}{index.primary ? ' · Primary key' : index.unique ? ' · Unique' : ''}{index.clustered ? ' · Clustering index' : ''}</p>
								</div>
								<Button variant="ghost" size="icon-sm" disabled={readOnly || !!index.constraint || index.replicaIdentity}
									aria-label={`Drop index ${index.name}`} title={index.constraint ? 'Manage the owning constraint instead' : index.replicaIdentity ? 'Change replica identity in SQL before dropping this index' : 'Drop index'}
									onclick={() => { indexToDrop = index; baseline = snapshot(); void focusField(); }}><Trash2 /></Button>
							</div>
							{#if !index.valid || !index.ready}<p class="text-xs text-amber-300">{!index.valid ? 'Invalid — unavailable to query planning.' : ''} {!index.ready ? 'Not ready for writes.' : ''}</p>{/if}
							{#if index.constraint}<p class="break-all text-xs text-muted-foreground">Owned by constraint <code>{index.constraint}</code>.</p>{/if}
							{#if index.replicaIdentity}<p class="text-xs text-muted-foreground">Replica identity — change it in SQL before dropping this index.</p>{/if}
							{#if index.comment}<p class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{index.comment}</p>{/if}
							<details class="text-xs"><summary class="cursor-pointer text-muted-foreground">SQL definition</summary><pre class="mt-2 whitespace-pre-wrap break-all font-mono">{index.definition}</pre></details>
						</section>
					{/each}
				{/if}
			{:else if catalog}
				{#if readOnly}<p role="status" class="text-sm text-muted-foreground">{definition?.reason ?? 'This definition is not available for editing.'}</p>{/if}
				{#if intent.kind === 'createTable' || intent.kind === 'renameTable' || intent.kind === 'duplicateTable'}
					<div class="grid gap-4 @min-[540px]:grid-cols-2">
						{#if intent.kind === 'createTable'}
							<div class="space-y-2">
								<Label for={`${id}-schema`}>Schema</Label>
								<Select.Root type="single" bind:value={schema} disabled={saving} allowDeselect={false}>
									<Select.Trigger id={`${id}-schema`} class="w-full font-mono text-xs">{schema}</Select.Trigger>
									<Select.Content>{#each catalog.schemas as schema}<Select.Item value={schema} label={schema} />{/each}</Select.Content>
								</Select.Root>
							</div>
						{/if}
						<div class="space-y-2"><Label for={`${id}-table`}>Table name</Label><Input id={`${id}-table`} bind:value={name} disabled={saving || readOnly} autocomplete="off" spellcheck={false} class="font-mono text-xs" /></div>
					</div>
				{/if}
				{#if intent.kind === 'duplicateTable'}
					<p class="text-xs leading-relaxed text-muted-foreground">{DUPLICATE_NOTICE}</p>
					<div class="flex items-center gap-2">
						<Checkbox id={`${id}-rows`} bind:checked={includeRows} disabled={saving || readOnly} />
						<Label for={`${id}-rows`} class="text-xs">Include rows</Label>
					</div>
					<p class="text-xs text-muted-foreground">Copies every row visible to your database role, not just the current page or filters. PostgreSQL recomputes generated values and evaluates checks; shared functions may have side effects.</p>
					<div class="flex items-start gap-2 rounded-md border p-3">
						<Checkbox id={`${id}-duplicate`} bind:checked={duplicateApproved} disabled={saving || readOnly} class="mt-0.5" />
						<Label for={`${id}-duplicate`} class="text-xs leading-relaxed">I understand the copy scope and destination permissions.</Label>
					</div>
				{/if}
				{#each columns as column, i (column)}
					<section class="space-y-4 rounded-lg border p-4" aria-label={`Column ${i + 1}`}>
						{#if intent.kind === 'createTable'}
							<div class="flex items-center justify-between"><h3 class="text-xs font-medium">Column {i + 1}</h3>
								<Button variant="ghost" size="icon-xs" disabled={saving || columns.length === 1} aria-label={`Remove column ${i + 1}`} onclick={() => columns = columns.filter((_, index) => index !== i)}><Trash2 /></Button>
							</div>
						{/if}
						<SchemaColumnFields bind:value={columns[i]} types={catalog.types} {existing} disabled={saving || readOnly}
							canSetPrimaryKey={intent.kind === 'createTable' || !definition?.primaryKey.length} />
					</section>
				{/each}
				{#if intent.kind === 'createTable'}<Button variant="outline" size="sm" disabled={saving || columns.length >= 100} onclick={() => columns = [...columns, newColumn()]}><Plus />Add column</Button>{/if}
				{#if typeChanged}
					<div class="flex items-start gap-2 rounded-md border border-amber-500/30 p-3">
						<Checkbox id={`${id}-convert`} bind:checked={conversionApproved} disabled={saving || readOnly} class="mt-0.5" />
						<Label for={`${id}-convert`} class="text-xs leading-relaxed">Convert existing values using a PostgreSQL cast. This can round or truncate values and may rewrite and lock the table. Foreign-key columns also require native LOCK permissions on related tables.</Label>
					</div>
				{/if}
				{#if intent.kind === 'alterColumn' && definition && columns[0]}
					<ColumnConstraints {definition} column={intent.column} renamedColumn={columns[0].name} primaryKey={columns[0].primaryKey}
						connection={target.connection} bind:operations={columnConstraints} bind:valid={columnConstraintsValid} disabled={saving || readOnly} />
				{/if}
				{#if intent.kind === 'addPrimaryKey'}
					{#if definition?.primaryKey.length}<p class="text-xs text-muted-foreground">This table already has a primary key.</p>
					{:else}
						<div class="space-y-3">
							{#each definition?.columns ?? [] as column, i}
								<div class="flex items-center gap-2">
									<Checkbox id={`${id}-key-${i}`} checked={keys.includes(column.name)} disabled={saving || readOnly}
										onCheckedChange={(checked) => keys = checked ? [...keys, column.name] : keys.filter((name) => name !== column.name)} />
									<Label for={`${id}-key-${i}`} class="font-mono text-xs">{column.name}</Label><span class="text-xs text-muted-foreground">{column.type}</span>
								</div>
							{/each}
						</div>
						{#if keys.length}<p class="break-all font-mono text-xs text-muted-foreground">PRIMARY KEY ({keys.join(', ')})</p>{/if}
					{/if}
				{/if}
				{#if destructive}
					<p class="text-sm text-destructive">{intent.kind === 'dropTable' ? 'The table and all its data will be permanently deleted.' : 'Column data and associated indexes and table constraints will be permanently deleted.'} External dependencies block deletion; they are not removed automatically.</p>
					<div class="space-y-2">
						<Label for={`${id}-confirm`} class="break-all text-xs">Type {confirmationName} to confirm</Label>
						<Input id={`${id}-confirm`} bind:value={confirmation} disabled={saving || readOnly} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
					</div>
				{/if}
			{/if}
		</div>
		<div class="shrink-0 space-y-3 border-t px-5 py-4">
			{#if error}<p role="alert" class="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">{error}</p>{/if}
			<div class="flex justify-end gap-2">
				<Button variant="outline" size="sm" disabled={saving} onclick={cancel}>{copying || (indexing && !indexDraft && !indexToDrop) || (constraining && !constraintDraft) ? 'Close' : 'Cancel'}</Button>
				{#if copying}
					<Button data-copy-schema size="sm" disabled={loading || saving || !exported} onclick={copySQL}><Copy /><span aria-live="polite">{saving ? 'Copying…' : copied ? 'Copied' : 'Copy SQL'}</span></Button>
				{:else if (!indexing || indexDraft || indexToDrop) && (!constraining || constraintDraft)}
					<Button variant={destructive || columnConstraints.some((operation) => operation.kind === 'dropConstraint') ? 'destructive' : 'default'} size="sm" disabled={!canApply} onclick={apply}>{saving ? 'Applying…' : 'Apply'}</Button>
				{/if}
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>
