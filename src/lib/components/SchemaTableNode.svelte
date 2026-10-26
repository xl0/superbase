<script module lang="ts">
	import type { Node } from '@xyflow/svelte';
	import type { Table } from '#lib/types.js';

	/** Fixed card geometry, shared with the layout in SchemaDiagram. */
	export const WIDTH = 280;
	export const HEADER = 36;
	export const ROW = 28;
	/** `external`: referenced from the shown schema but living in another one. */
	export type TableNode = Node<{ table: Table; external: boolean; href: string }, 'table'>;
</script>

<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { ArrowUpRight, KeyRound, Link } from '@lucide/svelte';

	let { data }: NodeProps<TableNode> = $props();
</script>

<div class={['table-node overflow-hidden rounded-md border bg-card text-xs shadow-sm', data.external && 'opacity-60']} style:width="{WIDTH}px">
	<div class="flex items-center gap-2 border-b bg-muted/60 pr-1 pl-3" style:height="{HEADER}px">
		<span class="truncate font-mono font-medium">{data.external ? `${data.table.schema}.` : ''}{data.table.name}</span>
		<Button variant="ghost" size="icon-xs" class="nodrag ml-auto" aria-label={`Open ${data.table.schema}.${data.table.name} in the table editor`}
			title="Open in the table editor" href={data.href}><ArrowUpRight /></Button>
	</div>
	{#each data.table.columns as column (column.name)}
		<div class="relative flex items-center gap-2 border-t px-3 first-of-type:border-t-0" style:height="{ROW}px">
			<!-- Edges attach per column: referenced columns on the right, referencing ones on the left. -->
			<Handle type="target" position={Position.Left} id="{column.name}:in" isConnectable={false} />
			{#if column.primaryKey}<KeyRound class="size-3 shrink-0 text-primary" aria-label="Primary key" />
			{:else if column.foreignKey}<Link class="size-3 shrink-0 text-muted-foreground" aria-label="Foreign key" />
			{:else}<span class="size-3 shrink-0"></span>{/if}
			<span class="truncate font-mono">{column.name}</span>
			<span class="ml-auto shrink-0 truncate pl-2 font-mono text-[11px] text-muted-foreground" style:max-width="55%" title={column.type}>{column.type}</span>
			<Handle type="source" position={Position.Right} id="{column.name}:out" isConnectable={false} />
		</div>
	{/each}
</div>

<style>
	.table-node :global(.svelte-flow__handle) { opacity: 0; }
</style>
