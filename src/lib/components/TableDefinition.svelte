<script lang="ts">
	import { KeyRound, Link2 } from 'lucide-svelte';
	import { editor } from '#lib/state/editor.svelte.js';
</script>

<div class="h-full overflow-auto p-6">
	<div class="mx-auto max-w-3xl">
		<div class="mb-4 flex items-baseline gap-2">
			<h2 class="font-mono text-sm font-medium">{editor.table.name}</h2>
			<span class="font-mono text-[11px] text-faint">{editor.table.columns.length} columns</span>
		</div>

		<div class="overflow-hidden rounded-lg border border-line bg-surface">
			<div class="grid grid-cols-[1.2fr_1fr_0.6fr_1.4fr] border-b border-line bg-panel px-3 py-2 font-mono text-[10px] tracking-wide text-faint uppercase">
				<span>Column</span>
				<span>Type</span>
				<span>Null</span>
				<span>Default</span>
			</div>
			{#each editor.table.columns as column (column.name)}
				<div class="grid grid-cols-[1.2fr_1fr_0.6fr_1.4fr] items-center border-b border-line/60 px-3 py-2 last:border-0">
					<div class="flex min-w-0 items-center gap-1.5">
						{#if column.primaryKey}
							<KeyRound size={10} class="shrink-0 text-accent" />
						{:else if column.foreignKey}
							<Link2 size={10} class="shrink-0 text-info/80" />
						{/if}
						<span class="truncate font-mono text-[11.5px]">{column.name}</span>
					</div>
					<span class="truncate font-mono text-[11px] text-muted">{column.type}</span>
					<span class="font-mono text-[11px] text-muted">{column.nullable ? 'yes' : 'no'}</span>
					<span class="truncate font-mono text-[11px] text-faint">{column.defaultValue ?? '—'}</span>
				</div>
			{/each}
		</div>

		{#if editor.table.columns.some((column) => column.foreignKey)}
			<div class="mt-4 space-y-1">
				<h3 class="text-[10px] font-medium tracking-[0.08em] text-faint uppercase">Relations</h3>
				{#each editor.table.columns.filter((column) => column.foreignKey) as column (column.name)}
					<p class="font-mono text-[11px] text-muted">
						{column.name} → {column.foreignKey!.schema}.{column.foreignKey!.table}.{column.foreignKey!.column}
					</p>
				{/each}
			</div>
		{/if}
	</div>
</div>
