<script lang="ts">
	import { KeyRound, Link2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
</script>

<div class="h-full overflow-auto p-5">
	<div class="mx-auto max-w-5xl">
		<div class="mb-4 flex items-baseline gap-2">
			<h2 class="font-mono text-sm font-medium">{editor.table.schema}.{editor.table.name}</h2>
			<span class="text-xs text-muted-foreground">{editor.table.columns.length} columns</span>
		</div>
		<div class="overflow-x-auto rounded-md border border-border bg-card">
			<table class="w-full text-left text-xs">
				<caption class="sr-only">Column definitions for {editor.table.name}</caption>
				<thead class="border-b border-border bg-muted/50 text-[10px] tracking-wide text-muted-foreground uppercase">
					<tr><th scope="col" class="px-3 py-2 font-medium">Column</th><th scope="col" class="px-3 py-2 font-medium">Type</th><th scope="col" class="px-3 py-2 font-medium">Nullable</th><th scope="col" class="px-3 py-2 font-medium">Default / generation</th></tr>
				</thead>
				<tbody>
					{#each editor.table.columns as column (column.name)}
						<tr class="border-b border-border last:border-0">
							<th scope="row" class="px-3 py-2 text-left font-normal">
								<div class="flex items-center gap-1.5 font-mono">
									{#if column.primaryKey}<KeyRound class="size-3 shrink-0 text-primary" /><span class="sr-only">Primary key:</span>{/if}
									{#if column.foreignKey}<Link2 class="size-3 shrink-0 text-muted-foreground" /><span class="sr-only">Foreign key:</span>{/if}
									{column.name}
								</div>
								{#if column.comment}<p class="mt-1 max-w-sm text-[11px] text-muted-foreground">{column.comment}</p>{/if}
							</th>
							<td class="px-3 py-2 font-mono text-[11px] text-muted-foreground">
								{column.type}
								{#if column.enumValues}<div class="mt-1 text-[10px]">{column.enumValues.join(' · ')}</div>{/if}
							</td>
							<td class="px-3 py-2 text-muted-foreground">{column.nullable ? 'yes' : 'no'}</td>
							<td class="max-w-md px-3 py-2 font-mono text-[11px] break-words text-muted-foreground">
								{#if column.generated}<Badge variant="secondary" class="mr-1 text-[10px]">generated</Badge>{/if}
								{#if column.identity}<Badge variant="secondary" class="mr-1 text-[10px]">identity {column.identity}</Badge>{/if}
								{column.defaultValue ?? '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if editor.table.columns.some((column) => column.foreignKey)}
			<section class="mt-5 space-y-2" aria-label="Foreign key relations">
				<h3 class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Relations</h3>
				{#each editor.table.columns as column (column.name)}
					{#if column.foreignKey}<p class="font-mono text-xs break-all text-muted-foreground">{column.name} → {column.foreignKey.schema}.{column.foreignKey.table}.{column.foreignKey.column}</p>{/if}
				{/each}
			</section>
		{/if}
	</div>
</div>
