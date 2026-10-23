<script lang="ts">
	import { Check, Plus, RotateCw } from 'lucide-svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { formatNumber } from '#lib/format.js';

	let { tab = $bindable('data') }: { tab: 'data' | 'definition' } = $props();
</script>

<header class="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-bg px-3.5">
	<div class="flex min-w-0 items-baseline gap-1.5">
		<span class="font-mono text-xs text-muted">{editor.table.schema}</span>
		<span class="text-xs text-faint">/</span>
		<span class="truncate font-mono text-[13px] font-medium">{editor.table.name}</span>
	</div>

	<span class="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
		{formatNumber(editor.sorted.length)} rows
	</span>

	<div class="ml-2 flex h-7 items-center gap-0.5 rounded-md border border-line bg-surface p-0.5">
		<button
			onclick={() => (tab = 'data')}
			class={[
				'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
				tab === 'data' ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg'
			]}
		>
			Data
		</button>
		<button
			onclick={() => (tab = 'definition')}
			class={[
				'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
				tab === 'definition' ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg'
			]}
		>
			Definition
		</button>
	</div>

	<div class="ml-auto flex items-center gap-1.5">
		{#if editor.dirtyCount > 0}
			<span class="mr-1 font-mono text-[10px] text-warn">{editor.dirtyCount} unsaved</span>
			<button
				onclick={() => editor.revert()}
				class="h-7 rounded-md border border-line px-2.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg"
			>
				Revert
			</button>
			<button
				onclick={() => editor.save()}
				class="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11px] font-medium text-[#08130d] transition-colors hover:bg-accent-dim"
			>
				<Check size={12} strokeWidth={2.5} />
				Save
			</button>
		{:else if editor.savedAt}
			<span class="mr-1 flex items-center gap-1 font-mono text-[10px] text-accent">
				<Check size={11} strokeWidth={2.5} /> saved
			</span>
		{/if}

		<button
			onclick={() => editor.insertRow()}
			class="flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg"
		>
			<Plus size={12} />
			Insert row
		</button>

		<button
			onclick={() => editor.reload()}
			title="Refresh"
			class="grid size-7 place-items-center rounded-md border border-line bg-surface text-muted transition-colors hover:bg-hover hover:text-fg"
		>
			<RotateCw size={12} />
		</button>
	</div>
</header>
