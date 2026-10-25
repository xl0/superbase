<script lang="ts">
	import { Plus, Search, Table2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Table } from '#lib/types.js';
	import type { SchemaEditMode } from '#lib/schema.js';
	import TableMenu from './TableMenu.svelte';
	import PanelResizer from './PanelResizer.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let { oncreate, onedit }: {
		oncreate: () => void;
		onedit: (mode: SchemaEditMode, anchor?: HTMLElement | null, table?: Table) => void;
	} = $props();
	let tableSearch = $state('');
	let windowWidth = $state(1024);
	let width = $state(240);
	// Clamp at render time so a temporarily narrow window does not overwrite the preferred width.
	const maxWidth = $derived(Math.max(160, Math.min(480, windowWidth / 2)));
	const panelWidth = $derived(Math.min(maxWidth, Math.max(160, width)));
	const id = $props.id();
	const tables = $derived(editor.schemaTables.filter((table) => table.name.toLowerCase().includes(tableSearch.trim().toLowerCase())));
</script>

<svelte:window bind:innerWidth={windowWidth} />

<aside class="relative flex h-full shrink-0 flex-col border-r border-border bg-card" style:width={`${panelWidth}px`}>
	<PanelResizer bind:width min={160} max={maxWidth} edge="right" label="Resize table sidebar" />
	<div class="space-y-3 p-3">
		<div class="space-y-1.5">
			<Label for={`${id}-schema`} class="text-[10px] tracking-wider text-muted-foreground uppercase">Schema</Label>
			<Select.Root type="single" value={editor.activeSchema} disabled={editor.busy || !editor.schemas.length}
				onValueChange={(value) => { if (value) void editor.setSchema(value); }} allowDeselect={false}>
				<Select.Trigger id={`${id}-schema`} size="sm" class="w-full min-w-0 font-mono text-xs">
					<span class="truncate" title={editor.activeSchema}>{editor.activeSchema || 'Choose schema'}</span>
				</Select.Trigger>
				<Select.Content class="max-w-[calc(100vw-1rem)]">
					{#each editor.schemas as schema (schema)}
						<Select.Item value={schema} label={schema}><span class="max-w-[min(24rem,calc(100vw-5rem))] truncate" title={schema}>{schema}</span></Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="relative">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<Input bind:value={tableSearch} aria-label="Search tables" placeholder="Search tables" disabled={editor.busy} spellcheck={false} class="h-8 pl-8 text-xs" />
		</div>
	</div>
	<div class="flex items-center justify-between px-3 pb-2">
		<span class="text-[10px] tracking-wider text-muted-foreground uppercase">Tables · {tables.length}</span>
		<Button variant="ghost" size="icon-xs" aria-label="Create table" disabled={editor.navigationBlocked || editor.loading} onclick={oncreate}><Plus /></Button>
	</div>
	<nav aria-label="Tables" class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
		{#each tables as table (table.name)}
			{@const active = editor.activeSchema === table.schema && editor.activeTableName === table.name}
			<div class={['mb-0.5 flex items-center rounded-md hover:bg-muted', active ? 'bg-muted text-foreground' : 'text-muted-foreground']}>
				<Button variant="ghost" size="sm" disabled={editor.busy} aria-current={active ? 'page' : undefined}
					onclick={() => void editor.selectTable(table.schema, table.name)}
					class="min-w-0 flex-1 justify-start gap-2 px-2 text-xs font-normal">
					<Table2 class={['size-3.5', active && 'text-foreground']} />
					<span class="truncate">{table.name}</span>
				</Button>
				<TableMenu {table} {onedit} />
			</div>
		{:else}
			<p class="px-2 py-3 text-xs text-muted-foreground">{tableSearch ? 'No matching tables.' : 'No tables in this schema.'}</p>
		{/each}
	</nav>
</aside>
