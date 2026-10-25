<script lang="ts">
	import { Gauge, ListTree, Network, Puzzle, SlidersHorizontal } from '@lucide/svelte';
	import type { Table } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import DatabaseConfig from './DatabaseConfig.svelte';
	import DatabaseExtensions from './DatabaseExtensions.svelte';
	import DatabaseIndexes from './DatabaseIndexes.svelte';
	import DatabasePerformance from './DatabasePerformance.svelte';
	import SchemaDiagram from './SchemaDiagram.svelte';
	import Workspace from './Workspace.svelte';

	let { onopen }: { onopen: (table: Table) => void } = $props();
	const SECTIONS = {
		schema: { label: 'Schema', icon: Network },
		indexes: { label: 'Indexes', icon: ListTree },
		performance: { label: 'Performance', icon: Gauge },
		extensions: { label: 'Extensions', icon: Puzzle },
		config: { label: 'Configuration', icon: SlidersHorizontal }
	};
	let section = $state<keyof typeof SECTIONS>('schema');
</script>

<Workspace label="Database">
	{#snippet sidebar()}
		<p class="px-3 pt-3 pb-2 text-[10px] tracking-wider text-muted-foreground uppercase">Database</p>
		<nav aria-label="Database sections" class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
			{#each Object.entries(SECTIONS) as [key, { label, icon: Icon }] (key)}
				{@const active = section === key}
				<Button variant="ghost" size="sm" aria-current={active ? 'page' : undefined} onclick={() => section = key as keyof typeof SECTIONS}
					class={['mb-0.5 w-full justify-start gap-2 px-2 text-xs font-normal hover:bg-muted', active ? 'bg-muted text-foreground' : 'text-muted-foreground']}>
					<Icon class="size-3.5" /><span class="truncate">{label}</span>
				</Button>
			{/each}
		</nav>
	{/snippet}
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if section === 'schema'}<SchemaDiagram {onopen} />
		{:else if section === 'indexes'}<DatabaseIndexes />
		{:else if section === 'performance'}<DatabasePerformance />
		{:else if section === 'extensions'}<DatabaseExtensions />
		{:else}<DatabaseConfig />{/if}
	</div>
</Workspace>
