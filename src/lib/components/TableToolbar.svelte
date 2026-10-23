<script lang="ts">
	import {
		ArrowDown,
		ArrowUp,
		ArrowUpDown,
		Check,
		Plus,
		RotateCw,
		Search,
		Trash2,
		X
	} from 'lucide-svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { formatNumber } from '#lib/format.js';

	let { tab = $bindable('data') }: { tab: 'data' | 'definition' } = $props();

	function onSearch(event: Event) {
		void editor.setSearch((event.currentTarget as HTMLInputElement).value);
	}
</script>

<header class="shrink-0 border-b border-line bg-bg">
	<div class="flex h-11 items-center gap-3 px-3.5">
		<div class="flex min-w-0 items-baseline gap-1.5">
			<span class="font-mono text-xs text-muted">{editor.table.schema}</span>
			<span class="text-xs text-faint">/</span>
			<span class="truncate font-mono text-[13px] font-medium">{editor.table.name}</span>
		</div>

		<span class="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
			{formatNumber(editor.rowCount)} rows
		</span>
		{#if editor.draftCount > 0}
			<span class="rounded border border-accent/30 bg-accent/8 px-1.5 py-0.5 font-mono text-[10px] text-accent">
				+{editor.draftCount} new
			</span>
		{/if}

		<div class="ml-2 flex h-7 items-center gap-0.5 rounded-md border border-line bg-surface p-0.5">
			<button
				onclick={() => (tab = 'data')}
				class={[
					'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
					tab === 'data' ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg'
				]}
			>
				Data
			</button>
			<button
				onclick={() => (tab = 'definition')}
				class={[
					'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
					tab === 'definition' ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg'
				]}
			>
				Definition
			</button>
		</div>

		<div class="ml-auto flex items-center gap-1.5">
			{#if editor.hasChanges}
				<span class="mr-1 font-mono text-[10px] text-warn">
					{editor.dirtyCount} unsaved
				</span>
				<button
					onclick={() => void editor.revert()}
					class="h-7 rounded-md border border-line px-2.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
				>
					Revert
				</button>
				<button
					onclick={() => void editor.save()}
					disabled={editor.saving}
					class="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-[#08130d] transition-colors hover:bg-accent-dim disabled:opacity-60"
				>
					<Check size={12} strokeWidth={2.5} />
					{editor.saving ? 'Saving…' : 'Save'}
				</button>
			{:else if editor.savedAt}
				<span class="mr-1 flex items-center gap-1 font-mono text-[10px] text-accent">
					<Check size={11} strokeWidth={2.5} /> saved
				</span>
			{/if}
		</div>
	</div>

	<div class="flex h-9 items-center gap-1.5 px-2.5">
		<div class="relative w-64">
			<Search
				size={12}
				class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint"
			/>
			<input
				value={editor.search}
				oninput={onSearch}
				placeholder="Filter rows…"
				spellcheck={false}
				class="h-7 w-full rounded-md border border-line bg-surface pr-6 pl-7 text-[12px] outline-none placeholder:text-faint focus:border-line-strong focus:bg-elevated"
			/>
			{#if editor.search}
				<button
					onclick={() => void editor.setSearch('')}
					class="absolute top-1/2 right-1.5 grid size-4 -translate-y-1/2 place-items-center rounded text-faint hover:text-fg"
					aria-label="Clear filter"
				>
					<X size={11} />
				</button>
			{/if}
		</div>

		<div class="flex h-7 items-center rounded-md border border-line bg-surface">
			<select
				value={editor.sort?.column ?? ''}
				onchange={(event) => void editor.setSort(event.currentTarget.value)}
				class="h-full appearance-none rounded-l-md bg-transparent pr-1 pl-2 text-[12px] text-muted outline-none hover:text-fg"
				title="Sort by column"
			>
				<option value="">Sort</option>
				{#each editor.table.columns as column (column.name)}
					<option value={column.name}>{column.name}</option>
				{/each}
			</select>
			<button
				onclick={() => void editor.toggleSortDirection()}
				disabled={!editor.sort}
				title="Toggle sort direction"
				class="grid h-full w-6 place-items-center border-l border-line text-muted transition-colors hover:text-fg disabled:opacity-35"
			>
				{#if editor.sort?.direction === 'asc'}
					<ArrowUp size={11} />
				{:else if editor.sort?.direction === 'desc'}
					<ArrowDown size={11} />
				{:else}
					<ArrowUpDown size={11} />
				{/if}
			</button>
		</div>

		<div class="ml-auto flex items-center gap-1.5">
			<button
				onclick={() => editor.insertRow()}
				class="flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
			>
				<Plus size={12} />
				Insert row
			</button>

			{#if editor.selectedCount > 0}
				<button
					onclick={() => void editor.deleteSelected()}
					class="flex h-7 items-center gap-1.5 rounded-md border border-danger/35 bg-danger/8 px-2.5 text-[12px] text-danger transition-colors hover:bg-danger/15"
				>
					<Trash2 size={12} />
					Delete {editor.selectedCount}
				</button>
			{/if}

			<button
				onclick={() => void editor.reload()}
				title="Refresh"
				class="grid size-7 place-items-center rounded-md border border-line bg-surface text-muted transition-colors hover:bg-hover hover:text-fg"
			>
				<RotateCw size={12} />
			</button>
		</div>
	</div>
</header>
