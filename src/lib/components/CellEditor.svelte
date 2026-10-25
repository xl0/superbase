<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import { ChevronDown, Maximize2, Minimize2, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { message } from '#lib/utils.js';
	import { isTemporal, optionLabel, valueOptions, valueState } from '#lib/format.js';
	import { arrayJSON, arrayLiteral } from '#lib/arrays.js';
	import { writable, type CellValue, type Column, type Row } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import ReferencePicker from './ReferencePicker.svelte';
	import ResizableSheet from './ResizableSheet.svelte';
	import TextEditor from './TextEditor.svelte';
	import type { EditorState } from '@codemirror/state';
	import type { EditorView } from '@codemirror/view';

	let { row, column, anchor, initial, startExpanded = false, onapply, onclose }: {
		row: Row;
		column: Column;
		anchor: HTMLElement;
		initial?: string;
		startExpanded?: boolean;
		onapply: (changes: Record<string, CellValue | undefined>) => Promise<void>;
		onclose: () => void;
	} = $props();
	const id = $props.id();
	const readOnly = $derived(!editor.tableEditable || !writable(column));
	const original = untrack(() => editor.getValue(row, column.name));
	// Arrays are edited as JSON and turned back into a literal on apply. Insert-form drafts already
	// hold JSON (InsertRow converts on save); values without a JSON form keep the literal editor.
	const json = (text: CellValue | undefined) => typeof text === 'string' ? arrayJSON(text, column) : null;
	const arrayJson = untrack(() => column.kind === 'array' && !!column.element && (row.draft || original == null || json(original) !== null));
	const baseline = untrack(() => arrayJson && !row.draft ? json(original) ?? original : original);
	let value = $state<CellValue | undefined>(untrack(() => readOnly || initial === undefined ? baseline : initial));
	let expanded = $state(untrack(() => startExpanded || !!column.foreignKey));
	let picking = $state(untrack(() => !!column.foreignKey && initial === undefined));
	let field = $state<HTMLTextAreaElement | null>(null);
	let textView = $state.raw<EditorView | null>(null);
	let textState = $state.raw<EditorState | null>(null);
	let panel = $state<HTMLElement | null>(null);
	let error = $state<string | null>(null);
	let saving = $state(false);
	let referenceChanges = $state<Record<string, CellValue> | null>(null);
	let selection: { start: number; end: number } | null = null;
	const temporal = $derived(isTemporal(column));
	const options = $derived(valueOptions(column));
	const specialOptions = $derived(readOnly ? [] : [
		...(column.nullable ? [{ action: 'null', label: 'Set to NULL' }] : []),
		...(temporal ? [{ action: 'now', label: 'Set to Now' }] : []),
		...(row.draft ? [{ action: 'default', label: 'Use DEFAULT' }] : []),
		...(column.kind === 'text' ? [{ action: 'empty', label: 'Empty text' }] : [])
	]);
	const current = $derived(Object.fromEntries((column.foreignKey?.columns ?? []).map((name) =>
		[name, name === column.name ? value ?? null : referenceChanges?.[name] ?? editor.getValue(row, name) ?? null])));
	const referenceReadOnly = $derived(readOnly || column.foreignKey?.columns.some((name) => {
		const source = editor.table.columns.find((column) => column.name === name);
		return !source || !writable(source);
	}));

	async function commit(changes: Record<string, CellValue | undefined>) {
		if (saving || editor.busy) return;
		saving = true;
		error = null;
		try {
			await onapply(changes);
			onclose();
		} catch (cause) {
			error = message(cause);
			await tick();
			if (!picking) { if (textView) textView.focus(); else field?.focus(); }
		} finally { saving = false; }
	}

	function apply() {
		if (saving || editor.busy) return;
		if (readOnly || (value === baseline && !referenceChanges)) { onclose(); return; }
		let next = value;
		if (arrayJson && !row.draft && typeof value === 'string') {
			try { next = arrayLiteral(value, column.element!); } catch (cause) { error = message(cause); return; }
		}
		void commit({ ...referenceChanges, [column.name]: next });
	}

	function selectReference(target: Row) {
		const fk = column.foreignKey!;
		referenceChanges = Object.fromEntries(fk.columns.map((name, i) => [name, target.values[fk.referencedColumns[i]]]));
		value = referenceChanges[column.name];
		picking = false;
	}

	function special(action: string) {
		if (saving) return;
		if (action === 'null') value = null;
		else if (action === 'default') value = undefined;
		else if (action === 'empty') value = '';
		else if (action === 'now') value = 'now'; // PostgreSQL resolves this literal in the save transaction's timezone.
	}

	async function focusField(event: Event) {
		event.preventDefault();
		await tick();
		if (picking) { panel?.querySelector<HTMLInputElement>('[data-reference-search]')?.focus(); return; }
		// Restore the selection across expand/collapse; otherwise place the caret at the end.
		if (textView) {
			const end = textView.state.doc.length;
			textView.focus();
			textView.dispatch({ selection: { anchor: selection?.start ?? end, head: selection?.end ?? end } });
		} else if (field) {
			field.focus();
			field.setSelectionRange(selection?.start ?? field.value.length, selection?.end ?? field.value.length);
		}
	}

	function keydown(event: KeyboardEvent) {
		// Let Bits UI dismiss the innermost menu on Escape before the editor itself.
		if (!event.defaultPrevented && !event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !picking) {
			event.preventDefault(); event.stopPropagation(); apply();
		}
	}
</script>

{#snippet contents()}
	<div class="flex shrink-0 items-center gap-2">
		<div class="min-w-0 flex-1">
			<h2 id={`${id}-title`} class="truncate font-mono text-sm font-medium">{column.name}</h2>
			<p id={`${id}-description`} class="truncate text-xs text-muted-foreground">{column.type}{readOnly ? ' · read-only' : ''}</p>
		</div>
		<Button variant="ghost" size="icon-sm" disabled={saving} aria-label={expanded ? 'Collapse cell editor' : 'Expand cell editor'}
			onclick={() => {
				selection = textView ? { start: textView.state.selection.main.anchor, end: textView.state.selection.main.head }
					: field ? { start: field.selectionStart, end: field.selectionEnd } : null;
				picking = false; expanded = !expanded;
			}}>
			{#if expanded}<Minimize2 />{:else}<Maximize2 />{/if}
		</Button>
		<Button variant="ghost" size="icon-sm" aria-label="Cancel cell edit" disabled={saving} onclick={onclose}><X /></Button>
	</div>
	{#if column.foreignKey}
		<div class="flex shrink-0 gap-2">
			<Button size="xs" disabled={saving} variant={picking ? 'secondary' : 'outline'} onclick={() => { picking = true; expanded = true; }}>Choose record</Button>
			<Button size="xs" disabled={saving} variant={!picking ? 'secondary' : 'outline'} onclick={() => picking = false}>Edit value</Button>
			<span class="min-w-0 truncate self-center font-mono text-[11px] text-muted-foreground">{column.foreignKey.schema}.{column.foreignKey.table}</span>
		</div>
	{/if}
	{#if error}<p role="alert" class="shrink-0 text-xs text-destructive">{error}</p>{/if}
	{#if picking && column.foreignKey}
		<ReferencePicker foreignKey={column.foreignKey} {current} disabled={referenceReadOnly || saving} onselect={selectReference} />
	{:else}
		<div class="flex shrink-0 flex-wrap items-center gap-2">
			{#if options.length && !readOnly}
				<Select.Root type="single" disabled={saving} value={value == null || !options.includes(value) ? '' : String(options.indexOf(value))} allowDeselect={false}
					onValueChange={(selected) => { if (selected) value = options[Number(selected)]; }}>
					<Select.Trigger size="sm" aria-label={`Choose ${column.name} value`} class="text-xs">{value == null || !options.includes(value) ? 'Choose value…' : optionLabel(column, value)}</Select.Trigger>
					<Select.Content>
						{#each options as option, i}<Select.Item value={String(i)} label={optionLabel(column, option)} />{/each}
					</Select.Content>
				</Select.Root>
			{/if}
			<span class="text-xs text-muted-foreground" aria-live="polite">{valueState(value)}</span>
		</div>
		{#if column.kind === 'json' || column.kind === 'text' || arrayJson}
			<TextEditor language={column.kind === 'text' ? 'text' : 'json'} bind:ref={textView} bind:state={textState} label={`Edit ${column.name}`} readonly={readOnly || saving}
				{value} onchange={(next) => value = next}
				placeholder={value === null ? 'NULL — type to replace' : value === undefined ? 'DEFAULT — type to replace' : ''}
				class={expanded ? 'min-h-24 flex-1' : 'h-64 max-h-[50dvh]'} />
		{:else}
			<Textarea bind:ref={field} aria-label={`Edit ${column.name}`} readonly={readOnly || saving} aria-invalid={!!error} value={value ?? ''}
				oninput={(event) => value = event.currentTarget.value} spellcheck={false}
				placeholder={value === null ? 'NULL — type to replace' : value === undefined ? 'DEFAULT — type to replace' : ''}
				class={expanded ? 'min-h-24 flex-1 resize-none font-mono text-xs' : 'min-h-48 max-h-[50dvh] resize-y font-mono text-xs'} />
		{/if}
		<div class="flex shrink-0 items-start justify-between gap-3 border-t pt-3">
			<div class="space-y-2">
				<p class="text-[11px] text-muted-foreground">{temporal && value === 'now' ? 'Now is resolved by PostgreSQL when you save.' : row.draft ? 'Ctrl/⌘+Enter to apply to form · Esc to cancel' : 'Ctrl/⌘+Enter to save · Esc to cancel'}</p>
				<div class="flex gap-2">
					<Button variant="outline" size="xs" disabled={saving} onclick={onclose}>{readOnly ? 'Close' : 'Cancel'}</Button>
					{#if !readOnly}<Button size="xs" disabled={saving} onclick={apply}>{saving ? 'Saving…' : 'Apply'}</Button>{/if}
				</div>
			</div>
			{#if specialOptions.length === 1}
				<Button variant="outline" size="xs" class="shrink-0" disabled={saving} onclick={() => special(specialOptions[0].action)}>{specialOptions[0].label}</Button>
			{:else if specialOptions.length > 1}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}<Button {...props} variant="outline" size="xs" class="shrink-0" disabled={saving} aria-label="Set cell to">Set to…<ChevronDown /></Button>{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="min-w-40">
						{#each specialOptions as option}<DropdownMenu.Item onSelect={() => special(option.action)}>{option.label}</DropdownMenu.Item>{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
	{/if}
{/snippet}

<Popover.Root open={!expanded}>
	<Popover.Portal>
		<!-- Keep outside clicks from navigating or implicitly saving/discarding the buffer. -->
		<PopoverPrimitive.Overlay class="fixed inset-0 z-40" />
	</Popover.Portal>
		<Popover.Content customAnchor={anchor} side="bottom" align="start" sideOffset={4} collisionPadding={12}
			role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-modal="true"
			class="z-50 flex max-h-[min(var(--bits-popover-content-available-height),calc(100dvh-24px))] w-[420px] max-w-[calc(100vw-24px)] flex-col gap-3 overflow-y-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-xl outline-none"
			onOpenAutoFocus={focusField} onCloseAutoFocus={(event) => event.preventDefault()}
			onInteractOutside={(event) => event.preventDefault()}
			onEscapeKeydown={(event) => { event.preventDefault(); if (!saving) onclose(); }} onkeydown={keydown}>
			{@render contents()}
		</Popover.Content>
</Popover.Root>

<ResizableSheet open={expanded} onOpenChange={(open) => { if (!open && !saving) onclose(); }} bind:ref={panel} label="Resize cell side panel"
	aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} class="gap-3 p-5"
	onEscapeKeydown={(event) => { if (saving) event.preventDefault(); }} onOpenAutoFocus={focusField}
	onCloseAutoFocus={(event) => event.preventDefault()} onkeydown={keydown}>
	{@render contents()}
</ResizableSheet>
