<script lang="ts">
	import { untrack } from 'svelte';
	import { ArrowDown, ArrowUp, KeyRound, Link2 } from 'lucide-svelte';
	import { PersistedState } from 'runed';
	import { editor } from '#lib/state/editor.svelte.js';
	import { displayValue } from '#lib/format.js';
	import type { Column, Row, Table } from '#lib/types.js';

	let { table, rows, rowOffset }: { table: Table; rows: Row[]; rowOffset: number } = $props();

	const ROW_HEIGHT = 30;
	const HEADER_HEIGHT = 42;
	const ROWNUM_WIDTH = 56;

	type Cell = { r: number; c: number };

	let viewport: HTMLDivElement;

	let focus = $state<Cell | null>(null);
	let anchor = $state<Cell | null>(null);
	let head = $state<Cell | null>(null);
	let editing = $state<Cell | null>(null);
	let editValue = $state('');

	const widths = new PersistedState<Record<string, number>>(
		untrack(() => `superbase:widths:${table.schema}.${table.name}`),
		untrack(() =>
			Object.fromEntries(table.columns.map((column) => [column.name, widthFor(column)]))
		)
	);

	const template = $derived(
		`${ROWNUM_WIDTH}px ${table.columns.map((column) => `${widths.current[column.name] ?? widthFor(column)}px`).join(' ')}`
	);

	function widthFor(column: Column): number {
		switch (column.kind) {
			case 'boolean':
				return 84;
			case 'number':
				return 96;
			case 'timestamp':
				return 178;
			case 'json':
				return 250;
			case 'array':
				return 140;
			case 'uuid':
				return 288;
			case 'enum':
				return 104;
			default:
				if (column.name === 'email') return 244;
				if (column.name === 'body') return 340;
				if (column.name === 'full_name' || column.name === 'title') return 208;
				return 160;
		}
	}

	function currentValue(row: Row, column: Column): unknown {
		return editor.hasEdit(row.__key, column.name)
			? editor.getEdit(row.__key, column.name)
			: row[column.name];
	}

	function rawString(value: unknown, column: Column): string {
		if (value === null || value === undefined) return '';
		if (column.kind === 'json') return JSON.stringify(value);
		if (column.kind === 'array') return Array.isArray(value) ? value.join(', ') : String(value);
		return String(value);
	}

	function coerce(input: string, column: Column): unknown {
		if (input === '__NULL__') return null;
		switch (column.kind) {
			case 'number': {
				const trimmed = input.trim();
				if (!trimmed) return null;
				const number = Number(trimmed);
				return Number.isNaN(number) ? input : number;
			}
			case 'boolean':
				return input === 'true';
			case 'json': {
				try {
					return JSON.parse(input);
				} catch {
					return input;
				}
			}
			case 'array': {
				const trimmed = input.trim();
				if (!trimmed) return null;
				return trimmed
					.replace(/^\{|\}$/g, '')
					.split(',')
					.map((part) => part.trim())
					.filter(Boolean);
			}
			default:
				return input;
		}
	}

	function clamp(value: number, min: number, max: number) {
		return Math.min(Math.max(value, min), max);
	}

	function lastRow() {
		return Math.max(0, rows.length - 1);
	}

	function lastCol() {
		return Math.max(0, table.columns.length - 1);
	}

	function isFocused(r: number, c: number) {
		return focus?.r === r && focus?.c === c;
	}

	function selection(): { r1: number; r2: number; c1: number; c2: number } | null {
		if (!anchor || !head) return null;
		return {
			r1: Math.min(anchor.r, head.r),
			r2: Math.max(anchor.r, head.r),
			c1: Math.min(anchor.c, head.c),
			c2: Math.max(anchor.c, head.c)
		};
	}

	function inSelection(r: number, c: number) {
		const box = selection();
		return !!box && r >= box.r1 && r <= box.r2 && c >= box.c1 && c <= box.c2;
	}

	function scrollToCell(r: number, c: number) {
		if (!viewport) return;
		const top = r * ROW_HEIGHT;
		const bottom = top + ROW_HEIGHT;
		const viewTop = viewport.scrollTop + HEADER_HEIGHT;
		const viewBottom = viewport.scrollTop + viewport.clientHeight;
		if (top < viewTop) {
			viewport.scrollTop = top - HEADER_HEIGHT;
		} else if (bottom > viewBottom) {
			viewport.scrollTop = bottom - viewport.clientHeight;
		}

		const left =
			ROWNUM_WIDTH +
			table.columns.slice(0, c).reduce((sum, column) => sum + (widths.current[column.name] ?? 160), 0);
		const width = widths.current[table.columns[c].name] ?? 160;
		const viewLeft = viewport.scrollLeft + ROWNUM_WIDTH;
		const viewRight = viewport.scrollLeft + viewport.clientWidth;
		if (left < viewLeft) {
			viewport.scrollLeft = left - ROWNUM_WIDTH;
		} else if (left + width > viewRight) {
			viewport.scrollLeft = left + width - viewport.clientWidth + 16;
		}
	}

	function setFocus(r: number, c: number, extend = false) {
		focus = { r, c };
		if (extend) {
			head = { r, c };
		} else {
			anchor = { r, c };
			head = { r, c };
		}
		scrollToCell(r, c);
	}

	function move(r: number, c: number, extend = false, wrap = false) {
		let row = clamp(r, 0, lastRow());
		let col = clamp(c, 0, lastCol());
		if (wrap) {
			if (c < 0) {
				row = clamp(r - 1, 0, lastRow());
				col = lastCol();
			} else if (c > lastCol()) {
				row = clamp(r + 1, 0, lastRow());
				col = 0;
			}
		}
		setFocus(row, col, extend);
	}

	function startEdit(r: number, c: number, initial?: string) {
		const row = rows[r];
		const column = table.columns[c];
		if (!row || !column) return;
		editing = { r, c };
		editValue = initial ?? rawString(currentValue(row, column), column);
	}

	function commitEdit(direction?: 'down' | 'right' | 'left') {
		if (!editing) return;
		const { r, c } = editing;
		const row = rows[r];
		const column = table.columns[c];
		editing = null;
		if (!row || !column) return;

		const value = coerce(editValue, column);
		const original = currentValue(row, column);
		if (JSON.stringify(value) !== JSON.stringify(original)) {
			editor.editCell(row.__key, column.name, value);
		}

		if (direction === 'down') move(r + 1, c);
		if (direction === 'right') move(r, c + 1, false, true);
		if (direction === 'left') move(r, c - 1, false, true);
		viewport?.focus();
	}

	function cancelEdit() {
		editing = null;
		viewport?.focus();
	}

	function onEditKeydown(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Enter') {
			event.preventDefault();
			commitEdit('down');
		} else if (event.key === 'Tab') {
			event.preventDefault();
			commitEdit(event.shiftKey ? 'left' : 'right');
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancelEdit();
		}
	}

	function onCellMouseDown(event: MouseEvent, r: number, c: number) {
		if (event.button !== 0) return;
		if (editing) commitEdit();
		viewport?.focus();
		if (event.shiftKey && anchor) {
			focus = { r, c };
			head = { r, c };
		} else {
			setFocus(r, c);
		}
	}

	function selectAll() {
		if (rows.length === 0) return;
		anchor = { r: 0, c: 0 };
		head = { r: lastRow(), c: lastCol() };
		focus = { r: 0, c: 0 };
	}

	function copyText(): string {
		const box = selection();
		if (!box) return '';
		const lines: string[] = [];
		for (let r = box.r1; r <= box.r2; r++) {
			const row = rows[r];
			const cells: string[] = [];
			for (let c = box.c1; c <= box.c2; c++) {
				cells.push(rawString(currentValue(row, table.columns[c]), table.columns[c]));
			}
			lines.push(cells.join('\t'));
		}
		return lines.join('\n');
	}

	function onCopy(event: ClipboardEvent) {
		if (editing) return;
		const box = selection();
		if (!box) return;
		event.preventDefault();
		event.clipboardData?.setData('text/plain', copyText());
	}

	function onPaste(event: ClipboardEvent) {
		if (editing || !focus) return;
		const text = event.clipboardData?.getData('text/plain');
		if (!text) return;
		event.preventDefault();
		const grid = text
			.replace(/\r/g, '')
			.replace(/\n$/, '')
			.split('\n')
			.map((line) => line.split('\t'));

		grid.forEach((cells, dr) => {
			cells.forEach((raw, dc) => {
				const r = focus!.r + dr;
				const c = focus!.c + dc;
				const row = rows[r];
				const column = table.columns[c];
				if (!row || !column) return;
				editor.editCell(row.__key, column.name, raw === '' ? null : coerce(raw, column));
			});
		});
	}

	function clearSelection() {
		const box = selection();
		if (!box) return;
		for (let r = box.r1; r <= box.r2; r++) {
			for (let c = box.c1; c <= box.c2; c++) {
				editor.editCell(rows[r].__key, table.columns[c].name, null);
			}
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (editing) return;
		const current = focus ?? { r: 0, c: 0 };

		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			selectAll();
			return;
		}

		switch (event.key) {
			case 'ArrowUp':
				event.preventDefault();
				move(current.r - 1, current.c, event.shiftKey);
				return;
			case 'ArrowDown':
				event.preventDefault();
				move(current.r + 1, current.c, event.shiftKey);
				return;
			case 'ArrowLeft':
				event.preventDefault();
				move(current.r, current.c - 1, event.shiftKey);
				return;
			case 'ArrowRight':
				event.preventDefault();
				move(current.r, current.c + 1, event.shiftKey);
				return;
			case 'Tab':
				event.preventDefault();
				move(current.r, current.c + (event.shiftKey ? -1 : 1), false, true);
				return;
			case 'Enter':
			case 'F2':
				event.preventDefault();
				startEdit(current.r, current.c);
				return;
			case 'Escape':
				focus = null;
				anchor = null;
				head = null;
				return;
			case 'Delete':
			case 'Backspace':
				event.preventDefault();
				clearSelection();
				return;
			case 'Home':
				event.preventDefault();
				move(event.metaKey || event.ctrlKey ? 0 : current.r, 0);
				return;
			case 'End':
				event.preventDefault();
				move(event.metaKey || event.ctrlKey ? lastRow() : current.r, lastCol());
				return;
			case 'PageUp':
				event.preventDefault();
				move(current.r - 20, current.c);
				return;
			case 'PageDown':
				event.preventDefault();
				move(current.r + 20, current.c);
				return;
		}

		if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
			event.preventDefault();
			startEdit(current.r, current.c, event.key);
		}
	}

	function startResize(event: PointerEvent, column: Column) {
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const startWidth = widths.current[column.name] ?? widthFor(column);
		const onMove = (moveEvent: PointerEvent) => {
			const width = Math.max(64, Math.round(startWidth + moveEvent.clientX - startX));
			widths.current = { ...widths.current, [column.name]: width };
		};
		const onUp = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	function focusInput(node: HTMLElement) {
		node.focus();
		if (node instanceof HTMLInputElement) node.select();
	}

	$effect(() => {
		if (focus && focus.r >= rows.length) {
			focus = null;
			anchor = null;
			head = null;
			editing = null;
		}
	});
</script>

<div class="relative h-full min-h-0 bg-surface">
	<div
		bind:this={viewport}
		tabindex="0"
		role="grid"
		aria-rowcount={rows.length}
		aria-colcount={table.columns.length}
		class="h-full overflow-auto outline-none"
		onkeydown={onKeydown}
		oncopy={onCopy}
		onpaste={onPaste}
	>
		<div class="w-max min-w-full">
			<div class="grid-header" role="row" style="grid-template-columns: {template}">
				<div class="rownum header-rownum">#</div>
				{#each table.columns as column, c (column.name)}
					<div class="header-cell">
						<button
							class="flex h-full w-full min-w-0 items-center gap-1.5 px-2.5 text-left"
							onclick={() => editor.toggleSort(column.name)}
							title={`${column.name} · ${column.type}`}
						>
							<span class="truncate font-mono text-[11px] text-fg">{column.name}</span>
							{#if column.primaryKey}
								<KeyRound size={10} class="shrink-0 text-faint" />
							{:else if column.foreignKey}
								<Link2 size={10} class="shrink-0 text-faint" />
							{/if}
							{#if editor.sort?.column === column.name}
								{#if editor.sort.direction === 'asc'}
									<ArrowUp size={10} class="shrink-0 text-accent" />
								{:else}
									<ArrowDown size={10} class="shrink-0 text-accent" />
								{/if}
							{/if}
							<span class="ml-auto shrink-0 font-mono text-[9.5px] text-faint">{column.type}</span>
						</button>
						<div
							class="resizer"
							role="separator"
							aria-orientation="vertical"
							onpointerdown={(event) => startResize(event, column)}
						></div>
					</div>
				{/each}
			</div>

			{#each rows as row, r (row.__key)}
				<div class="grid-row" role="row" style="grid-template-columns: {template}">
					<div class="rownum">{rowOffset + r + 1}</div>
					{#each table.columns as column, c (column.name)}
						{@const edited = editor.hasEdit(row.__key, column.name)}
						{@const value = edited ? editor.getEdit(row.__key, column.name) : row[column.name]}
						{@const active = isFocused(r, c)}
						<div
							class="cell"
							tabindex="-1"
							class:focused={active}
							class:selected={inSelection(r, c)}
							class:dirty={edited}
							data-cell={`${r}:${c}`}
							role="gridcell"
							onmousedown={(event) => onCellMouseDown(event, r, c)}
							ondblclick={() => startEdit(r, c)}
						>
							{#if editing?.r === r && editing?.c === c}
								{#if column.kind === 'enum'}
									<select
										value={editValue}
										class="cell-input"
										use:focusInput
										onmousedown={(event) => event.stopPropagation()}
										onkeydown={onEditKeydown}
										onblur={() => commitEdit()}
										onchange={(event) => {
											editValue = event.currentTarget.value;
											commitEdit('down');
										}}
									>
										{#each column.enumValues ?? [] as option (option)}
											<option value={option}>{option}</option>
										{/each}
										{#if column.nullable}
											<option value="__NULL__">NULL</option>
										{/if}
									</select>
								{:else if column.kind === 'boolean'}
									<select
										value={editValue}
										class="cell-input"
										use:focusInput
										onmousedown={(event) => event.stopPropagation()}
										onkeydown={onEditKeydown}
										onblur={() => commitEdit()}
										onchange={(event) => {
											editValue = event.currentTarget.value;
											commitEdit('down');
										}}
									>
										<option value="true">true</option>
										<option value="false">false</option>
										{#if column.nullable}
											<option value="__NULL__">NULL</option>
										{/if}
									</select>
								{:else}
									<input
										bind:value={editValue}
										class="cell-input"
										spellcheck={false}
										use:focusInput
										onmousedown={(event) => event.stopPropagation()}
										onkeydown={onEditKeydown}
										onblur={() => commitEdit()}
									/>
								{/if}
							{:else if value === null || value === undefined}
								<span class="text-[11.5px] text-faint italic">NULL</span>
							{:else if column.kind === 'boolean'}
								<span class={value ? 'text-accent' : 'text-faint'}>{value ? 'true' : 'false'}</span>
							{:else if column.kind === 'number'}
								<span class="tabular-nums text-info/90">{displayValue(value, column)}</span>
							{:else if column.kind === 'json' || column.kind === 'array'}
								<span class="truncate font-mono text-[11px] text-muted">{displayValue(value, column)}</span>
							{:else if column.kind === 'timestamp'}
								<span class="font-mono text-[11px] text-muted">{displayValue(value, column)}</span>
							{:else if column.kind === 'uuid'}
								<span class="truncate font-mono text-[11px]">{displayValue(value, column)}</span>
							{:else}
								<span class="truncate">{displayValue(value, column)}</span>
							{/if}
							{#if edited}
								<span class="dirty-dot"></span>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</div>

	{#if rows.length === 0}
		<div class="pointer-events-none absolute inset-0 grid place-items-center pt-10">
			<div class="text-center">
				<p class="text-xs text-muted">No rows</p>
				<p class="mt-1 text-[11px] text-faint">Insert a row to get started.</p>
			</div>
		</div>
	{/if}
</div>

<style>
	.grid-header {
		position: sticky;
		top: 0;
		z-index: 20;
		display: grid;
		height: 42px;
		background: var(--color-panel);
		border-bottom: 1px solid var(--color-line-strong);
	}

	.header-cell {
		position: relative;
		display: flex;
		min-width: 0;
		align-items: stretch;
		border-right: 1px solid var(--color-line);
		user-select: none;
	}

	.header-rownum {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding-right: 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-faint);
		border-right: 1px solid var(--color-line);
	}

	.resizer {
		position: absolute;
		top: 0;
		right: -3px;
		z-index: 2;
		height: 100%;
		width: 6px;
		cursor: col-resize;
	}

	.resizer:hover {
		background: color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.grid-row {
		display: grid;
		height: 30px;
		background: var(--color-surface);
	}

	.grid-row:hover {
		background: color-mix(in srgb, var(--color-hover) 45%, var(--color-surface));
	}

	.rownum {
		position: sticky;
		left: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding-right: 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-faint);
		background: var(--color-surface);
		border-right: 1px solid var(--color-line);
		border-bottom: 1px solid color-mix(in srgb, var(--color-line) 60%, transparent);
		user-select: none;
	}

	.grid-row:hover .rownum {
		background: color-mix(in srgb, var(--color-hover) 45%, var(--color-surface));
	}

	.header-rownum {
		position: sticky;
		left: 0;
		z-index: 21;
		background: var(--color-panel);
		border-bottom: none;
	}

	.cell {
		position: relative;
		display: flex;
		min-width: 0;
		align-items: center;
		padding: 0 8px;
		border-right: 1px solid color-mix(in srgb, var(--color-line) 60%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--color-line) 60%, transparent);
		white-space: nowrap;
		overflow: hidden;
		cursor: default;
	}

	.cell.selected {
		background: color-mix(in srgb, var(--color-accent) 9%, transparent);
	}

	.cell.focused {
		outline: 1px solid var(--color-accent);
		outline-offset: -1px;
		z-index: 1;
	}

	.cell.dirty {
		background: color-mix(in srgb, var(--color-warn) 7%, transparent);
	}

	.cell.dirty.selected {
		background: color-mix(in srgb, var(--color-warn) 12%, transparent);
	}

	.dirty-dot {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 4px;
		height: 4px;
		border-radius: 999px;
		background: var(--color-warn);
	}

	.cell-input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		padding: 0 7px;
		border: none;
		background: var(--color-elevated);
		font-size: 12px;
		outline: 1px solid var(--color-accent);
		outline-offset: -1px;
	}
</style>
