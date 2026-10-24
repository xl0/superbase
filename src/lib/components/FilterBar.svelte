<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Combobox } from 'bits-ui';
	import { Search, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { FILTER_OPERATORS, MAX_FILTERS, type FilterOperator, type RowFilter } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	const id = $props.id();
	let bar: HTMLDivElement;
	let query = $state('');
	let columnOpen = $state(false);
	let operatorOpen = $state(false);
	let valueInput = $state<HTMLInputElement | null>(null);
	let comparisonTrigger = $state<HTMLButtonElement | null>(null);
	let draft = $state<{ column: string; operator: FilterOperator | ''; value: string } | null>(null);
	let editingIndex = $state<number | null>(null);
	let tableKey = untrack(() => editor.tableKey);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	const columns = $derived(editor.table.columns.filter((column) => column.name.toLowerCase().includes(query.toLowerCase())));
	const operators = Object.entries(FILTER_OPERATORS) as [FilterOperator, (typeof FILTER_OPERATORS)[FilterOperator]][];
	const placeholder = $derived(editor.filters.length ? 'Add more filters…' : `Filter by ${editor.table.columns.slice(0, 3).map((column) => column.name).join(', ')}…`);

	$effect(() => {
		if (editor.tableKey !== tableKey || editor.navigationBlocked) {
			tableKey = editor.tableKey;
			draft = null;
			editingIndex = null;
			query = '';
			columnOpen = false;
		}
	});

	function begin(column: string, index: number | null = null) {
		if (blocked || (index === null && editor.filters.length >= MAX_FILTERS)) return;
		editingIndex = index;
		draft = index === null ? { column, operator: '', value: '' } : { ...editor.filters[index] };
		query = '';
		columnOpen = false;
		operatorOpen = false;
	}

	function cancel() { draft = null; editingIndex = null; operatorOpen = false; }

	function apply() {
		if (blocked || !draft?.operator) return;
		const next: RowFilter = { ...draft, operator: draft.operator };
		if (!FILTER_OPERATORS[next.operator].needsValue) next.value = '';
		const filters = [...editor.filters];
		if (editingIndex === null) filters.push(next);
		else filters[editingIndex] = next;
		cancel();
		void editor.setFilters(filters);
	}

	async function chooseOperator(value: string) {
		if (!draft || !Object.hasOwn(FILTER_OPERATORS, value)) return;
		draft.operator = value as FilterOperator;
		if (!FILTER_OPERATORS[draft.operator].needsValue) { apply(); return; }
		await tick();
		valueInput?.focus();
	}
</script>

{#snippet editChip()}
	{#if draft}
		<Popover.Root open onOpenChange={(open) => { if (!open) cancel(); }}>
			<Popover.Trigger>
				{#snippet child({ props })}
					{#if draft}
					<Button {...props} variant="outline" size="sm" class="max-w-72 justify-start gap-2 font-mono text-xs" aria-label={`Edit filter for ${draft.column}`}>
						<span class="truncate">{draft.column}</span>
						{#if draft.operator}<span>{FILTER_OPERATORS[draft.operator].sql}</span><span class="truncate">{draft.value}</span>{/if}
					</Button>
					{/if}
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="start" class="w-80 max-w-[calc(100vw-24px)] gap-3"
				onOpenAutoFocus={async (event) => {
					event.preventDefault(); await tick();
					if (draft?.operator === '') {
						comparisonTrigger?.focus();
						operatorOpen = true;
					} else if (valueInput) valueInput.focus();
					else comparisonTrigger?.focus();
				}}
				onCloseAutoFocus={(event) => { event.preventDefault(); bar?.focus(); }}>
				<form class="space-y-3" onsubmit={(event) => { event.preventDefault(); apply(); }}>
					<div class="space-y-1">
						<p class="break-all font-mono text-xs font-medium">{draft.column}</p>
						<p class="text-[11px] text-muted-foreground">{editor.table.columns.find((column) => column.name === draft?.column)?.type}</p>
					</div>
					<Select.Root type="single" value={draft.operator} bind:open={operatorOpen} allowDeselect={false} disabled={blocked} onValueChange={chooseOperator}>
						<Select.Trigger bind:ref={comparisonTrigger} aria-label="Filter comparison" class="w-full text-xs">{draft.operator ? FILTER_OPERATORS[draft.operator].label : 'Choose comparison…'}</Select.Trigger>
						<Select.Content class="max-h-80 w-80 max-w-[calc(100vw-24px)]">
							{#each ['Comparison', 'Pattern matching', 'Null checks'] as group}
								<Select.Group>
									<Select.GroupHeading class="text-[10px] uppercase">{group}</Select.GroupHeading>
									{#each operators.filter(([, option]) => option.group === group) as [operator, option]}
										<Select.Item value={operator} label={option.label} class="text-xs">
											<span class="flex-1">{option.label}</span><code class="text-muted-foreground">{option.sql}</code>
										</Select.Item>
									{/each}
								</Select.Group>
							{/each}
						</Select.Content>
					</Select.Root>
					{#if draft.operator && FILTER_OPERATORS[draft.operator].needsValue}
						<div class="space-y-2">
							<Label for={`${id}-value`} class="text-xs">Value</Label>
							<Input id={`${id}-value`} bind:ref={valueInput} bind:value={draft.value} disabled={blocked} maxlength={10000}
								autocomplete="off" spellcheck={false} placeholder="Enter a value" class="font-mono text-xs" />
							<p class="text-[11px] text-muted-foreground">
								{#if draft.operator === 'like' || draft.operator === 'ilike'}Use % for any characters and _ for one character.
								{:else}Values use the column’s PostgreSQL type. Empty text is distinct from NULL.{/if}
							</p>
						</div>
					{/if}
					<div class="flex justify-end gap-2 border-t pt-3">
						<Button type="button" variant="outline" size="sm" onclick={cancel}>Cancel</Button>
						<Button type="submit" size="sm" disabled={blocked || !draft.operator}>Apply filter</Button>
					</div>
				</form>
			</Popover.Content>
		</Popover.Root>
	{/if}
{/snippet}

<div bind:this={bar} role="group" aria-label="Row filters" tabindex="-1" class="flex min-h-8 min-w-0 flex-1 basis-64 flex-wrap items-center gap-2 outline-none">
	<Search class="size-4 shrink-0 text-muted-foreground" />
	{#each editor.filters as filter, i}
		{#if i > 0}<span class="text-[10px] text-muted-foreground">AND</span>{/if}
		{#if draft && editingIndex === i}
			{@render editChip()}
		{:else}
			<div class="flex max-w-full items-center rounded-md border bg-muted/30">
				<button class="flex min-w-0 items-center gap-2 rounded-l-md px-2 py-1.5 text-xs hover:bg-muted focus-visible:outline-1 focus-visible:outline-ring disabled:opacity-50"
					disabled={blocked} onclick={() => begin(filter.column, i)} aria-label={`Edit filter ${i + 1}: ${filter.column}`}>
					<span class="max-w-40 truncate font-mono">{filter.column}</span><span>{FILTER_OPERATORS[filter.operator].sql}</span>
					{#if FILTER_OPERATORS[filter.operator].needsValue}<span class="max-w-48 truncate font-mono" title={filter.value}>{filter.value === '' ? '""' : filter.value}</span>{/if}
				</button>
				<Button variant="ghost" size="icon-xs" class="mr-1 shrink-0" disabled={blocked} aria-label={`Remove filter ${i + 1}: ${filter.column}`}
					onclick={() => { cancel(); void editor.setFilters(editor.filters.filter((_, index) => index !== i)); }}><X /></Button>
			</div>
		{/if}
	{/each}
	{#if draft && editingIndex === null}
		{#if editor.filters.length}<span class="text-[10px] text-muted-foreground">AND</span>{/if}
		{@render editChip()}
	{/if}
	{#if !draft}
		<Combobox.Root type="single" value="" inputValue={query} bind:open={columnOpen} disabled={blocked || editor.filters.length >= MAX_FILTERS}
			allowDeselect={false} onValueChange={(column) => { if (column) begin(column); }}>
			<Combobox.Input aria-label="Add filter" {placeholder} maxlength={1024} autocomplete="off" spellcheck={false}
				onfocus={() => { if (!blocked && editor.filters.length < MAX_FILTERS) columnOpen = true; }}
				oninput={(event) => query = event.currentTarget.value}>
				{#snippet child({ props })}<Input {...props} class="h-8 min-w-36 flex-1 basis-52 border-transparent bg-transparent text-xs shadow-none dark:bg-transparent" />{/snippet}
			</Combobox.Input>
			<Combobox.Portal>
				<Combobox.Content align="start" sideOffset={4} class="z-50 max-h-72 w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
					{#each columns as column (column.name)}
						<Combobox.Item value={column.name} label={column.name} class="flex cursor-default items-center gap-3 rounded-sm px-2 py-2 text-xs outline-none data-highlighted:bg-accent">
							<span class="min-w-0 flex-1 truncate">{column.name}</span><span class="max-w-40 truncate text-muted-foreground">{column.type}</span>
						</Combobox.Item>
					{:else}<p role="status" class="p-3 text-xs text-muted-foreground">No matching columns.</p>{/each}
				</Combobox.Content>
			</Combobox.Portal>
		</Combobox.Root>
	{/if}
	{#if editor.hasFilters}
		<Button variant="ghost" size="xs" class="ml-auto" disabled={blocked} onclick={() => { cancel(); void editor.clearFilters(); }}>Remove filters</Button>
	{/if}
	{#if editor.filters.length >= MAX_FILTERS}<span class="text-xs text-muted-foreground">Maximum {MAX_FILTERS} filters.</span>{/if}
</div>
