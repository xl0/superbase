<script lang="ts">
	import { EllipsisVertical, KeyRound, Pencil, Trash2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { editable, type Table } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

	let { table, onedit }: {
		table: Table;
		onedit: (mode: SchemaEditMode, anchor?: HTMLElement | null, table?: Table) => void;
	} = $props();
	let trigger = $state<HTMLButtonElement | null>(null);
	const blocked = $derived(editor.navigationBlocked || editor.loading);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} bind:ref={trigger} variant="ghost" size="icon-xs" class="mr-1 text-muted-foreground" disabled={blocked}
				aria-label={`Table actions for ${table.name}`}><EllipsisVertical /></Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-52" onCloseAutoFocus={(event) => { if (editor.schemaEditing) event.preventDefault(); }}>
		<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'renameTable' }, trigger, table)}><Pencil />Rename table</DropdownMenu.Item>
		{#if !editable(table)}
			<DropdownMenu.Item disabled={blocked || !table.columns.length} onSelect={() => onedit({ kind: 'addPrimaryKey' }, trigger, table)}><KeyRound />Add primary key</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" disabled={blocked} onSelect={() => onedit({ kind: 'dropTable' }, trigger, table)}><Trash2 />Delete table</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
