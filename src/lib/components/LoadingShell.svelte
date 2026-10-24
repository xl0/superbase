<script lang="ts">
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
</script>

<div role="status" aria-busy="true" class="flex h-dvh bg-background text-foreground">
	<span class="sr-only">Loading database…</span>
	<div aria-hidden="true" class="flex w-12 shrink-0 flex-col items-center gap-4 border-r bg-card py-4">
		<Skeleton class="mb-3 size-5" /><Skeleton class="size-6" /><Skeleton class="size-6" /><Skeleton class="mt-auto size-6" />
	</div>
	<div aria-hidden="true" class="w-48 shrink-0 space-y-5 border-r bg-card p-4 lg:w-60">
		<div class="mb-8 text-sm font-semibold">Table editor</div>
		<Skeleton class="h-5 w-4/5" />
		<Skeleton class="h-8 w-full" />
		<div class="space-y-3 pt-4">
			{#each ['85%', '65%', '75%', '60%', '70%'] as width}
				<div class="flex items-center gap-3"><Skeleton class="size-4 shrink-0" /><Skeleton class="h-4" style={`width:${width}`} /></div>
			{/each}
		</div>
	</div>
	<div aria-hidden="true" class="min-w-0 flex-1">
		<div class="flex h-12 items-center border-b px-4"><Skeleton class="h-4 w-40" /></div>
		<div class="h-12 border-b"></div>
		<div class="space-y-3 p-3">
			<Skeleton class="h-6 w-full" />
			<Skeleton class="h-6 w-3/4" />
			<Skeleton class="h-6 w-1/2" />
		</div>
	</div>
</div>
