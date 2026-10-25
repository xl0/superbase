<script lang="ts">
	import { ArrowDown, ArrowUp, ChevronDown, Copy, Pencil, Trash2, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Column } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

	let { column, onedit }: { column: Column; onedit: (mode: SchemaEditMode, anchor?: HTMLElement | null) => void } = $props();
	let trigger = $state<HTMLButtonElement | null>(null);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
	const sort = $derived(editor.sort.find((rule) => rule.column === column.name));

	function order(direction: 'asc' | 'desc' | null) {
		if (blocked) return;
		void editor.setSort(direction === null ? editor.sort.filter((rule) => rule.column !== column.name)
			: sort ? editor.sort.map((rule) => rule.column === column.name ? { ...rule, direction } : rule)
			: [...editor.sort, { column: column.name, direction }]);
	}

	async function copyName() {
		try { await navigator.clipboard.writeText(column.name); }
		catch (cause) { window.alert(message(cause)); }
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} bind:ref={trigger} variant="ghost" size="icon-xs" class="mr-1 shrink-0" disabled={blocked}
				aria-label={`Column actions for ${column.name}`}><ChevronDown /></Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-56" onCloseAutoFocus={(event) => {
		if (editor.schemaEditing) event.preventDefault();
		else if (editor.loading) { event.preventDefault(); trigger?.closest<HTMLElement>('[role="grid"]')?.focus(); }
	}}>
		<DropdownMenu.Item disabled={blocked} onSelect={() => order('asc')}><ArrowUp />Sort ascending</DropdownMenu.Item>
		<DropdownMenu.Item disabled={blocked} onSelect={() => order('desc')}><ArrowDown />Sort descending</DropdownMenu.Item>
		{#if sort}<DropdownMenu.Item disabled={blocked} onSelect={() => order(null)}><X />Remove sort</DropdownMenu.Item>{/if}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => void copyName()}><Copy />Copy name</DropdownMenu.Item>
		<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'alterColumn', column: column.name }, trigger)}><Pencil />Edit column</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" disabled={blocked} onSelect={() => onedit({ kind: 'dropColumn', column: column.name }, trigger)}><Trash2 />Delete column</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
