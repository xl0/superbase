<script lang="ts">
	import { Copy, Download, EllipsisVertical, KeyRound, ListTree, LockKeyhole, Pencil, RefreshCw, ShieldCheck, Trash2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { editable, type Table } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

	let { table, onedit }: {
		table: Table;
		onedit: (mode: SchemaEditMode, anchor?: HTMLElement | null, table?: Table) => void;
	} = $props();
	let trigger = $state<HTMLButtonElement | null>(null);
	let exportOptionsOpening = false;
	const blocked = $derived(editor.navigationBlocked || editor.loading);

	async function copyName() {
		if (blocked) return;
		try { await navigator.clipboard.writeText(table.name); }
		catch (cause) { window.alert(message(cause)); }
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} bind:ref={trigger} variant="ghost" size="icon-xs" class="mr-1 text-muted-foreground" disabled={blocked}
				aria-label={`Actions for ${table.kind} ${table.name}`}><EllipsisVertical /></Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-52" onCloseAutoFocus={(event) => {
		if (editor.schemaEditing || exportOptionsOpening) event.preventDefault();
		exportOptionsOpening = false;
	}}>
		<DropdownMenu.Item disabled={blocked} onSelect={() => void copyName()}><Copy />Copy name</DropdownMenu.Item>
		<DropdownMenu.Separator />
		{#if table.kind === 'table'}
			<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'renameTable' }, trigger, table)}><Pencil />Rename table</DropdownMenu.Item>
			<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'duplicateTable' }, trigger, table)}><Copy />Duplicate table</DropdownMenu.Item>
			<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'indexes' }, trigger, table)}><ListTree />Indexes</DropdownMenu.Item>
			<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'constraints' }, trigger, table)}><ShieldCheck />Constraints</DropdownMenu.Item>
			<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'access' }, trigger, table)}><LockKeyhole />Policies & access</DropdownMenu.Item>
		{:else if table.kind === 'materialized view'}
			<DropdownMenu.Item disabled={blocked} onSelect={() => onedit({ kind: 'refreshView' }, trigger, table)}><RefreshCw />Refresh data</DropdownMenu.Item>
		{/if}
		{#if table.kind === 'table' && !editable(table)}
			<DropdownMenu.Item disabled={blocked || !table.columns.length} onSelect={() => onedit({ kind: 'addPrimaryKey' }, trigger, table)}><KeyRound />Add primary key</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Item disabled={blocked || !table.columns.length} onSelect={() => onedit({ kind: 'exportCsv' }, trigger, table)}><Download />Export CSV</DropdownMenu.Item>
		<DropdownMenu.Item disabled={blocked || !table.columns.length} onSelect={() => {
			exportOptionsOpening = true; onedit({ kind: 'exportCsv', options: true }, trigger, table);
		}}>Export options…</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" disabled={blocked} onSelect={() => onedit({ kind: 'dropTable' }, trigger, table)}><Trash2 />Delete {table.kind}</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
