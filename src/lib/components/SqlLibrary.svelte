<script lang="ts">
	import { tick } from 'svelte';
	import { EllipsisVertical, FilePlus, FileText, Heart, Search } from '@lucide/svelte';
	import type { SqlSnippet, SqlState } from '#lib/state/sql.svelte.js';
	import { SQL_EXAMPLES } from '#lib/sql-examples.js';
	import { message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';

	let { state: sql }: { state: SqlState } = $props();
	let query = $state('');
	let renaming = $state<{ id: string; name: string } | null>(null);
	const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
	const favorites = $derived(sql.snippets.filter((snippet) => snippet.favorite && match(snippet.name)));
	const others = $derived(sql.snippets.filter((snippet) => !snippet.favorite && match(snippet.name)));
	const examples = $derived(SQL_EXAMPLES.filter((example) => match(example.name)));

	function open(text: string, snippet: string | null) {
		if (sql.snippet === snippet && snippet !== null) return;
		if (sql.unsaved && !window.confirm('Replace the unsaved editor text?')) return;
		sql.open(text, snippet);
	}

	/** Start renaming a snippet in place (also used right after saving untitled text). */
	export async function rename(snippet: SqlSnippet) {
		renaming = { id: snippet.id, name: snippet.name };
		await tick();
		document.querySelector<HTMLInputElement>('[data-snippet-rename]')?.select();
	}

	function finishRename() {
		if (renaming?.name.trim()) attempt(() => sql.editSnippet(renaming!.id, { name: renaming!.name.trim() }));
		renaming = null;
	}

	function attempt(action: () => void) {
		try { action(); } catch (cause) { window.alert(`Could not update saved snippets: ${message(cause)}`); }
	}
</script>

<svelte:window onstorage={(event) => { if (event.key === null || event.key === 'superbase.sql-snippets') sql.loadLibrary(); }} />

{#snippet row(snippet: SqlSnippet)}
	<li class={['group flex items-center rounded-md hover:bg-muted', sql.snippet === snippet.id && 'bg-muted']}>
		{#if renaming?.id === snippet.id}
			<Input data-snippet-rename bind:value={renaming.name} aria-label="Snippet name" class="h-7 text-xs"
				onkeydown={(event) => { if (event.key === 'Enter') finishRename(); else if (event.key === 'Escape') { event.stopPropagation(); renaming = null; } }}
				onblur={finishRename} />
		{:else}
			<button class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs" title={snippet.name} onclick={() => open(snippet.sql, snippet.id)}>
				{snippet.name}{#if sql.snippet === snippet.id && sql.unsaved}<span class="text-muted-foreground"> •</span>{/if}
			</button>
			<Button variant="ghost" size="icon-xs" aria-label={snippet.favorite ? `Unfavourite ${snippet.name}` : `Favourite ${snippet.name}`}
				class={snippet.favorite ? 'text-rose-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}
				onclick={() => attempt(() => sql.editSnippet(snippet.id, { favorite: !snippet.favorite }))}>
				<Heart class={snippet.favorite ? 'fill-current' : ''} />
			</Button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-xs" class="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
							aria-label={`Actions for ${snippet.name}`}><EllipsisVertical /></Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-36">
					<DropdownMenu.Item onSelect={() => void rename(snippet)}>Rename</DropdownMenu.Item>
					<DropdownMenu.Item variant="destructive" onSelect={() => {
						if (window.confirm(`Delete snippet “${snippet.name}”?`)) attempt(() => sql.removeSnippet(snippet.id));
					}}>Delete</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</li>
{/snippet}

<aside aria-label="SQL snippets" class="flex h-full w-60 shrink-0 flex-col border-r bg-card">
	<div class="space-y-2 border-b p-3">
		<Button variant="outline" size="sm" class="w-full justify-start text-xs" onclick={() => open('', null)}><FilePlus />New query</Button>
		<div class="relative">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
			<Input bind:value={query} aria-label="Search snippets" placeholder="Search snippets" spellcheck={false} class="h-8 pl-8 text-xs" />
		</div>
	</div>
	<div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
		{#if favorites.length}
			<section>
				<h2 class="px-2 pb-1 text-[10px] tracking-wider text-muted-foreground uppercase">Favourites</h2>
				<ul>{#each favorites as snippet (snippet.id)}{@render row(snippet)}{/each}</ul>
			</section>
		{/if}
		<section>
			<h2 class="px-2 pb-1 text-[10px] tracking-wider text-muted-foreground uppercase">Snippets</h2>
			<ul>{#each others as snippet (snippet.id)}{@render row(snippet)}{:else}
				<li class="px-2 py-1 text-xs text-muted-foreground">{query ? 'No matches.' : 'Save queries with Ctrl/⌘+S.'}</li>
			{/each}</ul>
		</section>
		<!-- Collapsed by default; searching opens it so matches are visible. -->
		<details open={!!query.trim()}>
			<summary class="cursor-pointer px-2 pb-1 text-[10px] tracking-wider text-muted-foreground uppercase">Examples</summary>
			<ul>
				{#each examples as example (example.name)}
					<li>
						<button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
							title={example.description} onclick={() => open(example.sql, null)}>
							<FileText class="size-3.5 shrink-0" /><span class="truncate">{example.name}</span>
						</button>
					</li>
				{/each}
			</ul>
		</details>
	</div>
</aside>
