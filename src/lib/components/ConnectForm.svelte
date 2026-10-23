<script lang="ts">
	import { Eye, EyeOff } from '@lucide/svelte';
	import { connect, disconnect, useDefault } from '#lib/db.remote.js';
	import type { ConnectionStatus } from '#lib/types.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';

	let { status, pending = $bindable(false), disabled = false, beforechange = () => true, onsuccess = () => {} }: {
		status: ConnectionStatus;
		pending?: boolean;
		disabled?: boolean;
		beforechange?: () => boolean;
		onsuccess?: () => void;
	} = $props();

	const id = $props.id();
	let url = $state('');
	let reveal = $state(false);
	let error = $state<string | null>(null);
	let action = $state('');
	const parsedUrl = $derived.by(() => {
		try { return new URL(url.trim()); }
		catch { return null; }
	});
	const sslmode = $derived(parsedUrl?.searchParams.get('sslmode'));

	function setVerification(verify: boolean) {
		if (!parsedUrl || sslmode === 'disable') return;
		const next = new URL(parsedUrl);
		next.searchParams.set('sslmode', verify ? 'verify-full' : 'require');
		url = next.toString();
	}

	async function change(kind: 'connect' | 'default' | 'disconnect') {
		if (pending || disabled || (kind === 'connect' && !url.trim()) || !beforechange()) return;
		pending = true;
		action = kind;
		error = null;
		try {
			const expected = status.connection?.id ?? null;
			if (kind === 'connect') await connect({ url: url.trim(), expected });
			else if (kind === 'default') await useDefault({ expected });
			else await disconnect({ expected });
			url = '';
			onsuccess();
			window.location.reload();
		} catch (value) {
			error = message(value);
			pending = false;
		}
	}

</script>

<form onsubmit={(event) => { event.preventDefault(); void change('connect'); }} class="space-y-4" aria-busy={pending}>
	<div class="space-y-2">
		<Label for={id} class="text-xs">Postgres connection string</Label>
		<div class="relative">
			<Input id={id} type={reveal ? 'text' : 'password'} bind:value={url} disabled={pending || disabled}
				autocomplete="off" spellcheck={false} autocapitalize="none"
				placeholder="postgresql://user:password@host:5432/database"
				class="h-9 pr-10 font-mono text-xs" />
			<Button type="button" variant="ghost" size="icon-sm" class="absolute top-0.5 right-0.5"
				disabled={pending || disabled} onclick={() => (reveal = !reveal)}
				aria-label={reveal ? 'Hide connection string' : 'Reveal connection string'} aria-pressed={reveal}>
				{#if reveal}<EyeOff />{:else}<Eye />{/if}
			</Button>
		</div>
		<div class="flex items-center gap-2 pt-1">
			<Checkbox id={`${id}-verify`} checked={sslmode === 'verify-full'}
				disabled={pending || disabled || !parsedUrl || sslmode === 'disable'}
				onCheckedChange={setVerification} aria-describedby={`${id}-tls-help`} />
			<Label for={`${id}-verify`} class="text-xs">Verify server certificate</Label>
		</div>
		<p id={`${id}-tls-help`} class="text-[11px] leading-relaxed text-muted-foreground">
			{#if sslmode === 'disable'}
				TLS is disabled by <code>sslmode=disable</code>; this connection is unencrypted.
			{:else}
				TLS is encrypted without certificate verification by default. Checking this sets
				<code>sslmode=verify-full</code>. For an unencrypted connection, use <code>sslmode=disable</code>.
			{/if}
		</p>
	</div>
	{#if error}
		<p role="alert" class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs break-words text-destructive">{error}</p>
	{/if}
	<Button type="submit" class="w-full text-xs" disabled={pending || disabled || !url.trim()}>
		{pending && action === 'connect' ? 'Connecting…' : 'Connect'}
	</Button>
	{#if status.defaultAvailable || status.connection}
		<div class="flex flex-wrap gap-2 border-t border-border pt-3">
			{#if status.defaultAvailable}
				<Button variant="outline" size="sm" class="text-xs" disabled={pending || disabled} onclick={() => void change('default')}>
					{pending && action === 'default' ? 'Connecting…' : 'Use default DB'}
				</Button>
			{/if}
			{#if status.connection}
				<Button variant="destructive" size="sm" class="ml-auto text-xs" disabled={pending || disabled} onclick={() => void change('disconnect')}>
					{pending && action === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
				</Button>
			{/if}
		</div>
	{/if}
</form>
