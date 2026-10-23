<script lang="ts">
	import { editor } from '#lib/state/editor.svelte.js';
	import type { ConnectionStatus } from '#lib/types.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import ConnectForm from './ConnectForm.svelte';

	let { open = $bindable(false), status }: { open?: boolean; status: ConnectionStatus } = $props();
	let pending = $state(false);
	let returnFocus: HTMLElement | null = null;

	function approve() {
		return !editor.busy && (!(editor.inserting || editor.editing) || window.confirm(
			'Discard the open editor or new-row form and change the database connection?'
		));
	}
</script>

<Dialog.Root {open} onOpenChange={(value) => { if (!pending) open = value; }}>
	<Dialog.Content showCloseButton={!pending} class="gap-4"
		onOpenAutoFocus={() => { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
		onEscapeKeydown={(event) => { if (pending) event.preventDefault(); }}
		onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
		onCloseAutoFocus={(event) => { if (returnFocus?.isConnected) { event.preventDefault(); returnFocus.focus(); } }}>
		<Dialog.Header>
			<Dialog.Title>Database connection</Dialog.Title>
			<Dialog.Description class="break-all text-xs">
				{#if status.connection}
					{status.connection.database} · {status.connection.host}:{status.connection.port}
					<br />{status.connection.user} · {status.connection.source === 'env' ? 'Default database' : 'Session connection'}
				{:else}Connect to a Postgres database.{/if}
			</Dialog.Description>
		</Dialog.Header>
		<ConnectForm {status} bind:pending disabled={editor.busy} beforechange={approve} onsuccess={() => editor.discardAll()} />
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={pending} onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
