<script lang="ts">
	import { connect, connectionStatus } from '#lib/db.remote.js';
	import type { ConnectionStatus } from '#lib/types.js';
	import { rememberedConnection, restorationAllowed } from '#lib/remembered-connection.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectScreen from '#lib/components/ConnectScreen.svelte';
	import EditorApp from '#lib/components/EditorApp.svelte';
	import LoadingShell from '#lib/components/LoadingShell.svelte';

	const status = connectionStatus();
	const error = $derived(status.error ? message(status.error) : '');
	let initialized = $state(false);
	let restoreError = $state('');
	let started = false;

	$effect(() => {
		if (!status.ready || started) return;
		started = true;
		void restore(status.current);
	});

	async function restore(current: ConnectionStatus) {
		try {
			// Bootstrap only: never replace a mounted workspace or another active browser connection.
			if (restorationAllowed() && (!current.connection || current.connection.source === 'env')) {
				const saved = rememberedConnection();
				if (saved?.autoConnect) {
					await connect({ url: saved.url, expected: current.connection?.id ?? null });
					await status.refresh();
				}
			}
		} catch (value) {
			restoreError = `Could not restore the saved connection: ${message(value)}`;
		} finally {
			initialized = true;
		}
	}
</script>

{#if status.error}
	<main class="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
		<div class="w-full max-w-md space-y-3">
			<h1 class="text-lg font-semibold">Cannot load connection status</h1>
			<p role="alert" class="text-sm break-words text-destructive">{error}</p>
			<Button size="sm" onclick={() => void status.refresh()}>Retry</Button>
		</div>
	</main>
{:else if !status.ready || !initialized}
	<LoadingShell />
{:else if restoreError || !status.current.connection}
	<ConnectScreen status={status.current} {restoreError} />
{:else}
	{#key status.current.connection.id}
		<EditorApp status={status.current} />
	{/key}
{/if}
