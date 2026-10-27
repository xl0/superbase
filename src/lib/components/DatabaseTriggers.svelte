<script lang="ts">
	import { onMount } from 'svelte';
	import { Switch } from 'bits-ui';
	import { ChevronRight, Search, Trash2 } from '@lucide/svelte';
	import { changeSchema, triggers } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Trigger } from '#lib/database.js';
	import { ident, qualify } from '#lib/ddl.js';
	import { highlightSql } from '#lib/sql-highlight.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let list = $state.raw<Trigger[] | null>(null);
	let error = $state('');
	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	/** `table.name` of the expanded row. */
	let expanded = $state<string | null>(null);
	let toggling = $state(false);
	let dropping = $state.raw<Trigger | null>(null);
	let applying = $state(false);
	let applyError = $state('');
	const schemas = $derived([...new Set([...editor.schemas, ...(list ?? []).map((trigger) => trigger.schema)])].sort());
	const shown = $derived((list ?? []).filter((trigger) => trigger.schema === schema
		&& `${trigger.name} ${trigger.table} ${trigger.function}`.toLowerCase().includes(query.trim().toLowerCase())));
	const key = (trigger: Trigger) => `${trigger.table}.${trigger.name}`;

	async function load() {
		try { list = await fresh(triggers({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	/** Applied at once, like realtime: disabling a trigger is cheap and easily undone. */
	async function toggle(trigger: Trigger) {
		toggling = true;
		error = '';
		try {
			await changeSchema({ connection: editor.connection,
				sql: `alter table ${qualify(trigger.schema, trigger.table)} ${trigger.enabled ? 'disable' : 'enable'} trigger ${ident(trigger.name)};` });
			await load();
		} catch (cause) { error = message(cause); }
		finally { toggling = false; }
	}

	async function drop() {
		if (!dropping) return;
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql: `drop trigger ${ident(dropping.name)} on ${qualify(dropping.schema, dropping.table)};` });
			dropping = null;
			await load();
			void editor.reload(); // Dropping superbase_realtime turns realtime off for that table.
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

{#snippet code(text: string)}
	<pre class="sql-code max-h-96 overflow-auto rounded-md border bg-background p-3 font-mono text-xs">{#each highlightSql(text) as span}<span class={span.class}>{span.text}</span>{/each}</pre>
{/snippet}

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" bind:value={schema} allowDeselect={false}>
			<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
			<Select.Content>{#each schemas as option}<Select.Item value={option} label={option} />{/each}</Select.Content>
		</Select.Root>
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search triggers" placeholder="Search triggers" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		<p class="ml-auto text-xs text-muted-foreground">Create triggers in the SQL editor.</p>
	</div>
	{#if error}<p role="alert" class="text-xs break-words text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Name</th><th class="p-3 font-medium">Table</th><th class="p-3 font-medium">Fires</th>
				<th class="p-3 font-medium">Function</th><th class="p-3 text-right font-medium">Enabled</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as trigger (key(trigger))}
					{@const open = expanded === key(trigger)}
					<tr>
						<td class="p-3 font-mono">
							<button class="inline-flex items-center gap-1 hover:underline" aria-expanded={open}
								onclick={() => expanded = open ? null : key(trigger)}>
								<ChevronRight class={['size-3.5 transition-transform', open && 'rotate-90']} />{trigger.name}
							</button>
						</td>
						<td class="p-3 font-mono">{trigger.table}</td>
						<td class="p-3">{trigger.timing} {trigger.events.join(', ')} · {trigger.forEachRow ? 'row' : 'statement'}</td>
						<td class="p-3 font-mono text-muted-foreground">{trigger.function}</td>
						<td class="p-3 text-right">
							<Switch.Root bind:checked={() => trigger.enabled, () => void toggle(trigger)} disabled={toggling}
								aria-label={`${trigger.enabled ? 'Disable' : 'Enable'} trigger ${trigger.name}`}
								class="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors data-[state=checked]:bg-primary focus-visible:outline-2 focus-visible:outline-ring">
								<Switch.Thumb class="block size-4 rounded-full bg-foreground transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
							</Switch.Root>
						</td>
						<td class="p-2 text-right">
							<Button variant="ghost" size="icon-sm" aria-label={`Drop trigger ${trigger.name}`}
								onclick={() => { dropping = trigger; applyError = ''; }}><Trash2 /></Button>
						</td>
					</tr>
					{#if open}
						<tr><td colspan="6" class="space-y-2 bg-muted/20 p-3">
							{@render code(`${trigger.definition};`)}
							{@render code(trigger.functionDefinition)}
						</td></tr>
					{/if}
				{:else}
					<tr><td colspan="6" class="p-3 text-muted-foreground">{list === null ? 'Loading…' : query ? 'No matching triggers.' : 'No triggers in this schema.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={() => !!dropping, (open) => { if (!open && !applying) dropping = null; }}>
	<Dialog.Content class="gap-4">
		<Dialog.Header>
			<Dialog.Title>Drop trigger <code>{dropping?.name}</code></Dialog.Title>
			<Dialog.Description class="text-xs">The function {dropping?.function} stays.</Dialog.Description>
		</Dialog.Header>
		<pre class="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{dropping ? `drop trigger ${ident(dropping.name)} on ${qualify(dropping.schema, dropping.table)};` : ''}</pre>
		{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => dropping = null}>Cancel</Button>
			<Button variant="destructive" size="sm" disabled={applying} onclick={drop}>{applying ? 'Dropping…' : 'Drop'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
