<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowDown, Download, RotateCcw, RotateCw, Search, X } from '@lucide/svelte';
	import { queryStats } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { QueryStat, QueryStats } from '#lib/database.js';
	import { highlightSql } from '#lib/sql-highlight.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import PanelResizer from './PanelResizer.svelte';
	import SqlDialog from './SqlDialog.svelte';

	const COLUMNS = [
		['totalTime', 'Time consumed'], ['calls', 'Calls'], ['maxTime', 'Max time'], ['meanTime', 'Mean time'],
		['minTime', 'Min time'], ['rows', 'Rows processed'], ['hitRate', 'Cache hit rate']
	] as const;
	type Column = (typeof COLUMNS)[number][0];
	const ALL = '*';
	const ENABLE_SQL = 'create extension if not exists pg_stat_statements;';
	const id = $props.id();
	let stats = $state.raw<QueryStats | null>(null);
	let error = $state('');
	let query = $state('');
	let role = $state(ALL);
	let sort = $state<Column>('totalTime');
	let selected = $state.raw<QueryStat | null>(null);
	let panelWidth = $state(520);
	let windowWidth = $state(1280);
	/** The statement awaiting confirmation: enable the extension, or reset the statistics. */
	let pending = $state<'enable' | 'reset' | null>(null);
	const queries = $derived(stats?.available ? stats.queries : []);
	const resetSql = $derived(stats?.available ? `select ${stats.schema}.pg_stat_statements_reset();` : '');
	const totalTime = $derived(queries.reduce((sum, item) => sum + item.totalTime, 0));
	const totals = $derived(queries.reduce((sum, item) => ({ calls: sum.calls + item.calls, rows: sum.rows + item.rows }), { calls: 0, rows: 0 }));
	const roles = $derived([...new Set(queries.map((item) => item.role))].sort());
	const shown = $derived(queries.filter((item) => (role === ALL || item.role === role)
		&& item.query.toLowerCase().includes(query.trim().toLowerCase())).toSorted((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1)));
	const ms = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(value < 10 ? 2 : 0)}ms`;
	const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(value > 0.9995 ? 0 : 1)}%`;
	const share = (item: QueryStat) => totalTime ? item.totalTime / totalTime : 0;

	async function load() {
		try { stats = await fresh(queryStats({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(load);

	function cell(item: QueryStat, column: Column) {
		if (column === 'totalTime') return `${percent(share(item))} / ${ms(item.totalTime)}`;
		if (column === 'meanTime' || column === 'maxTime' || column === 'minTime') return ms(item[column]);
		if (column === 'hitRate') return percent(item.hitRate);
		return item[column].toLocaleString();
	}

	/** The rows as shown (filtered and sorted), times in milliseconds. */
	function exportCsv() {
		const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
		const lines = [['query', 'role', 'calls', 'total_ms', 'max_ms', 'mean_ms', 'min_ms', 'rows', 'cache_hit_rate'],
			...shown.map((item) => [item.query, item.role, item.calls, item.totalTime, item.maxTime, item.meanTime, item.minTime, item.rows, item.hitRate])];
		const blob = new Blob([lines.map((line) => line.map(quote).join(',')).join('\r\n')], { type: 'text/csv' });
		const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'query-performance.csv' });
		link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
	}
</script>

<svelte:window bind:innerWidth={windowWidth} onkeydown={(event) => { if (event.key === 'Escape' && selected && !pending && !event.defaultPrevented) selected = null; }} />

{#snippet sql(text: string)}{#each highlightSql(text) as span}<span class={span.class}>{span.text}</span>{/each}{/snippet}

<div class="flex h-full min-h-0">
	<div class="min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
		{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
		{#if stats && !stats.available}
			<div class="max-w-2xl space-y-2 rounded-md border p-4 text-xs">
				<p class="font-medium">Query statistics are unavailable</p>
				<p class="text-muted-foreground">{stats.reason}</p>
				{#if !stats.installed}
					<pre class="rounded-md bg-muted p-2 font-mono">{ENABLE_SQL}</pre>
					<Button size="xs" onclick={() => pending = 'enable'}>Enable extension</Button>
				{/if}
				<p class="text-muted-foreground">The server must also preload it: set <code>shared_preload_libraries = 'pg_stat_statements'</code>
					in its configuration (or <code>alter system set …</code>) and restart PostgreSQL.</p>
				<Button variant="outline" size="xs" onclick={load}>Check again</Button>
			</div>
		{:else if stats}
			<div class="flex flex-wrap items-baseline gap-x-3 gap-y-2 text-sm">
				<!-- queryStats returns the top 500. -->
				<span><span class="text-lg font-medium">{queries.length >= 500 ? '500+' : queries.length.toLocaleString()}</span> Statements</span>
				<span class="text-muted-foreground">/</span>
				<span><span class="text-lg font-medium">{percent(stats.hitRate)}</span> Cache hit rate</span>
				<span class="text-muted-foreground">/</span>
				<span><span class="text-lg font-medium">{totals.calls ? (totals.rows / totals.calls).toFixed(1) : '—'}</span> Avg. rows per call</span>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<div class="relative w-full max-w-xs">
					<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
					<Input bind:value={query} aria-label="Filter by query" placeholder="Filter by query" spellcheck={false} class="h-8 pl-9 text-xs" />
				</div>
				<Select.Root type="single" value={role} onValueChange={(next) => role = next || ALL} allowDeselect={false}>
					<Select.Trigger size="sm" aria-label="Role" class="text-xs">{role === ALL ? 'Roles' : role}</Select.Trigger>
					<Select.Content>
						<Select.Item value={ALL} label="Any role" class="text-xs" />
						{#each roles as option}<Select.Item value={option} label={option} class="text-xs" />{/each}
					</Select.Content>
				</Select.Root>
				<div class="ml-auto flex gap-2">
					<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" onclick={load}><RotateCw /></Button>
					<Button variant="outline" size="icon-sm" aria-label="Reset statistics" title="Reset statistics"
						onclick={() => pending = 'reset'}><RotateCcw /></Button>
					<Button variant="outline" size="sm" disabled={!shown.length} onclick={exportCsv}><Download />Export CSV</Button>
				</div>
			</div>
			<div class="overflow-x-auto rounded-md border">
				<table class="w-full text-left text-xs">
					<thead class="border-b text-muted-foreground"><tr>
						<th class="p-3 font-medium">Query</th>
						{#each COLUMNS as [key, label]}
							<th class="p-3 text-right font-medium whitespace-nowrap">
								<button class={['inline-flex items-center gap-1', sort === key && 'text-foreground']} onclick={() => sort = key}>
									{label}{#if sort === key}<ArrowDown class="size-3" />{/if}
								</button>
							</th>
						{/each}
						<th class="p-3 font-medium">Role</th>
					</tr></thead>
					<tbody class="divide-y">
						{#each shown as item, i (i)}
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (the query button is the keyboard path) -->
							<tr class={['cursor-pointer hover:bg-muted/40', selected === item && 'bg-muted/60']} onclick={() => selected = item}>
								<td class="max-w-sm p-3">
									<button class="sql-code block w-full truncate text-left font-mono outline-none focus-visible:underline"
										title="Show details">{@render sql(item.query.replace(/\s+/g, ' '))}</button>
								</td>
								{#each COLUMNS as [key]}
									<td class="relative p-3 text-right font-mono whitespace-nowrap">
										{#if key === 'totalTime'}<div class="absolute inset-y-0 left-0 bg-muted" style:width="{share(item) * 100}%"></div>{/if}
										<span class={['relative', key === 'hitRate' && item.hitRate === 0 && 'text-muted-foreground']}>{cell(item, key)}</span>
									</td>
								{/each}
								<td class="p-3 font-mono">{item.role}</td>
							</tr>
						{:else}
							<tr><td colspan={COLUMNS.length + 2} class="p-3 text-muted-foreground">{queries.length ? 'No matching statements.' : 'No statements recorded yet.'}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="grid gap-4 rounded-md border p-4 text-xs sm:grid-cols-2">
				<div class="space-y-2">
					<p class="font-medium">Reset report</p>
					<p class="text-muted-foreground">Consider resetting the statistics after optimizing queries, to measure from a clean slate.</p>
					<Button variant="outline" size="xs" onclick={() => pending = 'reset'}>Reset report</Button>
				</div>
				<div class="space-y-2">
					<p class="font-medium">How is this report generated?</p>
					<p class="text-muted-foreground">From the <code>pg_stat_statements</code> extension: statements with constants replaced by
						<code>$1</code>, <code>$2</code>…, accumulated since the last reset, for this database. The cache hit rate is the share of
						blocks read from shared buffers rather than disk.</p>
				</div>
			</div>
		{:else}
			<p class="text-xs text-muted-foreground">Loading…</p>
		{/if}
	</div>
	<!-- Beside the table, not modal: other rows stay clickable. -->
	{#if selected}
		<aside aria-labelledby={`${id}-details`} class="relative flex shrink-0 flex-col gap-4 overflow-y-auto border-l bg-card p-5" style:width="{panelWidth}px">
			<PanelResizer bind:width={panelWidth} min={320} max={Math.max(320, windowWidth - 480)} label="Resize query details" />
			<div class="flex items-center">
				<h2 id={`${id}-details`} class="text-sm font-medium">Query details</h2>
				<Button variant="ghost" size="icon-sm" class="ml-auto" aria-label="Close query details" onclick={() => selected = null}><X /></Button>
			</div>
			<div class="space-y-2">
				<h3 class="text-xs font-medium">Query pattern</h3>
				<!-- Unwrapped: keeps the statement's own line layout. -->
				<pre class="sql-code max-h-[50dvh] overflow-auto rounded-md border bg-background p-3 font-mono text-xs">{@render sql(selected.query)}</pre>
			</div>
			<div class="space-y-2">
				<h3 class="text-xs font-medium">Metadata</h3>
				<dl class="divide-y text-xs">
					{#each [...COLUMNS.map(([key, label]) => [label, cell(selected!, key)]), ['Role', selected.role]] as [label, value]}
						<div class="flex justify-between gap-4 py-2.5"><dt class="text-muted-foreground">{label}</dt><dd class="font-mono">{value}</dd></div>
					{/each}
				</dl>
			</div>
		</aside>
	{/if}
</div>

<SqlDialog open={!!pending} title={pending === 'enable' ? 'Enable pg_stat_statements' : 'Reset query statistics'}
	description={pending === 'enable' ? undefined : 'Clears pg_stat_statements for the whole server, not just this database.'}
	sql={pending === 'enable' ? ENABLE_SQL : pending ? resetSql : ''} destructive={pending === 'reset'} action={pending === 'reset' ? 'Reset' : 'Apply'}
	onclose={() => pending = null} onapplied={load} />
