<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { changeSchema } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	/** A previewed SQL change: optional form fields, the statement, Apply. Runs it in one transaction (`changeSchema`). */
	let { open, title, subject, description, sql, preview, destructive = false, disabled = false, action = 'Apply', class: className = '', children, onclose, onapplied }: {
		open: boolean;
		title: string;
		/** Object name, shown as code after the title. */
		subject?: string;
		description?: string;
		/** Empty while the form is incomplete or unchanged: nothing to apply. */
		sql: string;
		/** Shown instead of `sql`, e.g. with a masked password. */
		preview?: string;
		destructive?: boolean;
		/** Blocks Apply on top of an empty `sql` (e.g. a missing confirmation). */
		disabled?: boolean;
		action?: string;
		class?: string;
		/** Form fields, rendered above the preview; Enter applies. */
		children?: Snippet;
		onclose: () => void;
		/** Runs after a successful apply, once the dialog has closed: reload what changed. */
		onapplied?: () => unknown;
	} = $props();
	const id = $props.id();
	let applying = $state(false);
	let error = $state('');
	// A new opening or a changed statement makes the last error stale.
	$effect(() => { if (open) { sql; untrack(() => error = ''); } });

	async function apply() {
		if (applying || !sql || disabled) return;
		applying = true;
		error = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			onclose();
			await onapplied?.();
		} catch (cause) { error = message(cause); }
		finally { applying = false; }
	}
</script>

<Dialog.Root bind:open={() => open, (next) => { if (!next && !applying) onclose(); }}>
	<Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 {className}">
		<Dialog.Header>
			<Dialog.Title>{title}{#if subject}{' '}<code>{subject}</code>{/if}</Dialog.Title>
			{#if description}<Dialog.Description class="text-xs">{description}</Dialog.Description>{/if}
		</Dialog.Header>
		<form id={`${id}-form`} class="min-h-0 space-y-4 overflow-y-auto p-1" onsubmit={(event) => { event.preventDefault(); void apply(); }}>
			<!-- Fields can't change the statement while it runs. -->
			{#if children}<fieldset disabled={applying} class="min-w-0 space-y-4">{@render children()}</fieldset>{/if}
			{#if sql}<pre class="whitespace-pre-wrap wrap-anywhere rounded-md bg-muted p-2 font-mono text-xs">{preview ?? sql}</pre>{/if}
			{#if error}<p role="alert" class="text-xs break-words text-destructive">{error}</p>{/if}
		</form>
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={onclose}>Close</Button>
			<Button type="submit" form={`${id}-form`} variant={destructive ? 'destructive' : 'default'} size="sm"
				disabled={applying || !sql || disabled}>{applying ? 'Applying…' : action}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
