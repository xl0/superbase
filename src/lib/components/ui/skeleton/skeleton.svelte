<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let { ref = $bindable(null), class: className, ...restProps }: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div bind:this={ref} data-slot="skeleton" aria-hidden="true"
	class={cn('rounded-md bg-muted motion-safe:animate-pulse', className)} {...restProps}></div>
