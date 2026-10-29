<script lang="ts">
	import { Pencil, Plus, Trash2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Policy, PolicyCommand, PolicyTable } from '#lib/database.js';
	import { createPolicy, grantChanges, ident, qualify, TABLE_PRIVILEGES, type PolicySpec } from '#lib/ddl.js';
	import { highlightSql } from '#lib/sql-highlight.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import SqlDialog from './SqlDialog.svelte';

	/** One table's access: RLS switches, policies and table privileges. Used by Database → Policies and the table editor's panel. */
	let { table, privilegesOpen = false, onapplied }: {
		table: PolicyTable;
		privilegesOpen?: boolean;
		/** Called after a change was applied; reload the data. */
		onapplied: () => Promise<void> | void;
	} = $props();
	const COMMANDS: PolicyCommand[] = ['all', 'select', 'insert', 'update', 'delete'];
	const id = $props.id();
	const target = $derived(qualify(table.schema, table.table));
	/** Policy form; editing replaces the policy (drop + create) in one transaction. */
	let form = $state<{ original: Policy | null; spec: PolicySpec } | null>(null);
	/** A statement awaiting confirmation: RLS switches, policy drops, privilege changes. */
	let pending = $state.raw<{ title: string; description: string; sql: string; destructive?: boolean } | null>(null);
	const formSql = $derived(form && form.spec.name.trim()
		? `${form.original ? `drop policy ${ident(form.original.name)} on ${target};\n` : ''}${createPolicy(target, { ...form.spec, name: form.spec.name.trim() })}` : '');
	/** Role → table privileges (select/insert/update/delete only), as granted and as edited. */
	const granted = $derived(table.grants.reduce<Record<string, string[]>>((map, grant) => {
		if ((TABLE_PRIVILEGES as readonly string[]).includes(grant.privilege)) (map[grant.role] ??= []).push(grant.privilege);
		return map;
	}, {}));
	let privileges = $derived(structuredClone(granted));
	const grantSql = $derived(grantChanges(target, granted, privileges));
	/** `role:privilege` → its grantors, where someone besides the owner granted it: one revoke may not remove it. */
	const otherGrantors = $derived(new Map(table.grants.filter((grant) => grant.grantors.some((grantor) => grantor !== table.owner))
		.map((grant) => [`${grant.role}:${grant.privilege}`, grant.grantors])));
	const ungranted = $derived(['public', ...editor.roles].filter((name) => name !== table.owner && !(name in privileges)));

	function open(policy: Policy | null) {
		form = { original: policy, spec: policy
			? { name: policy.name, command: policy.command, permissive: policy.permissive,
				// PUBLIC is "no roles": Postgres ignores named roles listed beside it (with only a warning).
				roles: policy.roles.filter((role) => role !== 'public'), using: policy.using ?? '', check: policy.check ?? '' }
			: { name: '', command: 'all', permissive: true, roles: [], using: '', check: '' } };
	}

	function confirm(title: string, description: string, sql: string, destructive = false) {
		pending = { title, description, sql, destructive };
	}

	const rls = (change: 'enable' | 'disable' | 'force' | 'no force') => confirm(
		{ enable: 'Enable row-level security', disable: 'Disable row-level security', force: 'Force row-level security', 'no force': 'Stop forcing row-level security' }[change],
		{
			enable: table.policies.length ? 'Roles other than the owner, superusers and BYPASSRLS roles will see only rows the policies allow.'
				: 'This table has no policies yet: every role except the owner, superusers and BYPASSRLS roles will see no rows.',
			disable: 'Every role with access to the table sees all rows again; the policies stay but have no effect.',
			force: 'The policies will apply to the table owner too (superusers and BYPASSRLS roles still bypass them).',
			'no force': 'The table owner will bypass the policies again.'
		}[change],
		`alter table ${target} ${change} row level security;`, change === 'enable' || change === 'force');

	function toggle(name: string, privilege: string, on: boolean) {
		const current = privileges[name] ?? [];
		privileges = { ...privileges, [name]: on ? [...current, privilege] : current.filter((entry) => entry !== privilege) };
	}
</script>

