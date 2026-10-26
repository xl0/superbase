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
	/** The open database this URL names; requests carry its key. */
	const connection = $derived(status.ready ? status.current.connections.find((open) => databaseId(open) === params.db) : undefined);

	// Use the open database the URL names, otherwise connect the saved profile with that id.
	$effect(() => {
		const db = params.db;
		if (!status.ready || connection || attempted === db) return;
		attempted = db;
		const pinned = status.current.locked && status.current.connections[0];
		if (pinned) { void goto(tablesHref(databaseId(pinned)), { replace: true }); return; }
		const profile = loadProfiles().find((profile) => connectionId(profileTarget(profile.url)) === db);
		if (!profile) { problem = 'This link points to a database that is not among your saved connections.'; return; }
		connect({ url: profile.url, sslMode: profile.sslMode })
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
{:else if connection}
	{#key connection.key}<EditorApp status={{ connection, locked: status.current!.locked }} />{/key}
	{@render children()}
{:else if problem}
	<ConnectScreen status={{ connection: null, locked: status.current!.locked }} error={problem} />
{:else}
	<LoadingShell />
{/if}
