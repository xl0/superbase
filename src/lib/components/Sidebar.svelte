<script lang="ts">
	import { Database, Search, Settings2, Table2 } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { ConnectionInfo } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let { connection, onconnect }: { connection: ConnectionInfo; onconnect: () => void } = $props();
	let tableSearch = $state('');
	const id = $props.id();
	const tables = $derived(editor.schemaTables.filter((table) => table.name.toLowerCase().includes(tableSearch.trim().toLowerCase())));
</script>

<aside class="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
	<header class="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
		<Database class="size-4 text-muted-foreground" />
		<span class="text-sm font-semibold tracking-tight">superbase</span>
	</header>
	<div class="space-y-2 border-b border-border p-3">
		<div class="truncate text-xs font-medium" title={connection.database}>{connection.database}</div>
		<div class="truncate font-mono text-[11px] text-muted-foreground" title={`${connection.host}:${connection.port}`}>
			{connection.host}:{connection.port}
		</div>
		<Button variant="outline" size="sm" class="w-full justify-start text-xs" disabled={editor.busy} onclick={onconnect}>
			<Settings2 class="size-3.5" /> Change connection
		</Button>
	</div>
	<div class="space-y-3 p-3">
		<div class="space-y-1.5">
			<Label for={`${id}-schema`} class="text-[10px] tracking-wider text-muted-foreground uppercase">Schema</Label>
			<Select.Root type="single" value={editor.activeSchema} disabled={editor.busy || !editor.schemas.length}
				onValueChange={(value) => { if (value) void editor.setSchema(value); }} allowDeselect={false}>
				<Select.Trigger id={`${id}-schema`} size="sm" class="w-full font-mono text-xs">{editor.activeSchema || 'Choose schema'}</Select.Trigger>
				<Select.Content>
					{#each editor.schemas as schema (schema)}<Select.Item value={schema} label={schema} />{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="relative">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<Input bind:value={tableSearch} aria-label="Search tables" placeholder="Search tables" disabled={editor.busy} spellcheck={false} class="h-8 pl-8 text-xs" />
		</div>
	</div>
	<div class="px-3 pb-2 text-[10px] tracking-wider text-muted-foreground uppercase">Tables · {tables.length}</div>
	<nav aria-label="Tables" class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
		{#each tables as table (table.name)}
			{@const active = editor.activeSchema === table.schema && editor.activeTableName === table.name}
			<Button variant="ghost" size="sm" disabled={editor.busy} aria-current={active ? 'page' : undefined}
				onclick={() => void editor.selectTable(table.schema, table.name)}
				class={['mb-0.5 w-full justify-start gap-2 px-2 text-xs font-normal', active ? 'bg-muted text-foreground' : 'text-muted-foreground']}>
				<Table2 class={['size-3.5', active && 'text-foreground']} />
				<span class="truncate">{table.name}</span>
			</Button>
		{:else}
			<p class="px-2 py-3 text-xs text-muted-foreground">{tableSearch ? 'No matching tables.' : 'No tables in this schema.'}</p>
		{/each}
	</nav>
	<footer class="truncate border-t border-border px-3 py-3 text-[11px] text-muted-foreground" title={editor.server?.version}>
		PostgreSQL {editor.server?.version ?? ''}
	</footer>
</aside>
