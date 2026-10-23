<script lang="ts">
	import { ChevronLeft, ChevronRight } from 'lucide-svelte';
	import { editor } from '#lib/state/editor.svelte.js';

	const start = $derived(editor.sorted.length === 0 ? 0 : editor.page * editor.pageSize + 1);
	const end = $derived(Math.min(editor.sorted.length, (editor.page + 1) * editor.pageSize));

	function setPageSize(value: string) {
		editor.pageSize = Number(value);
		editor.setPage(0);
	}
</script>

<footer
	class="flex h-9 shrink-0 items-center gap-3 border-t border-line bg-bg px-3.5 font-mono text-[10.5px] text-muted"
>
	<span>{start}–{end} of {editor.sorted.length.toLocaleString('en-US')}</span>
	{#if editor.search}
		<span class="text-faint">filtered from {editor.rows.length.toLocaleString('en-US')}</span>
	{/if}

	<div class="ml-auto flex items-center gap-2">
		<div class="relative">
			<select
				value={editor.pageSize}
				onchange={(event) => setPageSize(event.currentTarget.value)}
				class="h-6 appearance-none rounded border border-line bg-surface pr-5 pl-2 font-mono text-[10px] outline-none focus:border-line-strong"
			>
				<option value={100}>100 rows</option>
				<option value={250}>250 rows</option>
				<option value={500}>500 rows</option>
			</select>
			<ChevronRight
				size={10}
				class="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rotate-90 text-faint"
			/>
		</div>

		<div class="flex items-center gap-0.5">
			<button
				disabled={editor.page === 0}
				onclick={() => editor.setPage(editor.page - 1)}
				class="grid size-6 place-items-center rounded border border-line bg-surface text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
			>
				<ChevronLeft size={12} />
			</button>
			<span class="min-w-16 text-center text-[10px] text-muted">
				{editor.page + 1} / {editor.pageCount}
			</span>
			<button
				disabled={editor.page >= editor.pageCount - 1}
				onclick={() => editor.setPage(editor.page + 1)}
				class="grid size-6 place-items-center rounded border border-line bg-surface text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
			>
				<ChevronRight size={12} />
			</button>
		</div>
	</div>
</footer>
