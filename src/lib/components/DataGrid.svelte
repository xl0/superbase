<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { ArrowDown, ArrowUp, ArrowUpRight, KeyRound, Link2 } from '@lucide/svelte';
	import { PersistedState } from 'runed';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import CellEditor from './CellEditor.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { message } from '#lib/utils.js';
	import { displayValue, fromTSV, toTSV } from '#lib/format.js';
	import { writable, type CellValue, type Column, type Row, type Table } from '#lib/types.js';

	let { table, rows, rowOffset }: { table: Table; rows: Row[]; rowOffset: number } = $props();
	const id = $props.id();
	const ROW_HEIGHT = 35;
	const GUTTER = 64;
	type Cell = { r: number; c: number };
	type Edit = { row: Row; column: Column; anchor: HTMLElement; initial?: string };
	let viewport: HTMLDivElement;
	let focus = $state<Cell | null>(null);
	let anchor = $state<Cell | null>(null);
	let head = $state<Cell | null>(null);
	let editing = $state<Edit | null>(null);

	let resizeCleanup: (() => void) | undefined;
	let widths = $state<{ current: Record<string, number> }>({ current: {} });
	try {
		widths = new PersistedState<Record<string, number>>(
			untrack(() => `superbase:widths:${editor.connection}:${JSON.stringify([table.schema, table.name])}`), {}
		);
	} catch (error) {
		// Column sizes are optional; denied storage must not disable editing or resizing.
		if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error;
	}
	const width = (column: Column) => Object.hasOwn(widths.current, column.name) && Number.isFinite(widths.current[column.name])
		? Math.max(64, widths.current[column.name]) : column.kind === 'number' || column.kind === 'boolean' ? 120 : 230;
	const template = $derived(`${GUTTER}px ${table.columns.map((column) => `${width(column)}px`).join(' ')}`);
	const disabled = $derived(editor.busy || editor.loading);
	const focusedColumn = $derived(focus ? table.columns[focus.c] : undefined);
	const allSelected = $derived(rows.length > 0 && rows.every((row) => editor.isRowSelected(row.key)));
	const someSelected = $derived(rows.some((row) => editor.isRowSelected(row.key)));

	function bounds() {
		if (!anchor || !head) return null;
		const box = { r1: Math.min(anchor.r, head.r), r2: Math.max(anchor.r, head.r), c1: Math.min(anchor.c, head.c), c2: Math.max(anchor.c, head.c) };
		return box.r1 >= 0 && box.c1 >= 0 && box.r2 < rows.length && box.c2 < table.columns.length ? box : null;
	}
	const selection = $derived(bounds());

	function setFocus(r: number, c: number, extend = false) {
		if (!rows.length || !table.columns.length) return;
		r = Math.max(0, Math.min(r, rows.length - 1));
		c = Math.max(0, Math.min(c, table.columns.length - 1));
		focus = { r, c };
		if (!extend || !anchor) anchor = focus;
		head = focus;
		if (!viewport) return;
		const top = ROW_HEIGHT + r * ROW_HEIGHT;
		if (top < viewport.scrollTop + ROW_HEIGHT) viewport.scrollTop = top - ROW_HEIGHT;
		else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
		const left = GUTTER + table.columns.slice(0, c).reduce((sum, column) => sum + width(column), 0);
		if (left < viewport.scrollLeft + GUTTER) viewport.scrollLeft = left - GUTTER;
		else if (left + width(table.columns[c]) > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = left + width(table.columns[c]) - viewport.clientWidth;
	}

	function deselect() {
		focus = anchor = head = null;
	}

	function startEdit(r: number, c: number, initial?: string) {
		const row = rows[r], column = table.columns[c];
		if (disabled || !row || !column) return;
		setFocus(r, c);
		const anchor = document.getElementById(`${id}-${r}-${c}`);
		if (anchor) editing = { row, column, anchor, initial };
	}

	async function closeEditor() {
		editing = null;
		await tick();
		viewport?.focus();
	}

	async function clearSelection() {
		const box = bounds();
		if (disabled || !editor.tableEditable || !box) return;
		// Validate the entire operation before changing any cell.
		for (let c = box.c1; c <= box.c2; c++) {
			if (!writable(table.columns[c]) || !table.columns[c].nullable) {
				editor.error = 'Only writable, nullable columns can be set to NULL'; return;
			}
		}
		try {
			await editor.updateRows(rows.slice(box.r1, box.r2 + 1).map((row) => ({
				row, values: Object.fromEntries(table.columns.slice(box.c1, box.c2 + 1).map((column) => [column.name, null]))
			})));
		} catch (error) { editor.error = message(error); }
	}

	function onKeydown(event: KeyboardEvent) {
		// Leave native buttons, checkboxes and editors in charge of their own keys.
		if (event.target !== viewport || editing || event.isComposing || !rows.length) return;
		const current = focus ?? { r: 0, c: 0 };
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
			event.preventDefault(); focus = { r: 0, c: 0 }; anchor = focus; head = { r: rows.length - 1, c: table.columns.length - 1 }; return;
		}
		const moves: Record<string, [number, number]> = {
			ArrowUp: [current.r - 1, current.c], ArrowDown: [current.r + 1, current.c],
			ArrowLeft: [current.r, current.c - 1], ArrowRight: [current.r, current.c + 1],
			Home: [event.ctrlKey || event.metaKey ? 0 : current.r, 0],
			End: [event.ctrlKey || event.metaKey ? rows.length - 1 : current.r, table.columns.length - 1],
			PageUp: [current.r - Math.floor(viewport.clientHeight / ROW_HEIGHT), current.c],
			PageDown: [current.r + Math.floor(viewport.clientHeight / ROW_HEIGHT), current.c]
		};
		if (Object.hasOwn(moves, event.key)) {
			event.preventDefault(); setFocus(...moves[event.key], event.shiftKey); return;
		}
		if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); startEdit(current.r, current.c); }
		else if (event.key === 'Escape') deselect();
		else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void clearSelection(); }
		else if (event.key === ' ' && event.shiftKey) { event.preventDefault(); editor.toggleRowSelection(rows[current.r]); }
		else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); startEdit(current.r, current.c, event.key); }
	}

	function onCopy(event: ClipboardEvent) {
		const box = bounds();
		if (editing || event.target !== viewport || !box) return;
		event.preventDefault();
		const values = rows.slice(box.r1, box.r2 + 1).map((row) => table.columns.slice(box.c1, box.c2 + 1).map((column) => editor.getValue(row, column.name)));
		event.clipboardData?.setData('text/plain', toTSV(values));
	}

	async function onPaste(event: ClipboardEvent) {
		if (editing || event.target !== viewport || !focus || disabled || !editor.tableEditable) return;
		const text = event.clipboardData?.getData('text/plain');
		if (!text) return;
		event.preventDefault();
		try {
			const pasted = fromTSV(text);
			const changes: { row: Row; values: Record<string, CellValue | undefined> }[] = [];
			for (let r = 0; r < pasted.length; r++) for (let c = 0; c < pasted[r].length; c++) {
				const row = rows[focus.r + r], column = table.columns[focus.c + c], value = pasted[r][c];
				if (!row || !column) throw new Error('Clipboard data extends beyond the loaded grid');
				if (!writable(column)) throw new Error(`${column.name} is generated and cannot be edited`);
				if (value === undefined) throw new Error('DEFAULT is only available in the new-row form');
				if (value === null && !column.nullable) throw new Error(`${column.name} does not allow NULL`);
				if (!changes[r]) changes[r] = { row, values: {} };
				changes[r].values = { ...changes[r].values, [column.name]: value };
			}
			await editor.updateRows(changes);
		} catch (error) { editor.error = message(error); }
	}

	function startResize(event: PointerEvent, column: Column) {
		event.preventDefault(); resizeCleanup?.();
		const startX = event.clientX, startWidth = width(column);
		const move = (event: PointerEvent) => { widths.current = { ...widths.current, [column.name]: Math.max(64, startWidth + event.clientX - startX) }; };
		resizeCleanup = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', resizeCleanup!);
			window.removeEventListener('pointercancel', resizeCleanup!);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', resizeCleanup);
		window.addEventListener('pointercancel', resizeCleanup);
	}

	$effect(() => {
		// New page/order/version: discard positional selection, never apply it to replacement rows.
		rows.map((row) => [row.key, row.identity?.version]);
		untrack(() => { focus = anchor = head = null; editing = null; });
	});
	$effect(() => { editor.editing = editing !== null; });
	$effect(() => { editor.cellSelected = focus !== null; });
	onDestroy(() => { resizeCleanup?.(); editor.editing = false; editor.cellSelected = false; });
