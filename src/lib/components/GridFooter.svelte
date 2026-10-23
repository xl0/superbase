<script lang="ts">
	import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-svelte';
	import { editor } from '#lib/state/editor.svelte.js';

	const total = $derived(editor.rowCount);
	const start = $derived(total === 0 ? 0 : editor.page * editor.pageSize + 1);
	const end = $derived(editor.page * editor.pageSize + editor.pageRows.length);

	function setPageSize(value: string) {
		void editor.setPageSize(Number(value));
	}

	function goToPage(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		if (!Number.isNaN(value)) void editor.setPage(value - 1);
	}
</script>

<footer
	class="flex h-10 shrink-0 items-center gap-3 border-t border-line bg-bg px-3.5 text-[12px] text-muted"
>
	<span class="font-mono text-[11.5px]">{start}–{end} of {total.toLocaleString('en-US')}</span>
	{#if editor.search}
		<span class="font-mono text-[10px] text-faint">filtered</span>
	{/if}

	<div class="ml-auto flex items-center gap-2">
		<div class="relative">
			<select
				value={editor.pageSize}
				onchange={(event) => setPageSize(event.currentTarget.value)}
				class="h-7 appearance-none rounded-md border border-line bg-surface pr-6 pl-2.5 font-mono text-[11px] outline-none focus:border-line-strong"
			>
				<option value={100}>100 rows</option>
				<option value={250}>250 rows</option>
				<option value={500}>500 rows</option>
			</select>
			<ChevronDown
				size={11}
				class="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-faint"
			/>
		</div>

		<div class="flex items-center gap-1">
			<button
				disabled={editor.page === 0}
				onclick={() => void editor.setPage(editor.page - 1)}
				title="Previous page"
				class="grid size-7 place-items-center rounded-md border border-line bg-surface text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
			>
				<ChevronLeft size={12} />
			</button>

			<span class="px-1 text-[12px] text-muted">Page</span>
			<input
				value={editor.page + 1}
				onchange={goToPage}
				inputmode="numeric"
				class="h-7 w-9 rounded-md border border-line bg-surface text-center font-mono text-[11.5px] outline-none focus:border-line-strong"
			/>
			<span class="text-[12px] text-muted">of {editor.pageCount}</span>

			<button
				disabled={editor.page >= editor.pageCount - 1}
				onclick={() => void editor.setPage(editor.page + 1)}
				title="Next page"
				class="grid size-7 place-items-center rounded-md border border-line bg-surface text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-35"
			>
				<ChevronRight size={12} />
			</button>
		</div>
	</div>
</footer>
