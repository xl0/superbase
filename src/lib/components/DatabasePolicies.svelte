<script lang="ts">
	import { onMount } from 'svelte';
	import { Search } from '@lucide/svelte';
	import { policies } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Policies } from '#lib/database.js';
	import { fresh, message } from '#lib/utils.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import TableAccess from './TableAccess.svelte';

	let data = $state.raw<Policies | null>(null);
	let error = $state('');
	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	const schemas = $derived([...new Set([...editor.schemas, ...(data?.tables ?? []).map((table) => table.schema)])].sort());
	const tables = $derived((data?.tables ?? []).filter((table) => table.schema === schema
		&& `${table.table} ${table.policies.map((policy) => policy.name).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));

	async function load() {
		try { data = await fresh(policies({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);
</script>

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" bind:value={schema} allowDeselect={false}>
			<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
			<Select.Content>{#each schemas as option}<Select.Item value={option} label={option} />{/each}</Select.Content>
		</Select.Root>
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search tables and policies" placeholder="Search tables and policies" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	{#each tables as table (table.table)}
		<section class="rounded-md border" aria-label={`Policies of ${table.table}`}>
			<TableAccess {table} roles={data!.roles} role={data!.role} bypass={data!.bypass}
				onapplied={async () => { await load(); void editor.reload(); }} />
		</section>
	{:else}
		<p class="text-xs text-muted-foreground">{data === null ? 'Loading…' : query ? 'No matching tables.' : 'No tables in this schema.'}</p>
	{/each}
</div>
