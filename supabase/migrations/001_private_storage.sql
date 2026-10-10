-- My INC HQ template only. No personal-app data is migrated by this script.
begin;
create table public.hq_documents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2097152),
  updated_at timestamptz not null default now()
);
create table public.hq_document_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null,
  payload jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (user_id, revision)
);
alter table public.hq_documents enable row level security;
alter table public.hq_document_history enable row level security;
revoke all on public.hq_documents, public.hq_document_history from public, anon, authenticated;
grant select on public.hq_documents, public.hq_document_history to authenticated;
create policy own_document_read on public.hq_documents for select to authenticated using ((select auth.uid()) = user_id);
create policy own_history_read on public.hq_document_history for select to authenticated using ((select auth.uid()) = user_id);
-- Only this function can write. The authenticated identity supplies the owner;
-- callers cannot nominate another user. A stale revision never overwrites data.
create function public.hq_save_document(expected_revision bigint, new_payload jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  next_revision bigint;
begin
  if owner_id is null then raise exception 'Sign in required'; end if;
  if expected_revision is null or expected_revision < 0 then raise exception 'Invalid revision'; end if;
  if new_payload is null or jsonb_typeof(new_payload) <> 'object' or octet_length(new_payload::text) > 2097152 then raise exception 'Invalid document'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));
  select revision into current_revision from public.hq_documents where user_id = owner_id for update;
  if coalesce(current_revision, 0) <> expected_revision then raise exception 'Cloud version changed; reload before saving' using errcode = '40001'; end if;
  next_revision := coalesce(current_revision, 0) + 1;
  insert into public.hq_documents(user_id, revision, payload) values(owner_id, next_revision, new_payload)
    on conflict(user_id) do update set revision = excluded.revision, payload = excluded.payload, updated_at = now();
  insert into public.hq_document_history(user_id, revision, payload) values(owner_id, next_revision, new_payload);
  -- Keep the latest 50 saved versions per account; not a provider backup.
  delete from public.hq_document_history where user_id = owner_id and revision <= next_revision - 50;
  return next_revision;
end;
$$;
revoke all on function public.hq_save_document(bigint, jsonb) from public, anon;
grant execute on function public.hq_save_document(bigint, jsonb) to authenticated;
commit;
