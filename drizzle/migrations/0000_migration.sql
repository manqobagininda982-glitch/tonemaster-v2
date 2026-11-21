create type public.app_role as enum ('admin', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create policy "Users read own roles" on public.user_roles for select to authenticated using (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role = _role) $$;

-- Tone packs, beat packs (kind = tone | beat)
create table public.packs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('tone','beat')),
  name text not null,
  version text not null default '1',
  description text not null default '',
  bpm numeric,
  status text not null default 'uploaded' check (status in ('uploaded','validated','rejected')),
  published boolean not null default false,
  upload_path text,
  file_path text,
  file_name text,
  file_size bigint not null default 0,
  manifest jsonb not null default '{}'::jsonb,
  validation_report jsonb not null default '{}'::jsonb,
  download_count integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.packs to anon;
grant select, insert, update, delete on public.packs to authenticated;
grant all on public.packs to service_role;
alter table public.packs enable row level security;
create policy "Public reads published validated packs" on public.packs for select to anon, authenticated using (published and status = 'validated');
create policy "Admins read all packs" on public.packs for select to authenticated using (public.has_role(auth.uid(),'admin'));
create policy "Admins insert packs" on public.packs for insert to authenticated with check (public.has_role(auth.uid(),'admin'));
create policy "Admins update packs" on public.packs for update to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "Admins delete packs" on public.packs for delete to authenticated using (public.has_role(auth.uid(),'admin'));

-- Only validated packs may be published
create or replace function public.packs_guard() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.published and new.status <> 'validated' then raise exception 'Only validated packs can be published'; end if;
  return new;
end $$;
create trigger packs_guard before insert or update on public.packs for each row execute function public.packs_guard();

-- Android APK releases
create table public.app_releases (
  id uuid primary key default gen_random_uuid(),
  version_code integer not null check (version_code > 0),
  version_name text not null,
  notes text not null default '',
  package_name text not null default 'com.mgsounds.tonemaster',
  min_sdk integer not null default 24,
  status text not null default 'uploaded' check (status in ('uploaded','validated','rejected')),
  published boolean not null default false,
  upload_path text,
  file_path text,
  file_size bigint not null default 0,
  sha256 text,
  validation_report jsonb not null default '{}'::jsonb,
  download_count integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (package_name, version_code)
);
grant select on public.app_releases to anon;
grant select, insert, update, delete on public.app_releases to authenticated;
grant all on public.app_releases to service_role;
alter table public.app_releases enable row level security;
create policy "Public reads published releases" on public.app_releases for select to anon, authenticated using (published and status = 'validated');
create policy "Admins read releases" on public.app_releases for select to authenticated using (public.has_role(auth.uid(),'admin'));
create policy "Admins insert releases" on public.app_releases for insert to authenticated with check (public.has_role(auth.uid(),'admin'));
create policy "Admins update releases" on public.app_releases for update to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create policy "Admins delete releases" on public.app_releases for delete to authenticated using (public.has_role(auth.uid(),'admin'));
create trigger releases_guard before insert or update on public.app_releases for each row execute function public.packs_guard();

create or replace function public.bump_download(_table text, _id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if _table = 'packs' then update public.packs set download_count = download_count + 1 where id = _id and published;
  elsif _table = 'app_releases' then update public.app_releases set download_count = download_count + 1 where id = _id and published;
  end if;
end $$;
revoke all on function public.bump_download(text, uuid) from public, anon, authenticated;
grant execute on function public.bump_download(text, uuid) to service_role;