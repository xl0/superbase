<script lang="ts">
	import DataGrid from '#lib/components/DataGrid.svelte';
	import GridFooter from '#lib/components/GridFooter.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import TableDefinition from '#lib/components/TableDefinition.svelte';
	import TableToolbar from '#lib/components/TableToolbar.svelte';
	import { editor } from '#lib/state/editor.svelte.js';

	let tab = $state<'data' | 'definition'>('data');
</script>

<div class="flex h-dvh">
	<Sidebar />

	<main class="flex min-w-0 flex-1 flex-col">
		<TableToolbar bind:tab />

		{#if tab === 'data'}
			<div class="min-h-0 flex-1">
				{#key editor.tableKey}
					<DataGrid
						table={editor.table}
						rows={editor.pageRows}
						rowOffset={editor.page * editor.pageSize}
					/>
				{/key}
			</div>
			<GridFooter />
		{:else}
			<div class="min-h-0 flex-1">
				<TableDefinition />
			</div>
		{/if}
	</main>
</div>
