<script lang="ts">
	import { Check, ChevronDown, Plus, ShieldOff, UserRound, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';

	/** "View as role" for RLS testing: grid reads and writes run as the chosen role with these settings. */
	let open = $state(false);
	let settings = $state<{ name: string; value: string }[]>([]);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	const active = $derived(editor.viewAs?.role ?? editor.role);
	const others = $derived(editor.roles.filter((role) => role !== editor.role));
	const draft = () => Object.fromEntries(settings.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]));
	const settingsChanged = $derived(JSON.stringify(draft()) !== JSON.stringify(editor.viewAs?.settings ?? {}));

	function changeOpen(value: boolean) {
		if (value && blocked) return;
		if (value) settings = Object.entries(editor.viewAs?.settings ?? {}).map(([name, value]) => ({ name, value }));
		open = value;
	}

	/** The connection role without settings is the plain connection: no `set role` at all. */
	function choose(role: string, values = draft()) {
		void editor.setViewAs(role === editor.role && !Object.keys(values).length ? null : { role, settings: values });
	}
</script>

{#snippet option(role: string, detail: string, Icon: typeof UserRound)}
	<button class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50" disabled={blocked}
		aria-current={active === role} onclick={() => choose(role)}>
		<Icon class="size-4 shrink-0 text-muted-foreground" />
		<span class="min-w-0 flex-1"><span class="block truncate font-mono text-xs">{role}</span>
			<span class="block truncate text-[11px] text-muted-foreground">{detail}</span></span>
		{#if active === role}<Check class="size-4 shrink-0" />{/if}
	</button>
{/snippet}

<Popover.Root {open} onOpenChange={changeOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" disabled={blocked}
				class={['text-xs', editor.viewAs && 'border-amber-300/50 text-amber-300']} title="View and edit rows as another role (row-level security)">
				<span class="text-muted-foreground">Role</span><span class="max-w-32 truncate font-mono">{active}</span><ChevronDown />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-80 max-w-[calc(100vw-24px)] gap-0 p-1.5" aria-label="View as role">
		<div class="max-h-60 overflow-y-auto">
			{@render option(editor.role, editor.bypass ? 'Connection role · bypasses RLS' : 'Connection role', editor.bypass ? ShieldOff : UserRound)}
			{#each others as role (role)}{@render option(role, 'Rows filtered by its policies', UserRound)}{/each}
		</div>
		<div class="mt-1.5 space-y-2 border-t px-2 pt-2.5 pb-1">
			<p class="text-xs font-medium">Session settings</p>
			{#each settings as row, i (i)}
				<div class="flex items-center gap-1.5">
					<Input bind:value={row.name} aria-label={`Setting ${i + 1} name`} placeholder="app.user_id" spellcheck={false} class="h-7 font-mono text-xs" />
					<Input bind:value={row.value} aria-label={`Setting ${i + 1} value`} placeholder="value" spellcheck={false} class="h-7 font-mono text-xs" />
					<Button variant="ghost" size="icon-xs" aria-label={`Remove setting ${i + 1}`} onclick={() => settings.splice(i, 1)}><X /></Button>
				</div>
			{/each}
			<div class="flex gap-2">
				<Button variant="outline" size="xs" onclick={() => settings.push({ name: '', value: '' })}><Plus />Add setting</Button>
				{#if settingsChanged}<Button size="xs" disabled={blocked} onclick={() => choose(active)}>Apply settings</Button>{/if}
			</div>
			<p class="text-[11px] text-muted-foreground">For policies that read <code>current_setting('…')</code>.</p>
		</div>
		<p class="mt-1.5 border-t px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
			{#if !editor.viewAs}{editor.bypass ? 'Bypasses RLS and can return all rows.' : 'Your connection role: policies apply unless you own the table.'}
			{:else}Reads and edits run as <code>{active}</code>: you see what it sees, and its policies check your changes.{/if}
		</p>
	</Popover.Content>
</Popover.Root>
