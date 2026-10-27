<script lang="ts">
	import { Database } from '@lucide/svelte';
	import ConnectionDialog from './ConnectionDialog.svelte';

	let { locked, error = '' }: { locked: boolean; error?: string } = $props();
</script>

<main class="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
	<div class="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
		<div class="mb-7 flex items-center gap-2.5">
			<div class="grid size-8 place-items-center rounded-md bg-muted text-foreground"><Database size={17} /></div>
			<span class="text-sm font-semibold tracking-tight">superbase</span>
		</div>
		<h1 class="text-xl font-semibold tracking-tight">Connect to Postgres</h1>
		<p class="mt-2 mb-5 text-xs leading-relaxed text-muted-foreground">Choose a saved connection or add a Postgres URL.</p>
		{#if error}<p role="alert" class="mb-4 text-xs break-words text-destructive">{error}</p>{/if}
		<ConnectionDialog connection={null} {locked} />
	</div>
</main>
