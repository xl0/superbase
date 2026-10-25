<script lang="ts">
	import { connect, connectionStatus } from '#lib/db.remote.js';
	import { lastProfile } from '#lib/connection-profiles.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectScreen from '#lib/components/ConnectScreen.svelte';
	import EditorApp from '#lib/components/EditorApp.svelte';
	import LoadingShell from '#lib/components/LoadingShell.svelte';

	const status = connectionStatus();
	let reconnecting = $state(true);
	let reconnectError = $state('');

	// After a server restart, reconnect to the last saved profile instead of showing the connect screen.
	$effect(() => {
		if (!status.ready || !reconnecting) return;
		const profile = !status.current.connection && !status.current.locked ? lastProfile() : undefined;
		if (!profile) { reconnecting = false; return; }
		connect({ url: profile.url, sslMode: profile.sslMode, expected: null })
			.then(() => status.refresh())
			.catch((cause) => { reconnectError = `Could not reconnect to “${profile.name}”: ${message(cause)}`; })
			.finally(() => { reconnecting = false; });
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
{:else if !status.ready || reconnecting}
	<LoadingShell />
{:else if !status.current.connection}
	<ConnectScreen status={status.current} error={reconnectError} />
{:else}
	<EditorApp status={status.current} />
{/if}
