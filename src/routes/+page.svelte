<script lang="ts">
	import { goto } from '$app/navigation';
	import { connectionStatus } from '#lib/db.remote.js';
	import { connectionId, lastProfile, profileTarget } from '#lib/connection-profiles.js';
	import { databaseId, tablesHref } from '#lib/links.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectScreen from '#lib/components/ConnectScreen.svelte';
	import LoadingShell from '#lib/components/LoadingShell.svelte';

	const status = connectionStatus();
	// Open the saved connection used last (its route connects it if needed), else any open database.
	const target = $derived.by(() => {
		if (!status.ready) return null;
		const profile = status.current.locked ? undefined : lastProfile();
		if (profile) return connectionId(profileTarget(profile.url));
		const open = status.current.connections[0];
		return open ? databaseId(open) : null;
	});
	$effect(() => { if (target) void goto(tablesHref(target), { replace: true }); });
</script>

{#if status.error}
	<main class="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
		<div class="w-full max-w-md space-y-3">
			<h1 class="text-lg font-semibold">Cannot load connection status</h1>
			<p role="alert" class="text-sm break-words text-destructive">{message(status.error)}</p>
			<Button size="sm" onclick={() => void status.refresh()}>Retry</Button>
		</div>
	</main>
{:else if !status.ready || target}
	<LoadingShell />
{:else}
	<ConnectScreen status={{ connection: null, locked: status.current.locked }} />
{/if}
