<script lang="ts">
	import { untrack } from 'svelte';
	import { Combobox } from 'bits-ui';
	import { ChevronDown } from '@lucide/svelte';
	import type { ColumnSpec, SchemaColumn, SchemaType } from '#lib/schema.js';
	import { elementType } from '#lib/schema-options.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	let { value = $bindable(), types, existing, disabled = false }: {
		value: ColumnSpec; types: SchemaType[]; existing?: SchemaColumn; disabled?: boolean;
	} = $props();
	const id = $props.id();
	const initial = untrack(() => value.typeOid === null ? existing?.typeModifiers ?? [] : value.typeModifiers);
	let first = $state(String(initial[0] ?? ''));
	let second = $state(String(initial[1] ?? ''));
	let query = $state('');
	let open = $state(false);
	const type = $derived(types.find((type) => type.oid === (value.typeOid ?? existing?.typeOid)));
	const base = $derived(elementType(type, types));
	const array = $derived(type?.kind === 'array');
	const builtin = $derived(base?.schema === 'pg_catalog' && base.kind === 'base' ? base.name : '');
	const integer = $derived(['int2', 'int4', 'int8'].includes(builtin));
	const temporal = $derived(['timestamp', 'timestamptz', 'time', 'timetz'].includes(builtin));
	const length = $derived(['varchar', 'bpchar', 'bit', 'varbit'].includes(builtin));
	const numeric = $derived(builtin === 'numeric');
	const groups = ['Common types', 'Other PostgreSQL types', 'Custom types'];
	const common = ['text', 'int4', 'numeric', 'bool', 'uuid', 'timestamp', 'date', 'time', 'jsonb', 'json', 'varchar'];
	const options = $derived(types.filter((type) => type.kind !== 'array' && !(type.schema === 'pg_catalog' && ['int2', 'int8', 'timestamptz', 'timetz'].includes(type.name)))
		.map((type) => ({ type, label: label(type), group: type.schema !== 'pg_catalog' ? groups[2] : common.includes(type.name) ? groups[0] : groups[1] }))
		.filter((option) => {
			const aliases = option.type.schema !== 'pg_catalog' ? '' : option.type.name === 'int4' ? 'int2 int8 smallint bigint 16 32 64'
				: option.type.name === 'timestamp' ? 'timestamptz with without time zone' : option.type.name === 'time' ? 'timetz with without time zone' : '';
			const search = `${option.label} ${option.type.name} ${option.type.schema} ${aliases}`.toLowerCase();
			return query.toLowerCase().split(/\s+/).every((word) => search.includes(word));
		}));
	const preview = $derived(value.typeOid === null ? existing?.type ?? '' : formattedType());

	function label(type: SchemaType) {
		if (type.schema !== 'pg_catalog') return type.label;
		if (['int2', 'int4', 'int8'].includes(type.name)) return 'Integer';
		if (['timestamp', 'timestamptz'].includes(type.name)) return 'Timestamp';
		if (['time', 'timetz'].includes(type.name)) return 'Time';
		return ({ numeric: 'Decimal', bool: 'Boolean', text: 'Text', varchar: 'Varchar', uuid: 'UUID', json: 'JSON', jsonb: 'JSONB', date: 'Date' } as Record<string, string>)[type.name] ?? type.label;
	}

	function modifiers() {
		const number = (text: string) => /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
		return second !== '' ? [number(first), number(second)] : first !== '' ? [number(first)] : [];
	}

	function setType(oid: string) {
		const mods = modifiers();
		const unchanged = existing && oid === existing.typeOid && existing.typeModifiers !== null
			&& JSON.stringify(mods) === JSON.stringify(existing.typeModifiers);
		value.typeOid = unchanged ? null : oid;
		value.typeModifiers = unchanged ? [] : mods;
	}

	function select(oid: string) {
		if (!oid || disabled) return;
		if (oid === 'keep') {
			value.typeOid = null; value.typeModifiers = [];
			first = String(existing?.typeModifiers?.[0] ?? ''); second = String(existing?.typeModifiers?.[1] ?? '');
		} else {
			let selected = types.find((type) => type.oid === oid);
			if (!selected) return;
			if (selected.schema === 'pg_catalog') {
				const name = selected.name === 'int4' && integer ? builtin
					: selected.name === 'timestamp' ? (['timestamp', 'timestamptz'].includes(builtin) ? builtin : 'timestamptz')
					: selected.name === 'time' && ['time', 'timetz'].includes(builtin) ? builtin : selected.name;
				selected = types.find((type) => type.schema === 'pg_catalog' && type.name === name)!;
			}
			setType(array && selected.arrayOid ? selected.arrayOid : selected.oid);
		}
		query = ''; open = false;
	}

	function variant(name: string) {
		const selected = types.find((type) => type.schema === 'pg_catalog' && type.name === name);
		if (selected) setType(array && selected.arrayOid ? selected.arrayOid : selected.oid);
	}

	function formattedType() {
		if (!base) return 'Choose a type';
		const mods = value.typeModifiers.length ? `(${value.typeModifiers.map((value) => Number.isFinite(value) ? value : '?').join(', ')})` : '';
		const baseName = !mods && builtin === 'bpchar' ? 'bpchar' : !mods && builtin === 'bit' ? '"bit"' : base.label;
		const name = temporal ? `${builtin.startsWith('timestamp') ? 'timestamp' : 'time'}${mods} ${builtin.endsWith('tz') ? 'with' : 'without'} time zone`
			: `${baseName}${mods}`;
		return name + (array ? '[]' : '');
	}
