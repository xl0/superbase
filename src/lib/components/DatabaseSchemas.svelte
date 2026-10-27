<script lang="ts">
	import { onMount } from 'svelte';
	import { Pencil, Plus, Search, Trash2 } from '@lucide/svelte';
	import { page } from '$app/state';
	import { schemas } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { SchemaInfo } from '#lib/database.js';
	import { ident } from '#lib/ddl.js';
	import { tablesHref } from '#lib/links.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import SqlDialog from './SqlDialog.svelte';

	const id = $props.id();
	let list = $state.raw<SchemaInfo[] | null>(null);
	let error = $state('');
	let query = $state('');
	/** The schema being edited, or 'new'; null when no form is open. */
	let editing = $state.raw<SchemaInfo | 'new' | null>(null);
	let name = $state('');
	let owner = $state('');
	let dropping = $state.raw<SchemaInfo | null>(null);
	let cascade = $state(false);
	let confirmation = $state('');
	const shown = $derived((list ?? []).filter((schema) => schema.name.toLowerCase().includes(query.trim().toLowerCase())));
	// Owners may be pg_* roles (public belongs to pg_database_owner), which editor.roles omits.
	const owners = $derived([...new Set([owner, ...editor.roles])].filter(Boolean).sort());
	const editSql = $derived.by(() => {
		const next = name.trim();
		if (!next || !editing) return '';
		if (editing === 'new') return `create schema ${ident(next)}${owner !== editor.role ? ` authorization ${ident(owner)}` : ''};`;
		return [
			owner !== editing.owner ? `alter schema ${ident(editing.name)} owner to ${ident(owner)};` : '',
			next !== editing.name ? `alter schema ${ident(editing.name)} rename to ${ident(next)};` : ''
		].filter(Boolean).join('\n');
	});

	async function load() {
		try { list = await fresh(schemas({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function open(schema: SchemaInfo | 'new') {
		editing = schema;
		name = schema === 'new' ? '' : schema.name;
		owner = schema === 'new' ? editor.role : schema.owner;
	}

	async function applied() {
		await load();
		void editor.reload(); // The table editor lists schemas from its metadata.
	}
</script>

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search schemas" placeholder="Search schemas" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		<Button size="sm" class="ml-auto" onclick={() => open('new')}><Plus />Create schema</Button>
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Name</th><th class="p-3 font-medium">Owner</th>
				<th class="p-3 text-right font-medium">Tables</th><th class="p-3 text-right font-medium">Functions</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as schema (schema.name)}
					<tr>
						<td class="p-3 font-mono">
							{#if editor.schemas.includes(schema.name)}
								<a class="hover:underline" title="Open in the table editor"
									href={tablesHref(page.params.db!, { schema: schema.name, table: '', filters: [], sort: [], page: 0, reference: null })}>{schema.name}</a>
							{:else}{schema.name}{/if}
						</td>
						<td class="p-3 font-mono text-muted-foreground">{schema.owner}</td>
						<td class="p-3 text-right font-mono">{schema.tables}</td>
						<td class="p-3 text-right font-mono">{schema.functions}</td>
						<td class="p-2 text-right whitespace-nowrap">
							<Button variant="ghost" size="icon-sm" aria-label={`Edit schema ${schema.name}`} onclick={() => open(schema)}><Pencil /></Button>
							<Button variant="ghost" size="icon-sm" aria-label={`Drop schema ${schema.name}`}
								onclick={() => { dropping = schema; cascade = false; confirmation = ''; }}><Trash2 /></Button>
						</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="p-3 text-muted-foreground">{list === null ? 'Loading…' : 'No matching schemas.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<SqlDialog open={!!editing} title={editing === 'new' ? 'Create schema' : 'Edit schema'} sql={editSql}
	description={editing === 'new' ? 'The owner may create and drop anything in it.' : 'Renaming breaks code and search_path entries that name the schema.'}
	onclose={() => editing = null} onapplied={applied}>
	<div class="space-y-2">
		<Label for={`${id}-name`} class="text-xs">Name</Label>
		<Input id={`${id}-name`} bind:value={name} spellcheck={false} autocomplete="off" class="font-mono text-xs" />
	</div>
	<div class="space-y-2">
		<Label for={`${id}-owner`} class="text-xs">Owner</Label>
		<Select.Root type="single" bind:value={owner} allowDeselect={false}>
			<Select.Trigger id={`${id}-owner`} size="sm" class="w-full font-mono text-xs">{owner}</Select.Trigger>
			<Select.Content>{#each owners as role}<Select.Item value={role} label={role} />{/each}</Select.Content>
		</Select.Root>
	</div>
</SqlDialog>

<SqlDialog open={!!dropping} title="Drop schema" subject={dropping?.name} destructive action="Drop"
	description={dropping?.tables || dropping?.functions
		? `It holds ${dropping.tables} table${dropping.tables === 1 ? '' : 's'} and ${dropping.functions} function${dropping.functions === 1 ? '' : 's'}, and may hold types or sequences. PostgreSQL refuses to drop a schema that isn't empty unless you cascade.`
		: 'No tables or functions; PostgreSQL refuses if it holds other objects, unless you cascade.'}
	sql={dropping ? `drop schema ${ident(dropping.name)}${cascade ? ' cascade' : ''};` : ''} disabled={cascade && confirmation !== dropping?.name}
	onclose={() => dropping = null} onapplied={applied}>
	<div class="flex items-center gap-2">
		<Checkbox id={`${id}-cascade`} bind:checked={cascade} />
		<Label for={`${id}-cascade`} class="text-xs">Cascade: also drop everything in it, and objects elsewhere that depend on it</Label>
	</div>
	{#if cascade}
		<div class="space-y-2">
			<Label for={`${id}-confirm`} class="break-all text-xs">Type {dropping?.name} to confirm</Label>
			<Input id={`${id}-confirm`} bind:value={confirmation} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
		</div>
	{/if}
</SqlDialog>
