<script lang="ts">
	import { Switch } from 'bits-ui';
	import { Search } from '@lucide/svelte';
	import { changeSchema } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { qualify, REALTIME_SCHEMA, realtimeSql } from '#lib/ddl.js';
	import type { Table } from '#lib/types.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let schema = $state(editor.activeSchema || 'public');
	let query = $state('');
	let removing = $state(false);
	let applying = $state(false);
	let applyError = $state('');
	const REMOVE_SQL = `drop schema ${REALTIME_SCHEMA} cascade;`;
	const tables = $derived(editor.tables.filter((table) => table.kind === 'table'));
	const enabled = $derived(tables.filter((table) => table.realtime));
	const shown = $derived(tables.filter((table) => table.schema === schema && table.name.toLowerCase().includes(query.trim().toLowerCase())));

	let error = $state('');
	let toggling = $state(false);

	/** Applied at once: adding or dropping one trigger is cheap and easily undone. */
	async function toggle(table: Table) {
		toggling = true;
		error = '';
		try {
			await changeSchema({ connection: editor.connection, sql: realtimeSql(qualify(table.schema, table.name), !table.realtime) });
			await editor.reload(); // Table flags drive the editors' realtime subscription.
		} catch (cause) { error = message(cause); }
		finally { toggling = false; }
	}

	async function remove() {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql: REMOVE_SQL });
			removing = false;
			await editor.reload(); // Table flags drive the editors' realtime subscription.
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

<div class="space-y-3 p-4">
	<div class="max-w-3xl space-y-1 text-xs text-muted-foreground">
		<p>Realtime tables refresh open table editors as soon as they change, instead of every 5 seconds. Each has a statement-level trigger
			calling <code>{REALTIME_SCHEMA}.notify_change()</code>, which sends a <code>NOTIFY</code> with the table and operation.</p>
		<p>{#if editor.realtimeInstalled}The <code>{REALTIME_SCHEMA}</code> schema is installed; {enabled.length} table{enabled.length === 1 ? '' : 's'} use{enabled.length === 1 ? 's' : ''} it.
			{:else}Nothing is installed yet; enabling a table creates the <code>{REALTIME_SCHEMA}</code> schema and its function.{/if}</p>
	</div>
	{#if editor.realtimeIssue}<p role="status" class="max-w-3xl text-xs text-amber-300">{editor.realtimeIssue}</p>{/if}
	{#if error}<p role="alert" class="text-xs break-words text-destructive">{error}</p>{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" bind:value={schema} allowDeselect={false}>
			<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
			<Select.Content>{#each editor.schemas as option}<Select.Item value={option} label={option} />{/each}</Select.Content>
		</Select.Root>
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search tables" placeholder="Search tables" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		{#if editor.realtimeInstalled}
			<Button variant="outline" size="sm" class="ml-auto" onclick={() => { removing = true; applyError = ''; }}>Remove {REALTIME_SCHEMA}</Button>
		{/if}
	</div>
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Table</th><th class="p-3 text-right font-medium">Realtime</th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as table (table.name)}
					<tr>
						<td class="p-3 font-mono">{table.name}</td>
						<td class="p-3 text-right">
							<!-- Controlled: the switch only moves once the change is applied. -->
							<Switch.Root bind:checked={() => table.realtime, () => void toggle(table)} disabled={editor.navigationBlocked || toggling}
								aria-label={`${table.realtime ? 'Disable' : 'Enable'} realtime on ${table.name}`}
								class="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors data-[state=checked]:bg-primary focus-visible:outline-2 focus-visible:outline-ring">
								<Switch.Thumb class="block size-4 rounded-full bg-foreground transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
							</Switch.Root>
						</td>
					</tr>
				{:else}
					<tr><td colspan="2" class="p-3 text-muted-foreground">{query ? 'No matching tables.' : 'No tables in this schema.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={() => removing, (open) => { if (!applying) removing = open; }}>
	<Dialog.Content class="gap-4">
		<Dialog.Header>
			<Dialog.Title>Remove {REALTIME_SCHEMA}</Dialog.Title>
			<Dialog.Description class="text-xs">{enabled.length
				? `Drops the shared function and with it realtime on ${enabled.map((table) => `${table.schema}.${table.name}`).join(', ')}.`
				: 'Drops the shared function; no table uses it.'}</Dialog.Description>
		</Dialog.Header>
		<pre class="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{REMOVE_SQL}</pre>
		{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => removing = false}>Cancel</Button>
			<Button variant="destructive" size="sm" disabled={applying} onclick={remove}>{applying ? 'Applying…' : 'Apply'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
