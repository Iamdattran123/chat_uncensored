-- Run this in Supabase Dashboard > SQL Editor.
create table if not exists public.conversations (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Cuộc trò chuyện mới',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conversations enable row level security;

create policy "Users can read own conversations"
  on public.conversations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can create own conversations"
  on public.conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can update own conversations"
  on public.conversations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users can delete own conversations"
  on public.conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.conversations to authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists conversations_touch_updated_at on public.conversations;
create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function public.touch_updated_at();
