<script lang="ts">
	import { ChevronDown, Database, Search, Table2 } from 'lucide-svelte';
	import { editor } from '#lib/state/editor.svelte.js';

	let tableSearch = $state('');

	const tables = $derived(
		editor.schemaTables.filter((table) =>
			table.name.toLowerCase().includes(tableSearch.trim().toLowerCase())
		)
	);

	function compact(value: number): string {
		if (value < 1000) return String(value);
		return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	}
</script>

<aside class="flex h-full w-58 shrink-0 flex-col border-r border-line bg-panel">
	<header class="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
		<div class="grid size-6 place-items-center rounded-md bg-accent/12 text-accent">
			<Database size={13} strokeWidth={2.2} />
		</div>
		<span class="text-[13px] font-semibold tracking-tight">superbase</span>
		<span class="ml-auto rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-faint">
			local
		</span>
	</header>

	<div class="shrink-0 space-y-2.5 p-2.5 pb-2">
		<div class="relative">
			<Search
				size={13}
				class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
			/>
			<input
				bind:value={tableSearch}
				placeholder="Search tables"
				spellcheck={false}
				class="h-8 w-full rounded-md border border-line bg-surface pr-2 pl-7.5 text-xs outline-none placeholder:text-faint focus:border-line-strong focus:bg-elevated"
			/>
		</div>

		<div>
			<div class="mb-1 px-1 text-[10px] font-medium tracking-[0.08em] text-faint uppercase">
				Schema
			</div>
			<div class="relative">
				<select
					value={editor.activeSchema}
					onchange={(event) => editor.setSchema(event.currentTarget.value)}
					class="h-8 w-full appearance-none rounded-md border border-line bg-surface pr-7 pl-2.5 font-mono text-xs outline-none focus:border-line-strong focus:bg-elevated"
				>
					{#each editor.schemas as schema (schema)}
						<option value={schema}>{schema}</option>
					{/each}
				</select>
				<ChevronDown
					size={13}
					class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-faint"
				/>
			</div>
		</div>
	</div>

	<div class="flex min-h-0 flex-1 flex-col">
		<div class="flex items-center gap-1.5 px-3 pt-1 pb-1.5">
			<span class="text-[10px] font-medium tracking-[0.08em] text-faint uppercase">Tables</span>
			<span class="font-mono text-[10px] text-faint">{tables.length}</span>
		</div>

		<nav class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
			{#each tables as table (table.name)}
				{@const active =
					editor.activeSchema === table.schema && editor.activeTableName === table.name}
				<button
					onclick={() => editor.selectTable(table.schema, table.name)}
					class={[
						'group flex h-7.5 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors',
						active ? 'bg-elevated text-fg' : 'text-muted hover:bg-hover/70 hover:text-fg'
					]}
				>
					<Table2 size={13} class={active ? 'text-accent' : 'text-faint'} />
					<span class="truncate font-mono text-[11.5px]">{table.name}</span>
					<span class="ml-auto font-mono text-[10px] text-faint">{compact(table.rowCount)}</span>
				</button>
			{:else}
				<p class="px-2 py-3 text-xs text-faint">No tables match “{tableSearch}”.</p>
			{/each}
		</nav>
	</div>

	<footer class="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2.5 text-[11px]">
		<span class="size-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--color-accent)]"></span>
		<span class="text-muted">PostgreSQL 16.4</span>
		<span class="ml-auto font-mono text-[10px] text-faint">postgres</span>
	</footer>
</aside>
