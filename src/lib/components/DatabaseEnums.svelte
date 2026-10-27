<script lang="ts">
	import { onMount } from 'svelte';
	import { Pencil, Plus, Search, Trash2, X } from '@lucide/svelte';
	import { changeSchema, enums } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { EnumType } from '#lib/database.js';
	import { enumChanges, literal, qualify } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	/** A value row in the form: `original` null means new (appended). */
	type Value = { original: string | null; value: string };
	const id = $props.id();
	let list = $state.raw<EnumType[] | null>(null);
	let error = $state('');
	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	/** The type being edited, or 'new'; null when no form is open. */
	let editing = $state.raw<EnumType | 'new' | null>(null);
	let name = $state('');
	let values = $state<Value[]>([]);
	let dropping = $state.raw<EnumType | null>(null);
	let applying = $state(false);
	let applyError = $state('');
	const schemas = $derived([...new Set([...editor.schemas, ...(list ?? []).map((type) => type.schema)])].sort());
	const shown = $derived((list ?? []).filter((type) => type.schema === schema
		&& `${type.name} ${type.values.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));
	const sql = $derived(dropping ? `drop type ${qualify(dropping.schema, dropping.name)};`
		: editing === 'new' ? `create type ${qualify(schema, name.trim())} as enum (${values.filter((row) => row.value).map((row) => literal(row.value)).join(', ')});`
		: editing ? enumChanges(editing.schema, editing.name, values, name.trim()) : '');

	async function load() {
		try { list = await fresh(enums({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function open(type: EnumType | 'new') {
		editing = type;
		name = type === 'new' ? '' : type.name;
		values = type === 'new' ? [{ original: null, value: '' }] : type.values.map((value) => ({ original: value, value }));
		applyError = '';
	}

	async function apply() {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			editing = dropping = null;
			await load();
			void editor.reload(); // Cell editors list enum values from the table metadata.
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" bind:value={schema} allowDeselect={false}>
			<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
			<Select.Content>{#each schemas as option}<Select.Item value={option} label={option} />{/each}</Select.Content>
		</Select.Root>
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search enums" placeholder="Search enums" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		<Button size="sm" class="ml-auto" onclick={() => open('new')}><Plus />Create enum</Button>
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Name</th><th class="p-3 font-medium">Values</th><th class="p-3 text-right font-medium">Columns</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as type (type.name)}
					<tr class="align-top">
						<td class="p-3 font-mono">{type.name}</td>
						<td class="p-3"><div class="flex flex-wrap gap-1">
							{#each type.values as value}<span class="rounded border bg-muted/40 px-1.5 py-0.5 font-mono">{value === '' ? '""' : value}</span>{/each}
						</div></td>
						<td class="p-3 text-right font-mono">{type.columns}</td>
						<td class="p-2 text-right whitespace-nowrap">
							<Button variant="ghost" size="icon-sm" aria-label={`Edit enum ${type.name}`} onclick={() => open(type)}><Pencil /></Button>
							<Button variant="ghost" size="icon-sm" aria-label={`Drop enum ${type.name}`}
								onclick={() => { dropping = type; applyError = ''; }}><Trash2 /></Button>
						</td>
					</tr>
				{:else}
					<tr><td colspan="4" class="p-3 text-muted-foreground">{list === null ? 'Loading…' : list.length && query ? 'No matching enums.' : 'No enums in this schema.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={() => !!editing, (open) => { if (!open && !applying) editing = null; }}>
	<Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4">
		<Dialog.Header>
			<Dialog.Title>{editing === 'new' ? 'Create enum' : 'Edit enum'}</Dialog.Title>
			<Dialog.Description class="text-xs">{editing === 'new' ? `In schema ${schema}.`
				: 'Rename the type or its values, or add values (appended at the end). PostgreSQL cannot remove values from an enum.'}</Dialog.Description>
		</Dialog.Header>
		<form id={`${id}-form`} class="min-h-0 space-y-4 overflow-y-auto p-1" onsubmit={(event) => { event.preventDefault(); if (sql) void apply(); }}>
			<div class="space-y-2">
				<Label for={`${id}-name`} class="text-xs">Name</Label>
				<Input id={`${id}-name`} bind:value={name} spellcheck={false} autocomplete="off" class="font-mono text-xs" />
			</div>
			<div class="space-y-2">
				<p class="text-xs font-medium">Values</p>
				{#each values as row, i (i)}
					<div class="flex items-center gap-2">
						<Input bind:value={row.value} aria-label={`Value ${i + 1}`} spellcheck={false} autocomplete="off" class="font-mono text-xs" />
						{#if row.original === null}
							<Button variant="ghost" size="icon-sm" aria-label={`Remove new value ${i + 1}`} onclick={() => values.splice(i, 1)}><X /></Button>
						{:else}
							<span class="w-8 shrink-0"></span>
						{/if}
					</div>
				{/each}
				<Button type="button" variant="outline" size="xs" onclick={() => values.push({ original: null, value: '' })}><Plus />Add value</Button>
			</div>
			{#if sql}<pre class="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{sql}</pre>{/if}
			{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		</form>
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => editing = null}>Cancel</Button>
			<Button type="submit" form={`${id}-form`} size="sm" disabled={applying || !sql || !name.trim()}>{applying ? 'Applying…' : 'Apply'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={() => !!dropping, (open) => { if (!open && !applying) dropping = null; }}>
	<Dialog.Content class="gap-4">
		<Dialog.Header>
			<Dialog.Title>Drop enum <code>{dropping?.name}</code></Dialog.Title>
			<Dialog.Description class="text-xs">{dropping?.columns
				? `${dropping.columns === 1 ? '1 column still uses' : `${dropping.columns} columns still use`} it, so PostgreSQL will refuse; change those columns first.`
				: 'No column uses this type.'}</Dialog.Description>
		</Dialog.Header>
		<pre class="rounded-md bg-muted p-2 font-mono text-xs">{sql}</pre>
		{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => dropping = null}>Cancel</Button>
			<Button variant="destructive" size="sm" disabled={applying} onclick={apply}>{applying ? 'Dropping…' : 'Drop'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
