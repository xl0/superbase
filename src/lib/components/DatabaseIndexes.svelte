<script lang="ts">
	import { onMount } from 'svelte';
	import { Search, Trash2 } from '@lucide/svelte';
	import { changeSchema, indexes } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { DatabaseIndex } from '#lib/database.js';
	import { qualify } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let list = $state.raw<DatabaseIndex[]>([]);
	let error = $state('');
	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	let dropping = $state<DatabaseIndex | null>(null);
	let applying = $state(false);
	let applyError = $state('');
	const schemas = $derived([...new Set(list.map((index) => index.schema))]);
	const shown = $derived(list.filter((index) => index.schema === schema
		&& `${index.table} ${index.name} ${index.columns.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));
	const sql = $derived(dropping ? `drop index ${qualify(dropping.schema, dropping.name)};` : '');

	async function load() {
		try { list = await fresh(indexes({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	async function drop() {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			dropping = null;
			await load();
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" bind:value={schema} allowDeselect={false}>
			<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
			<Select.Content>{#each schemas as name}<Select.Item value={name} label={name} />{/each}</Select.Content>
		</Select.Root>
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search indexes" placeholder="Search indexes" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		<p class="text-xs text-muted-foreground">Create indexes from a table's ⋮ menu → Indexes.</p>
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Table</th><th class="p-3 font-medium">Columns</th><th class="p-3 font-medium">Name</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as index (`${index.schema}.${index.name}`)}
					<tr class="align-top">
						<td class="p-3 font-mono">{index.table}</td>
						<td class="p-3 font-mono">{index.columns.join(', ')}</td>
						<td class="p-3">
							<details><summary class="cursor-pointer font-mono">{index.name}</summary>
								<pre class="mt-2 whitespace-pre-wrap break-all font-mono text-muted-foreground">{index.definition}</pre></details>
						</td>
						<td class="p-2 text-right">
							<Button variant="ghost" size="icon-sm" disabled={!!index.constraint} aria-label={`Drop index ${index.name}`}
								title={index.constraint ? `Owned by constraint ${index.constraint}` : 'Drop index'}
								onclick={() => { dropping = index; applyError = ''; }}><Trash2 /></Button>
						</td>
					</tr>
				{:else}
					<tr><td colspan="4" class="p-3 text-muted-foreground">{list.length ? 'No matching indexes.' : 'Loading…'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={() => !!dropping, (open) => { if (!open && !applying) dropping = null; }}>
	<Dialog.Content class="gap-4">
		<Dialog.Header>
			<Dialog.Title>Drop index <code>{dropping?.name}</code></Dialog.Title>
			<Dialog.Description class="text-xs">Table data is not affected; queries using it may get slower.</Dialog.Description>
		</Dialog.Header>
		<pre class="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{sql}</pre>
		{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => dropping = null}>Cancel</Button>
			<Button variant="destructive" size="sm" disabled={applying} onclick={drop}>{applying ? 'Dropping…' : 'Drop'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
