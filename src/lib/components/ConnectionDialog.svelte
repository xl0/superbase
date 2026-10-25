<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Check, ChevronsUpDown, Database, Plus, Search, Settings2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { connect, disconnect, useDefault } from '#lib/db.remote.js';
	import type { ConnectionStatus } from '#lib/types.js';
	import { message } from '#lib/utils.js';
	import { activeProfile, recordActiveProfile, connectionProfiles, profileTarget, saveProfile, removeProfile,
		assertCurrentProfile, withCurrentProfile, PROFILES_KEY, ACTIVE_PROFILE_KEY, type ConnectionProfile } from '#lib/connection-profiles.js';
	import { connectionOptions, SSL_MODES, type SslMode } from '#lib/connection-options.js';
	import { autoReconnectEnabled, setAutoReconnect, rememberedConnection, rememberConnection, pauseRememberedConnection, forgetConnection, reconnectIntentCurrent, RECONNECT_KEY } from '#lib/remembered-connection.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';

	let { open = $bindable(false), active = $bindable(false), pending = $bindable(false), status,
		sqlProtected = () => false, sqlBusy = false, onsuccess = () => {} }: {
		open?: boolean; active?: boolean; pending?: boolean; status: ConnectionStatus;
		sqlProtected?: () => boolean; sqlBusy?: boolean; onsuccess?: () => void;
	} = $props();
	const id = $props.id();
	let pickerOpen = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let search = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let profiles = $state.raw<ConnectionProfile[]>([]);
	let current = $state.raw<ConnectionProfile | null>(null);
	let reconnect = $state(false);
	let catalogError = $state('');
	let error = $state('');
	let notice = $state('');
	let editing = $state.raw<ConnectionProfile | null | undefined>(undefined); // undefined = list, null = new
	let name = $state('');
	let url = $state('');
	let sslMode = $state<SslMode>('require');
	let baseline = $state('');
	let leaving = false;
	const snapshot = () => JSON.stringify([name, url, sslMode]);
	const dirty = $derived(editing !== undefined && snapshot() !== baseline);
	const stale = $derived(!!editing && !profiles.some((item) => item.id === editing!.id && item.revision === editing!.revision));
	const disabled = $derived(pending || editor.busy || sqlBusy);
	const filtered = $derived(profiles.filter((profile) => `${profile.name} ${profileTarget(profile)}`.toLowerCase().includes(query.trim().toLowerCase())));
	const actualTarget = $derived(status.connection ? `${status.connection.host}:${status.connection.port}/${status.connection.database} · ${status.connection.user}` : '');
	$effect(() => { active = open || pickerOpen || pending; });

	function refresh() {
		try {
			profiles = connectionProfiles();
			current = activeProfile(status.connection?.id, profiles);
			rememberedConnection(); // Surface corruption even when an explicit preference is present.
			reconnect = autoReconnectEnabled();
			catalogError = '';
		} catch (cause) { catalogError = message(cause); }
	}
	onMount(refresh);

	function discard() { return !dirty || window.confirm('Discard unsaved connection settings?'); }
	function close() {
		if (pending || !discard()) return;
		open = false; editing = undefined; error = ''; notice = '';
	}
	function begin(profile: ConnectionProfile | null | undefined) {
		if (disabled || !discard()) return;
		refresh();
		editing = profile; name = profile?.name ?? ''; url = profile?.url ?? '';
		sslMode = profile?.sslMode ?? 'require';
		baseline = snapshot(); error = ''; notice = '';
		pickerOpen = false; open = true;
	}
	function approve() {
		return !editor.busy && !sqlBusy && (!(editor.inserting || editor.editing || editor.schemaEditing || sqlProtected()) || window.confirm(
			'Discard unsaved edits and close SQL sessions (rolling back uncommitted work)? Saved SQL drafts will be kept.'
		));
	}

	async function change(choice: ConnectionProfile | 'manual' | 'default' | 'disconnect') {
		if (disabled) return;
		if (typeof choice !== 'string' && current?.id === choice.id && current.revision === choice.revision) { pickerOpen = false; return; }
		if (!approve()) return;
		pending = true; error = ''; notice = '';
		try {
			const profile = typeof choice === 'string' ? null : choice;
			if (profile) assertCurrentProfile(profile);
			const target = profile?.url ?? (choice === 'manual' ? connectionOptions(url, sslMode).url : '');
			const mode = profile?.sslMode ?? sslMode;
			let restore = false;
			try { if (profile) restore = autoReconnectEnabled(); }
			catch (cause) { if (!(cause instanceof DOMException && cause.name === 'SecurityError')) throw cause; }
			const intent = pauseRememberedConnection();
			const expected = status.connection?.id ?? null;
			const result = choice === 'disconnect' ? await disconnect({ expected }) : choice === 'default' ? await useDefault({ expected })
				: await connect({ url: target, sslMode: mode, expected });
			try {
				const persist = () => {
					recordActiveProfile(result.connection?.id, profile);
					if (target) {
						if (restore) rememberConnection(target, intent, profile?.id, mode);
						else forgetConnection(intent);
					}
				};
				if (profile) await withCurrentProfile(profile, persist); else persist();
			} catch { window.alert('Connection changed, but browser preferences could not be updated. Automatic reconnection remains paused.'); }
			leaving = true;
			editor.discardAll(); onsuccess(); pending = false;
			window.location.reload();
		} catch (cause) { error = message(cause); pending = false; }
	}

	async function save() {
		if (disabled || editing === undefined) return;
		pending = true; error = '';
		try {
			await saveProfile(editing, { name, url, sslMode });
			baseline = snapshot(); editing = undefined; open = false;
			refresh(); notice = 'Connection saved';
		} catch (cause) { error = message(cause); }
		finally { pending = false; }
	}
	async function remove() {
		if (disabled || !editing || !window.confirm(`Remove connection “${editing.name}”? The active session and database will not be deleted.`)) return;
		pending = true; error = '';
		try {
			await removeProfile(editing);
			editing = undefined; name = url = ''; baseline = snapshot(); refresh();
			notice = 'Connection removed';
		} catch (cause) { error = message(cause); }
		finally { pending = false; }
	}
	async function configureReconnect(enabled: boolean) {
		if (disabled) return;
		pending = true; error = ''; notice = '';
		try {
			if (enabled && current) {
				const profile = current;
				const intent = pauseRememberedConnection();
				await withCurrentProfile(profile, () => {
					if (!reconnectIntentCurrent(intent)) return;
					if (activeProfile(status.connection?.id, connectionProfiles())?.id !== profile.id) {
						throw new Error('The active connection changed. Reload before enabling automatic reconnect.');
					}
					setAutoReconnect(true);
					rememberConnection(profile.url, intent, profile.id, profile.sslMode);
				});
			} else {
				setAutoReconnect(enabled);
				if (enabled) notice = 'Automatic reconnect will apply to the next saved connection.';
			}
			refresh();
		} catch (cause) { error = message(cause); }
		finally { pending = false; }
	}
	function clearReconnect() {
		if (disabled) return;
		try { setAutoReconnect(false); error = ''; refresh(); }
		catch (cause) { error = message(cause); }
	}
	function editUrl(value: string) {
		url = value;
		try {
			const imported = connectionOptions(value);
			if (imported.url !== value.trim()) { url = imported.url; sslMode = imported.sslMode; }
		} catch { /* Keep incomplete or invalid URLs intact for correction. */ }
	}
	function navigate(event: KeyboardEvent) {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
			(event.target === search && ['Home', 'End'].includes(event.key))) return;
		const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[data-connection-choice]:not(:disabled)')];
		if (!buttons.length) return;
		event.preventDefault();
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
			: index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
			: (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
		buttons[next].focus();
	}
