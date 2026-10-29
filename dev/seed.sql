-- Dev database for superbase. Run against a fresh database:
--   psql "$DATABASE_URL" -f dev/seed.sql

create type user_role as enum ('owner', 'admin', 'member', 'viewer');
create type org_plan as enum ('free', 'pro', 'team', 'enterprise');

create table public.users (
  id bigserial primary key,
  email text not null unique,
  full_name text,
  role user_role not null default 'member',
  is_active boolean not null default true,
  age int4,
  metadata jsonb,
  tags text[],
  created_at timestamptz not null default now()
);

create table public.posts (
  id bigserial primary key,
  author_id int8 not null references public.users(id),
  title text not null,
  body text,
  published boolean not null default false,
  views int8 not null default 0,
  created_at timestamptz not null default now()
);

create table public.comments (
  id bigserial primary key,
  post_id int8 not null references public.posts(id),
  author_id int8 not null references public.users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan org_plan not null,
  seats int4 not null,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  message text,
  at timestamptz not null default now()
);

create schema analytics;

create table analytics.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  user_id int8 references public.users(id),
  props jsonb,
  occurred_at timestamptz not null default now()
);

insert into public.users (email, full_name, role, is_active, age, metadata, tags, created_at)
select
  'user' || g || '@example.com',
  (array['Ada Lovelace','Linus Torvalds','Grace Hopper','Alan Turing','Margaret Hamilton',
         'Dennis Ritchie','Barbara Liskov','Ken Thompson'])[1 + (g % 8)],
  (array['owner','admin','member','viewer']::user_role[])[1 + (g % 4)],
  g % 7 <> 0,
  case when g % 9 = 0 then null else 18 + (g % 55) end,
  jsonb_build_object('plan', (array['free','pro','team','enterprise'])[1 + (g % 4)],
                     'beta', g % 2 = 0, 'logins', g % 900),
  case when g % 10 = 0 then null else array['beta','staff'] end,
  now() - (g || ' hours')::interval
from generate_series(1, 1240) g;

insert into public.posts (author_id, title, body, published, views, created_at)
select 1 + (g % 1240), 'Post ' || g, 'Lorem ipsum dolor sit amet.', g % 3 <> 0, g * 17,
       now() - (g || ' hours')::interval
from generate_series(1, 3420) g;

insert into public.comments (post_id, author_id, body, created_at)
select 1 + (g % 3420), 1 + (g % 1240), 'Comment ' || g, now() - (g || ' hours')::interval
from generate_series(1, 2000) g;

insert into public.organizations (name, plan, seats)
select 'Org ' || g, (array['free','pro','team','enterprise']::org_plan[])[1 + (g % 4)], g * 3
from generate_series(1, 12) g;

insert into public.audit_log (message)
select 'event ' || g from generate_series(1, 25) g;

insert into analytics.events (name, user_id, props, occurred_at)
select (array['page_view','signup','login','checkout'])[1 + (g % 4)],
       1 + (g % 1240),
       jsonb_build_object('path', '/', 'ms', g % 2000),
       now() - (g || ' minutes')::interval
from generate_series(1, 5000) g;

create view public.post_authors as
select p.id, p.title, p.published, u.full_name as author, u.email
from public.posts p join public.users u on u.id = p.author_id;

create materialized view public.posts_per_user as
select u.id as user_id, u.full_name, count(p.id) as posts, coalesce(sum(p.views), 0) as views
from public.users u left join public.posts p on p.author_id = u.id
group by u.id, u.full_name;
create function public.log_post_change() returns trigger language plpgsql as $$
begin
  insert into public.audit_log (message) values (lower(tg_op) || ' post ' || coalesce(new.id, old.id));
  return null;
end $$;
create trigger posts_audit after insert or update or delete on public.posts
  for each row execute function public.log_post_change();

-- Arrays of JSON documents: shown and edited as Postgres literals (1-D and 2-D).
create table public.json_arrays (
  id int primary key,
  docs jsonb[]
);
insert into public.json_arrays values
  (1, array['{"a": 1}', '[1, 2]', null]::jsonb[]),
  (2, array[['{"a": 1}', '2'], ['3', '4']]::jsonb[]);

-- Edge cases: awkward names, partitions, inheritance, constraints and types the UI must handle.
create schema edge;
create table edge."a/b" (id int primary key, note text);
create table edge."100%" (id int primary key, note text);
create table edge."#hash?q" (id int primary key, note text);
create table edge."Mixed Case café" (id int primary key, note text);
insert into edge."a/b" values (1, 'slash');
insert into edge."100%" values (1, 'percent');
insert into edge."#hash?q" values (1, 'hash and question mark');
insert into edge."Mixed Case café" values (1, 'unicode');

-- Partitioned table, referenced by a foreign key (Postgres adds per-partition copies of it).
create table edge.measurements (
  id int primary key,
  value numeric(10, 2) check (value >= 0)
) partition by range (id);
create table edge.measurements_low partition of edge.measurements for values from (0) to (100);
create table edge.measurements_high partition of edge.measurements for values from (100) to (1000);
create table edge.readings (id int primary key, measurement_id int references edge.measurements);
insert into edge.measurements select g, g * 1.5 from generate_series(1, 150) g;
insert into edge.readings select g, g from generate_series(1, 150) g;

-- Inheritance: the child inherits the CHECK and shows up in the parent's rows.
create table edge.vehicles (id int primary key, wheels int check (wheels > 0));
create table edge.cars (doors int) inherits (edge.vehicles);
alter table edge.cars add primary key (id);
insert into edge.vehicles values (1, 2);
insert into edge.cars values (2, 4, 5);

-- Exclusion constraint (gist on a range; no extension needed).
create table edge.bookings (
  id int primary key,
  during tstzrange not null,
  exclude using gist (during with &&)
);
insert into edge.bookings values (1, '[2026-01-01 10:00, 2026-01-01 11:00)'), (2, '[2026-01-01 11:00, 2026-01-01 12:00)');

-- Enum used only through a domain; json keeps its exact text, jsonb normalizes; bpchar and array conversions.
create type edge.mood as enum ('happy', 'sad', 'it''s complicated');
create domain edge.mood_domain as edge.mood;
create table edge.values (
  id int primary key,
  mood edge.mood_domain,
  doc json,
  docb jsonb,
  code bpchar,
  single int[],
  many int[]
);
insert into edge.values values
  (1, 'happy', '{"b": 1,   "a": [1, 2.50]}', '{"b": 1,   "a": [1, 2.50]}', 'ab', '{1}', '{1,2}'),
  (2, 'it''s complicated', '"text"', 'null', null, null, '{}');

-- RLS disabled while still forced (the flags are independent).
create table edge.rls_forced (id int primary key);
alter table edge.rls_forced enable row level security;
alter table edge.rls_forced force row level security;
alter table edge.rls_forced disable row level security;
