-- Run this migration in the Supabase SQL editor before the first Vercel deployment.

create table if not exists public.activity_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'uploading' check (status in ('uploading', 'queued', 'running', 'ready', 'failed', 'cancelled')),
  stage text not null default 'Preparing files',
  progress integer not null default 0 check (progress between 0 and 100),
  warnings jsonb not null default '[]'::jsonb,
  error text,
  inputs jsonb not null,
  artifacts jsonb not null default '{}'::jsonb,
  use_default_references boolean not null default true,
  design_prompt text not null,
  additional_prompt text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists activity_jobs_user_created_idx on public.activity_jobs (user_id, created_at desc);
create index if not exists activity_jobs_expiry_idx on public.activity_jobs (expires_at);
create unique index if not exists activity_jobs_one_active_per_user_idx
on public.activity_jobs (user_id)
where status in ('uploading', 'queued', 'running');

create or replace function public.set_activity_job_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists activity_jobs_updated_at on public.activity_jobs;
create trigger activity_jobs_updated_at before update on public.activity_jobs
for each row execute function public.set_activity_job_updated_at();

alter table public.activity_jobs enable row level security;
drop policy if exists "Teachers can read their own activity jobs" on public.activity_jobs;
create policy "Teachers can read their own activity jobs" on public.activity_jobs
for select to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('activity-inputs', 'activity-inputs', false, 52428800, array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]),
  ('activity-outputs', 'activity-outputs', false, 52428800, array[
    'application/zip',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Teachers upload their own activity inputs" on storage.objects;
create policy "Teachers upload their own activity inputs" on storage.objects
for insert to authenticated with check (
  bucket_id = 'activity-inputs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.activity_jobs
    where activity_jobs.user_id = (select auth.uid())
      and activity_jobs.id::text = (storage.foldername(name))[2]
      and activity_jobs.status = 'uploading'
  )
);

drop policy if exists "Teachers read their own activity inputs" on storage.objects;
create policy "Teachers read their own activity inputs" on storage.objects
for select to authenticated using (
  bucket_id = 'activity-inputs' and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Teachers delete their own activity inputs" on storage.objects;
create policy "Teachers delete their own activity inputs" on storage.objects
for delete to authenticated using (
  bucket_id = 'activity-inputs' and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Teachers read their own activity outputs" on storage.objects;
create policy "Teachers read their own activity outputs" on storage.objects
for select to authenticated using (
  bucket_id = 'activity-outputs' and (storage.foldername(name))[1] = (select auth.uid())::text
);
