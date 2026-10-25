<script lang="ts">
	import type { Table } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import DatabaseConfig from './DatabaseConfig.svelte';
	import DatabaseExtensions from './DatabaseExtensions.svelte';
	import DatabaseIndexes from './DatabaseIndexes.svelte';
	import DatabasePerformance from './DatabasePerformance.svelte';
	import SchemaDiagram from './SchemaDiagram.svelte';

	let { onopen }: { onopen: (table: Table) => void } = $props();
	const TABS = { schema: 'Schema', indexes: 'Indexes', performance: 'Performance', extensions: 'Extensions', config: 'Configuration' };
	let tab = $state<keyof typeof TABS>('schema');
</script>

<section aria-label="Database" class="flex h-full min-h-0 flex-col">
	<nav aria-label="Database sections" class="flex shrink-0 gap-1 border-b px-3 py-2">
		{#each Object.entries(TABS) as [key, label]}
			<Button size="sm" variant={tab === key ? 'secondary' : 'ghost'} aria-pressed={tab === key} onclick={() => tab = key as keyof typeof TABS}>{label}</Button>
		{/each}
	</nav>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if tab === 'schema'}<SchemaDiagram {onopen} />{:else if tab === 'indexes'}<DatabaseIndexes />{:else if tab === 'performance'}<DatabasePerformance />{:else if tab === 'extensions'}<DatabaseExtensions />{:else}<DatabaseConfig />{/if}
	</div>
</section>
