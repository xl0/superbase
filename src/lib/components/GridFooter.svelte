<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	const start = $derived(editor.rows.length ? editor.rowsPage * editor.pageSize + 1 : 0);
	const end = $derived(editor.rows.length ? editor.rowsPage * editor.pageSize + editor.rows.length : 0);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
</script>

<footer class="flex min-h-11 shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
	<span class="font-mono text-[11px]">{start.toLocaleString()}–{end.toLocaleString()} displayed</span>
	{#if editor.hasFilters}<span class="text-[10px]">filtered</span>{/if}
	<div class="ml-auto flex items-center gap-2">
		<Select.Root type="single" value={String(editor.pageSize)} disabled={blocked} allowDeselect={false}
			onValueChange={(value) => { if (value) void editor.setPageSize(Number(value)); }}>
			<Select.Trigger size="sm" aria-label="Rows per page" class="text-xs">{editor.pageSize} rows</Select.Trigger>
			<Select.Content>
				{#each [100, 250, 500] as size}<Select.Item value={String(size)} label={`${size} rows`} />{/each}
			</Select.Content>
		</Select.Root>
		<Button variant="outline" size="icon-sm" disabled={blocked || editor.page === 0} aria-label="Previous page" onclick={() => void editor.setPage(editor.page - 1)}><ChevronLeft /></Button>
		<span class="px-1 font-mono text-[11px]">Page {editor.page + 1}</span>
		<Button variant="outline" size="icon-sm" disabled={blocked || !editor.hasMore} aria-label="Next page" onclick={() => void editor.setPage(editor.page + 1)}><ChevronRight /></Button>
	</div>
</footer>
