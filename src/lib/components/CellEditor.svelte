<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Popover } from 'bits-ui';
	import { Maximize2, Minimize2, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { writable, type CellValue, type Column, type Row } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import ReferencePicker from './ReferencePicker.svelte';

	let { row, column, anchor, initial, onapply, onclose }: {
		row: Row;
		column: Column;
		anchor: HTMLElement;
		initial?: string;
		onapply: (changes: Record<string, CellValue | undefined>) => boolean;
		onclose: () => void;
	} = $props();
	const id = $props.id();
	const readOnly = $derived(!editor.tableEditable || !writable(column));
	const original = untrack(() => editor.getValue(row, column.name));
	let value = $state<CellValue | undefined>(untrack(() => readOnly || initial === undefined ? original : initial));
	let expanded = $state(untrack(() => !!column.foreignKey));
	let picking = $state(untrack(() => !!column.foreignKey && initial === undefined));
	let width = $state(640);
	let windowWidth = $state(1024);
	let field = $state<HTMLTextAreaElement | null>(null);
	let panel = $state<HTMLDivElement | null>(null);
	let error = $state<string | null>(null);
	let resize: { x: number; width: number } | null = null;
	let selection: { start: number; end: number } | null = null;
	const temporal = $derived(/^(date|timestamp|time)(?:\(|\s|$)/.test(column.type));
	const options = $derived(column.kind === 'boolean' ? ['t', 'f'] : column.enumValues ?? []);
	const panelWidth = $derived(Math.min(windowWidth, Math.max(320, width)));
	const current = $derived(Object.fromEntries((column.foreignKey?.columns ?? []).map((name) => [name, editor.getValue(row, name) ?? null])));
	const referenceReadOnly = $derived(readOnly || column.foreignKey?.columns.some((name) => {
		const source = editor.table.columns.find((column) => column.name === name);
		return !source || !writable(source);
	}));

	function apply() {
		if (readOnly || value === original) { onclose(); return; }
		if (!onapply({ [column.name]: value })) error = 'This cell is no longer editable. Cancel and reopen it.';
	}

	function selectReference(target: Row) {
		const fk = column.foreignKey!;
		const changes = Object.fromEntries(fk.columns.map((name, i) => [name, target.values[fk.referencedColumns[i]]]));
		if (!onapply(changes)) error = 'The reference cannot be changed: a source column is read-only or the row changed.';
	}

	function special(action: string) {
		if (action === 'null') value = null;
		else if (action === 'default') value = undefined;
		else if (action === 'empty') value = '';
		else if (action === 'now') value = 'now'; // PostgreSQL resolves this literal in the save transaction's timezone.
	}

	async function focusField(event: Event) {
		event.preventDefault();
		await tick();
		if (picking) { panel?.querySelector<HTMLInputElement>('[data-reference-search]')?.focus(); return; }
		field?.focus();
		if (selection) field?.setSelectionRange(selection.start, selection.end);
		else if (initial === undefined) field?.select();
		else field?.setSelectionRange(field.value.length, field.value.length);
	}

	function keydown(event: KeyboardEvent) {
		event.stopPropagation();
		if (!event.isComposing && event.key === 'Escape') {
			event.preventDefault(); onclose();
		} else if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !picking) {
			event.preventDefault(); apply();
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

{#snippet contents()}
	<div class="flex shrink-0 items-center gap-2">
		<div class="min-w-0 flex-1">
			<h2 id={`${id}-title`} class="truncate font-mono text-sm font-medium">{column.name}</h2>
			<p id={`${id}-description`} class="truncate text-xs text-muted-foreground">{column.type}{readOnly ? ' · read-only' : ''}</p>
		</div>
		<Button variant="ghost" size="icon-sm" aria-label={expanded ? 'Collapse cell editor' : 'Expand cell editor'}
			onclick={() => {
				selection = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
				picking = false; expanded = !expanded;
			}}>
			{#if expanded}<Minimize2 />{:else}<Maximize2 />{/if}
		</Button>
		<Button variant="ghost" size="icon-sm" aria-label="Cancel cell edit" onclick={onclose}><X /></Button>
	</div>
	{#if column.foreignKey}
		<div class="flex shrink-0 gap-2">
			<Button size="xs" variant={picking ? 'secondary' : 'outline'} onclick={() => { picking = true; expanded = true; }}>Choose record</Button>
			<Button size="xs" variant={!picking ? 'secondary' : 'outline'} onclick={() => picking = false}>Edit value</Button>
			<span class="min-w-0 truncate self-center font-mono text-[11px] text-muted-foreground">{column.foreignKey.schema}.{column.foreignKey.table}</span>
		</div>
	{/if}
	{#if error}<p role="alert" class="shrink-0 text-xs text-destructive">{error}</p>{/if}
	{#if picking && column.foreignKey}
		<ReferencePicker foreignKey={column.foreignKey} {current} disabled={referenceReadOnly} onselect={selectReference} />
	{:else}
		<div class="flex shrink-0 flex-wrap items-center gap-2">
			{#if !readOnly && (column.nullable || temporal || row.draft || column.kind === 'text')}
				<NativeSelect.Root size="sm" aria-label="Set cell to" value="" onchange={(event) => { special(event.currentTarget.value); event.currentTarget.value = ''; }}>
					<NativeSelect.Option value="" disabled>Set to…</NativeSelect.Option>
					{#if column.nullable}<NativeSelect.Option value="null">NULL</NativeSelect.Option>{/if}
					{#if temporal}<NativeSelect.Option value="now">Now</NativeSelect.Option>{/if}
					{#if row.draft}<NativeSelect.Option value="default">DEFAULT</NativeSelect.Option>{/if}
					{#if column.kind === 'text'}<NativeSelect.Option value="empty">Empty text</NativeSelect.Option>{/if}
				</NativeSelect.Root>
			{/if}
			{#if options.length && !readOnly}
				<NativeSelect.Root size="sm" aria-label={`Choose ${column.name} value`} value={value == null ? -1 : options.indexOf(value)}
					onchange={(event) => value = options[Number(event.currentTarget.value)]}>
					<NativeSelect.Option value={-1} disabled>Choose value…</NativeSelect.Option>
					{#each options as option, i}<NativeSelect.Option value={i}>{column.kind === 'boolean' ? option === 't' ? 'true' : 'false' : option || '(empty string)'}</NativeSelect.Option>{/each}
				</NativeSelect.Root>
			{/if}
			<span class="text-xs text-muted-foreground" aria-live="polite">{value === null ? 'SQL NULL' : value === undefined ? 'DEFAULT' : value === '' ? 'Empty text' : ''}</span>
		</div>
		<Textarea bind:ref={field} aria-label={`Edit ${column.name}`} readonly={readOnly} value={value ?? ''}
			oninput={(event) => value = event.currentTarget.value} spellcheck={false}
			placeholder={value === null ? 'NULL — type to replace' : value === undefined ? 'DEFAULT — type to replace' : ''}
			class={expanded ? 'min-h-24 flex-1 resize-none font-mono text-xs' : 'min-h-48 max-h-[50dvh] resize-y font-mono text-xs'} />
		<div class="flex shrink-0 items-center gap-2">
			<p class="mr-auto text-[11px] text-muted-foreground">{temporal && value === 'now' ? 'Now is resolved by PostgreSQL when you save.' : 'Ctrl/⌘+Enter to apply · Esc to cancel'}</p>
			<Button variant="outline" size="sm" onclick={onclose}>{readOnly ? 'Close' : 'Cancel'}</Button>
			{#if !readOnly}<Button size="sm" onclick={apply}>Apply</Button>{/if}
		</div>
	{/if}
{/snippet}

<Popover.Root open={!expanded} onOpenChange={(open) => { if (!open && !expanded) apply(); }}>
	<Popover.Portal>
		<!-- Consume the outside click: dismissal must apply before any navigation can run. -->
		<Popover.Overlay class="fixed inset-0 z-40" />
		<Popover.Content customAnchor={anchor} side="bottom" align="start" sideOffset={4} collisionPadding={12}
			role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-modal="true"
			class="z-50 flex w-[420px] max-w-[calc(100vw-24px)] flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-xl outline-none"
			onOpenAutoFocus={focusField} onCloseAutoFocus={(event) => event.preventDefault()}
			onEscapeKeydown={(event) => { event.preventDefault(); onclose(); }} onkeydown={keydown}>
			{@render contents()}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>

<Dialog.Root open={expanded} onOpenChange={(open) => { if (!open) onclose(); }}>
	<Dialog.Content bind:ref={panel} showCloseButton={false} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
		class="gap-3 rounded-none p-5" style={`top:0;left:auto;right:0;transform:none;translate:none;width:${panelWidth}px;max-width:100vw;height:100dvh;display:flex;flex-direction:column;`}
		onInteractOutside={(event) => event.preventDefault()} onOpenAutoFocus={focusField}
		onCloseAutoFocus={(event) => event.preventDefault()} onkeydown={keydown}>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (ARIA adjustable separators are focusable and support arrow keys.) -->
		<div role="separator" tabindex="0" aria-label="Resize cell side panel" aria-orientation="vertical"
			aria-valuemin={Math.min(320, windowWidth)} aria-valuemax={windowWidth} aria-valuenow={panelWidth}
			class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none"
			onkeydown={resizeKey}
			onpointerdown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resize = { x: event.clientX, width: panelWidth }; }}
			onpointermove={(event) => { if (resize) width = Math.min(windowWidth, Math.max(320, resize.width + resize.x - event.clientX)); }}
			onpointerup={() => resize = null} onlostpointercapture={() => resize = null}></div>
		{@render contents()}
	</Dialog.Content>
</Dialog.Root>
