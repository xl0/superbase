<script lang="ts">
	import { Check, ChevronsUpDown, Pencil, Plus } from '@lucide/svelte';
	import { connect } from '#lib/db.remote.js';
	import type { ConnectionInfo } from '#lib/types.js';
	import { message } from '#lib/utils.js';
	import { connectionTarget, loadProfiles, profileTarget, rememberProfile, storeProfiles, type ConnectionProfile } from '#lib/connection-profiles.js';
	import { checkUrl, SSL_MODES, urlParam, withParam } from '#lib/connection-options.js';
	import { databaseId, tablesHref } from '#lib/links.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';

	let { connection, locked, active = $bindable(false), disabled = false, approve = () => true, onswitch = () => {} }: {
		/** The database this page shows; null on the connect screen. */
		connection: ConnectionInfo | null;
		/** Pinned to DATABASE_URL: no switching. */
		locked: boolean;
		/** Bound: true while the picker or dialog is open (pauses polling/shortcuts). */
		active?: boolean;
		disabled?: boolean;
		/** Confirm discarding unsaved work before switching databases. */
		approve?: () => boolean;
		/** Called right before the page loads the new connection. */
		onswitch?: () => void;
	} = $props();
	const id = $props.id();
	let pickerOpen = $state(false);
	let dialogOpen = $state(false);
	let pending = $state(false);
	let error = $state('');
	let profiles = $state.raw<ConnectionProfile[]>(loadProfiles());
	let editing = $state.raw<ConnectionProfile | null>(null);
	let name = $state('');
	let url = $state('');
	/** Controls for common URL options; they edit the URL, which stays the only setting. */
	const sslMode = $derived(urlParam(url, 'sslmode') ?? 'prefer');
	const channelBinding = $derived(urlParam(url, 'channel_binding') === 'require');
	// The demo keeps the connection UI to show how it works, but has only its in-browser database.
	const demo = import.meta.env.MODE === 'demo';
	let demoBlocked = $state(false);
	const target = $derived(connection ? connectionTarget(connection) : '');
	const current = $derived(profiles.find((profile) => profile.target === target));
	$effect(() => { active = pickerOpen || dialogOpen || pending; });

	function edit(profile: ConnectionProfile | null) {
		editing = profile;
		name = profile?.name ?? '';
		url = profile?.url ?? '';
		error = '';
		demoBlocked = false;
		pickerOpen = false;
		dialogOpen = true;
	}

	/** Saved profiles are remembered for automatic reconnection; one-off URLs never are. */
	async function change(choice: { url: string; id?: string }) {
		if (demo) { demoBlocked = true; return; }
		if (pending || !approve()) return;
		pending = true;
		error = '';
		try {
			const next = await connect({ url: choice.url });
			rememberProfile(choice.id ?? null, next);
			onswitch();
			// A full load onto the new database's route resets this page's state (other tabs keep theirs).
			// Switching adds a history entry (Back returns to the old database); leaving the connect screen does not.
			const href = tablesHref(databaseId(next));
			if (connection) window.location.assign(href); else window.location.replace(href);
		} catch (cause) {
			error = message(cause);
			pending = false;
		}
	}

	function save() {
		if (demo) { demoBlocked = true; return; }
		error = '';
		try {
			checkUrl(url);
			if (!name.trim()) throw new Error('Name the connection.');
			// The resolved target stays valid while the URL does.
			const profile = { id: editing?.id ?? crypto.randomUUID(), name: name.trim(), url: url.trim(),
				...(editing?.url === url.trim() ? { target: editing.target } : {}) };
			const others = loadProfiles().filter((item) => item.id !== profile.id);
			storeProfiles([...others, profile].sort((a, b) => a.name.localeCompare(b.name)));
			profiles = loadProfiles();
			// A new connection is opened right away; a failure stays in the dialog, the profile stays saved.
			if (editing) dialogOpen = false;
			else void change(profile);
		} catch (cause) { error = message(cause); }
	}

	function remove() {
		if (!editing || !window.confirm(`Remove saved connection “${editing.name}”?`)) return;
		storeProfiles(loadProfiles().filter((item) => item.id !== editing!.id));
		profiles = loadProfiles();
		dialogOpen = false;
	}

</script>

