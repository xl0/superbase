<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { X } from '@lucide/svelte';
	import type { CsvExportArgs, Table } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();
	const id = $props.id();
	let args = $state.raw<CsvExportArgs | null>(null);
	let columns = $state<{ name: string; type: string }[]>([]);
	let selected = $state<string[]>([]);
	let anchor: HTMLElement | null = null;
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(noticeTimer));
	let request = $state.raw<{ name: string; payload: string; table: string } | null>(null);
	let form = $state<HTMLFormElement | null>(null);
	let serial = 0;

	/** Capture a table/query independently of later workspace navigation. */
	export function start(target: CsvExportArgs, table: Table, options: boolean, trigger: HTMLElement | null) {
		const snapshot: CsvExportArgs = JSON.parse(JSON.stringify(target));
		error = null;
		notice = null;
		clearTimeout(noticeTimer);
		if (!options) { void download(snapshot); return; }
		args = snapshot;
		columns = table.columns.map(({ name, type }) => ({ name, type }));
		selected = columns.map((column) => column.name);
		anchor = trigger;
		open = true;
	}

	async function download(target: CsvExportArgs) {
		error = null;
		notice = `${target.schema}.${target.table}`;
		clearTimeout(noticeTimer);
		// Acknowledge the click, not transfer completion (native attachments have no callback).
		noticeTimer = setTimeout(() => notice = null, 6000);
		const name = `${id}-download-${++serial}`;
		request = { name, payload: JSON.stringify(target), table: `${target.schema}.${target.table}` };
		await tick();
		if (request?.name === name && form) form.submit();
	}

	function loaded(event: Event) {
		const frame = event.currentTarget as HTMLIFrameElement;
		if (!request || frame.name !== request.name) return;
		const document = frame.contentDocument;
		if (document?.URL === 'about:blank') return;
		// Attachments go to the browser download manager and don't navigate this frame.
		// A committed document is an initial HTTP/network error, never a successful CSV.
		const detail = document?.body?.textContent?.trim().slice(0, 16_384);
		notice = null;
		clearTimeout(noticeTimer);
		error = `${request.table}: ${detail || 'CSV download failed. Check your connection and retry.'}`;
	}
</script>

{#if request}
	{#key request.name}
		<!-- Replacing a target cancels only a previous navigation still preparing its headers. -->
		<iframe hidden name={request.name} title="CSV download" src="about:blank"
			sandbox="allow-same-origin allow-forms allow-downloads" onload={loaded}></iframe>
	{/key}
	<form bind:this={form} hidden method="POST" action="/export" target={request.name}>
		<input type="hidden" name="export" value={request.payload} />
	</form>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4"
		onCloseAutoFocus={(event) => { event.preventDefault(); if (anchor?.isConnected) anchor.focus(); }}>
		<Dialog.Header class="shrink-0 pr-8">
			<Dialog.Title>Export options</Dialog.Title>
			<Dialog.Description class="break-words">
				<span class="font-mono">{args?.schema}.{args?.table}</span><br />
				{args?.query ? 'All matching rows, with the current filters and sort order.' : 'All rows visible to your database role, ignoring grid filters.'}
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex shrink-0 items-center gap-3 border-b pb-3">
			<Checkbox id={`${id}-all`} checked={selected.length === columns.length}
				indeterminate={selected.length > 0 && selected.length < columns.length}
				onCheckedChange={(checked) => selected = checked ? columns.map((column) => column.name) : []} />
			<Label for={`${id}-all`} class="text-xs">All columns</Label>
			<span class="ml-auto text-xs text-muted-foreground">{selected.length} / {columns.length}</span>
		</div>
		<div class="min-h-0 space-y-3 overflow-y-auto p-1" aria-label="Export columns">
			{#if error}<p role="alert" class="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p>{/if}
			{#each columns as column, i (column.name)}
				<div class="flex items-center gap-3">
					<Checkbox id={`${id}-column-${i}`} checked={selected.includes(column.name)}
						onCheckedChange={(checked) => selected = checked ? [...selected, column.name] : selected.filter((name) => name !== column.name)} />
					<Label for={`${id}-column-${i}`} class="min-w-0 flex-1 truncate font-mono text-xs" title={column.name}>{column.name}</Label>
					<span class="max-w-32 truncate text-xs text-muted-foreground" title={column.type}>{column.type}</span>
				</div>
			{/each}
		</div>
		<Dialog.Footer class="shrink-0 border-t pt-3">
			<Button variant="outline" size="sm" onclick={() => open = false}>Close</Button>
			<Button size="sm" disabled={!selected.length} title="Raw CSV values: import untrusted data as text in spreadsheets."
				onclick={() => { if (args && selected.length) void download({ ...args, columns: [...selected] }); }}>
				<span aria-live="polite">{notice ? 'Download requested' : 'Download CSV'}</span>
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if !open && (error || notice)}
	<div role={error ? 'alert' : 'status'} class={['fixed right-4 bottom-4 z-50 flex max-h-48 w-96 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg', error && 'border-destructive/40']}>
		<div class="max-h-40 min-w-0 flex-1 overflow-y-auto text-xs">
			{#if error}<p class="whitespace-pre-wrap break-words text-destructive">{error}</p>
			{:else}<p>CSV download requested</p><p class="mt-1 break-all font-mono text-muted-foreground">{notice}</p>{/if}
		</div>
		<Button variant="ghost" size="icon-xs" aria-label={error ? 'Dismiss CSV error' : 'Dismiss download notification'}
			onclick={() => { error = null; notice = null; clearTimeout(noticeTimer); }}><X /></Button>
	</div>
{/if}
