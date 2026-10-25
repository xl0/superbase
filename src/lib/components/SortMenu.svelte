<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { ArrowDown, ArrowUp, ListOrdered, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Sort } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let open = $state(false);
	let draft = $state<Sort[]>([]);
	let picked = $state('');
	let tableKey = untrack(() => editor.tableKey);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	const available = $derived(editor.table.columns.filter((column) => !draft.some((rule) => rule.column === column.name)));
	const changed = $derived(JSON.stringify(draft) !== JSON.stringify(editor.sort));

	$effect(() => {
		if (editor.tableKey !== tableKey || blocked) {
			tableKey = editor.tableKey;
			open = false;
		}
	});

	function changeOpen(value: boolean) {
		if (value && blocked) return;
		if (value) { draft = editor.sort.map((rule) => ({ ...rule })); picked = ''; }
		open = value;
	}

	async function add(column: string) {
		if (blocked || !column || !available.some((entry) => entry.name === column)) return;
		draft = [...draft, { column, direction: 'asc' }];
		await tick();
		picked = '';
	}

	function move(index: number, offset: number) {
		const target = index + offset;
		if (target < 0 || target >= draft.length) return;
		[draft[index], draft[target]] = [draft[target], draft[index]];
	}

	function apply() {
		if (blocked || !changed) return;
		open = false;
		void editor.setSort(draft);
	}
</script>

<Popover.Root {open} onOpenChange={changeOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant={editor.sort.length ? 'secondary' : 'outline'} size="sm" class="text-xs" disabled={blocked}
				aria-label={editor.sort.length ? `Sorted by ${editor.sort.length} ${editor.sort.length === 1 ? 'rule' : 'rules'}` : 'Sort'}>
				<ListOrdered />{editor.sort.length ? `Sort (${editor.sort.length})` : 'Sort'}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-[32rem] max-w-[calc(100vw-24px)] gap-0 p-0" aria-label="Sort rules">
		{#if draft.length}
			<ol class="max-h-72 space-y-1 overflow-y-auto p-2">
				{#each draft as rule, i (rule.column)}
					<li class="flex items-center gap-2 rounded-md p-2">
						<div class="flex shrink-0">
							<Button variant="ghost" size="icon-xs" disabled={blocked || i === 0} aria-label={`Move ${rule.column} up`} onclick={() => move(i, -1)}><ArrowUp /></Button>
							<Button variant="ghost" size="icon-xs" disabled={blocked || i === draft.length - 1} aria-label={`Move ${rule.column} down`} onclick={() => move(i, 1)}><ArrowDown /></Button>
						</div>
						<span class="shrink-0 text-xs text-muted-foreground">{i === 0 ? 'sort by' : 'then by'}</span>
						<span class="min-w-0 flex-1 truncate font-mono text-xs" title={rule.column}>{rule.column}</span>
						<Button variant="outline" size="sm" class="shrink-0 text-xs" disabled={blocked}
							aria-label={`Sort direction for ${rule.column}: ${rule.direction === 'asc' ? 'ascending' : 'descending'}`}
							onclick={() => rule.direction = rule.direction === 'asc' ? 'desc' : 'asc'}>
							{#if rule.direction === 'asc'}<ArrowUp />Ascending{:else}<ArrowDown />Descending{/if}
						</Button>
						<Button variant="ghost" size="icon-xs" class="shrink-0" disabled={blocked} aria-label={`Remove sort for ${rule.column}`}
							onclick={() => draft = draft.filter((_, index) => index !== i)}><X /></Button>
					</li>
				{/each}
			</ol>
		{:else}<p class="p-4 text-xs text-muted-foreground">No sorts applied to this view.</p>{/if}
		<div class="flex flex-wrap items-center gap-2 border-t p-3">
			<Select.Root type="single" bind:value={picked} onValueChange={add} allowDeselect={false} disabled={blocked || !available.length}>
				<Select.Trigger aria-label="Add sort column" size="sm" class="min-w-0 flex-1 text-xs">
					{draft.length ? 'Pick another column to sort by' : 'Pick a column to sort by'}
				</Select.Trigger>
				<Select.Content class="max-h-72">
					{#each available as column (column.name)}
						<Select.Item value={column.name} label={column.name} class="text-xs">
							<span class="max-w-56 truncate">{column.name}</span><span class="max-w-40 truncate text-muted-foreground">{column.type}</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Button variant="outline" size="sm" class="text-xs" disabled={blocked || !changed} onclick={apply}>Apply sorting</Button>
		</div>
	</Popover.Content>
</Popover.Root>
