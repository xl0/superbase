import type { Column, Row, Table } from '#lib/types.js';

const BASE_TIME = Date.UTC(2026, 9, 1, 12, 0, 0);

function hash(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function rng(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(rand: () => number, values: readonly T[]): T =>
	values[Math.floor(rand() * values.length)];

const between = (rand: () => number, min: number, max: number) =>
	Math.floor(rand() * (max - min + 1)) + min;

function uuid(rand: () => number): string {
	const hex = '0123456789abcdef';
	let out = '';
	for (let i = 0; i < 32; i++) out += hex[Math.floor(rand() * 16)];
	return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

function timestamp(rand: () => number, maxDaysAgo: number): string {
	const ms = BASE_TIME - Math.floor(rand() * maxDaysAgo * 86_400_000);
	const d = new Date(ms);
	return (
		`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ` +
		`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}.` +
		`${String(d.getUTCMilliseconds()).padStart(3, '0')}+00`
	);
}

const FIRST_NAMES = [
	'Ada',
	'Linus',
	'Grace',
	'Alan',
	'Margaret',
	'Dennis',
	'Barbara',
	'Ken',
	'Radia',
	'John',
	'Hedy',
	'Guido',
	'Anita',
	'Brian',
	'Frances',
	'Tim'
];
const LAST_NAMES = [
	'Lovelace',
	'Torvalds',
	'Hopper',
	'Turing',
	'Hamilton',
	'Ritchie',
	'Liskov',
	'Thompson',
	'Perlman',
	'McCarthy',
	'Lamarr',
	'van Rossum',
	'Borg',
	'Kernighan',
	'Allen',
	'Berners-Lee'
];
const COMPANIES = [
	'Acme Corp',
	'Globex',
	'Initech',
	'Umbrella',
	'Hooli',
	'Soylent',
	'Vandelay Industries',
	'Stark Labs',
	'Wayne Enterprises',
	'Cyberdyne',
	'Tyrell Corp',
	'Massive Dynamic'
];
const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
const PLANS = ['free', 'pro', 'team', 'enterprise'] as const;
const TAGS = ['beta', 'staff', 'vip', 'internal', 'churn-risk'] as const;
const EVENT_NAMES = [
	'page_view',
	'signup',
	'login',
	'checkout',
	'search',
	'export',
	'invite_sent',
	'api_request'
];
const POST_TITLES = [
	'Shipping faster with fewer migrations',
	'What we learned from 10k queries',
	'Postgres indexes, explained',
	'A gentle intro to row level security',
	'Designing a table editor',
	'On schema migrations',
	'Why we moved to SQL',
	'Reading query plans for fun'
];

const userColumns: Column[] = [
	{ name: 'id', type: 'int8', kind: 'number', nullable: false, primaryKey: true, defaultValue: 'nextval(...)' },
	{ name: 'email', type: 'text', kind: 'text', nullable: false },
	{ name: 'full_name', type: 'text', kind: 'text', nullable: true },
	{ name: 'role', type: 'user_role', kind: 'enum', nullable: false, enumValues: [...ROLES], defaultValue: "'member'" },
	{ name: 'is_active', type: 'bool', kind: 'boolean', nullable: false, defaultValue: 'true' },
	{ name: 'age', type: 'int4', kind: 'number', nullable: true },
	{ name: 'metadata', type: 'jsonb', kind: 'json', nullable: true },
	{ name: 'tags', type: '_text', kind: 'array', nullable: true },
	{ name: 'created_at', type: 'timestamptz', kind: 'timestamp', nullable: false, defaultValue: 'now()' }
];

const postColumns: Column[] = [
	{ name: 'id', type: 'int8', kind: 'number', nullable: false, primaryKey: true },
	{ name: 'author_id', type: 'int8', kind: 'number', nullable: false, foreignKey: { schema: 'public', table: 'users', column: 'id' } },
	{ name: 'title', type: 'text', kind: 'text', nullable: false },
	{ name: 'body', type: 'text', kind: 'text', nullable: true },
	{ name: 'published', type: 'bool', kind: 'boolean', nullable: false, defaultValue: 'false' },
	{ name: 'views', type: 'int8', kind: 'number', nullable: false, defaultValue: '0' },
	{ name: 'created_at', type: 'timestamptz', kind: 'timestamp', nullable: false }
];

const commentColumns: Column[] = [
	{ name: 'id', type: 'int8', kind: 'number', nullable: false, primaryKey: true },
	{ name: 'post_id', type: 'int8', kind: 'number', nullable: false, foreignKey: { schema: 'public', table: 'posts', column: 'id' } },
	{ name: 'author_id', type: 'int8', kind: 'number', nullable: false, foreignKey: { schema: 'public', table: 'users', column: 'id' } },
	{ name: 'body', type: 'text', kind: 'text', nullable: false },
	{ name: 'created_at', type: 'timestamptz', kind: 'timestamp', nullable: false }
];

const orgColumns: Column[] = [
	{ name: 'id', type: 'uuid', kind: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
	{ name: 'name', type: 'text', kind: 'text', nullable: false },
	{ name: 'plan', type: 'org_plan', kind: 'enum', nullable: false, enumValues: [...PLANS] },
	{ name: 'seats', type: 'int4', kind: 'number', nullable: false },
	{ name: 'created_at', type: 'timestamptz', kind: 'timestamp', nullable: false }
];

const eventColumns: Column[] = [
	{ name: 'id', type: 'uuid', kind: 'uuid', nullable: false, primaryKey: true },
	{ name: 'name', type: 'text', kind: 'text', nullable: false },
	{ name: 'user_id', type: 'int8', kind: 'number', nullable: true, foreignKey: { schema: 'public', table: 'users', column: 'id' } },
	{ name: 'props', type: 'jsonb', kind: 'json', nullable: true },
	{ name: 'occurred_at', type: 'timestamptz', kind: 'timestamp', nullable: false }
];

export const mockTables: Table[] = [
	{ schema: 'public', name: 'users', columns: userColumns, rowCount: 1240 },
	{ schema: 'public', name: 'posts', columns: postColumns, rowCount: 3420 },
	{ schema: 'public', name: 'comments', columns: commentColumns, rowCount: 8910 },
	{ schema: 'public', name: 'organizations', columns: orgColumns, rowCount: 12 },
	{ schema: 'analytics', name: 'events', columns: eventColumns, rowCount: 24500 }
];

function makeUser(index: number): Row {
	const rand = rng(hash(`users:${index}`));
	const first = pick(rand, FIRST_NAMES);
	const last = pick(rand, LAST_NAMES);
	return {
		__key: `public.users:${index + 1}`,
		id: index + 1,
		email: `${first.toLowerCase()}.${last.toLowerCase().replaceAll(/[^a-z]/g, '')}${index + 1}@example.com`,
		full_name: rand() > 0.04 ? `${first} ${last}` : null,
		role: pick(rand, ROLES),
		is_active: rand() > 0.15,
		age: rand() > 0.12 ? between(rand, 18, 72) : null,
		metadata: rand() > 0.06 ? { plan: pick(rand, PLANS), beta: rand() > 0.5, logins: between(rand, 0, 900) } : null,
		tags: rand() > 0.1 ? TAGS.filter(() => rand() > 0.7) : null,
		created_at: timestamp(rand, 720)
	};
}

function makePost(index: number): Row {
	const rand = rng(hash(`posts:${index}`));
	return {
		__key: `public.posts:${index + 1}`,
		id: index + 1,
		author_id: between(rand, 1, 1240),
		title: `${pick(rand, POST_TITLES)}${rand() > 0.5 ? ` (${between(rand, 2, 12)})` : ''}`,
		body: rand() > 0.2 ? 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.' : null,
		published: rand() > 0.4,
		views: between(rand, 0, 80_000),
		created_at: timestamp(rand, 540)
	};
}

function makeComment(index: number): Row {
	const rand = rng(hash(`comments:${index}`));
	return {
		__key: `public.comments:${index + 1}`,
		id: index + 1,
		post_id: between(rand, 1, 3420),
		author_id: between(rand, 1, 1240),
		body: pick(rand, [
			'Great post, thanks for writing this up.',
			'Does this still hold on Postgres 17?',
			'We hit the same issue last week.',
			'The query plan part was especially useful.',
			'Any plans for a follow-up?',
			'Bookmarked. Sharing with the team.'
		]),
		created_at: timestamp(rand, 365)
	};
}

function makeOrganization(index: number): Row {
	const rand = rng(hash(`organizations:${index}`));
	return {
		__key: `public.organizations:${uuid(rand)}`,
		id: uuid(rand),
		name: COMPANIES[index % COMPANIES.length],
		plan: pick(rand, PLANS),
		seats: between(rand, 1, 250),
		created_at: timestamp(rand, 900)
	};
}

function makeEvent(index: number): Row {
	const rand = rng(hash(`events:${index}`));
	return {
		__key: `analytics.events:${uuid(rand)}`,
		id: uuid(rand),
		name: pick(rand, EVENT_NAMES),
		user_id: rand() > 0.08 ? between(rand, 1, 1240) : null,
		props: { path: pick(rand, ['/', '/pricing', '/docs', '/blog', '/app']), ms: between(rand, 4, 2400), ok: rand() > 0.05 },
		occurred_at: timestamp(rand, 30)
	};
}

const MAKERS: Record<string, (index: number) => Row> = {
	'public.users': makeUser,
	'public.posts': makePost,
	'public.comments': makeComment,
	'public.organizations': makeOrganization,
	'analytics.events': makeEvent
};

const cache = new Map<string, Row[]>();

/** Deterministic mock rows for a table. Cached per table. */
export function getMockRows(table: Table): Row[] {
	const key = `${table.schema}.${table.name}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const make = MAKERS[key];
	const rows = Array.from({ length: table.rowCount }, (_, i) => make(i));
	cache.set(key, rows);
	return rows;
}
