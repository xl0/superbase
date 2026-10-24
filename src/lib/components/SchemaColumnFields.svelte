<script lang="ts">
	import type { ColumnSpec, SchemaColumn, SchemaType } from '#lib/schema.js';
	import { columnOptionsError, defaultOptions, DEFAULT_LABELS } from '#lib/schema-options.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import TextEditor from './TextEditor.svelte';
	import SchemaTypePicker from './SchemaTypePicker.svelte';

	let { value = $bindable(), types, existing, canSetPrimaryKey, disabled = false }: {
		value: ColumnSpec; types: SchemaType[]; existing?: SchemaColumn;
		canSetPrimaryKey: boolean; disabled?: boolean;
	} = $props();
	const id = $props.id();
	const type = $derived(types.find((type) => type.oid === (value.typeOid ?? existing?.typeOid)));
	const builtin = $derived(type?.schema === 'pg_catalog' && type.kind === 'base' ? type.name : '');
	const text = $derived(['text', 'varchar', 'bpchar'].includes(builtin));
	const json = $derived(['json', 'jsonb'].includes(builtin));
	const array = $derived(type?.kind === 'array');
	const boolean = $derived(builtin === 'bool');
	const enumValues = $derived(type?.kind === 'enum' ? type.enumValues : null);
	const defaults = $derived(defaultOptions(type, !existing));
	const available = $derived(defaults.some((option) => option.kind === value.default.kind));
	const problem = $derived(columnOptionsError(value, types, existing));
	const fixedDefault = $derived(!!(existing?.identity || existing?.generated));
	const literalChoices = $derived(boolean ? ['true', 'false'] : enumValues ?? []);

	function setDefault(kind: string) {
		const option = defaults.find((option) => option.kind === kind);
		if (!option) return;
		value.default = option.kind === 'literal' ? { kind: 'literal', value: '' } : { kind: option.kind };
		if (option.kind === 'identity') value.nullable = false;
	}
	function literal(text: string) { value.default = { kind: 'literal', value: text }; }
</script>

<div class="grid gap-4 @min-[540px]:grid-cols-2">
	<div class="space-y-2">
		<Label for={`${id}-name`}>Name</Label>
		<Input id={`${id}-name`} bind:value={value.name} {disabled} autocomplete="off" spellcheck={false} placeholder="column_name" class="font-mono text-xs" />
	</div>
	<SchemaTypePicker bind:value {types} {existing} disabled={disabled || !!existing?.generated} />
	<div class="space-y-2 @min-[540px]:col-span-2">
		<Label for={`${id}-comment`}>Description</Label>
		<Textarea id={`${id}-comment`} bind:value={value.comment} {disabled} maxlength={10000} class="min-h-16 text-xs" />
	</div>
	<div class="space-y-2 @min-[540px]:col-span-2">
		<Label for={`${id}-default`}>Default value</Label>
		{#if fixedDefault}
			<Input id={`${id}-default`} readonly value={existing?.identity ? `Identity (${existing.identity})` : existing?.defaultValue ?? 'Generated'} class="font-mono text-xs" />
		{:else}
			<Select.Root type="single" value={value.default.kind} allowDeselect={false} {disabled} onValueChange={setDefault}>
				<Select.Trigger id={`${id}-default`} class="w-full text-xs">{DEFAULT_LABELS[value.default.kind]}{available ? '' : ' — incompatible'}</Select.Trigger>
				<Select.Content>
					{#if !available}<Select.Item value={value.default.kind} label={`${DEFAULT_LABELS[value.default.kind]} — incompatible`} disabled />{/if}
					{#each defaults.filter((option) => !(text && option.kind === 'uuid')) as option}
						<Select.Item value={option.kind} label={option.label} class="text-xs" />
					{/each}
					{#if text}
						<Select.Group><Select.GroupHeading>Advanced</Select.GroupHeading><Select.Item value="uuid" label="Generate UUID as text" class="text-xs" /></Select.Group>
					{/if}
				</Select.Content>
			</Select.Root>
			{#if value.default.kind === 'keep'}<p class="break-all font-mono text-xs text-muted-foreground">{existing?.defaultValue ?? 'No default'}</p>{/if}
			{#if value.default.kind === 'literal'}
				{#if boolean || enumValues}
					{@const index = literalChoices.indexOf(value.default.value)}
					<Select.Root type="single" value={index < 0 ? 'unlisted' : String(index)} allowDeselect={false} {disabled}
						onValueChange={(selected) => { if (selected !== 'unlisted' && selected !== '') literal(literalChoices[Number(selected)]); }}>
						<Select.Trigger aria-label="Default literal" class="w-full text-xs">{index < 0 ? value.default.value ? `Current literal: ${value.default.value}` : 'Choose a value' : value.default.value || '(empty string)'}</Select.Trigger>
						<Select.Content>
							{#if index < 0}<Select.Item value="unlisted" label={value.default.value || 'Choose a value'} disabled />{/if}
							{#each literalChoices as choice, index}<Select.Item value={String(index)} label={choice || '(empty string)'} />{/each}
						</Select.Content>
					</Select.Root>
				{:else if json || text || type?.kind === 'domain' || !type}
					<TextEditor value={value.default.value} language={json ? 'json' : 'text'} label={`Default literal for ${value.name || 'column'}`} readonly={disabled} class="h-24"
						onchange={(text) => { if (value.default.kind === 'literal') value.default.value = text ?? ''; }} />
				{:else if array}
					<Textarea value={value.default.value} aria-label="Default array literal" {disabled} spellcheck={false} class="min-h-20 font-mono text-xs"
						oninput={(event) => literal(event.currentTarget.value)} />
				{:else}
					<Input value={value.default.value} aria-label="Default literal" {disabled} spellcheck={false} class="font-mono text-xs"
						oninput={(event) => literal(event.currentTarget.value)} />
				{/if}
			{/if}
			{#if text || json || array}
				<div class="flex flex-wrap gap-1">
					{#if text}<Button variant="ghost" size="xs" {disabled} onclick={() => literal('')}>Empty text</Button>{/if}
					{#if json}<Button variant="ghost" size="xs" {disabled} onclick={() => literal('{}')}>Empty object {'{}'}</Button><Button variant="ghost" size="xs" {disabled} onclick={() => literal('[]')}>Empty JSON array []</Button>{/if}
					{#if array}<Button variant="ghost" size="xs" {disabled} onclick={() => literal('{}')}>Empty array {'{}'}</Button>{/if}
				</div>
			{/if}
		{/if}
		{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
	</div>
	<div class="flex flex-wrap items-center gap-x-5 gap-y-3 @min-[540px]:col-span-2">
		<div class="flex items-center gap-2">
			<Checkbox id={`${id}-nullable`} bind:checked={value.nullable} disabled={disabled || value.primaryKey || value.default.kind === 'identity' || !!existing?.identity} />
			<Label for={`${id}-nullable`} class="text-xs">Allow NULL</Label>
		</div>
		<div class="flex items-center gap-2">
			<Checkbox id={`${id}-pk`} checked={value.primaryKey} disabled={disabled || !canSetPrimaryKey || !!existing?.primaryKey}
				onCheckedChange={(checked) => { value.primaryKey = checked; if (checked) value.nullable = false; }} />
			<Label for={`${id}-pk`} class="text-xs">Primary key</Label>
		</div>
	</div>
</div>
