<script lang="ts">
	import { goto } from '$app/navigation';
	import { connect, connectionStatus } from '#lib/db.remote.js';
	import { connectionId, loadProfiles, profileTarget, rememberProfile } from '#lib/connection-profiles.js';
	import { databaseId, tablesHref } from '#lib/links.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectScreen from '#lib/components/ConnectScreen.svelte';
	import EditorApp from '#lib/components/EditorApp.svelte';
	import LoadingShell from '#lib/components/LoadingShell.svelte';
	import type { LayoutProps } from './$types';

	let { children, params }: LayoutProps = $props();
	const status = connectionStatus();
	let problem = $state('');
	/** The id this page already tried to connect to: one attempt, then the connection manager. */
	let attempted = '';
	const connected = $derived(status.ready && status.current.connection ? databaseId(status.current.connection) : null);

	// The URL names its database: open it if connected, otherwise connect the saved profile with that id.
	// Connecting switches the server for every tab (one global connection).
	$effect(() => {
		const db = params.db;
		if (!status.ready || connected === db || attempted === db) return;
		attempted = db;
		if (status.current.locked && connected) { void goto(tablesHref(connected), { replace: true }); return; }
		const profile = loadProfiles().find((profile) => connectionId(profileTarget(profile.url)) === db);
		if (!profile) { problem = 'This link points to a database that is not among your saved connections.'; return; }
		connect({ url: profile.url, sslMode: profile.sslMode, expected: status.current.connection?.id ?? null })
			.then(() => { rememberProfile(profile.id); return status.refresh(); })
			.catch((cause) => { problem = `Could not connect to “${profile.name}”: ${message(cause)}`; });
	});
</script>

{#if status.error}
	<main class="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
		<div class="w-full max-w-md space-y-3">
			<h1 class="text-lg font-semibold">Cannot load connection status</h1>
			<p role="alert" class="text-sm break-words text-destructive">{message(status.error)}</p>
			<Button size="sm" onclick={() => void status.refresh()}>Retry</Button>
		</div>
	</main>
{:else if connected && connected === params.db}
	{#key status.current!.connection?.id}<EditorApp status={status.current!} />{/key}
	{@render children()}
{:else if problem}
	<ConnectScreen status={status.current!} error={problem} />
{:else}
	<LoadingShell />
{/if}
