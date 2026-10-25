<script lang="ts">
	import { tick } from 'svelte';
	import { Plus } from '@lucide/svelte';
	import type { ColumnConstraintOperation, ConstraintOperation, ConstraintSpec, SchemaConstraint, SchemaDefinition } from '#lib/schema.js';
	import { constraintOperationSchema } from '#lib/schema-validation.js';
	import { constraintSpec, displayIdentifier, schemaDraftSnapshot } from '#lib/schema-forms.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import SchemaConstraints from './SchemaConstraints.svelte';

	let { definition, column, renamedColumn, primaryKey, connection, disabled,
		operations = $bindable([]), valid = $bindable(true) }: {
		definition: SchemaDefinition; column: string; renamedColumn: string; primaryKey: boolean;
		connection: string; disabled: boolean; operations: ColumnConstraintOperation[]; valid: boolean;
	} = $props();
	const id = $props.id();
	type Draft = { key: string; operation: ColumnConstraintOperation; beforeRemoval?: ColumnConstraintOperation };
	let drafts = $state<Draft[]>([]);
	let opened = $state<string[]>([]);
	let confirmations = $state<Record<string, string>>({});
	let root = $state<HTMLDivElement | null>(null);
	const related = $derived(definition.constraints.filter((constraint) => constraint.columns.includes(column)));
	const individualPrimary = $derived(primaryKey && definition.primaryKey.length <= 1);
	const atLimit = $derived(drafts.length >= 20);
	const singles = $derived.by(() => {
		const result: { original: SchemaConstraint | null; draft: Draft | undefined; spec: Extract<ConstraintSpec, { kind: 'unique' }> }[] = [];
		for (const original of definition.constraints.filter((constraint) => constraint.kind === 'u')) {
			const draft = drafts.find((draft) => draft.key === original.oid);
			if (draft?.operation.kind === 'dropConstraint') continue;
			const spec = draft?.operation.kind === 'alterConstraint' ? draft.operation.constraint : constraintSpec(original);
			if (spec.kind === 'unique' && spec.columns.length === 1 && spec.columns[0] === column) result.push({ original, draft, spec });
		}
		for (const draft of drafts) {
			const operation = draft.operation;
			if (operation.kind === 'addConstraint' && operation.constraint.kind === 'unique'
				&& operation.constraint.columns.length === 1 && operation.constraint.columns[0] === column) {
				result.push({ original: null, draft, spec: operation.constraint });
			}
		}
		return result;
	});
	const simpleUnique = $derived(singles.length === 1 && !singles[0].spec.deferrable && !singles[0].spec.nullsNotDistinct
		&& (!singles[0].original || singles[0].original.replaceable));

	function changed(draft: Draft) {
		const operation = draft.operation;
		if (operation.kind !== 'alterConstraint') return true;
		const original = definition.constraints.find((constraint) => constraint.oid === operation.constraintOid)!;
		return schemaDraftSnapshot(operation.constraint) !== schemaDraftSnapshot(constraintSpec(original));
	}
	function issues(operation: ConstraintOperation) {
		const result = constraintOperationSchema['~standard'].validate(operation);
		return 'issues' in result ? result.issues : undefined;
	}
	$effect(() => {
		operations = drafts.filter(changed).map((draft) => draft.operation);
		valid = drafts.length <= 20 && drafts.every(({ operation }) => !issues(operation)
			&& (operation.kind !== 'dropConstraint' || confirmations[operation.constraintOid]
				=== definition.constraints.find((constraint) => constraint.oid === operation.constraintOid)?.name));
	});

	function name(suffix: string) {
		const used = new Set([...definition.constraints.map((constraint) => constraint.name),
			...definition.indexes.map((index) => index.name), ...drafts.flatMap(({ operation }) => 'constraint' in operation ? [operation.constraint.name] : [])]);
		for (let counter = 0; ; counter++) {
			const ending = `_${suffix}${counter || ''}`;
			const prefix = Array.from(`${definition.table}_${column}`);
			while (new TextEncoder().encode(prefix.join('') + ending).length > 63) prefix.pop();
			const candidate = prefix.join('') + ending;
			if (!used.has(candidate)) return candidate;
		}
	}
	async function focus(key: string) {
		await tick();
		root?.querySelector<HTMLElement>(`[data-constraint-draft="${key}"] input:not(:disabled)`)?.focus();
	}
	function add(kind: 'check' | 'foreignKey') {
		if (disabled || atLimit) return;
		const constraint: ConstraintSpec = kind === 'check'
			? { kind, name: name('check'), expression: '', notValid: false, noInherit: false }
			: { kind, name: name('fkey'), columns: [column], reference: { schema: definition.schema, table: '', oid: '', version: '', columns: [] },
				match: 'simple', onUpdate: 'no action', onDelete: 'no action', notValid: false, deferrable: false, initiallyDeferred: false };
		const key = crypto.randomUUID();
		drafts = [...drafts, { key, operation: { kind: 'addConstraint', constraint } }];
		opened = [...opened, key];
		void focus(key);
	}
	function edit(original: SchemaConstraint) {
		if (disabled || !original.replaceable) return;
		if (!drafts.some((draft) => draft.key === original.oid)) {
			if (atLimit) return;
			drafts = [...drafts, { key: original.oid, operation: { kind: 'alterConstraint', constraintOid: original.oid, constraint: constraintSpec(original) } }];
		}
		opened = [...opened, original.oid];
		void focus(original.oid);
	}
	function undo(key: string) {
		if (disabled) return;
		const draft = drafts.find((draft) => draft.key === key);
		if (draft?.operation.kind === 'dropConstraint' && draft.beforeRemoval) {
			draft.operation = draft.beforeRemoval;
			delete draft.beforeRemoval;
		} else {
			drafts = drafts.filter((draft) => draft.key !== key);
			opened = opened.filter((value) => value !== key);
		}
		delete confirmations[key];
	}
	function remove(original: SchemaConstraint) {
		if (disabled) return;
		const existing = drafts.find((draft) => draft.key === original.oid);
		if (!existing && atLimit) return;
		const operation: ColumnConstraintOperation = { kind: 'dropConstraint', constraintOid: original.oid };
		if (existing) { existing.beforeRemoval = existing.operation; existing.operation = operation; }
		else drafts = [...drafts, { key: original.oid, operation }];
		confirmations[original.oid] = '';
		void focus(original.oid);
	}
	function toggleUnique(checked: boolean) {
		if (disabled || individualPrimary) return;
		if (checked) {
			const removed = drafts.find((draft) => draft.operation.kind === 'dropConstraint' && related.some((constraint) =>
				constraint.oid === draft.key && constraint.kind === 'u' && constraint.columns.length === 1));
			if (removed) { undo(removed.key); return; }
			if (atLimit || singles.length) return;
			drafts = [...drafts, { key: crypto.randomUUID(), operation: { kind: 'addConstraint', constraint: {
				kind: 'unique', name: name('key'), columns: [column], nullsNotDistinct: false, deferrable: false, initiallyDeferred: false
			} } }];
		} else if (simpleUnique) {
			if (singles[0].original) remove(singles[0].original);
			else if (singles[0].draft) undo(singles[0].draft.key);
		}
	}
	function update(draft: Draft, operation: ConstraintOperation | null) {
		if (operation && (operation.kind === 'addConstraint' || operation.kind === 'alterConstraint' || operation.kind === 'dropConstraint')) draft.operation = operation;
	}
