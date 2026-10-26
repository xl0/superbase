<script lang="ts">
	import { onMount } from 'svelte';
	import { LinkPreview } from 'bits-ui';
	import { PostgreSQL } from '@codemirror/lang-sql';
	import { classHighlighter, highlightCode } from '@lezer/highlight';
	import { EllipsisVertical, Pause, Play, Search } from '@lucide/svelte';
	import { activity, changeSchema } from '#lib/db.remote.js';
	import { editor } from '#lib/state/editor.svelte.js';
	import type { Activity, Session } from '#lib/database.js';
	import { fresh, message } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Select from '#lib/components/ui/select/index.js';

	const ALL = '*';
	let data = $state.raw<Activity | null>(null);
	let error = $state('');
	let paused = $state(false);
	let search = $state('');
	let stateFilter = $state(ALL);
	let role = $state(ALL);
	let application = $state(ALL);
	let rootBlockers = $state(false);
	let action = $state.raw<{ session: Session; kind: 'cancel' | 'terminate' } | null>(null);
	let applying = $state(false);
	let applyError = $state('');

	const sessions = $derived(data?.sessions ?? []);
	/** PID → number of sessions waiting on its locks. */
	const blocking = $derived(sessions.reduce((counts, session) => {
		for (const pid of session.blockedBy) counts.set(pid, (counts.get(pid) ?? 0) + 1);
		return counts;
	}, new Map<number, number>()));
	const topBlocker = $derived([...blocking].sort((a, b) => b[1] - a[1])[0]);
	const longest = $derived(sessions.filter((session) => session.state === 'active').sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0]);
	const values = (pick: (session: Session) => string | null) => [...new Set(sessions.map(pick).filter((value) => !!value) as string[])].sort();
	const shown = $derived(sessions.filter((session) =>
		(stateFilter === ALL || session.state === stateFilter) && (role === ALL || session.role === role)
		&& (application === ALL || session.application === application)
		&& (!rootBlockers || (blocking.has(session.pid) && !session.blockedBy.length))
		&& `${session.pid} ${session.query}`.toLowerCase().includes(search.trim().toLowerCase())));
	const sql = $derived(action ? `select pg_${action.kind}_backend(${action.session.pid});` : '');

	async function load() {
		try { data = await fresh(activity({ connection: editor.connection })); error = ''; }
		catch (cause) { error = message(cause); }
	}
	onMount(() => {
		void load();
		const timer = setInterval(() => { if (!paused && !action && document.visibilityState === 'visible') void load(); }, 5_000);
		return () => clearInterval(timer);
	});

	function age(seconds: number | null | undefined) {
		if (seconds == null) return '—';
		seconds = Math.max(0, seconds); // a query that just started can read a hair below zero
		if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
		return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
	}

	/** Syntax-highlighted spans for the hover preview (same parser as the SQL editor). */
	function highlighted(query: string) {
		const spans: { text: string; class: string }[] = [];
		highlightCode(query, PostgreSQL.language.parser.parse(query), classHighlighter,
			(text, classes) => spans.push({ text, class: classes }), () => spans.push({ text: '\n', class: '' }));
		return spans;
	}

	async function run() {
		applying = true;
		applyError = '';
		try {
			await changeSchema({ connection: editor.connection, sql });
			action = null;
			await load();
		} catch (cause) { applyError = message(cause); }
		finally { applying = false; }
	}
</script>