{#if locked}
	<span class="truncate px-2 text-sm font-medium" title={target}>{connection?.database}</span>
{:else}
	<Popover.Root bind:open={() => pickerOpen, (value) => { if (!pending) { pickerOpen = value; error = ''; } }}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" {disabled} class="max-w-full justify-start gap-2 px-2" title={target}>
					<span class="truncate">{current?.name ?? connection?.database ?? 'Choose connection'}</span>
					<ChevronsUpDown class="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" class="w-96 max-w-[calc(100vw-24px)] gap-0 p-1.5" aria-label="Connections">
			<div class="max-h-80 overflow-y-auto" aria-busy={pending}>
				{#each profiles as profile (profile.id)}
					<div class="flex items-center">
						<Button variant="ghost" class="h-auto min-w-0 flex-1 justify-start gap-3 px-2 py-2 text-left" disabled={pending}
							onclick={() => current === profile ? pickerOpen = false : void change(profile)}>
							<div class="min-w-0 flex-1">
								<p class="truncate text-xs">{profile.name}</p>
								<p class="truncate text-[11px] font-normal text-muted-foreground">{profileTarget(profile.url)}</p>
							</div>
							{#if current === profile}<Check class="size-4 shrink-0" aria-label="Current connection" />{/if}
						</Button>
						<Button variant="ghost" size="icon-sm" aria-label={`Edit ${profile.name}`} disabled={pending} onclick={() => edit(profile)}><Pencil /></Button>
					</div>
				{:else}
					<p class="px-2 py-3 text-xs text-muted-foreground">No saved connections.</p>
				{/each}
			</div>
			{#if error}<p role="alert" class="p-2 text-xs break-words text-destructive">{error}</p>{/if}
			{#if pending}<p role="status" class="p-2 text-xs text-muted-foreground">Connecting…</p>{/if}
			<div class="mt-1 border-t pt-1">
				<Button variant="ghost" class="w-full justify-start text-xs" disabled={pending} onclick={() => edit(null)}><Plus />Add connection</Button>
			</div>
		</Popover.Content>
	</Popover.Root>
{/if}

<Dialog.Root bind:open={() => dialogOpen, (value) => { if (!pending) dialogOpen = value; }}>
	<Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Edit connection' : 'Add connection'}</Dialog.Title>
			<Dialog.Description class="text-xs">Saved connections stay in this browser, unencrypted.</Dialog.Description>
		</Dialog.Header>
		<form id={`${id}-form`} class="min-h-0 space-y-4 overflow-y-auto" onsubmit={(event) => { event.preventDefault(); save(); }}>
			<div class="space-y-2">
				<Label for={`${id}-name`} class="text-xs">Name</Label>
				<Input id={`${id}-name`} bind:value={name} maxlength={100} disabled={pending} placeholder="Local development" />
			</div>
			<div class="space-y-2">
				<Label for={`${id}-url`} class="text-xs">Postgres URL</Label>
				<Input id={`${id}-url`} bind:value={url} disabled={pending} autocomplete="off" spellcheck={false}
					placeholder="postgresql://user:password@host:5432/database" class="font-mono text-xs" />
			</div>
			<div class="space-y-2">
				<Label for={`${id}-ssl`} class="text-xs">SSL</Label>
				<Select.Root type="single" value={sslMode} onValueChange={(mode) => url = withParam(url, 'sslmode', mode)} allowDeselect={false} disabled={pending}>
					<Select.Trigger id={`${id}-ssl`} class="w-full text-xs">{SSL_MODES[sslMode as keyof typeof SSL_MODES] ?? sslMode}</Select.Trigger>
					<Select.Content>
						{#each Object.entries(SSL_MODES) as [value, label]}<Select.Item {value} {label} />{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex items-center gap-2">
				<Checkbox id={`${id}-binding`} checked={channelBinding} disabled={pending}
					onCheckedChange={(on) => url = withParam(url, 'channel_binding', on ? 'require' : null)} />
				<Label for={`${id}-binding`} class="text-xs">Channel binding (SCRAM-SHA-256-PLUS, e.g. Neon)</Label>
			</div>
			<p class="text-xs text-muted-foreground">Other URL options go to the driver as written.</p>
			{#if error}<p role="alert" class="text-xs break-words text-destructive">{error}</p>{/if}
			{#if demoBlocked}
				<p role="alert" class="text-xs text-destructive">This demo runs PostgreSQL inside your browser and cannot connect to other databases.
					To use your own, run superbase locally (<code>npx @xl0/superbase</code>):
					<a href="https://github.com/xl0/superbase" target="_blank" rel="noreferrer" class="underline">github.com/xl0/superbase</a></p>
			{/if}
		</form>
		<Dialog.Footer>
			{#if editing}<Button variant="destructive" size="sm" class="mr-auto" disabled={pending} onclick={remove}>Remove</Button>{/if}
			<Button variant="outline" size="sm" disabled={pending || !url.trim()} onclick={() => void change({ url })}>{pending ? 'Connecting…' : 'Connect'}</Button>
			<Button type="submit" form={`${id}-form`} size="sm" disabled={pending || !name.trim() || !url.trim()}>Save</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
