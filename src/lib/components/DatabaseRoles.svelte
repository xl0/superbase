<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Pencil, Plus, Search, Trash2 } from '@lucide/svelte';
	import { roles } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Role } from '#lib/database.js';
	import { alterRole, createRole, ident, type RoleSpec } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import SqlDialog from './SqlDialog.svelte';

	const id = $props.id();
	let list = $state.raw<Role[] | null>(null);
	let error = $state('');
	let query = $state('');
	/** Role form: `original` null creates. */
	let form = $state<{ original: Role | null; spec: RoleSpec } | null>(null);
	let dropping = $state.raw<Role | null>(null);
	let dropOwned = $state(false);
	const shown = $derived((list ?? []).filter((role) => role.name.toLowerCase().includes(query.trim().toLowerCase())));
	const build = (spec: RoleSpec) => form?.original ? alterRole(form.original, spec) : createRole(spec);
	const formSql = $derived(form && form.spec.name.trim() ? build({ ...form.spec, name: form.spec.name.trim() }) : '');
	/** What the preview shows: the same statement with the password masked. */
	const formPreview = $derived(form && formSql && form.spec.password ? build({ ...form.spec, name: form.spec.name.trim(), password: '********' }) : formSql);
	const dropSql = $derived(dropping ? `${dropOwned ? `drop owned by ${ident(dropping.name)};\n` : ''}drop role ${ident(dropping.name)};` : '');

	async function load() {
		try { list = await fresh(roles({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function open(role: Role | null) {
		form = { original: role, spec: role
			? { name: role.name, login: role.login, password: '', bypass: role.bypass, createdb: role.createdb, memberOf: [...role.memberOf] }
			: { name: '', login: false, password: '', bypass: false, createdb: false, memberOf: [] } };
	}

	async function applied() {
		await load();
		void editor.reload(); // The table editor's Role menu lists roles.
	}
</script>

{#snippet flag(on: boolean, label: string)}
	<td class="p-3 text-center">{#if on}<Check class="mx-auto size-3.5" aria-label={label} />{:else}<span class="text-muted-foreground">—</span>{/if}</td>
{/snippet}

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative w-full max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search roles" placeholder="Search roles" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		<p class="text-xs text-muted-foreground">Roles belong to the whole server, not one database.</p>
		<Button size="sm" class="ml-auto" onclick={() => open(null)}><Plus />Create role</Button>
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Role</th><th class="p-3 text-center font-medium">Login</th><th class="p-3 text-center font-medium">Superuser</th>
				<th class="p-3 text-center font-medium whitespace-nowrap">Bypass RLS</th><th class="p-3 text-center font-medium whitespace-nowrap">Create DB</th>
				<th class="p-3 font-medium whitespace-nowrap">Member of</th><th></th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as role (role.name)}
					<tr>
						<td class="p-3 font-mono">{role.name}{#if role.current}<span class="ml-2 rounded border px-1 py-0.5 font-sans text-[10px] text-muted-foreground">you</span>{/if}</td>
						{@render flag(role.login, 'Can log in')}
						{@render flag(role.superuser, 'Superuser')}
						{@render flag(role.bypass, 'Bypasses RLS')}
						{@render flag(role.createdb, 'Can create databases')}
						<td class="p-3 font-mono">{role.memberOf.join(', ') || '—'}</td>
						<td class="p-2 text-right whitespace-nowrap">
							<Button variant="ghost" size="icon-sm" aria-label={`Edit role ${role.name}`} onclick={() => open(role)}><Pencil /></Button>
							<Button variant="ghost" size="icon-sm" aria-label={`Drop role ${role.name}`} disabled={role.current}
								onclick={() => { dropping = role; dropOwned = false; }}><Trash2 /></Button>
						</td>
					</tr>
				{:else}
					<tr><td colspan="7" class="p-3 text-muted-foreground">{list === null ? 'Loading…' : 'No matching roles.'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<SqlDialog open={!!form} title={form?.original ? 'Edit role' : 'Create role'} subject={form?.original?.name} sql={formSql} preview={formPreview}
	description="A role without login is a group or a role to test policies with (the table editor's Role menu)."
	onclose={() => form = null} onapplied={applied}>
	{#if form}
		<div class="space-y-2">
			<Label for={`${id}-name`} class="text-xs">Name</Label>
			<Input id={`${id}-name`} bind:value={form.spec.name} spellcheck={false} autocomplete="off" class="font-mono text-xs" />
		</div>
		<div class="space-y-2">
			{#each [['login', 'Can log in'], ['bypass', 'Bypasses row-level security'], ['createdb', 'Can create databases']] as const as [key, label]}
				<div class="flex items-center gap-2">
					<Checkbox id={`${id}-${key}`} bind:checked={form.spec[key]} />
					<Label for={`${id}-${key}`} class="text-xs">{label}</Label>
				</div>
			{/each}
		</div>
		{#if form.spec.login}
			<div class="space-y-2">
				<Label for={`${id}-password`} class="text-xs">{form.original ? 'New password (leave empty to keep)' : 'Password'}</Label>
				<Input id={`${id}-password`} type="password" bind:value={form.spec.password} autocomplete="new-password" class="font-mono text-xs" />
				<p class="text-[11px] text-muted-foreground">Masked in the preview; sent in the statement (server statement logs may record it).</p>
			</div>
		{/if}
		{#if (list ?? []).some((role) => role.name !== form?.original?.name)}
			<fieldset class="space-y-2">
				<legend class="text-xs font-medium">Member of</legend>
				<div class="flex flex-wrap gap-x-4 gap-y-2">
					{#each (list ?? []).filter((role) => role.name !== form?.original?.name) as parent, i (parent.name)}
						<div class="flex items-center gap-2">
							<Checkbox id={`${id}-member-${i}`} checked={form.spec.memberOf.includes(parent.name)}
								onCheckedChange={(checked) => { if (form) form.spec.memberOf = checked ? [...form.spec.memberOf, parent.name] : form.spec.memberOf.filter((name) => name !== parent.name); }} />
							<Label for={`${id}-member-${i}`} class="font-mono text-xs">{parent.name}</Label>
						</div>
					{/each}
				</div>
				<p class="text-[11px] text-muted-foreground">Members can use their parent roles' privileges.</p>
			</fieldset>
		{/if}
	{/if}
</SqlDialog>

<SqlDialog open={!!dropping} title="Drop role" subject={dropping?.name} sql={dropSql} destructive action="Drop"
	description="PostgreSQL refuses while the role owns objects or holds privileges in any database."
	onclose={() => dropping = null} onapplied={applied}>
	<div class="flex items-start gap-2">
		<Checkbox id={`${id}-owned`} bind:checked={dropOwned} />
		<Label for={`${id}-owned`} class="text-xs leading-snug">First revoke its privileges and drop the objects it owns in this database (DROP OWNED BY).
			Other databases are not touched.</Label>
	</div>
</SqlDialog>
