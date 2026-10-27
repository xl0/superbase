<script lang="ts">
	import { Activity, Gauge, List, ListTree, Network, Puzzle, ShieldCheck, SlidersHorizontal, Users } from '@lucide/svelte';
	import { page } from '$app/state';
	import { databaseHref } from '#lib/links.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import DatabaseActivity from './DatabaseActivity.svelte';
	import DatabaseConfig from './DatabaseConfig.svelte';
	import DatabaseEnums from './DatabaseEnums.svelte';
	import DatabaseExtensions from './DatabaseExtensions.svelte';
	import DatabaseIndexes from './DatabaseIndexes.svelte';
	import DatabasePolicies from './DatabasePolicies.svelte';
	import DatabaseRoles from './DatabaseRoles.svelte';
	import DatabasePerformance from './DatabasePerformance.svelte';
	import SchemaDiagram from './SchemaDiagram.svelte';
	import Workspace from './Workspace.svelte';

	const SECTIONS = {
		schema: { label: 'Schema', icon: Network },
		indexes: { label: 'Indexes', icon: ListTree },
		enums: { label: 'Enums', icon: List },
		policies: { label: 'Policies', icon: ShieldCheck },
		roles: { label: 'Roles', icon: Users },
		performance: { label: 'Performance', icon: Gauge },
		activity: { label: 'Activity', icon: Activity },
		extensions: { label: 'Extensions', icon: Puzzle },
		config: { label: 'Configuration', icon: SlidersHorizontal }
	};
	type Section = keyof typeof SECTIONS;
	const section = $derived<Section>(page.params.section && page.params.section in SECTIONS ? page.params.section as Section : 'schema');
</script>

<Workspace label="Database">
	{#snippet sidebar()}
		<p class="px-3 pt-3 pb-2 text-[10px] tracking-wider text-muted-foreground uppercase">Database</p>
		<nav aria-label="Database sections" class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
			{#each Object.entries(SECTIONS) as [key, { label, icon: Icon }] (key)}
				{@const active = section === key}
				<Button variant="ghost" size="sm" aria-current={active ? 'page' : undefined} href={databaseHref(page.params.db!, key)}
					class={['mb-0.5 w-full justify-start gap-2 px-2 text-xs font-normal hover:bg-muted', active ? 'bg-muted text-foreground' : 'text-muted-foreground']}>
					<Icon class="size-3.5" /><span class="truncate">{label}</span>
				</Button>
			{/each}
		</nav>
	{/snippet}
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if section === 'schema'}<SchemaDiagram />
		{:else if section === 'indexes'}<DatabaseIndexes />
		{:else if section === 'enums'}<DatabaseEnums />
		{:else if section === 'policies'}<DatabasePolicies />
		{:else if section === 'roles'}<DatabaseRoles />
		{:else if section === 'performance'}<DatabasePerformance />
		{:else if section === 'activity'}<DatabaseActivity />
		{:else if section === 'extensions'}<DatabaseExtensions />
		{:else}<DatabaseConfig />{/if}
	</div>
</Workspace>