{#snippet code(sql: string)}<code class="sql-code font-mono break-all whitespace-pre-wrap">{#each highlightSql(sql) as span}<span class={span.class}>{span.text}</span>{/each}</code>{/snippet}

<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
	<span class="font-mono text-xs font-medium">{table.table}</span>
	<span class={['rounded border px-1.5 py-0.5 text-[10px] uppercase', table.enabled ? 'border-primary/40 text-primary' : 'text-muted-foreground']}>
		{table.forced ? 'RLS forced' : table.enabled ? 'RLS on' : 'RLS off'}</span>
	{#if !editor.bypass && table.owner === editor.role && !table.forced && table.enabled}
		<span class="text-[11px] text-muted-foreground">you own it, so you bypass its policies</span>
	{/if}
	<div class="ml-auto flex flex-wrap gap-1.5">
		{#if table.enabled}
			<Button variant="ghost" size="xs" onclick={() => rls(table.forced ? 'no force' : 'force')}>{table.forced ? 'Stop forcing' : 'Force for owner'}</Button>
			<Button variant="outline" size="xs" onclick={() => rls('disable')}>Disable RLS</Button>
		{:else}
			<Button variant="outline" size="xs" onclick={() => rls('enable')}>Enable RLS</Button>
		{/if}
		<Button size="xs" onclick={() => open(null)}><Plus />New policy</Button>
	</div>
</div>
{#if table.enabled && !table.policies.length}
	<p class="px-3 py-2 text-xs text-amber-300">No policies: every role except the owner, superusers and BYPASSRLS roles sees no rows.</p>
{:else if !table.enabled && table.policies.length}
	<p class="px-3 py-2 text-xs text-muted-foreground">RLS is off, so these policies have no effect.</p>
{/if}
{#each table.policies as policy (policy.name)}
	<div class="flex items-start gap-3 border-b px-3 py-2 text-xs">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="flex flex-wrap items-center gap-2">
				<span class="font-mono font-medium">{policy.name}</span>
				<span class="rounded border px-1.5 py-0.5 text-[10px] uppercase">{policy.command}</span>
				{#if !policy.permissive}<span class="rounded border border-amber-300/40 px-1.5 py-0.5 text-[10px] text-amber-300 uppercase">restrictive</span>{/if}
				<span class="text-muted-foreground">to {policy.roles.join(', ')}</span>
			</div>
			{#if policy.using}<p><span class="mr-1.5 text-muted-foreground">using</span>{@render code(policy.using)}</p>{/if}
			{#if policy.check}<p><span class="mr-1.5 text-muted-foreground">with check</span>{@render code(policy.check)}</p>{/if}
		</div>
		<Button variant="ghost" size="icon-sm" aria-label={`Edit policy ${policy.name}`} onclick={() => open(policy)}><Pencil /></Button>
		<Button variant="ghost" size="icon-sm" aria-label={`Drop policy ${policy.name}`}
			onclick={() => confirm(`Drop policy ${policy.name}`, table.enabled && table.policies.length === 1
				? 'This is the last policy: with RLS on, every role except the owner, superusers and BYPASSRLS roles will see no rows.'
				: 'Rows this policy allowed are no longer allowed by it.', `drop policy ${ident(policy.name)} on ${target};`, true)}><Trash2 /></Button>
	</div>
{/each}
<details open={privilegesOpen} class="px-3 py-2 text-xs">
	<summary class="cursor-pointer text-muted-foreground">Table privileges · {Object.keys(granted).length} role{Object.keys(granted).length === 1 ? '' : 's'}</summary>
	<div class="mt-2 space-y-2">
		<p class="text-[11px] text-muted-foreground">Which roles may touch the table at all; RLS then filters their rows. The owner
			(<code>{table.owner}</code>) has every privilege.</p>
		{#if Object.keys(privileges).length}
			<table class="text-left">
				<thead class="text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
					<th class="py-1 pr-4 font-medium">Role</th>{#each TABLE_PRIVILEGES as privilege}<th class="px-2 py-1 text-center font-medium">{privilege}</th>{/each}
				</tr></thead>
				<tbody>
					{#each Object.keys(privileges).sort() as name (name)}
						<tr>
							<td class="py-1 pr-4 font-mono">{name}</td>
							{#each TABLE_PRIVILEGES as privilege}
								{@const grantors = otherGrantors.get(`${name}:${privilege}`)}
								<td class="px-2 py-1 text-center whitespace-nowrap" title={grantors && `Granted by ${grantors.join(', ')}`}>
									<Checkbox aria-label={`${privilege} for ${name}`} checked={privileges[name].includes(privilege)}
										onCheckedChange={(checked) => toggle(name, privilege, !!checked)} />{#if grantors}<span class="ml-0.5 align-top text-amber-300">*</span>{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			{#if otherGrantors.size}
				<p class="text-[11px] text-amber-300">* Also granted by roles other than the owner (hover for who). A revoke removes only the grant
					made by you (by the owner, when a superuser revokes); the others stay until their grantors revoke them.</p>
			{/if}
		{/if}
		<div class="flex flex-wrap items-center gap-2">
			{#if ungranted.length}
				<Select.Root type="single" value="" onValueChange={(name) => { if (name) privileges = { ...privileges, [name]: [] }; }}>
					<Select.Trigger size="sm" aria-label="Add a role" class="text-xs">Add role…</Select.Trigger>
					<Select.Content>{#each ungranted as name}<Select.Item value={name} label={name} class="font-mono text-xs" />{/each}</Select.Content>
				</Select.Root>
			{/if}
			{#if grantSql}
				<Button size="xs" onclick={() => confirm('Change table privileges', `On ${table.table}.`, grantSql)}>Apply privileges</Button>
				<Button variant="ghost" size="xs" onclick={() => privileges = structuredClone(granted)}>Reset</Button>
			{/if}
		</div>
	</div>
</details>

<SqlDialog open={!!form} title={form?.original ? 'Edit policy' : 'New policy'} subject={table.table} class="sm:max-w-xl"
	description="Expressions are SQL evaluated per row, e.g. user_id = current_setting('app.user_id')::bigint."
	sql={formSql} onclose={() => form = null} {onapplied}>
	{#if form}
		<div class="space-y-2">
			<Label for={`${id}-name`} class="text-xs">Name</Label>
			<Input id={`${id}-name`} bind:value={form.spec.name} spellcheck={false} autocomplete="off" class="font-mono text-xs" />
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-2">
				<Label class="text-xs">Command</Label>
				<Select.Root type="single" bind:value={form.spec.command} allowDeselect={false}>
					<Select.Trigger aria-label="Command" size="sm" class="w-full text-xs uppercase">{form.spec.command}</Select.Trigger>
					<Select.Content>{#each COMMANDS as command}<Select.Item value={command} label={command.toUpperCase()} class="text-xs" />{/each}</Select.Content>
				</Select.Root>
			</div>
			<div class="space-y-2">
				<Label class="text-xs">Type</Label>
				<Select.Root type="single" value={form.spec.permissive ? 'permissive' : 'restrictive'} allowDeselect={false}
					onValueChange={(value) => { if (form) form.spec.permissive = value === 'permissive'; }}>
					<Select.Trigger aria-label="Type" size="sm" class="w-full text-xs">{form.spec.permissive ? 'Permissive (OR)' : 'Restrictive (AND)'}</Select.Trigger>
					<Select.Content>
						<Select.Item value="permissive" label="Permissive (OR)" class="text-xs" />
						<Select.Item value="restrictive" label="Restrictive (AND)" class="text-xs" />
					</Select.Content>
				</Select.Root>
			</div>
		</div>
		<fieldset class="space-y-2">
			<legend class="text-xs font-medium">Roles</legend>
			<div class="flex flex-wrap gap-x-4 gap-y-2">
				{#each editor.roles as name, i}
					<div class="flex items-center gap-2">
						<Checkbox id={`${id}-role-${i}`} checked={form.spec.roles.includes(name)}
							onCheckedChange={(checked) => { if (form) form.spec.roles = checked ? [...form.spec.roles, name] : form.spec.roles.filter((entry) => entry !== name); }} />
						<Label for={`${id}-role-${i}`} class="font-mono text-xs">{name}</Label>
					</div>
				{/each}
			</div>
			<p class="text-[11px] text-muted-foreground">None selected means public (every role).</p>
		</fieldset>
		{#if form.spec.command !== 'insert'}
			<div class="space-y-2">
				<Label for={`${id}-using`} class="text-xs">USING</Label>
				<Textarea id={`${id}-using`} bind:value={form.spec.using} spellcheck={false} class="min-h-16 font-mono text-xs" placeholder="true" />
				<p class="text-[11px] text-muted-foreground">Which existing rows the roles can see, update or delete.</p>
			</div>
		{/if}
		{#if form.spec.command !== 'select' && form.spec.command !== 'delete'}
			<div class="space-y-2">
				<Label for={`${id}-check`} class="text-xs">WITH CHECK</Label>
				<Textarea id={`${id}-check`} bind:value={form.spec.check} spellcheck={false} class="min-h-16 font-mono text-xs" />
				<p class="text-[11px] text-muted-foreground">Which rows they may insert, or turn rows into by an update. Empty: the USING rule.</p>
			</div>
		{/if}
	{/if}
</SqlDialog>

<SqlDialog open={!!pending} title={pending?.title ?? ''} description={pending?.description} sql={pending?.sql ?? ''} destructive={pending?.destructive}
	onclose={() => pending = null} {onapplied} />
