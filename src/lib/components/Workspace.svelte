<script module lang="ts">
	// One preferred width for every workspace, so switching between them keeps the layout steady.
	const panel = $state({ width: 240 });
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import PanelResizer from './PanelResizer.svelte';

	/** Workspace layout: a resizable side panel and the main area. */
	let { label, sidebar, children }: { label: string; sidebar: Snippet; children: Snippet } = $props();
	let windowWidth = $state(1024);
	// Clamp at render time so a temporarily narrow window does not overwrite the preferred width.
	const maxWidth = $derived(Math.max(160, Math.min(480, windowWidth / 2)));
	const width = $derived(Math.min(maxWidth, Math.max(160, panel.width)));
</script>

<svelte:window bind:innerWidth={windowWidth} />

<div class="flex h-full min-h-0 min-w-0 flex-1">
	<aside aria-label={label} class="relative flex h-full shrink-0 flex-col border-r bg-card" style:width="{width}px">
		<PanelResizer bind:width={panel.width} min={160} max={maxWidth} edge="right" label={`Resize ${label.toLowerCase()} panel`} />
		{@render sidebar()}
	</aside>
	<main class="flex min-h-0 min-w-0 flex-1 flex-col">{@render children()}</main>
</div>
