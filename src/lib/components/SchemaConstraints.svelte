<script lang="ts">
	import { tick } from 'svelte';
	import { ArrowDown, ArrowUp, Plus, X } from '@lucide/svelte';
	import type { ConstraintOperation, SchemaConstraint, SchemaDefinition } from '#lib/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import TextEditor from './TextEditor.svelte';
	import SchemaForeignKey from './SchemaForeignKey.svelte';
	import { constraintSpec, displayIdentifier } from '#lib/schema-forms.js';

	let { definition, connection, draft = $bindable(null), confirmation = $bindable(''), disabled, onbegin }: {
		definition: SchemaDefinition;
		connection: string;
		draft: ConstraintOperation | null;
		confirmation: string;
		disabled: boolean;
		onbegin: (operation: ConstraintOperation) => void;
	} = $props();
	const id = $props.id();
	let picked = $state('');
	const spec = $derived(draft && 'constraint' in draft ? draft.constraint : null);
	const existing = $derived.by(() => {
		const operation = draft;
		return operation && 'constraintOid' in operation ? definition.constraints.find((constraint) => constraint.oid === operation.constraintOid) : undefined;
	});

	function edit(constraint: SchemaConstraint) {
		onbegin({ kind: 'alterConstraint', constraintOid: constraint.oid, constraint: constraintSpec(constraint) });
	}

	async function addColumn(name: string) {
		if (disabled || spec?.kind !== 'unique' || spec.columns.length >= 32 || spec.columns.includes(name)
			|| !definition.columns.some((column) => column.name === name)) return;
		spec.columns = [...spec.columns, name];
		await tick();
		picked = '';
	}

	function moveColumn(index: number, delta: number) {
		if (disabled || spec?.kind !== 'unique') return;
		const next = index + delta;
		if (next < 0 || next >= spec.columns.length) return;
		[spec.columns[index], spec.columns[next]] = [spec.columns[next], spec.columns[index]];
	}
</script>

