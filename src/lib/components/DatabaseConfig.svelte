<script lang="ts">
	import { onMount } from 'svelte';
	import { settings } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { DatabaseSetting } from '#lib/database.js';
	import { ident, literal } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import SqlDialog from './SqlDialog.svelte';

	const id = $props.id();
	let data = $state.raw<{ database: string; role: string; settings: DatabaseSetting[] } | null>(null);
	let error = $state('');
	type Scope = 'database' | 'role' | 'roleInDatabase';
	let pending = $state<{ setting: DatabaseSetting; scope: Scope; value: string } | null>(null);
	const scopes = $derived<Record<Scope, string>>({
		database: `Database ${data?.database}`, role: `Role ${data?.role}`, roleInDatabase: `Role ${data?.role} in ${data?.database}`
	});
	const current = (setting: DatabaseSetting, scope: Scope) =>
		(scope === 'database' ? setting.databaseDefault : scope === 'role' ? setting.roleDefault : setting.roleInDatabase) ?? '';
	const sql = $derived.by(() => {
		if (!pending || !data) return '';
		const target = pending.scope === 'database' ? `database ${ident(data.database)}`
			: `role ${ident(data.role)}${pending.scope === 'roleInDatabase' ? ` in database ${ident(data.database)}` : ''}`;
		const value = pending.value.trim();
		// search_path is a list: its value is written as SQL (e.g. "$user", public), not one string.
		return `alter ${target} ${value ? `set ${pending.setting.name} to ${pending.setting.name === 'search_path' ? value : literal(value)}` : `reset ${pending.setting.name}`};`;
	});

	async function load() {
		try { data = await fresh(settings({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	/** Opens on the most specific scope that sets it, so editing changes what actually applies. */
	function begin(setting: DatabaseSetting) {
		const scope: Scope = setting.roleInDatabase !== null ? 'roleInDatabase' : setting.roleDefault !== null ? 'role' : 'database';
		pending = { setting, scope, value: current(setting, scope) };
	}
</script>

<div class="space-y-3 p-4">
	<p class="max-w-3xl text-xs text-muted-foreground">
		Defaults for new connections to <code>{data?.database}</code>, for the role <code>{data?.role}</code>, or for the role in this database.
		The most specific wins: role in database, then role, then database. The table editor's own connections set <code>statement_timeout</code>.
	</p>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-muted-foreground"><tr>
				<th class="p-2 font-medium">Setting</th><th class="p-2 font-medium">Current</th>
				<th class="p-2 font-medium">Database default</th><th class="p-2 font-medium">Role default</th>
				<th class="p-2 font-medium">Role in database</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each data?.settings ?? [] as setting (setting.name)}
					<tr>
						<td class="p-2"><div class="font-mono">{setting.name}</div><div class="text-muted-foreground">{setting.description}</div></td>
						<td class="p-2 font-mono">{setting.current}</td>
						<td class="p-2 font-mono">{setting.databaseDefault ?? '—'}</td>
						<td class="p-2 font-mono">{setting.roleDefault ?? '—'}</td>
						<td class="p-2 font-mono">{setting.roleInDatabase ?? '—'}</td>
						<td class="p-2 text-right"><Button variant="outline" size="xs" onclick={() => begin(setting)}>Edit</Button></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<SqlDialog open={!!pending} title="Set" subject={pending?.setting.name} description={pending?.setting.description} {sql}
	onclose={() => pending = null} onapplied={load}>
	{#if pending}
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="space-y-2">
				<Label for={`${id}-scope`} class="text-xs">Default for</Label>
				<Select.Root type="single" bind:value={pending.scope} allowDeselect={false}
					onValueChange={(scope) => { if (pending) pending.value = current(pending.setting, scope as Scope); }}>
					<Select.Trigger id={`${id}-scope`} class="w-full text-xs">{scopes[pending.scope]}</Select.Trigger>
					<Select.Content>
						{#each Object.entries(scopes) as [value, label]}<Select.Item {value} {label} />{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="space-y-2">
				<Label for={`${id}-value`} class="text-xs">Value{pending.setting.unit ? ` (default unit ${pending.setting.unit})` : ''}</Label>
				<Input id={`${id}-value`} bind:value={pending.value} placeholder="Empty resets it (the next default applies)" spellcheck={false} class="font-mono text-xs" />
			</div>
		</div>
		<p class="text-xs text-muted-foreground">Takes effect for new connections; reconnect to see it here.</p>
	{/if}
</SqlDialog>
