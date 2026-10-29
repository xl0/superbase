<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { Download, X } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { CsvExportArgs } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { message } from '#lib/utils.js';

	/** Toolbar export: choose columns, then download every row matching the grid's filters, in grid order. */
	const id = $props.id();
	let open = $state(false);
	let args = $state.raw<Omit<CsvExportArgs, 'columns'> | null>(null);
	let columns = $state<string[]>([]);
	let selected = $state<string[]>([]);
	let error = $state<string | null>(null);
	let payload = $state('');
	let form = $state<HTMLFormElement | null>(null);

	/** Capture the table and query now, independently of later grid navigation. */
	function start() {
		error = null;
		args = {
			connection: editor.connection, schema: editor.activeSchema, table: editor.activeTableName,
			query: { sort: $state.snapshot(editor.sort), filters: $state.snapshot(editor.filters), ...(editor.reference ? { reference: { ...editor.reference } } : {}) },
			...(editor.viewAs ? { as: editor.viewAs } : {})
		};
		columns = editor.table.columns.map((column) => column.name);
		selected = [...columns];
		open = true;
	}

	async function download(target: CsvExportArgs) {
		error = null;
		if (import.meta.env.MODE === 'demo') {
			const { downloadCsv } = await import('#lib/demo/db.svelte.js');
			await downloadCsv(target).catch((cause) => { error = `CSV export failed: ${message(cause)}`; });
			return;
		}
		payload = JSON.stringify(target);
		await tick();
		form?.submit();
	}

	function loaded(event: Event) {
		// Attachments go to the download manager without loading the frame; a loaded document is an error response.
		const document = (event.currentTarget as HTMLIFrameElement).contentDocument;
		if (document && document.URL !== 'about:blank') error = document.body?.textContent?.trim() || 'CSV download failed.';
	}
</script>

<Button variant="outline" size="icon-sm" disabled={editor.navigationBlocked || editor.loading || !editor.table.columns.length}
	aria-label="Export CSV" title="Download rows matching the filters as CSV" onclick={start}><Download /></Button>

<iframe hidden name={`${id}-download`} title="CSV download" src="about:blank" sandbox="allow-same-origin allow-downloads" onload={loaded}></iframe>
<form bind:this={form} hidden method="POST" action={resolve('/export')} target={`${id}-download`}>
	<input type="hidden" name="export" value={payload} />
</form>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4">
		<Dialog.Header class="pr-8">
			<Dialog.Title>Export CSV</Dialog.Title>
			<Dialog.Description class="break-words">
				<span class="font-mono">{args?.schema}.{args?.table}</span> · all rows matching the current filters, in grid order
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex items-center gap-3 border-b pb-3">
			<Checkbox id={`${id}-all`} checked={selected.length === columns.length} indeterminate={selected.length > 0 && selected.length < columns.length}
				onCheckedChange={(checked) => selected = checked ? [...columns] : []} />
			<Label for={`${id}-all`} class="text-xs">All columns</Label>
			<span class="ml-auto text-xs text-muted-foreground">{selected.length} / {columns.length}</span>
		</div>
		<div class="min-h-0 space-y-3 overflow-y-auto p-1" aria-label="Export columns">
			{#each columns as column, i (column)}
				<div class="flex items-center gap-3">
					<Checkbox id={`${id}-${i}`} checked={selected.includes(column)}
						onCheckedChange={(checked) => selected = checked ? [...selected, column] : selected.filter((name) => name !== column)} />
					<Label for={`${id}-${i}`} class="min-w-0 truncate font-mono text-xs">{column}</Label>
				</div>
			{/each}
		</div>
		<Dialog.Footer class="border-t pt-3">
			<Button variant="outline" size="sm" onclick={() => open = false}>Close</Button>
			<Button size="sm" disabled={!selected.length} onclick={() => { if (args) void download({ ...args, columns: [...selected] }); }}>Download</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if error}
	<div role="alert" class="fixed right-4 bottom-4 z-50 flex max-h-48 w-96 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md border border-destructive/40 bg-popover p-3 shadow-lg">
		<p class="max-h-40 min-w-0 flex-1 overflow-y-auto text-xs whitespace-pre-wrap break-words text-destructive">{error}</p>
		<Button variant="ghost" size="icon-xs" aria-label="Dismiss CSV error" onclick={() => error = null}><X /></Button>
	</div>
{/if}
