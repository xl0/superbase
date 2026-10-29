<script lang="ts">
	import { Combobox } from 'bits-ui';
	import { ChevronDown } from '@lucide/svelte';
	import type { SchemaColumn, SchemaType } from '#lib/schema.js';
	import { elementType, MODIFIABLE_TYPES, typeSql, type ColumnSpec } from '#lib/ddl.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';

	let { value = $bindable(), types, existing, disabled = false }: {
		value: ColumnSpec; types: SchemaType[]; existing?: SchemaColumn; disabled?: boolean;
	} = $props();
	const id = $props.id();
	const COMMON = ['text', 'int4', 'int8', 'numeric', 'bool', 'uuid', 'timestamptz', 'timestamp', 'date', 'jsonb', 'varchar'];
	const GROUPS = ['Common', 'PostgreSQL', 'Custom'];
	let query = $state('');
	let open = $state(false);
	const type = $derived(types.find((type) => type.oid === value.typeOid));
	const base = $derived(elementType(type, types));
	const modifiable = $derived(base?.schema === 'pg_catalog' && MODIFIABLE_TYPES.includes(base.name));
	const options = $derived(types
		.filter((type) => type.kind !== 'array' && `${type.label} ${type.name} ${type.schema}`.toLowerCase().includes(query.trim().toLowerCase()))
		.map((type) => ({ type, group: type.schema !== 'pg_catalog' ? GROUPS[2] : COMMON.includes(type.name) ? GROUPS[0] : GROUPS[1] })));

	function choose(oid: string, array = type?.kind === 'array') {
		const chosen = types.find((type) => type.oid === oid);
		if (oid !== 'keep' && !chosen) return;
		// A different base type invalidates its modifiers; it or an array invalidates type-specific defaults (identity, presets).
		if (chosen?.oid !== base?.oid) value.typeModifiers = '';
		if ((chosen?.oid !== base?.oid || array) && (value.default.kind === 'identity' || value.default.kind === 'expression')) {
			value.default = { kind: existing ? 'keep' : 'none' };
		}
		value.typeOid = !chosen ? null : array && chosen.arrayOid ? chosen.arrayOid : chosen.oid;
		query = '';
		open = false;
	}
</script>

<div class="min-w-0 space-y-3">
	<div class="space-y-2">
		<Label for={`${id}-type`}>Type</Label>
		<Combobox.Root type="single" value={value.typeOid === null ? 'keep' : base?.oid ?? ''} inputValue={query} bind:open {disabled}
			allowDeselect={false} onValueChange={(oid) => choose(oid)} onOpenChange={(opened) => { if (!opened) query = ''; }}>
			<div class="relative">
				<Combobox.Input id={`${id}-type`} placeholder={value.typeOid === null ? existing?.type : base?.label ?? 'Search types…'}
					autocomplete="off" spellcheck={false} onfocus={() => { if (!disabled) open = true; }} oninput={(event) => query = event.currentTarget.value}>
					{#snippet child({ props })}<Input {...props} class="pr-8 text-xs placeholder:text-foreground" />{/snippet}
				</Combobox.Input>
				<Combobox.Trigger aria-label="Choose type" class="absolute inset-y-0 right-0 px-2 text-muted-foreground"><ChevronDown class="size-4" /></Combobox.Trigger>
			</div>
			<Combobox.Portal>
				<Combobox.Content align="start" sideOffset={4} class="z-50 max-h-80 w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
					{#if existing && !query}
						<Combobox.Item value="keep" label={existing.type} class="rounded-sm px-2 py-2 text-xs outline-none data-highlighted:bg-accent">Keep current: {existing.type}</Combobox.Item>
					{/if}
					{#each GROUPS as group}
						{@const choices = options.filter((option) => option.group === group)}
						{#if choices.length}
							<Combobox.Group>
								<Combobox.GroupHeading class="px-2 pt-3 pb-1 text-[10px] text-muted-foreground">{group}</Combobox.GroupHeading>
								{#each choices as { type } (type.oid)}
									<Combobox.Item value={type.oid} label={type.label} class="flex justify-between gap-2 rounded-sm px-2 py-2 text-xs outline-none data-highlighted:bg-accent">
										<span class="min-w-0 break-all">{type.label}</span>{#if group === GROUPS[2]}<span class="text-[10px] text-muted-foreground">{type.kind}</span>{/if}
									</Combobox.Item>
								{/each}
							</Combobox.Group>
						{/if}
					{/each}
					{#if !options.length}<p class="p-3 text-xs text-muted-foreground">No matching types.</p>{/if}
				</Combobox.Content>
			</Combobox.Portal>
		</Combobox.Root>
	</div>
	{#if value.typeOid !== null}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<div class="flex items-center gap-2">
				<Checkbox id={`${id}-array`} checked={type?.kind === 'array'} disabled={disabled || !base?.arrayOid}
					onCheckedChange={(checked) => { if (base) choose(base.oid, checked); }} />
				<Label for={`${id}-array`} class="text-xs">Array</Label>
			</div>
			{#if modifiable}
				<Input bind:value={value.typeModifiers} aria-label="Type modifiers" {disabled} spellcheck={false} class="h-8 w-40 font-mono text-xs"
					placeholder={base?.name === 'numeric' ? 'precision, scale' : base?.name.startsWith('time') ? 'precision' : 'length'} />
			{/if}
		</div>
		<p class="break-all font-mono text-xs text-muted-foreground">{base ? typeSql(value.typeOid, value.typeModifiers, types) : ''}</p>
	{/if}
</div>
