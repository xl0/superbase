<script module lang="ts">
	/** The schema last picked on any Database page: switching pages keeps it. */
	export const picked = $state({ schema: '' });
</script>

<script lang="ts">
	import { Search } from '@lucide/svelte';
	import { editor } from '#lib/state/editor.svelte.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	/** Schema picker and search box of the Database pages that list objects per schema. */
	let { schema = $bindable(), query = $bindable(), label }: { schema: string; query: string; label: string } = $props();
</script>

<Select.Root type="single" bind:value={schema} allowDeselect={false} onValueChange={(value) => picked.schema = value}>
	<Select.Trigger aria-label="Schema" size="sm" class="min-w-40 font-mono text-xs">{schema}</Select.Trigger>
	<Select.Content>{#each editor.schemas as option}<Select.Item value={option} label={option} />{/each}</Select.Content>
</Select.Root>
<div class="relative w-full max-w-sm">
	<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
	<Input bind:value={query} aria-label={label} placeholder={label} spellcheck={false} class="h-8 pl-9 text-xs" />
</div>