</script>

<svelte:window onstorage={(event) => {
	if ([PROFILES_KEY, ACTIVE_PROFILE_KEY, RECONNECT_KEY, 'superbase.connection', null].includes(event.key)) refresh();
}} onbeforeunload={(event) => {
	if (!leaving && (dirty || pending)) { event.preventDefault(); event.returnValue = ''; }
}} />

<Popover.Root bind:open={() => pickerOpen, (value) => {
	if (pending) return;
	pickerOpen = value;
	if (value) { query = ''; error = ''; refresh(); }
}}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} bind:ref={trigger} variant="ghost" disabled={disabled} class="max-w-full justify-start gap-2 px-2"
				aria-label="Switch connection" title={actualTarget}>
				<Database class="size-4 shrink-0 text-muted-foreground" />
				<span class="truncate">{current?.name ?? status.connection?.database ?? 'Choose connection'}</span>
				<ChevronsUpDown class="size-3.5 shrink-0 text-muted-foreground" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" collisionPadding={12} class="max-h-[min(32rem,var(--bits-popover-content-available-height))] w-96 max-w-[calc(100vw-24px)] gap-0 overflow-hidden p-0"
		aria-label="Switch connection" onkeydown={navigate}
		onOpenAutoFocus={async (event) => { event.preventDefault(); await tick(); search?.focus(); }}
		onCloseAutoFocus={(event) => { if (open) event.preventDefault(); }}
		onEscapeKeydown={(event) => { if (pending) event.preventDefault(); }}
		onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
			<Search class="size-4 shrink-0 text-muted-foreground" />
			<Input bind:ref={search} bind:value={query} disabled={pending} aria-label="Find connection" placeholder="Find connection…"
				class="h-8 min-w-0 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" autocomplete="off" />
			<kbd class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
		</div>
		<div class="min-h-0 overflow-y-auto p-1.5" aria-busy={pending}>
			{#if status.connection && !current && (!query || actualTarget.toLowerCase().includes(query.toLowerCase()))}
				<div class="flex items-center gap-3 rounded-md px-2 py-2.5">
					<Database class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0 flex-1"><p class="truncate text-xs">{status.connection.database}</p><p class="truncate text-[11px] text-muted-foreground" title={actualTarget}>{actualTarget}</p></div>
					<Check class="size-4 shrink-0" aria-label="Current connection" />
				</div>
			{/if}
			{#each filtered as profile (profile.id)}
				<Button data-connection-choice variant="ghost" class="h-auto w-full justify-start gap-3 px-2 py-2.5 text-left" disabled={disabled}
					aria-current={current?.id === profile.id ? 'true' : undefined} onclick={() => void change(profile)}>
					<Database class="size-4 shrink-0 text-muted-foreground" />
					<div class="min-w-0 flex-1"><p class="truncate text-xs" title={profile.name}>{profile.name}</p><p class="truncate text-[11px] font-normal text-muted-foreground" title={profileTarget(profile)}>{profileTarget(profile)}</p></div>
					{#if current?.id === profile.id}<Check class="size-4 shrink-0" /><span class="sr-only">Current connection</span>{/if}
				</Button>
			{:else}<p class="px-2 py-3 text-xs text-muted-foreground">{query ? 'No matching connections.' : 'No saved connections.'}</p>{/each}
			{#if catalogError || error}<p role="alert" class="p-2 text-xs break-words text-destructive">{error || catalogError}</p>{/if}
			{#if pending}<p role="status" class="p-2 text-xs text-muted-foreground">Connecting…</p>{/if}
		</div>
		<div class="shrink-0 border-t p-1.5">
			<Button data-connection-choice variant="ghost" class="w-full justify-start text-xs" disabled={disabled} onclick={() => begin(null)}><Plus class="text-muted-foreground" />Add connection</Button>
			<Button data-connection-choice variant="ghost" class="w-full justify-start text-xs" disabled={disabled} onclick={() => begin(undefined)}><Settings2 class="text-muted-foreground" />Manage connections</Button>
		</div>
	</Popover.Content>
</Popover.Root>

<Dialog.Root bind:open={() => open, (value) => { if (!value) close(); }}>
	<Dialog.Content showCloseButton={!pending} class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4"
		onEscapeKeydown={(event) => { if (pending) event.preventDefault(); }} onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
		onCloseAutoFocus={(event) => { event.preventDefault(); trigger?.focus(); }}>
		<Dialog.Header class="shrink-0">
			<Dialog.Title>{editing === undefined ? 'Manage connections' : editing ? 'Edit connection' : 'Add connection'}</Dialog.Title>
			<Dialog.Description class="text-xs">{editing === undefined ? 'Saved connections on this browser.' : 'Save the complete Postgres URL. Stored locally, unencrypted.'}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 overflow-y-auto">
			{#if editing === undefined}
				<div class="space-y-3">
					{#each profiles as profile (profile.id)}
						<Button variant="outline" class="h-auto w-full justify-start px-3 py-2 text-left" disabled={disabled} onclick={() => begin(profile)}>
							<div class="min-w-0"><p class="truncate text-xs">{profile.name}</p><p class="truncate text-[11px] font-normal text-muted-foreground">{profileTarget(profile)}</p></div>
						</Button>
					{:else}<p class="text-xs text-muted-foreground">No saved connections.</p>{/each}
					<Button variant="outline" size="sm" disabled={disabled} onclick={() => begin(null)}><Plus />Add connection</Button>
					<div class="space-y-2 border-t pt-4">
						<div class="flex items-center gap-2">
							<Checkbox id={`${id}-reconnect`} disabled={disabled} bind:checked={() => reconnect, (value) => void configureReconnect(value)} />
							<Label for={`${id}-reconnect`} class="text-xs">Reconnect automatically on reload</Label>
						</div>
						<p class="text-[11px] text-muted-foreground">Disconnect pauses automatic reconnection.</p>
					</div>
					<div class="flex flex-wrap gap-2 border-t pt-3">
						{#if status.defaultAvailable}<Button variant="outline" size="sm" disabled={disabled} onclick={() => void change('default')}>Use default DB</Button>{/if}
						{#if status.connection}<Button variant="destructive" size="sm" disabled={disabled} onclick={() => void change('disconnect')}>Disconnect</Button>{/if}
					</div>
				</div>
			{:else}
				<form id={`${id}-form`} class="space-y-4" onsubmit={(event) => { event.preventDefault(); void save(); }}>
					{#if stale}<p role="alert" class="text-xs text-destructive">This connection changed or was removed in another tab. Your draft was kept.</p>
						<Button variant="outline" size="sm" disabled={disabled} onclick={() => begin(profiles.find((item) => item.id === editing?.id))}>Reload connection</Button>{/if}
					<div class="space-y-2"><Label for={`${id}-name`} class="text-xs">Connection name</Label>
						<Input id={`${id}-name`} bind:value={name} maxlength={100} required disabled={disabled} placeholder="Local development" /></div>
					<div class="space-y-2"><Label for={`${id}-url`} class="text-xs">Postgres connection URL</Label>
						<Input id={`${id}-url`} type="text" bind:value={() => url, editUrl} required disabled={disabled}
							autocomplete="off" autocapitalize="none" spellcheck={false} placeholder="postgresql://user:password@host:5432/database" class="font-mono text-xs" />
					</div>
					<div class="space-y-2">
						<Label for={`${id}-ssl`} class="text-xs">SSL</Label>
						<Select.Root type="single" bind:value={sslMode} allowDeselect={false} disabled={disabled}>
							<Select.Trigger id={`${id}-ssl`} class="w-full text-xs">{SSL_MODES[sslMode]}</Select.Trigger>
							<Select.Content>
								{#each Object.entries(SSL_MODES) as [value, label]}<Select.Item {value} {label}>{label}</Select.Item>{/each}
							</Select.Content>
						</Select.Root>
						<p class="text-[11px] text-muted-foreground">{sslMode === 'disable' ? 'Unencrypted connection.'
							: sslMode === 'prefer' ? 'Uses SSL when supported; otherwise connects unencrypted.'
							: sslMode === 'require' ? 'Encryption required; certificate not verified.'
							: 'Encryption and a valid server certificate required.'}</p>
					</div>
					{#if editing}<Button variant="destructive" size="sm" disabled={disabled || stale} onclick={() => void remove()}>Remove connection</Button>{/if}
				</form>
			{/if}
			{#if catalogError || error}
				<p role="alert" class="mt-3 text-xs break-words text-destructive">{error || catalogError}</p>
				<Button variant="outline" size="sm" class="mt-2" disabled={disabled} onclick={clearReconnect}>Clear automatic reconnect data</Button>
			{/if}
			{#if notice}<p role="status" class="mt-3 text-xs text-muted-foreground">{notice}</p>{/if}
		</div>
		<Dialog.Footer class="shrink-0">
			{#if editing === undefined}<Button variant="outline" size="sm" disabled={pending} onclick={close}>Close</Button>
			{:else}
				<Button variant="outline" size="sm" disabled={pending} onclick={close}>Cancel</Button>
				{#if !editing}<Button variant="outline" size="sm" disabled={disabled || !url.trim()} onclick={() => void change('manual')}>Connect without saving</Button>{/if}
				<Button type="submit" form={`${id}-form`} size="sm" disabled={disabled || stale || !name.trim() || !url.trim()}>Save</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
