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
