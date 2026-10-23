<script lang="ts">
	import { connectionStatus } from '#lib/db.remote.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectScreen from '#lib/components/ConnectScreen.svelte';
	import EditorApp from '#lib/components/EditorApp.svelte';

	const status = connectionStatus();
	const error = $derived(status.error ? message(status.error) : '');
</script>

{#if status.error}
	<main class="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
		<div class="w-full max-w-md space-y-3">
			<h1 class="text-lg font-semibold">Cannot load connection status</h1>
			<p role="alert" class="text-sm break-words text-destructive">{error}</p>
			<Button size="sm" onclick={() => void status.refresh()}>Retry</Button>
		</div>
	</main>
{:else if !status.ready}
	<div role="status" class="grid h-dvh place-items-center bg-background text-xs text-muted-foreground">Loading connection…</div>
{:else if !status.current.connection}
	<ConnectScreen status={status.current} />
{:else}
	{#key status.current.connection.id}
		<EditorApp status={status.current} />
	{/key}
{/if}
