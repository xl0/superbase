<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Maximize2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { writable, type CellValue, type Column, type Row, type Table, type Values } from '#lib/types.js';
	import { message } from '#lib/utils.js';
	import { isTemporal, optionLabel, valueOptions, valueState } from '#lib/format.js';
	import { arrayLiteral } from '#lib/arrays.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import CellEditor from './CellEditor.svelte';
	import ResizableSheet from './ResizableSheet.svelte';
	import TextEditor from './TextEditor.svelte';

	let { table, onclose }: { table: Table; onclose: () => void } = $props();
	const target = untrack(() => table);
	const id = $props.id();
	let values = $state<Values>({});
	let formKey = $state(0);
	let createMore = $state(false);
	let error = $state<string | null>(null);
	let nested = $state.raw<{ column: Column; anchor: HTMLElement } | null>(null);
	let panel = $state<HTMLElement | null>(null);
	const row: Row = $derived({ key: `${id}-draft`, values, identity: null, draft: true });

	function change(name: string, value: CellValue | undefined) {
		if (editor.busy) return;
		if (value !== undefined) { values = { ...values, [name]: value }; return; }
		const next = { ...values };
		delete next[name];
		values = next;
	}

	async function applyChanges(changes: Record<string, CellValue | undefined>) {
		if (editor.busy) throw new Error('An insert is already in progress.');
		const entries = Object.entries(changes);
		if (entries.some(([name]) => !target.columns.some((column) => column.name === name && writable(column)))) {
			throw new Error('A source column is read-only or no longer available.');
		}
		values = Object.fromEntries(Object.entries({ ...values, ...changes })
			.filter((entry): entry is [string, CellValue] => entry[1] !== undefined));
	}

	function cancel() {
		if (editor.busy || nested) return;
		if (Object.keys(values).length && !window.confirm('Discard the values for this new row?')) return;
		onclose();
	}

	async function save() {
		if (editor.busy || nested) return;
		error = null;
		try {
			// Array fields hold JSON in the form; convert them to literals now.
			await editor.insertRow(Object.fromEntries(Object.entries(values).map(([name, value]) => {
				const element = target.columns.find((column) => column.name === name)?.element;
				if (!element || typeof value !== 'string') return [name, value];
				try { return [name, arrayLiteral(value, element)]; } catch (cause) { throw new Error(`${name}: ${message(cause)}`); }
			})));
		} catch (cause) {
			error = message(cause);
			return;
		}
		if (!createMore) { onclose(); return; }
		values = {};
		formKey++;
		await focusField();
	}

	async function focusField(event?: Event) {
		event?.preventDefault();
		await tick();
		panel?.querySelector<HTMLElement>('[data-insert-fields] input:not(:disabled), [data-insert-fields] textarea:not(:disabled), [data-insert-fields] [role="combobox"]:not(:disabled), [data-insert-fields] [contenteditable="true"]')?.focus();
	}

	function keydown(event: KeyboardEvent) {
		if (!event.defaultPrevented && !event.isComposing && !nested && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			event.stopPropagation();
			void save();
		}
	}
</script>

