<script lang="ts">
	import { onMount } from 'svelte';
	import { Search } from '@lucide/svelte';
	import { changeSchema, extensions } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Extension } from '#lib/database.js';
	import { ident } from '#lib/ddl.js';
	import { fresh, message } from '#lib/utils.js';
	import { Switch } from 'bits-ui';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	const id = $props.id();
	let list = $state.raw<Extension[]>([]);
	let error = $state('');
	let query = $state('');
	let pending = $state<{ extension: Extension; action: 'enable' | 'update' | 'disable'; schema: string; cascade: boolean } | null>(null);
	let applying = $state(false);
	let applyError = $state('');
	const shown = $derived(list.filter((extension) => `${extension.name} ${extension.comment ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
		.sort((a, b) => Number(!!b.installedVersion) - Number(!!a.installedVersion)));
	const sql = $derived.by(() => {
		if (!pending) return '';
		const name = ident(pending.extension.name);
		if (pending.action === 'update') return `alter extension ${name} update;`;
		if (pending.action === 'disable') return `drop extension ${name};`;
		return `create extension ${name}${pending.schema.trim() ? ` schema ${ident(pending.schema.trim())}` : ''}${pending.cascade ? ' cascade' : ''};`;
	});

	async function load() {
		try { list = await fresh(extensions({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function begin(extension: Extension, action: 'enable' | 'update' | 'disable') {
		pending = { extension, action, schema: extension.requiredSchema ?? 'public', cascade: extension.requires.length > 0 };
		applyError = '';
	}

	async function apply() {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			pending = null;
			await load();
			void editor.reload(); // Extensions can add tables and types.
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

<div class="space-y-3 p-4">
	<div class="relative max-w-sm">
		<Search class="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
		<Input bind:value={query} aria-label="Search extensions" placeholder="Search extensions" spellcheck={false} class="pl-9 text-xs" />
	</div>
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<div class="overflow-x-auto rounded-md border">
		<table class="w-full text-left text-xs">
			<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
				<th class="p-3 font-medium">Name</th><th class="p-3 font-medium">Version</th><th class="p-3 font-medium">Schema</th>
				<th class="p-3 font-medium">Description</th><th class="p-3 text-right font-medium">Enabled</th>
			</tr></thead>
			<tbody class="divide-y">
				{#each shown as extension (extension.name)}
					<tr>
						<td class="p-3 font-mono font-medium">{extension.name}</td>
						<td class="p-3 font-mono whitespace-nowrap">
							{extension.installedVersion ?? extension.defaultVersion}
							{#if extension.installedVersion && extension.installedVersion !== extension.defaultVersion}
								<Button variant="outline" size="xs" class="ml-2" onclick={() => begin(extension, 'update')}>Update to {extension.defaultVersion}</Button>
							{/if}
						</td>
						<td class="p-3 font-mono">{extension.schema ?? '—'}</td>
						<td class="p-3 text-muted-foreground">{extension.comment}</td>
						<td class="p-3 text-right">
							<!-- Controlled: the switch only moves once the change is applied. -->
							<Switch.Root bind:checked={() => !!extension.installedVersion, () => begin(extension, extension.installedVersion ? 'disable' : 'enable')}
								aria-label={`${extension.installedVersion ? 'Disable' : 'Enable'} ${extension.name}`}
								class="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors data-[state=checked]:bg-primary focus-visible:outline-2 focus-visible:outline-ring">
								<Switch.Thumb class="block size-4 rounded-full bg-foreground transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
							</Switch.Root>
						</td>
					</tr>
				{:else}
					<tr><td colspan="5" class="p-3 text-muted-foreground">{list.length ? 'No matching extensions.' : 'Loading…'}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={() => !!pending, (open) => { if (!open && !applying) pending = null; }}>
	<Dialog.Content class="gap-4">
		{#if pending}
			<Dialog.Header>
				<Dialog.Title>{{ enable: 'Enable', update: 'Update', disable: 'Disable' }[pending.action]} <code>{pending.extension.name}</code></Dialog.Title>
				<Dialog.Description class="text-xs">{pending.extension.comment}</Dialog.Description>
			</Dialog.Header>
			{#if pending.action === 'enable'}
				<div class="space-y-2">
					<Label for={`${id}-schema`} class="text-xs">Schema</Label>
					<Input id={`${id}-schema`} bind:value={pending.schema} readonly={!!pending.extension.requiredSchema} spellcheck={false} class="font-mono text-xs" />
				</div>
				{#if pending.extension.requires.length}
					<div class="flex items-center gap-2">
						<Checkbox id={`${id}-cascade`} bind:checked={pending.cascade} />
						<Label for={`${id}-cascade`} class="text-xs">Also install required: {pending.extension.requires.join(', ')}</Label>
					</div>
				{/if}
			{:else if pending.action === 'disable'}
				<p class="text-xs text-destructive">Objects that depend on this extension block removal; drop them first in the SQL editor.</p>
			{/if}
			<pre class="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{sql}</pre>
			{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
			<Dialog.Footer>
				<Button variant="outline" size="sm" disabled={applying} onclick={() => pending = null}>Cancel</Button>
				<Button variant={pending.action === 'disable' ? 'destructive' : 'default'} size="sm" disabled={applying} onclick={apply}>{applying ? 'Applying…' : 'Apply'}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
