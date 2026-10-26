<script lang="ts">
	import '@xyflow/svelte/dist/style.css';
	import { Background, Controls, SvelteFlow, type Edge } from '@xyflow/svelte';
	import { Graph, layout } from '@dagrejs/dagre';
	import { RotateCw } from '@lucide/svelte';
	import { page } from '$app/state';
	import { editor } from '#lib/state/editor.svelte.js';
	import { tablesHref } from '#lib/links.js';
	import { tableKey, type Table } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import SchemaTableNode, { HEADER, ROW, WIDTH, type TableNode } from './SchemaTableNode.svelte';

	let schema = $state(editor.activeSchema || 'public');
	const nodeTypes = { table: SchemaTableNode };

	/** One schema's tables plus tables they reference elsewhere; referenced tables lay out to the left. */
	function diagram(tables: Table[], schema: string): { nodes: TableNode[]; edges: Edge[] } {
		const shown = tables.filter((table) => table.schema === schema);
		const edges: Edge[] = [];
		for (const table of [...shown]) {
			for (const column of table.columns) {
				const fk = column.foreignKey;
				if (!fk) continue;
				const source = tableKey(fk.schema, fk.table);
				const referenced = tables.find((other) => other.schema === fk.schema && other.name === fk.table);
				if (!referenced) continue;
				if (!shown.includes(referenced)) shown.push(referenced);
				const referencedColumn = fk.referencedColumns[fk.columns.indexOf(column.name)];
				edges.push({
					id: JSON.stringify([table.schema, table.name, column.name]), type: 'smoothstep',
					ariaLabel: `${table.name}.${column.name} references ${fk.table}.${referencedColumn}`,
					source, sourceHandle: `${referencedColumn}:out`,
					target: tableKey(table.schema, table.name), targetHandle: `${column.name}:in`
				});
			}
		}
		const graph = new Graph().setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 120 }).setDefaultEdgeLabel(() => ({}));
		for (const table of shown) graph.setNode(tableKey(table.schema, table.name), { width: WIDTH, height: HEADER + ROW * table.columns.length });
		for (const edge of edges) if (edge.source !== edge.target) graph.setEdge(edge.source, edge.target);
		layout(graph);
		const nodes = shown.map((table): TableNode => {
			const { x, y, width, height } = graph.node(tableKey(table.schema, table.name));
			return {
				id: tableKey(table.schema, table.name), type: 'table', position: { x: x - width / 2, y: y - height / 2 },
				data: { table, external: table.schema !== schema, href: tablesHref(page.params.db!, { schema: table.schema, table: table.name, filters: [], sort: [], page: 0, reference: null }) }
			};
		});
		return { nodes, edges };
	}

	const layoutResult = $derived(diagram(editor.tables, schema));
	// Re-laid out whenever the tables change; dragging only moves cards until then.
	let nodes = $derived(layoutResult.nodes);
	let edges = $derived(layoutResult.edges);
</script>

<div class="flex h-full flex-col">
	<div class="flex shrink-0 items-center gap-3 border-b px-4 py-2">
		<Select.Root type="single" bind:value={schema} allowDeselect={false}>
			<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
			<Select.Content>{#each editor.schemas as name}<Select.Item value={name} label={name} />{/each}</Select.Content>
		</Select.Root>
		<p class="text-xs text-muted-foreground">↗ opens a table. Edit columns, keys and indexes from the table editor.</p>
		<Button variant="outline" size="icon-sm" class="ml-auto" disabled={editor.navigationBlocked || editor.loading} aria-label="Refresh database"
			onclick={() => void editor.reload()}><RotateCw /></Button>
	</div>
	{#if nodes.length}
		{#key schema}
			<SvelteFlow bind:nodes bind:edges {nodeTypes} colorMode="dark" fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.1} nodesConnectable={false} elementsSelectable={false} class="schema-flow min-h-0 flex-1">
				<Background />
				<Controls showLock={false} />
			</SvelteFlow>
		{/key}
	{:else}
		<p class="p-4 text-xs text-muted-foreground">No tables in this schema.</p>
	{/if}
</div>

<style>
	:global(.schema-flow) {
		--xy-background-color: var(--background);
		--xy-background-pattern-dots-color: var(--border);
		--xy-edge-stroke: var(--muted-foreground);
		--xy-controls-button-background-color: var(--card);
		--xy-controls-button-background-color-hover: var(--accent);
		--xy-controls-button-color: var(--foreground);
		--xy-controls-button-border-color: var(--border);
	}
</style>