{#if !definition.editable}<p role="status" class="text-sm text-muted-foreground">{definition.reason}</p>{/if}
{#if spec}
	<div class="space-y-2">
		<Label for={`${id}-name`}>Constraint name</Label>
		<Input id={`${id}-name`} bind:value={spec.name} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
	</div>
	{#if spec.kind === 'unique'}
		<div class="space-y-3">
			<p class="text-xs font-medium">Key columns · {spec.columns.length} / 32</p>
			<ol class="space-y-2">
				{#each spec.columns as column, i (column)}
					<li class="flex items-center gap-2 rounded-md border p-2">
						<span class="text-xs text-muted-foreground">{i + 1}.</span>
						<span class="min-w-0 flex-1 truncate font-mono text-xs" title={column}>{column}</span>
						<Button variant="ghost" size="icon-xs" disabled={disabled || i === 0} aria-label={`Move ${column} up`} onclick={() => moveColumn(i, -1)}><ArrowUp /></Button>
						<Button variant="ghost" size="icon-xs" disabled={disabled || i === spec.columns.length - 1} aria-label={`Move ${column} down`} onclick={() => moveColumn(i, 1)}><ArrowDown /></Button>
						<Button variant="ghost" size="icon-xs" {disabled} aria-label={`Remove constraint column ${column}`} onclick={() => { if (spec?.kind === 'unique') spec.columns = spec.columns.filter((name) => name !== column); }}><X /></Button>
					</li>
				{/each}
			</ol>
			<Select.Root type="single" bind:value={picked} onValueChange={addColumn} allowDeselect={false}
				disabled={disabled || spec.columns.length >= Math.min(32, definition.columns.length)}>
				<Select.Trigger aria-label="Add constraint column" class="w-full text-xs">Add a column…</Select.Trigger>
				<Select.Content class="max-h-72">
					{#each definition.columns.filter((column) => spec?.kind === 'unique' && !spec.columns.includes(column.name)) as column (column.name)}
						<Select.Item value={column.name} label={column.name}><span class="max-w-64 truncate">{column.name}</span></Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="space-y-3">
			<div class="flex items-start gap-2"><Checkbox id={`${id}-nulls`} bind:checked={spec.nullsNotDistinct} {disabled} /><Label for={`${id}-nulls`} class="text-xs leading-relaxed">Treat NULLs as equal (NULLS NOT DISTINCT)</Label></div>
			<div class="flex items-start gap-2"><Checkbox id={`${id}-defer`} bind:checked={spec.deferrable} {disabled} /><Label for={`${id}-defer`} class="text-xs leading-relaxed">Deferrable</Label></div>
			<div class="flex items-start gap-2"><Checkbox id={`${id}-initial`} bind:checked={spec.initiallyDeferred} {disabled} /><Label for={`${id}-initial`} class="text-xs leading-relaxed">Initially deferred until transaction commit</Label></div>
			{#if spec.initiallyDeferred && !spec.deferrable}<p role="status" class="text-xs text-destructive">Initially deferred requires Deferrable.</p>{/if}
		</div>
	{:else if spec.kind === 'foreignKey'}
		<SchemaForeignKey bind:value={() => spec, (value) => { if (draft && 'constraint' in draft) draft.constraint = value; }} {definition} {connection} {disabled} />
	{:else}
		<div class="space-y-2">
			<Label onclick={() => { if (!disabled) document.getElementById(`${id}-expression`)?.focus(); }}>CHECK expression</Label>
			<TextEditor id={`${id}-expression`} value={spec.expression} language="sql" readonly={disabled} label="CHECK expression"
				onchange={(value) => { if (!disabled && spec?.kind === 'check') spec.expression = value ?? ''; }} placeholder="price >= 0" class="h-44" />
			<p class="text-xs text-muted-foreground">A PostgreSQL boolean expression, without CHECK (...). NULL passes; use IS NOT NULL or column nullability to require a value.</p>
		</div>
		<div class="space-y-3">
			<div class="flex items-start gap-2"><Checkbox id={`${id}-validate`} bind:checked={spec.notValid} {disabled} /><Label for={`${id}-validate`} class="text-xs leading-relaxed">Skip existing rows (NOT VALID); new or updated rows are still checked</Label></div>
			<div class="flex items-start gap-2"><Checkbox id={`${id}-inherit`} bind:checked={spec.noInherit} {disabled} /><Label for={`${id}-inherit`} class="text-xs leading-relaxed">Do not inherit this check (NO INHERIT)</Label></div>
		</div>
	{/if}
	{#if existing}
		<p class="text-xs text-muted-foreground">Apply replaces this constraint atomically and preserves comments. Dependencies can block replacement; they are not removed automatically. Advanced options require SQL.</p>
		{#if existing.kind === 'f'}<p class="text-xs text-muted-foreground">Replacement also locks the old referenced table exclusively and requires its native LOCK permissions, not just REFERENCES.</p>{/if}
	{/if}
	<p class="text-xs text-muted-foreground">Apply locks the table and can block reads and writes. {spec.kind === 'check' ? 'PostgreSQL evaluates the expression during validation; functions can have side effects.' : spec.kind === 'unique' ? 'Existing rows must satisfy uniqueness; PostgreSQL creates a backing index.' : 'Source values must match the referenced key unless validation is deferred.'}</p>
{:else if draft && existing}
	<pre class="whitespace-pre-wrap break-all font-mono text-xs">{existing.definition}</pre>
	{#if draft.kind === 'renameConstraint'}
		<div class="space-y-2">
			<Label for={`${id}-rename`}>Constraint name</Label>
			<Input id={`${id}-rename`} bind:value={draft.name} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
		</div>
	{:else if draft.kind === 'validateConstraint'}
		<p class="text-sm">Validate all existing rows against this {existing.kind === 'f' ? 'foreign key' : 'CHECK constraint'}. Failures leave it NOT VALID; new writes remain checked.</p>
		<p class="text-xs text-muted-foreground">Apply locks the table and can block reads and writes. PostgreSQL evaluates the expression; functions can have side effects.</p>
	{:else if draft.kind === 'dropConstraint'}
		<p class="text-sm text-destructive">Remove this constraint’s enforcement, not the table’s data.{existing.kind === 'u' ? ' Its backing index will also be removed.' : ''} Dependencies block removal; they are not deleted automatically.</p>
		<div class="space-y-2">
			<Label for={`${id}-confirm`} class="break-all text-xs">Type {existing.name} to confirm</Label>
			<Input id={`${id}-confirm`} bind:value={confirmation} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" />
		</div>
	{/if}
{:else}
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm">{definition.constraints.length} {definition.constraints.length === 1 ? 'constraint' : 'constraints'}</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" disabled={disabled || !definition.columns.length} onclick={() => onbegin({ kind: 'addConstraint', constraint: { kind: 'unique', name: '', columns: [], nullsNotDistinct: false, deferrable: false, initiallyDeferred: false } })}><Plus />UNIQUE</Button>
			<Button variant="outline" size="sm" {disabled} onclick={() => onbegin({ kind: 'addConstraint', constraint: { kind: 'check', name: '', expression: '', notValid: false, noInherit: false } })}><Plus />CHECK</Button>
			<Button variant="outline" size="sm" disabled={disabled || !definition.columns.length} onclick={() => onbegin({ kind: 'addConstraint', constraint: {
				kind: 'foreignKey', name: '', columns: [], reference: { schema: definition.schema, table: '', oid: '', version: '', columns: [] },
				match: 'simple', onUpdate: 'no action', onDelete: 'no action', notValid: false, deferrable: false, initiallyDeferred: false
			} })}><Plus />Foreign key</Button>
		</div>
	</div>
	{#each definition.constraints as constraint (constraint.oid)}
		{@const replica = definition.indexes.some((index) => index.oid === constraint.indexOid && index.replicaIdentity)}
		<section class="space-y-3 rounded-md border p-3" aria-label={`Constraint ${constraint.name}`}>
			<div class="space-y-1">
				<h3 class="break-all font-mono text-xs font-medium">{constraint.name}</h3>
				<p class="text-xs text-muted-foreground">{constraint.kind === 'u' ? 'UNIQUE' : constraint.kind === 'f' ? 'FOREIGN KEY' : 'CHECK'}{constraint.deferrable ? ' · Deferrable' : ''}{constraint.initiallyDeferred ? ' · Initially deferred' : ''}{constraint.nullsNotDistinct ? ' · NULLs not distinct' : ''}</p>
			</div>
			{#if constraint.foreignKey}<p class="break-all font-mono text-xs">({constraint.columns.map(displayIdentifier).join(', ')}) → {displayIdentifier(constraint.foreignKey.schema)}.{displayIdentifier(constraint.foreignKey.table)} ({constraint.foreignKey.columns.map(displayIdentifier).join(', ')})</p>{/if}
			{#if !constraint.validated || !constraint.enforced}<p class="text-xs text-amber-300">{!constraint.enforced ? 'Not enforced.' : ''} {!constraint.validated ? 'Not validated against existing rows.' : ''}</p>{/if}
			{#if replica}<p class="text-xs text-muted-foreground">Replica identity — change it in SQL before editing or dropping this constraint.</p>
			{:else if !constraint.replaceable}<p class="text-xs text-muted-foreground">Native options require SQL to edit. Rename preserves them.</p>{/if}
			{#if constraint.comment}<p class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{constraint.comment}</p>{/if}
			<details class="text-xs"><summary class="cursor-pointer text-muted-foreground">SQL definition</summary><pre class="mt-2 whitespace-pre-wrap break-all font-mono">{constraint.definition}</pre></details>
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" size="sm" disabled={disabled || !constraint.replaceable} aria-label={`Edit constraint ${constraint.name}`} onclick={() => edit(constraint)}>Edit</Button>
				<Button variant="ghost" size="sm" {disabled} aria-label={`Rename constraint ${constraint.name}`} onclick={() => onbegin({ kind: 'renameConstraint', constraintOid: constraint.oid, name: constraint.name })}>Rename</Button>
				{#if (constraint.kind === 'c' || constraint.kind === 'f') && !constraint.validated && constraint.enforced}<Button variant="ghost" size="sm" {disabled} aria-label={`Validate constraint ${constraint.name}`} onclick={() => onbegin({ kind: 'validateConstraint', constraintOid: constraint.oid })}>Validate</Button>{/if}
				<Button variant="ghost" size="sm" disabled={disabled || replica} class="text-destructive" aria-label={`Drop constraint ${constraint.name}`} onclick={() => onbegin({ kind: 'dropConstraint', constraintOid: constraint.oid })}>Drop</Button>
			</div>
		</section>
	{/each}
{/if}
