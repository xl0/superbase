<script lang="ts">
	import { onMount } from 'svelte';
	import { changeSchema, settings } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { DatabaseSetting } from '#lib/database.js';
	import { ident, literal } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	const id = $props.id();
	let data = $state.raw<{ database: string; role: string; settings: DatabaseSetting[] } | null>(null);
	let error = $state('');
	let pending = $state<{ setting: DatabaseSetting; scope: 'database' | 'role'; value: string } | null>(null);
	let applying = $state(false);
	let applyError = $state('');
	const sql = $derived.by(() => {
		if (!pending || !data) return '';
		const target = pending.scope === 'database' ? `database ${ident(data.database)}` : `role ${ident(data.role)}`;
		const value = pending.value.trim();
		// search_path is a list: its value is written as SQL (e.g. "$user", public), not one string.
		return `alter ${target} ${value ? `set ${pending.setting.name} to ${pending.setting.name === 'search_path' ? value : literal(value)}` : `reset ${pending.setting.name}`};`;
	});

	async function load() {
		try { data = await fresh(settings({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function begin(setting: DatabaseSetting) {
		pending = { setting, scope: 'database', value: setting.databaseDefault ?? '' };
		applyError = '';
	}

	async function apply() {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			pending = null;
			await load();
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

<div class="space-y-3 p-4">
	<p class="max-w-3xl text-xs text-muted-foreground">
		Defaults for new connections to <code>{data?.database}</code>, or for the role <code>{data?.role}</code> (role defaults win).
		The app's own connections set <code>statement_timeout</code> and the SQL editor also sets <code>idle_in_transaction_session_timeout</code>.
	</p>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-muted-foreground"><tr>
				<th class="p-2 font-medium">Setting</th><th class="p-2 font-medium">Current</th>
				<th class="p-2 font-medium">Database default</th><th class="p-2 font-medium">Role default</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each data?.settings ?? [] as setting (setting.name)}
					<tr>
						<td class="p-2"><div class="font-mono">{setting.name}</div><div class="text-muted-foreground">{setting.description}</div></td>
						<td class="p-2 font-mono">{setting.current}</td>
						<td class="p-2 font-mono">{setting.databaseDefault ?? '—'}</td>
						<td class="p-2 font-mono">{setting.roleDefault ?? '—'}</td>
						<td class="p-2 text-right"><Button variant="outline" size="xs" onclick={() => begin(setting)}>Edit</Button></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={() => !!pending, (open) => { if (!open && !applying) pending = null; }}>
	<Dialog.Content class="gap-4">
		{#if pending}
			<Dialog.Header>
				<Dialog.Title class="font-mono">{pending.setting.name}</Dialog.Title>
				<Dialog.Description class="text-xs">{pending.setting.description}</Dialog.Description>
			</Dialog.Header>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="space-y-2">
					<Label for={`${id}-scope`} class="text-xs">Default for</Label>
					<Select.Root type="single" bind:value={pending.scope} allowDeselect={false}
						onValueChange={(scope) => { if (pending) pending.value = (scope === 'database' ? pending.setting.databaseDefault : pending.setting.roleDefault) ?? ''; }}>
						<Select.Trigger id={`${id}-scope`} class="w-full text-xs">{pending.scope === 'database' ? `Database ${data?.database}` : `Role ${data?.role}`}</Select.Trigger>
						<Select.Content>
							<Select.Item value="database" label={`Database ${data?.database}`} />
							<Select.Item value="role" label={`Role ${data?.role}`} />
						</Select.Content>
					</Select.Root>
				</div>
				<div class="space-y-2">
					<Label for={`${id}-value`} class="text-xs">Value{pending.setting.unit ? ` (default unit ${pending.setting.unit})` : ''}</Label>
					<Input id={`${id}-value`} bind:value={pending.value} placeholder="Empty resets to the server default" spellcheck={false} class="font-mono text-xs" />
				</div>
			</div>
			<pre class="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{sql}</pre>
			<p class="text-xs text-muted-foreground">Takes effect for new connections; reconnect to see it here.</p>
			{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
			<Dialog.Footer>
				<Button variant="outline" size="sm" disabled={applying} onclick={() => pending = null}>Cancel</Button>
				<Button size="sm" disabled={applying} onclick={apply}>{applying ? 'Applying…' : 'Apply'}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