</script>

{#snippet summary(spec: ConstraintSpec)}
	<p class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{spec.kind === 'check' ? spec.expression
		: spec.kind === 'unique' ? `(${spec.columns.map(displayIdentifier).join(', ')})`
		: `(${spec.columns.map(displayIdentifier).join(', ')}) → ${displayIdentifier(spec.reference.schema)}.${displayIdentifier(spec.reference.table)} (${spec.reference.columns.map(displayIdentifier).join(', ')})`}</p>
	{#if spec.kind === 'foreignKey'}<p class="text-xs text-muted-foreground">ON UPDATE {spec.onUpdate.toUpperCase()} · ON DELETE {spec.onDelete.toUpperCase()} · MATCH {spec.match.toUpperCase()}</p>{/if}
{/snippet}

{#snippet form(draft: Draft)}
	<details open={opened.includes(draft.key)} class="space-y-3" ontoggle={(event) => {
		opened = event.currentTarget.open ? [...new Set([...opened, draft.key])] : opened.filter((key) => key !== draft.key);
	}}>
		<summary class="cursor-pointer text-xs text-muted-foreground">Edit constraint draft</summary>
		<div class="space-y-4 border-t pt-4">
			<SchemaConstraints {definition} {connection} bind:draft={() => draft.operation, (operation) => update(draft, operation)}
				confirmation="" {disabled} onbegin={(operation) => update(draft, operation)} />
			{#if 'constraint' in draft.operation && (draft.operation.constraint.kind !== 'foreignKey' || draft.operation.constraint.reference.version)}
				{#if issues(draft.operation)?.[0]}<p role="status" class="text-xs text-destructive">{issues(draft.operation)?.[0].message}</p>{/if}
			{/if}
		</div>
	</details>
{/snippet}

<div bind:this={root} class="space-y-6" aria-label="Column constraints">
	{#if renamedColumn !== column}<p class="break-words text-xs text-muted-foreground">Use the current name <code>{column}</code> in constraint drafts. PostgreSQL applies the column rename afterward.</p>{/if}
	{#each ['u', 'c', 'f'] as kind}
		<section class="space-y-3 border-t pt-5" aria-label={kind === 'u' ? 'Unique constraints' : kind === 'c' ? 'CHECK constraints' : 'Foreign keys'}>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h3 class="text-sm font-medium">{kind === 'u' ? 'Unique' : kind === 'c' ? 'CHECK constraints' : 'Foreign keys'}</h3>
				{#if kind !== 'u'}<Button variant="outline" size="xs" disabled={disabled || atLimit} onclick={() => add(kind === 'c' ? 'check' : 'foreignKey')}><Plus />{kind === 'c' ? 'Add CHECK' : 'Add foreign key'}</Button>{/if}
			</div>
			{#if kind === 'u'}
				<div class="flex items-center gap-2">
					<Checkbox id={`${id}-unique`} checked={individualPrimary || singles.length > 0}
						disabled={disabled || individualPrimary || (singles.length > 0 && !simpleUnique) || (atLimit && !singles.length)} onCheckedChange={toggleUnique} />
					<Label for={`${id}-unique`} class="text-xs">{individualPrimary ? 'Unique (primary key)' : 'Unique constraint'}</Label>
				</div>
				{#if singles.length > 0 && !simpleUnique && !individualPrimary}<p class="text-xs text-muted-foreground">Manage the individual constraints below.</p>{/if}
				{#if definition.primaryKey.length > 1 && definition.primaryKey.includes(column)}<p class="break-all text-xs text-muted-foreground">Composite primary key: ({definition.primaryKey.map(displayIdentifier).join(', ')})</p>{/if}
				{#each definition.indexes.filter((index) => index.unique && !index.constraint && index.columns.includes(column)) as index}
					<p class="break-all text-xs text-muted-foreground">Unique index: {displayIdentifier(index.name)} ({index.columns.map(displayIdentifier).join(', ')}). Manage it in Indexes.</p>
				{/each}
			{/if}
			{#each related.filter((constraint) => constraint.kind === kind) as constraint (constraint.oid)}
				{@const draft = drafts.find((draft) => draft.key === constraint.oid)}
				{@const dropping = draft?.operation.kind === 'dropConstraint'}
				{@const replica = definition.indexes.some((index) => index.oid === constraint.indexOid && index.replicaIdentity)}
				<section class="min-w-0 space-y-3 rounded-md border p-3" aria-label={`Constraint ${constraint.name}`} data-constraint-draft={constraint.oid}>
					<div class="flex flex-wrap items-start justify-between gap-2">
						<h4 class="min-w-0 break-all font-mono text-xs">{draft && 'constraint' in draft.operation ? draft.operation.constraint.name : constraint.name}</h4>
						{#if draft}<span class="text-xs text-muted-foreground">{dropping ? 'Removal staged' : changed(draft) ? 'Changed' : 'Editing'}</span>{/if}
					</div>
					{#if constraint.columns.length > 1}<p class="break-all text-xs text-muted-foreground">Whole constraint on ({constraint.columns.map(displayIdentifier).join(', ')})</p>{/if}
					{#if draft && 'constraint' in draft.operation}{@render summary(draft.operation.constraint)}
					{:else}<pre class="whitespace-pre-wrap break-all font-mono text-xs">{constraint.definition}</pre>{/if}
					{#if !constraint.validated || !constraint.enforced}<p class="text-xs text-amber-300">{!constraint.enforced ? 'Not enforced.' : ''} {!constraint.validated ? 'Not validated against existing rows.' : ''}</p>{/if}
					{#if dropping}
						<p class="text-xs text-destructive">Apply removes the whole constraint, not just this column’s membership.{constraint.kind === 'u' ? ' Its backing index is also removed.' : ''} Dependencies are not removed automatically.</p>
						<div class="space-y-2"><Label for={`${id}-${constraint.oid}`} class="break-all text-xs">Type {constraint.name} to confirm removal</Label>
							<Input id={`${id}-${constraint.oid}`} value={confirmations[constraint.oid] ?? ''} oninput={(event) => confirmations[constraint.oid] = event.currentTarget.value} {disabled} autocomplete="off" spellcheck={false} class="font-mono text-xs" /></div>
					{:else if draft}{@render form(draft)}
					{:else if !constraint.replaceable}<p class="text-xs text-muted-foreground">Native options require SQL to edit.{replica ? ' Change replica identity before removal.' : ''}</p>{/if}
					<div class="flex flex-wrap justify-end gap-2">
						{#if draft}<Button size="xs" variant="ghost" {disabled} onclick={() => undo(constraint.oid)}>Undo {dropping ? 'removal' : 'edit'}</Button>
						{:else}<Button size="xs" variant="ghost" disabled={disabled || atLimit || !constraint.replaceable} aria-label={`Edit constraint ${constraint.name}`} onclick={() => edit(constraint)}>Edit</Button>{/if}
						{#if !dropping}<Button size="xs" variant="ghost" class="text-destructive" disabled={disabled || replica || (atLimit && !draft)} aria-label={`Remove constraint ${constraint.name}`} onclick={() => remove(constraint)}>Remove</Button>{/if}
					</div>
				</section>
			{/each}
			{#each drafts.filter((draft) => draft.operation.kind === 'addConstraint' && draft.operation.constraint.kind === ({ u: 'unique', c: 'check', f: 'foreignKey' }[kind])) as draft (draft.key)}
				{#if draft.operation.kind === 'addConstraint'}
					<section class="min-w-0 space-y-3 rounded-md border p-3" aria-label={`New constraint ${draft.operation.constraint.name}`} data-constraint-draft={draft.key}>
						<div class="flex flex-wrap justify-between gap-2"><h4 class="min-w-0 break-all font-mono text-xs">{draft.operation.constraint.name}</h4><span class="text-xs text-muted-foreground">New</span></div>
						{@render summary(draft.operation.constraint)}
						{@render form(draft)}
						<div class="flex justify-end"><Button size="xs" variant="ghost" {disabled} onclick={() => undo(draft.key)}>Discard new constraint</Button></div>
					</section>
				{/if}
			{/each}
		</section>
	{/each}
	{#if atLimit}<p role="status" class="text-xs text-muted-foreground">At most 20 constraint changes can share one Apply.</p>{/if}
</div>
