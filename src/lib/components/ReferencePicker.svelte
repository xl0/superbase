<script lang="ts">
	import * as Table from '#lib/components/ui/table/index.js';
	import { Search, ChevronLeft, ChevronRight } from '@lucide/svelte';
	import { tableRows } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { fresh, message } from '#lib/utils.js';
	import { displayValue } from '#lib/format.js';
	import type { Column, Row, Values } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';

	let { foreignKey, current, disabled = false, onselect }: {
		foreignKey: NonNullable<Column['foreignKey']>;
		current: Values;
		disabled?: boolean;
		onselect: (row: Row) => void;
	} = $props();
	let search = $state('');
	let page = $state(0);
	let rows = $state<Row[]>([]);
	let hasMore = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let retry = $state(0);
	const table = $derived(editor.tables.find((table) => table.schema === foreignKey.schema && table.name === foreignKey.table));

	$effect(() => {
		const args = { connection: editor.connection, schema: foreignKey.schema, table: foreignKey.table,
			page, pageSize: 25, sort: [], search };
		void retry;
		let cancelled = false;
		loading = true;
		error = null;
		const timer = setTimeout(async () => {
			try {
				const result = await fresh(tableRows(args));
				if (cancelled) return;
				rows = result.rows;
				hasMore = result.hasMore;
			} catch (value) {
				if (!cancelled) { rows = []; hasMore = false; error = message(value); }
			} finally { if (!cancelled) loading = false; }
		}, search ? 250 : 0);
		return () => { cancelled = true; clearTimeout(timer); };
	});
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" aria-busy={loading}>
	<p class="text-xs text-muted-foreground">Choose a record to fill <span class="font-mono">{foreignKey.columns.join(', ')}</span>.</p>
	<div class="relative">
		<Search class="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
		<Input data-reference-search aria-label="Search referenced records" placeholder="Search referenced records…" value={search}
			oninput={(event) => { search = event.currentTarget.value; page = 0; }} class="pl-9 text-xs" />
	</div>
	{#if error}
		<div role="alert" class="flex items-center gap-2 text-xs text-destructive"><span class="min-w-0 break-words">{error}</span><Button variant="outline" size="xs" onclick={() => retry++}>Retry</Button></div>
	{/if}
	{#if disabled}<p class="text-xs text-muted-foreground">Reference selection is unavailable while saving or for read-only fields.</p>{/if}
	<div class="min-h-0 flex-1 overflow-auto rounded-md border">
		{#if table}
			<Table.Root containerClass="overflow-visible" class="w-full text-left text-xs">
				<Table.Caption class="sr-only mt-0">Available records in {foreignKey.schema}.{foreignKey.table}</Table.Caption>
				<Table.Header class="sticky top-0 z-10 bg-card [&_tr]:border-0"><Table.Row class="border-0 hover:bg-transparent transition-none">
					<Table.Head class="h-auto border-b p-2 font-bold text-inherit" scope="col">Select</Table.Head>
					{#each table.columns as column (column.name)}<Table.Head class="h-auto border-b p-2 font-mono font-medium whitespace-nowrap text-inherit" scope="col">{column.name}</Table.Head>{/each}
				</Table.Row></Table.Header>
				<Table.Body>
					{#each rows as row (row.key)}
						{@const selected = foreignKey.referencedColumns.every((name, i) => row.values[name] != null && row.values[name] === current[foreignKey.columns[i]])}
						<Table.Row class={selected ? 'border-0 bg-muted hover:bg-muted transition-none' : 'border-0 hover:bg-muted/50 transition-none'}>
							<Table.Cell class="border-b p-2">
								<Button variant={selected ? 'secondary' : 'outline'} size="xs" disabled={disabled || loading || foreignKey.referencedColumns.some((name) => row.values[name] == null)}
									onclick={() => onselect(row)} aria-label={`Select referenced record ${foreignKey.referencedColumns.map((name) => row.values[name]).join(', ')}`}>
									{selected ? 'Current' : 'Select'}
								</Button>
							</Table.Cell>
							{#each table.columns as column (column.name)}
								<Table.Cell class="max-w-64 truncate border-b p-2 font-mono" title={displayValue(row.values[column.name], column)}>{displayValue(row.values[column.name], column)}</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{:else}<p class="p-4 text-xs text-muted-foreground">Referenced table metadata is unavailable. Refresh the database.</p>{/if}
		{#if loading && !rows.length}
			<div aria-hidden="true" class="space-y-3 p-3"><Skeleton class="h-6 w-full" /><Skeleton class="h-6 w-3/4" /><Skeleton class="h-6 w-1/2" /></div>
		{/if}
		{#if !loading && !error && !rows.length}<p class="p-6 text-center text-xs text-muted-foreground">No matching records.</p>{/if}
	</div>
	<div class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
		{#if loading}<span role="status" class="flex items-center gap-2"><Skeleton class="h-2 w-8" />Loading records…</span>{/if}
		<div class="ml-auto flex items-center gap-2">
			<Button variant="outline" size="icon-sm" aria-label="Previous referenced records" disabled={loading || page === 0} onclick={() => page--}><ChevronLeft /></Button>
			<span>Page {page + 1}</span>
			<Button variant="outline" size="icon-sm" aria-label="Next referenced records" disabled={loading || !hasMore} onclick={() => page++}><ChevronRight /></Button>
		</div>
	</div>
</div>
