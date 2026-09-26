-- Replace this address with the verified owner email used in Supabase Auth.
create table if not exists public.store_owners (
  email text primary key
);

insert into public.store_owners (email)
values ('you@example.com')
on conflict (email) do nothing;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  description text not null check (char_length(description) between 1 and 500),
  price_cents integer not null check (price_cents > 0),
  image_path text,
  is_published boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.store_owners enable row level security;
alter table public.products enable row level security;

create or replace function public.is_store_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.store_owners
    where lower(email) = lower((select auth.jwt() ->> 'email'))
  );
$$;

revoke all on function public.is_store_owner() from public;
grant execute on function public.is_store_owner() to anon, authenticated;
grant select, insert, update, delete on public.products to anon, authenticated;

drop policy if exists "Anyone can view published products" on public.products;
create policy "Anyone can view published products"
on public.products for select to anon, authenticated
using (is_published or (select public.is_store_owner()));

drop policy if exists "Owner can insert products" on public.products;
create policy "Owner can insert products"
on public.products for insert to authenticated
with check ((select public.is_store_owner()));

drop policy if exists "Owner can update products" on public.products;
create policy "Owner can update products"
on public.products for update to authenticated
using ((select public.is_store_owner()))
with check ((select public.is_store_owner()));

drop policy if exists "Owner can delete products" on public.products;
create policy "Owner can delete products"
on public.products for delete to authenticated
using ((select public.is_store_owner()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can view product photos" on storage.objects;
create policy "Anyone can view product photos"
on storage.objects for select to anon, authenticated
using (
  bucket_id = 'product-images'
  and (
    (select public.is_store_owner())
    or exists (
      select 1 from public.products
      where image_path = name and is_published
    )
  )
);

drop policy if exists "Owner can upload product photos" on storage.objects;
create policy "Owner can upload product photos"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and (select public.is_store_owner()));

drop policy if exists "Owner can update product photos" on storage.objects;
create policy "Owner can update product photos"
on storage.objects for update to authenticated
using (bucket_id = 'product-images' and (select public.is_store_owner()))
with check (bucket_id = 'product-images' and (select public.is_store_owner()));

drop policy if exists "Owner can delete product photos" on storage.objects;
create policy "Owner can delete product photos"
on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and (select public.is_store_owner()));

create table if not exists public.store_legal_settings (
  id integer primary key default 1 check (id = 1),
  business_name text not null check (char_length(business_name) between 1 and 120),
  support_email text not null check (char_length(support_email) between 3 and 254),
  postal_address text not null check (char_length(postal_address) between 1 and 500),
  shipping_policy text not null check (char_length(shipping_policy) between 1 and 3000),
  returns_policy text not null check (char_length(returns_policy) between 1 and 3000),
  tax_disclosure text not null check (char_length(tax_disclosure) between 1 and 2000),
  policy_date date not null,
  compliance_confirmed boolean not null default false,
  is_published boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.store_legal_settings enable row level security;
grant select on public.store_legal_settings to anon, authenticated;
grant insert, update on public.store_legal_settings to authenticated;
grant all on public.store_legal_settings to service_role;

drop policy if exists "Anyone can view published seller policies" on public.store_legal_settings;
create policy "Anyone can view published seller policies"
on public.store_legal_settings for select to anon, authenticated
using (is_published or (select public.is_store_owner()));

drop policy if exists "Owner can insert seller policies" on public.store_legal_settings;
create policy "Owner can insert seller policies"
on public.store_legal_settings for insert to authenticated
with check ((select public.is_store_owner()));

drop policy if exists "Owner can update seller policies" on public.store_legal_settings;
create policy "Owner can update seller policies"
on public.store_legal_settings for update to authenticated
using ((select public.is_store_owner()))
with check ((select public.is_store_owner()));

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  paypal_order_id text not null unique,
  reference text not null unique,
  status text not null check (status in ('CREATED', 'COMPLETED')),
  total_cents integer not null check (total_cents > 0),
  shipping_cents integer not null default 0 check (shipping_cents >= 0),
  items jsonb not null,
  capture_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.store_orders enable row level security;
grant select on public.store_orders to authenticated;
grant all on public.store_orders to service_role;

drop policy if exists "Owner can view store orders" on public.store_orders;
create policy "Owner can view store orders"
on public.store_orders for select to authenticated
using ((select public.is_store_owner()));