<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowDown, RotateCw, Search } from '@lucide/svelte';
	import { changeSchema, queryStats } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { QueryStat, QueryStats } from '#lib/database.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	const COLUMNS = [
		['totalTime', 'Time consumed'], ['calls', 'Calls'], ['meanTime', 'Mean'], ['maxTime', 'Max'], ['rows', 'Rows'], ['hitRate', 'Cache hit']
	] as const;
	const RESET_SQL = 'select pg_stat_statements_reset();';
	const ENABLE_SQL = 'create extension if not exists pg_stat_statements;';
	let stats = $state.raw<QueryStats | null>(null);
	let error = $state('');
	let query = $state('');
	let sort = $state<(typeof COLUMNS)[number][0]>('totalTime');
	let resetting = $state(false);
	let applying = $state(false);
	let applyError = $state('');
	const queries = $derived(stats?.available ? stats.queries : []);
	const totalTime = $derived(queries.reduce((sum, item) => sum + item.totalTime, 0));
	const totals = $derived(queries.reduce((sum, item) => ({ calls: sum.calls + item.calls, rows: sum.rows + item.rows }), { calls: 0, rows: 0 }));
	const shown = $derived(queries.filter((item) => item.query.toLowerCase().includes(query.trim().toLowerCase()))
		.toSorted((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1)));
	const ms = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(value < 10 ? 2 : 0)}ms`;
	const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(value > 0.9995 ? 0 : 1)}%`;

	async function load() {
		try { stats = await fresh(queryStats({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function cell(item: QueryStat, column: (typeof COLUMNS)[number][0]) {
		if (column === 'totalTime') return `${ms(item.totalTime)} · ${percent(totalTime ? item.totalTime / totalTime : 0)}`;
		if (column === 'meanTime' || column === 'maxTime') return ms(item[column]);
		if (column === 'hitRate') return percent(item.hitRate);
		return item[column].toLocaleString();
	}

	async function run(sql: string) {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			resetting = false;
			await load();
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

<div class="space-y-3 p-4">
	{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	{#if stats && !stats.available}
		<div class="max-w-2xl space-y-2 rounded-md border p-4 text-xs">
			<p class="font-medium">Query statistics are unavailable</p>
			<p class="text-muted-foreground">{stats.reason}</p>
			{#if !stats.installed}
				<pre class="rounded-md bg-muted p-2 font-mono">{ENABLE_SQL}</pre>
				{#if applyError}<p role="alert" class="break-words text-destructive">{applyError}</p>{/if}
				<Button size="xs" disabled={applying} onclick={() => run(ENABLE_SQL)}>{applying ? 'Enabling…' : 'Enable extension'}</Button>
			{/if}
			<p class="text-muted-foreground">The server must also preload it: set <code>shared_preload_libraries = 'pg_stat_statements'</code>
				in its configuration (or <code>alter system set …</code>) and restart PostgreSQL.</p>
			<Button variant="outline" size="xs" onclick={load}>Check again</Button>
		</div>
	{:else if stats}
		<div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
			<span><span class="text-base font-medium">{queries.length.toLocaleString()}</span> statements</span>
			<span><span class="text-base font-medium">{percent(stats.hitRate)}</span> cache hit rate</span>
			<span><span class="text-base font-medium">{totals.calls ? (totals.rows / totals.calls).toFixed(1) : '—'}</span> rows per call</span>
			<div class="ml-auto flex gap-2">
				<Button variant="outline" size="sm" onclick={load}><RotateCw />Refresh</Button>
				<Button variant="outline" size="sm" onclick={() => { resetting = true; applyError = ''; }}>Reset statistics</Button>
			</div>
		</div>
		<div class="relative max-w-sm">
			<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
			<Input bind:value={query} aria-label="Filter by query" placeholder="Filter by query" spellcheck={false} class="h-8 pl-9 text-xs" />
		</div>
		<div class="overflow-x-auto rounded-md border">
			<table class="w-full text-left text-xs">
				<thead class="border-b text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
					<th class="p-3 font-medium">Query</th>
					{#each COLUMNS as [key, label]}
						<th class="p-3 text-right font-medium whitespace-nowrap">
							<button class={['inline-flex items-center gap-1 uppercase', sort === key && 'text-foreground']} onclick={() => sort = key}>
								{label}{#if sort === key}<ArrowDown class="size-3" />{/if}
							</button>
						</th>
					{/each}
					<th class="p-3 font-medium">Role</th>
				</tr></thead>
				<tbody class="divide-y">
					{#each shown as item, i (i)}
						<tr class="align-top">
							<td class="max-w-xl p-3 font-mono">
								<details><summary class="cursor-pointer truncate">{item.query}</summary>
									<pre class="mt-2 whitespace-pre-wrap break-all text-muted-foreground">{item.query}</pre></details>
							</td>
							{#each COLUMNS as [key]}<td class="p-3 text-right font-mono whitespace-nowrap">{cell(item, key)}</td>{/each}
							<td class="p-3 font-mono">{item.role}</td>
						</tr>
					{:else}
						<tr><td colspan={COLUMNS.length + 2} class="p-3 text-muted-foreground">{queries.length ? 'No matching statements.' : 'No statements recorded yet.'}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="text-xs text-muted-foreground">Loading…</p>
	{/if}
</div>

<Dialog.Root bind:open={() => resetting, (open) => { if (!applying) resetting = open; }}>
	<Dialog.Content class="gap-4">
		<Dialog.Header>
			<Dialog.Title>Reset query statistics</Dialog.Title>
			<Dialog.Description class="text-xs">Clears pg_stat_statements for the whole server, not just this database.</Dialog.Description>
		</Dialog.Header>
		<pre class="rounded-md bg-muted p-2 font-mono text-xs">{RESET_SQL}</pre>
		{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => resetting = false}>Cancel</Button>
			<Button variant="destructive" size="sm" disabled={applying} onclick={() => run(RESET_SQL)}>{applying ? 'Resetting…' : 'Reset'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