</script>

<svelte:window onpointerdowncapture={(event) => {
	if (event.button === 0 && !editing && event.target instanceof Node && !viewport?.contains(event.target)) deselect();
}} />

<div class="flex h-full min-h-0 flex-col bg-background">
	<div class="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs text-muted-foreground">
		<span class="mr-auto truncate">{focusedColumn ? `${focusedColumn.name} · ${focusedColumn.type}` : 'Double-click or Enter to edit · Shift+Space selects a row'}</span>
	</div>
	<div bind:this={viewport} role="grid" tabindex="0" aria-label={`${table.schema}.${table.name} data`}
		aria-rowcount={rows.length + 1} aria-colcount={table.columns.length + 1}
		aria-busy={editor.loading || editor.busy} aria-readonly={!editor.tableEditable}
		aria-activedescendant={focus ? `${id}-${focus.r}-${focus.c}` : undefined}
		class="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
		onkeydown={onKeydown} oncopy={onCopy} onpaste={onPaste}
		onmousedown={(event) => {
			if (event.button === 0 && event.target instanceof HTMLElement &&
				!event.target.closest('[role="gridcell"], [role="columnheader"], [role="rowheader"]')) {
				event.preventDefault(); deselect(); viewport.focus();
			}
		}}>
		<div class="w-max min-w-full">
			<div class="grid-header" role="row" aria-rowindex={1} style:grid-template-columns={template}>
				<div class="gutter" role="columnheader" aria-label="Row selection">
					<Checkbox aria-label="Select loaded rows" checked={allSelected} indeterminate={someSelected && !allSelected}
						disabled={disabled || !editor.tableEditable} onCheckedChange={(checked) => editor.setRowsSelected(rows, checked)} class="size-3.5" />
					<span>#</span>
				</div>
				{#each table.columns as column (column.name)}
					<div class="header-cell" role="columnheader" aria-sort={editor.sort?.column === column.name ? editor.sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
						<button class="flex h-full w-full items-center gap-1.5 px-2 text-left text-xs focus-visible:outline-1 focus-visible:outline-ring" disabled={disabled}
							onclick={() => editor.toggleSort(column.name)} title={`${column.name} · ${column.type} — sort`}>
							{#if column.primaryKey}<KeyRound class="size-3 shrink-0 text-muted-foreground" />{:else if column.foreignKey}<Link2 class="size-3 shrink-0 text-muted-foreground" />{/if}
							<span class="truncate font-semibold">{column.name}</span><span class="truncate text-muted-foreground">{column.type}</span>
							{#if editor.sort?.column === column.name}{#if editor.sort.direction === 'asc'}<ArrowUp class="size-3 shrink-0 text-primary" />{:else}<ArrowDown class="size-3 shrink-0 text-primary" />{/if}{/if}
						</button>
						<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (ARIA adjustable separators are focusable and support arrow keys.) -->
						<div class="resizer" role="separator" tabindex="0" aria-label={`Resize ${column.name}`}
							aria-orientation="vertical" aria-valuenow={Math.round(width(column))} aria-valuemin={64}
							onpointerdown={(event) => startResize(event, column)}
							onkeydown={(event) => {
								if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
								event.preventDefault();
								widths.current = { ...widths.current, [column.name]: Math.max(64, width(column) + (event.key === 'ArrowLeft' ? -16 : 16)) };
							}}></div>
					</div>
				{/each}
			</div>
			{#each rows as row, r (row.key)}
				<div class="grid-row" role="row" aria-rowindex={r + 2} style:grid-template-columns={template}>
					<div class="gutter" role="rowheader">
						<Checkbox aria-label={`Select row ${rowOffset + r + 1}`} tabindex={-1} checked={editor.isRowSelected(row.key)} disabled={disabled || !editor.tableEditable}
							onCheckedChange={() => editor.toggleRowSelection(row)} class="size-3.5" />
						<span>{rowOffset + r + 1}</span>
					</div>
					{#each table.columns as column, c (column.name)}
						{@const value = editor.getValue(row, column.name)}
						{@const active = focus?.r === r && focus?.c === c}
						{@const selected = !!selection && r >= selection.r1 && r <= selection.r2 && c >= selection.c1 && c <= selection.c2}
						<div id={`${id}-${r}-${c}`} class="cell" class:focused={active} class:selected role="gridcell" tabindex="-1" aria-colindex={c + 2}
							aria-selected={selected} aria-readonly={!editor.tableEditable || !writable(column)} data-cell={`${r}:${c}`}
							onmousedown={(event) => { if (event.button !== 0) return; event.preventDefault(); viewport.focus(); setFocus(r, c, event.shiftKey); }}
							ondblclick={() => startEdit(r, c)}>
							{#if column.foreignKey}
								<button class="h-full min-w-0 flex-1 truncate text-left hover:underline" class:text-muted-foreground={value == null}
									tabindex={active ? 0 : -1} disabled={disabled} aria-label={`Choose reference for ${column.name}, row ${r + 1}`}
									title={displayValue(value, column)} onmousedown={(event) => event.stopPropagation()} onclick={() => startEdit(r, c)}>
									{displayValue(value, column)}
								</button>
								<Button variant="ghost" size="icon-xs" class="ml-1 shrink-0" tabindex={active ? 0 : -1}
									aria-label={`Go to referenced record for ${column.name}, row ${r + 1}`}
									disabled={disabled || column.foreignKey.columns.some((name) => editor.getValue(row, name) == null)}
									onmousedown={(event) => event.stopPropagation()} onclick={() => void editor.followReference(row, column)}><ArrowUpRight /></Button>
							{:else}
								<span class="truncate" class:text-muted-foreground={value == null} class:italic={value == null} title={displayValue(value, column)}>{value === undefined && !writable(column) ? 'GENERATED' : displayValue(value, column)}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
		{#if !rows.length}
			{#if editor.loading}
				<div role="status" class="space-y-3 p-3">
					<span class="sr-only">Loading rows…</span>
					<Skeleton class="h-6 w-full" /><Skeleton class="h-6 w-3/4" /><Skeleton class="h-6 w-1/2" />
				</div>
			{:else}<p class="p-12 text-center text-sm text-muted-foreground">No rows match this view.</p>{/if}
		{/if}
	</div>
</div>

{#if editing}
	{@const edit = editing}
	{#key edit}
		<CellEditor {...edit} onclose={closeEditor} onapply={(values) => editor.updateRows([{ row: edit.row, values }])} />
	{/key}
{/if}

<style>
	.grid-header, .grid-row { display: grid; height: 35px; }
	.grid-header { position: sticky; top: 0; z-index: 20; background: var(--card); }
	.header-cell { position: relative; min-width: 0; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
	.gutter { position: sticky; left: 0; z-index: 10; display: flex; align-items: center; gap: 8px; padding: 0 8px; background: var(--card); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); color: var(--muted-foreground); font: 10px var(--font-mono); }
	.gutter span { margin-left: auto; }
	.resizer { position: absolute; top: 0; right: -3px; z-index: 2; width: 6px; height: 100%; cursor: col-resize; }
	.resizer:hover, .resizer:focus-visible { background: var(--ring); outline: none; }
	.cell { position: relative; display: flex; align-items: center; min-width: 0; padding: 0 8px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); font-size: 12px; white-space: nowrap; overflow: hidden; cursor: default; }
	.cell.selected { background: var(--muted); }
	.cell.focused { outline: 1px solid var(--ring); outline-offset: -1px; z-index: 1; }
</style>
