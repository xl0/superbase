<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { Copy, Plus, Trash2, X } from '@lucide/svelte';
	import { schemaCatalog, schemaDefinition, tableSchema } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { DUPLICATE_NOTICE, type ColumnSpec, type SchemaCatalog, type SchemaDefinition, type SchemaEditMode, type SchemaExport, type SchemaOperation } from '#lib/schema.js';
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
		duplicateTable: 'Duplicate table', copySchema: 'Copy table schema' }[intent.kind];
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
	const destructive = intent.kind === 'dropColumn' || intent.kind === 'dropTable';
	const confirmationName = intent.kind === 'dropColumn' ? intent.column : target.table;
	const typeChanged = $derived(intent.kind === 'alterColumn' && columns.length > 0 && columns[0].typeOid !== null);
	const readOnly = $derived(intent.kind !== 'createTable' && !definition?.editable);
	const snapshot = () => JSON.stringify({ schema, name, columns, keys, includeRows });
	const dirty = $derived(!!baseline && snapshot() !== baseline);
	const valid = $derived(intent.kind === 'createTable' ? !!schema && !!name && columns.length > 0 && columns.every((column) => !!column.name && !!column.typeOid)
		: intent.kind === 'duplicateTable' ? !!name && name !== target.table && duplicateApproved
		: intent.kind === 'renameTable' ? !!name && name !== target.table
		: intent.kind === 'addColumn' ? !!columns[0]?.name && !!columns[0]?.typeOid
		: intent.kind === 'alterColumn' ? !!columns[0]?.name && dirty
		: intent.kind === 'addPrimaryKey' ? keys.length > 0 : confirmation === confirmationName);
	const canApply = $derived(!loading && !saving && !!catalog && !readOnly && valid && (!typeChanged || conversionApproved)
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
				const choices = schemaCatalog({ connection: target.connection });
				const details = intent.kind === 'createTable' ? null : schemaDefinition(target);
				await Promise.all([choices.refresh(), details?.refresh()]);
				if (cancelled) return;
				if (choices.error) throw choices.error;
				if (details?.error) throw details.error;
				if (!choices.current || (details && !details.current)) throw new Error('No schema response from the database');
				catalog = choices.current;
				definition = details?.current ?? null;
				if (intent.kind === 'createTable') {
					if (!catalog.schemas.length) throw new Error('No writable schemas are available');
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

	async function apply() {
		if (!canApply || intent.kind === 'copySchema') return;
		let operation: SchemaOperation;
		switch (intent.kind) {
			case 'createTable': operation = { kind: intent.kind, columns }; break;
			case 'duplicateTable': operation = { kind: intent.kind, name, includeRows }; break;
			case 'renameTable': operation = { kind: intent.kind, name }; break;
			case 'dropTable': operation = { kind: intent.kind }; break;
			case 'addColumn': operation = { kind: intent.kind, column: columns[0] }; break;
			case 'alterColumn': operation = { kind: intent.kind, column: intent.column, changes: columns[0] }; break;
			case 'dropColumn': operation = { kind: intent.kind, column: intent.column }; break;
			case 'addPrimaryKey': operation = { kind: intent.kind, columns: keys }; break;
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
				<Sheet.Title class="min-w-0 flex-1 break-words text-base font-medium">{title}{#if 'column' in intent}{' '}<code>{intent.column}</code>{/if}</Sheet.Title>
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
						<Label for={`${id}-convert`} class="text-xs leading-relaxed">Convert existing values using a PostgreSQL cast. This can round or truncate values and may rewrite and lock the table.</Label>
					</div>
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
				<Button variant="outline" size="sm" disabled={saving} onclick={cancel}>{copying ? 'Close' : 'Cancel'}</Button>
				{#if copying}
					<Button data-copy-schema size="sm" disabled={loading || saving || !exported} onclick={copySQL}><Copy /><span aria-live="polite">{saving ? 'Copying…' : copied ? 'Copied' : 'Copy SQL'}</span></Button>
				{:else}
					<Button variant={destructive ? 'destructive' : 'default'} size="sm" disabled={!canApply} onclick={apply}>{saving ? 'Applying…' : 'Apply'}</Button>
				{/if}
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>
