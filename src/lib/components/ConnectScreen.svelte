<script lang="ts">
	import { Database } from '@lucide/svelte';
	import type { ConnectionStatus } from '#lib/types.js';
	import ConnectForm from './ConnectForm.svelte';

	let { status, restoreError = '' }: { status: ConnectionStatus; restoreError?: string } = $props();
</script>

<main class="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
	<div class="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
		<div class="mb-7 flex items-center gap-2.5">
			<div class="grid size-8 place-items-center rounded-md bg-muted text-foreground"><Database size={17} /></div>
			<span class="text-sm font-semibold tracking-tight">superbase</span>
		</div>
		<h1 class="text-xl font-semibold tracking-tight">Connect to Postgres</h1>
		<p class="mt-2 mb-5 text-xs leading-relaxed text-muted-foreground">
			Browse your tables and edit rows. The server keeps credentials only in memory.
			Optionally remember your connection in this browser.
		</p>
		{#if restoreError}
			<p role="alert" class="mb-4 rounded-md border border-destructive/30 p-3 text-xs text-destructive">{restoreError}</p>
		{/if}
		{#if status.error}
			<p role="alert" class="mb-4 rounded-md border border-destructive/30 p-3 text-xs text-destructive">{status.error}</p>
		{/if}
		{#if status.expired}
			<p role="alert" class="mb-4 rounded-md border border-border bg-muted p-3 text-xs">
				Your database session expired. Reconnect to continue.
			</p>
		{/if}
		<ConnectForm {status} />
		<p class="mt-5 text-xs leading-relaxed text-muted-foreground">
			Server sessions expire after two idle hours or a restart. Remembered connections
			reconnect when you reload. Disconnect pauses this; Forget erases the saved URL.
			Set <code class="text-foreground">DATABASE_URL</code> for an optional default.
		</p>
	</div>
</main>
