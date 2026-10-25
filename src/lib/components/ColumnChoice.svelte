<script lang="ts">
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';

	/** Ordered multi-select of column names; click order is key order. */
	let { columns, selected = $bindable(), disabled = false, label }: {
		columns: string[]; selected: string[]; disabled?: boolean; label: string;
	} = $props();
	const id = $props.id();
</script>

<fieldset class="space-y-2">
	<legend class="mb-2 text-xs font-medium">{label}</legend>
	{#each columns as column, i (column)}
		{@const position = selected.indexOf(column)}
		<div class="flex items-center gap-2">
			<Checkbox id={`${id}-${i}`} checked={position >= 0} {disabled}
				onCheckedChange={(checked) => selected = checked ? [...selected, column] : selected.filter((name) => name !== column)} />
			<Label for={`${id}-${i}`} class="min-w-0 truncate font-mono text-xs">{column}</Label>
			{#if position >= 0 && selected.length > 1}<span class="text-[10px] text-muted-foreground">#{position + 1}</span>{/if}
		</div>
	{/each}
</fieldset>