{#snippet card(label: string, value: string, detail = '')}
	<div class="rounded-md border bg-card px-4 py-3">
		<p class="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">{label}</p>
		<p class="mt-1 truncate text-lg">{value}{#if detail}<span class="ml-2 text-xs text-muted-foreground">{detail}</span>{/if}</p>
	</div>
{/snippet}

{#snippet filter(label: string, value: string, options: string[], set: (value: string) => void)}
	<Select.Root type="single" {value} onValueChange={(next) => set(next || ALL)} allowDeselect={false}>
		<Select.Trigger size="sm" aria-label={label} class="text-xs">{value === ALL ? label : value || '(none)'}</Select.Trigger>
		<Select.Content>
			<Select.Item value={ALL} label={`Any ${label.toLowerCase()}`} class="text-xs" />
			{#each options as option}<Select.Item value={option} label={option} class="text-xs" />{/each}
		</Select.Content>
	</Select.Root>
{/snippet}

<div class="space-y-6 p-4">
	<section class="space-y-3">
		<div class="flex items-center gap-3">
			<h2 class="text-sm font-medium">Overview</h2>
			<span class={['flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] uppercase', paused ? 'text-muted-foreground' : 'border-primary/40 text-primary']}>
				<span class={['size-1.5 rounded-full', paused ? 'bg-muted-foreground' : 'bg-primary']}></span>{paused ? 'Paused' : 'Live'}
			</span>
			<Button variant="outline" size="sm" class="ml-auto" onclick={() => { paused = !paused; if (!paused) void load(); }}>
				{#if paused}<Play />Resume{:else}<Pause />Pause{/if}
			</Button>
		</div>
		{#if error}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{@render card('Connections', data ? `${data.connections} / ${data.maxConnections}` : '—', 'server-wide')}
			{@render card('Active queries', String(sessions.filter((session) => session.state === 'active').length))}
			{@render card('Idle in transaction', String(sessions.filter((session) => session.state?.startsWith('idle in transaction')).length))}
			{@render card('Blocked queries', String(sessions.filter((session) => session.blockedBy.length).length))}
			{@render card('Top blocker', topBlocker ? `PID ${topBlocker[0]}` : '—', topBlocker ? `blocks ${topBlocker[1]}` : '')}
			{@render card('Longest running', longest ? age(longest.duration) : '—', longest ? `PID ${longest.pid}` : '')}
		</div>
	</section>

	<section class="space-y-3">
		<h2 class="text-sm font-medium">Sessions</h2>
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative w-full max-w-xs">
				<Search class="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
				<Input bind:value={search} aria-label="Search query" placeholder="Search query or PID" spellcheck={false} class="h-8 pl-9 text-xs" />
			</div>
			{@render filter('State', stateFilter, values((session) => session.state), (value) => stateFilter = value)}
			{@render filter('Role', role, values((session) => session.role), (value) => role = value)}
			{@render filter('Application', application, values((session) => session.application), (value) => application = value)}
			<Button variant={rootBlockers ? 'secondary' : 'outline'} size="sm" aria-pressed={rootBlockers} onclick={() => rootBlockers = !rootBlockers}
				title="Sessions that block others without waiting themselves">Root blockers</Button>
		</div>
		<div class="overflow-x-auto rounded-md border">
			<table class="w-full text-left text-xs">
				<thead class="border-b font-mono text-[10px] tracking-wider text-muted-foreground uppercase"><tr>
					<th class="p-3 font-medium">State</th><th class="p-3 font-medium">Query · Session</th>
					<th class="p-3 font-medium">Duration</th><th class="p-3 font-medium whitespace-nowrap">Blocked by</th><th></th>
				</tr></thead>
				<tbody class="divide-y">
					{#each shown as session (session.pid)}
						<tr class="align-top">
							<td class="p-3">
								<span class={['inline-block rounded border px-1.5 py-0.5 text-[10px] whitespace-nowrap uppercase',
									session.state === 'active' ? 'border-primary/40 text-primary'
									: session.state?.startsWith('idle in transaction') ? 'border-amber-300/40 text-amber-300' : 'text-muted-foreground']}>{session.state ?? 'unknown'}</span>
							</td>
							<td class="max-w-0 w-full p-3">
								<LinkPreview.Root openDelay={300}>
									<LinkPreview.Trigger>
										{#snippet child({ props })}<button {...props} type="button" class="block w-full cursor-default truncate text-left font-mono outline-none focus-visible:underline">{session.query || '—'}</button>{/snippet}
									</LinkPreview.Trigger>
									{#if session.query}
										<LinkPreview.Portal>
											<LinkPreview.Content side="bottom" align="start" sideOffset={4}
												class="sql-preview z-50 max-h-96 w-[min(40rem,calc(100vw-24px))] overflow-auto rounded-md border bg-popover p-3 shadow-md">
												<pre class="font-mono text-xs whitespace-pre-wrap break-words">{#each highlighted(session.query) as span}<span class={span.class}>{span.text}</span>{/each}</pre>
											</LinkPreview.Content>
										</LinkPreview.Portal>
									{/if}
								</LinkPreview.Root>
								<p class="mt-1 truncate text-muted-foreground">PID: {session.pid} · {session.role ?? '—'} · {session.application || '—'}{session.client ? ` · ${session.client}` : ''}{session.state === 'active' && session.waitType ? ` · waiting on ${session.waitType}: ${session.wait}` : ''}</p>
							</td>
							<td class="p-3 font-mono whitespace-nowrap">{age(session.duration)}</td>
							<td class="p-3 whitespace-nowrap">{#if session.blockedBy.length}<span class="text-destructive">PID {session.blockedBy.join(', ')}</span>{:else}—{/if}</td>
							<td class="p-2 text-right">
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-xs" aria-label={`Actions for session ${session.pid}`}><EllipsisVertical /></Button>{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item disabled={session.state !== 'active'} onSelect={() => { action = { session, kind: 'cancel' }; applyError = ''; }}>Cancel query</DropdownMenu.Item>
										<DropdownMenu.Item variant="destructive" onSelect={() => { action = { session, kind: 'terminate' }; applyError = ''; }}>Terminate session</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="p-3 text-muted-foreground">{data === null ? 'Loading…' : sessions.length ? 'No matching sessions.' : 'No other sessions on this database.'}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>

<Dialog.Root bind:open={() => !!action, (open) => { if (!open && !applying) action = null; }}>
	<Dialog.Content class="gap-4">
		<Dialog.Header>
			<Dialog.Title>{action?.kind === 'cancel' ? 'Cancel query' : 'Terminate session'} <code>{action?.session.pid}</code></Dialog.Title>
			<Dialog.Description class="text-xs">{action?.kind === 'cancel'
				? 'Stops the running query; the session stays connected and an open transaction becomes aborted.'
				: 'Closes the connection; any open transaction is rolled back.'}</Dialog.Description>
		</Dialog.Header>
		<pre class="rounded-md bg-muted p-2 font-mono text-xs">{sql}</pre>
		{#if applyError}<p role="alert" class="text-xs break-words text-destructive">{applyError}</p>{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" disabled={applying} onclick={() => action = null}>Close</Button>
			<Button variant="destructive" size="sm" disabled={applying} onclick={run}>{applying ? 'Running…' : action?.kind === 'cancel' ? 'Cancel query' : 'Terminate'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	/* Same palette as the SQL editor (TextEditor). */
	:global(.sql-preview .tok-keyword) { color: #c4b5fd; }
	:global(.sql-preview .tok-string) { color: #ce9178; }
	:global(.sql-preview .tok-number) { color: #b5cea8; }
	:global(.sql-preview .tok-comment) { color: #7f8a82; }
	:global(.sql-preview .tok-bool), :global(.sql-preview .tok-null) { color: #c4b5fd; }
</style>
