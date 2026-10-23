<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';

	const start = $derived(editor.rows.length ? editor.rowsPage * editor.pageSize + 1 : 0);
	const end = $derived(editor.rows.length ? editor.rowsPage * editor.pageSize + editor.rows.length : 0);
	const blocked = $derived(editor.busy || editor.loading);
</script>

<footer class="flex min-h-11 shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
	<span class="font-mono text-[11px]">{start.toLocaleString()}–{end.toLocaleString()} displayed</span>
	{#if editor.rowsPage === 0 && editor.draftCount > 0}<span class="text-[11px]">+ {editor.draftCount} unsaved drafts</span>{/if}
	{#if editor.search || editor.filter}<span class="text-[10px]">filtered</span>{/if}
	<div class="ml-auto flex items-center gap-2">
		<NativeSelect.Root size="sm" value={editor.pageSize} aria-label="Rows per page" disabled={blocked}
			onchange={(event) => void editor.setPageSize(Number(event.currentTarget.value))}>
			<NativeSelect.Option value={100}>100 rows</NativeSelect.Option>
			<NativeSelect.Option value={250}>250 rows</NativeSelect.Option>
			<NativeSelect.Option value={500}>500 rows</NativeSelect.Option>
		</NativeSelect.Root>
		<Button variant="outline" size="icon-sm" disabled={blocked || editor.page === 0} aria-label="Previous page" onclick={() => void editor.setPage(editor.page - 1)}><ChevronLeft /></Button>
		<span class="px-1 font-mono text-[11px]">Page {editor.page + 1}</span>
		<Button variant="outline" size="icon-sm" disabled={blocked || !editor.hasMore} aria-label="Next page" onclick={() => void editor.setPage(editor.page + 1)}><ChevronRight /></Button>
	</div>
</footer>