</script>

<div class="min-w-0 space-y-3">
	<div class="space-y-2">
		<Label for={`${id}-type`}>Type</Label>
		<Combobox.Root type="single" value={value.typeOid === null ? 'keep' : base?.oid ?? ''} inputValue={query} bind:open {disabled}
			allowDeselect={false} onValueChange={select} onOpenChange={(opened) => { if (!opened) query = ''; }}>
			<div class="relative">
				<Combobox.Input id={`${id}-type`} aria-label="Type" placeholder={base ? label(base) : existing?.type ?? 'Search types…'} autocomplete="off" spellcheck={false}
					onfocus={() => { if (!disabled) open = true; }} oninput={(event) => query = event.currentTarget.value}>
					{#snippet child({ props })}<Input {...props} class="pr-8 text-xs placeholder:text-foreground" />{/snippet}
				</Combobox.Input>
				<Combobox.Trigger aria-label="Choose type" class="absolute inset-y-0 right-0 px-2 text-muted-foreground disabled:opacity-50"><ChevronDown class="size-4" /></Combobox.Trigger>
			</div>
			<Combobox.Portal>
				<Combobox.Content align="start" sideOffset={4} class="z-50 max-h-80 w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
					{#if existing && !query}
						<Combobox.Item value="keep" label={`Keep ${existing.type}`} class="cursor-default rounded-sm px-2 py-2 text-xs outline-none data-highlighted:bg-accent">Keep current: {existing.type}</Combobox.Item>
					{/if}
					{#each groups as group}
						{@const choices = options.filter((option) => option.group === group)}
						{#if choices.length}
							<Combobox.Group>
								<Combobox.GroupHeading class="px-2 pt-3 pb-1 text-[10px] text-muted-foreground">{group}</Combobox.GroupHeading>
								{#each choices as option (option.type.oid)}
									<Combobox.Item value={option.type.oid} label={option.label} class="flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-2 text-xs outline-none data-highlighted:bg-accent">
										<span class="min-w-0 break-all">{option.label}</span>{#if group === groups[2]}<span class="text-[10px] text-muted-foreground">{option.type.kind}</span>{/if}
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
	{#if integer}
		<div class="space-y-2">
			<Label for={`${id}-bits`} class="text-xs">Integer size</Label>
			<Select.Root type="single" value={builtin} {disabled} allowDeselect={false} onValueChange={variant}>
				<Select.Trigger id={`${id}-bits`} class="w-full text-xs">{builtin === 'int2' ? '16-bit · smallint' : builtin === 'int4' ? '32-bit · integer' : '64-bit · bigint'}</Select.Trigger>
				<Select.Content><Select.Item value="int2" label="16-bit · smallint" /><Select.Item value="int4" label="32-bit · integer" /><Select.Item value="int8" label="64-bit · bigint" /></Select.Content>
			</Select.Root>
		</div>
	{/if}
	<div class="flex flex-wrap gap-x-4 gap-y-2">
		{#if temporal}
			<div class="flex items-center gap-2"><Checkbox id={`${id}-timezone`} checked={builtin.endsWith('tz')} {disabled}
				onCheckedChange={(checked) => variant(builtin.startsWith('timestamp') ? checked ? 'timestamptz' : 'timestamp' : checked ? 'timetz' : 'time')} />
				<Label for={`${id}-timezone`} class="text-xs" title={builtin.startsWith('timestamp') ? 'Stores an instant, not the original timezone name.' : 'Stores a time and UTC offset.'}>With timezone</Label></div>
		{/if}
		<div class="flex items-center gap-2"><Checkbox id={`${id}-array`} checked={array} disabled={disabled || !base?.arrayOid}
			onCheckedChange={(checked) => { if (base) setType(checked ? base.arrayOid! : base.oid); }} />
			<Label for={`${id}-array`} class="text-xs">Array</Label></div>
	</div>
	{#if numeric || temporal || length || first || second}
		<div class="grid grid-cols-2 gap-2">
			<div class="space-y-2"><Label for={`${id}-first`} class="text-xs">{numeric ? 'Precision' : temporal ? 'Fractional digits' : length ? 'Length' : 'Modifier 1'}</Label>
				<Input id={`${id}-first`} value={first} inputmode="numeric" placeholder={numeric || length ? 'Unspecified' : 'Default'} {disabled} class="text-xs"
					oninput={(event) => { first = event.currentTarget.value; if (type) setType(type.oid); }} /></div>
			{#if numeric || second}
				<div class="space-y-2"><Label for={`${id}-second`} class="text-xs">{numeric ? 'Scale' : 'Modifier 2'}</Label>
					<Input id={`${id}-second`} value={second} inputmode="text" placeholder={numeric ? '0' : 'Unspecified'} {disabled} class="text-xs"
						oninput={(event) => { second = event.currentTarget.value; if (type) setType(type.oid); }} /></div>
			{/if}
		</div>
		{#if first || second}<Button variant="ghost" size="xs" {disabled} onclick={() => { first = second = ''; if (type) setType(type.oid); }}>Clear type options</Button>{/if}
	{/if}
	<p class="break-all font-mono text-xs text-muted-foreground" aria-label="Resulting SQL type">{preview}</p>
	{#if existing?.typeModifiers === null}<p class="text-xs text-muted-foreground">{value.typeOid === null ? 'Existing type options are preserved.' : 'Replacing this type removes its unsupported type options.'}</p>{/if}
</div>