<ResizableSheet bind:ref={panel} width={800} label="Resize new row panel" class="@container gap-0 p-0" onOpenChange={(open) => { if (!open) cancel(); }}
	onEscapeKeydown={(event) => { if (event.defaultPrevented) return; event.preventDefault(); cancel(); }}
	onOpenAutoFocus={focusField} onkeydown={keydown}>
		<Sheet.Header class="shrink-0 border-b px-6 py-5">
			<Sheet.Title class="text-base font-medium">Add new row to <code class="rounded border break-all bg-muted px-1.5 py-0.5 text-sm">{target.name}</code></Sheet.Title>
			<Sheet.Description class="sr-only">Insert into {target.schema}.{target.name}. Unspecified fields use their database defaults.</Sheet.Description>
		</Sheet.Header>
		<div data-insert-fields class="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-7" aria-busy={editor.busy}>
			{#key formKey}
			{#each target.columns as column, i (column.name)}
				{@const value = Object.hasOwn(values, column.name) ? values[column.name] : undefined}
				{@const readOnly = !writable(column)}
				{@const richText = column.kind === 'json' || column.kind === 'text' || !!column.element}
				{@const options = valueOptions(column)}
				{@const placeholder = value === null ? 'SQL NULL' : value === undefined ? `Default: ${column.defaultValue ?? (column.identity ? 'generated identity' : column.nullable ? 'NULL' : 'none — required')}` : ''}
				<div class="grid grid-cols-[minmax(0,1fr)] gap-3 @min-[500px]:grid-cols-[minmax(120px,1fr)_minmax(0,2fr)]">
					<div class="min-w-0 space-y-2">
						<Label id={`${id}-label-${i}`} for={richText && !readOnly ? undefined : `${id}-field-${i}`}
							onclick={() => { if (richText && !readOnly) document.getElementById(`${id}-field-${i}`)?.focus(); }}
							class="break-all leading-snug">{column.name}</Label>
						<p class="break-words text-xs text-muted-foreground">{column.type}{readOnly ? ' · generated' : !column.nullable && !column.defaultValue && !column.identity ? ' · required' : ''}</p>
					</div>
					<div class="min-w-0 space-y-2">
						{#if readOnly}
							<Input id={`${id}-field-${i}`} disabled placeholder={column.defaultValue ?? 'Generated automatically'} />
						{:else if column.kind === 'boolean' || column.kind === 'enum'}
							<Select.Root type="single" disabled={editor.busy} allowDeselect={false}
								value={value == null || !options.includes(value) ? '' : String(options.indexOf(value))}
								onValueChange={(selected) => { if (selected !== '') change(column.name, options[Number(selected)]); }}>
								<Select.Trigger id={`${id}-field-${i}`} aria-labelledby={`${id}-label-${i}`} class="w-full">
									{value == null ? placeholder : options.includes(value) ? optionLabel(column, value) : value}
								</Select.Trigger>
								<Select.Content>{#each options as option, index}<Select.Item value={String(index)} label={optionLabel(column, option)} />{/each}</Select.Content>
							</Select.Root>
						{:else if richText}
							<TextEditor id={`${id}-field-${i}`} language={column.kind === 'text' ? 'text' : 'json'} {value} {placeholder} label={column.name} readonly={editor.busy}
								onchange={(next) => change(column.name, next)} class="h-40" />
						{:else if column.kind === 'array'}
							<Textarea id={`${id}-field-${i}`} value={value ?? ''} {placeholder} disabled={editor.busy}
								oninput={(event) => change(column.name, event.currentTarget.value)} spellcheck={false} class="min-h-28 font-mono text-xs" />
						{:else}
							<Input id={`${id}-field-${i}`} value={value ?? ''} {placeholder} disabled={editor.busy}
								oninput={(event) => change(column.name, event.currentTarget.value)} spellcheck={false} class="font-mono text-xs" />
						{/if}
						{#if !readOnly}
							<div class="flex flex-wrap items-center gap-1">
								<Button variant="ghost" size="xs" disabled={editor.busy} onclick={() => change(column.name, undefined)}>Default</Button>
								{#if column.nullable}<Button variant="ghost" size="xs" disabled={editor.busy} onclick={() => change(column.name, null)}>NULL</Button>{/if}
								{#if column.kind === 'text' || column.enumValues?.includes('')}<Button variant="ghost" size="xs" disabled={editor.busy} onclick={() => change(column.name, '')}>Empty text</Button>{/if}
								{#if isTemporal(column)}<Button variant="ghost" size="xs" disabled={editor.busy} onclick={() => change(column.name, 'now')}>Now</Button>{/if}
								<span class="ml-auto text-[11px] text-muted-foreground" aria-live="polite">{valueState(value)}</span>
								<Button variant="outline" size="icon-xs" disabled={editor.busy} aria-label={column.foreignKey ? `Choose reference for ${column.name}` : `Expand ${column.name}`}
									onclick={(event) => nested = { column, anchor: event.currentTarget }}><Maximize2 /></Button>
							</div>
						{/if}
						{#if column.foreignKey}<p class="break-words text-xs text-muted-foreground">References <code>{column.foreignKey.schema}.{column.foreignKey.table} ({column.foreignKey.referencedColumns.join(', ')})</code></p>{/if}
						{#if value === 'now' && isTemporal(column)}<p class="text-xs text-muted-foreground">Resolved by PostgreSQL when you save.</p>{/if}
					</div>
				</div>
			{/each}
			{/key}
		</div>
		<div class="shrink-0 space-y-3 border-t px-5 py-4">
			{#if error}<p role="alert" class="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive">{error}</p>{/if}
			<div class="flex flex-wrap items-center gap-3">
				<Checkbox id={`${id}-more`} bind:checked={createMore} disabled={editor.busy} />
				<Label for={`${id}-more`} class="text-xs">Create more</Label>
				<div class="ml-auto flex gap-2">
					<Button variant="outline" size="sm" disabled={editor.busy} onclick={cancel}>Cancel</Button>
					<Button size="sm" disabled={editor.busy || !!nested} onclick={save}>{editor.busy ? 'Saving…' : 'Save'}<span class="text-[10px] opacity-70">Ctrl/⌘↵</span></Button>
				</div>
			</div>
		</div>
		{#if nested}
			<CellEditor {row} column={nested.column} anchor={nested.anchor} startExpanded onapply={applyChanges} onclose={() => { const anchor = nested?.anchor; nested = null; void tick().then(() => anchor?.focus()); }} />
		{/if}
</ResizableSheet>
