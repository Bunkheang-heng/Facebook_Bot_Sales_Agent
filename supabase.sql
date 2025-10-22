-- Ensure product_categories exists before products
create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create products table
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text not null unique,
  price numeric not null default 0,
  stock integer not null default 0,
  category text,
  category_id uuid references public.product_categories(id) on delete set null,
  description text,
  image_url text,
  embedding vector(1408),  -- Main embedding for RAG similarity search (text-based)
  image_embedding vector(1408),  -- Optional: separate image embedding for visual search
  embedding_metadata jsonb,  -- Store full API response for debugging/analysis
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create vector index for fast similarity search (HNSW index)
-- This enables efficient nearest neighbor search for RAG
create index if not exists products_embedding_idx on public.products 
using hnsw (embedding vector_cosine_ops);

create index if not exists products_image_embedding_idx on public.products 
using hnsw (image_embedding vector_cosine_ops);

-- Full text search support
create extension if not exists pg_trgm;
create extension if not exists unaccent;
alter table public.products
  add column if not exists search_tsv tsvector;
update public.products
  set search_tsv = to_tsvector('simple', unaccent(coalesce(name,'') || ' ' || coalesce(description,'')));
create index if not exists products_tsv_idx on public.products using GIN (search_tsv);

create or replace function products_tsv_trigger()
returns trigger as $$
begin
  new.search_tsv := to_tsvector('simple', unaccent(coalesce(new.name,'') || ' ' || coalesce(new.description,'')));
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_tsv on public.products;
create trigger trg_products_tsv before insert or update on public.products
for each row execute function products_tsv_trigger();

-- Trigger to update updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at
before update on public.products
for each row execute function public.set_updated_at();

-- Enable row level security
alter table public.products enable row level security;

-- Policies: allow read for authenticated users; insert/update/delete for authenticated
drop policy if exists "Allow read for authenticated" on public.products;
create policy "Allow read for authenticated" on public.products
for select using (auth.role() = 'authenticated');

drop policy if exists "Allow write for authenticated" on public.products;
create policy "Allow write for authenticated" on public.products
for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Ensure products has category_id with FK even if table pre-existed
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'category_id'
  ) then
    alter table public.products add column category_id uuid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_category_id_fkey'
  ) then
    alter table public.products
      add constraint products_category_id_fkey
      foreign key (category_id) references public.product_categories(id) on delete set null;
  end if;
end $$;

-- Drop legacy text category column if it exists (replaced by category_id)
alter table if exists public.products drop column if exists category;

-- Trigger for categories updated_at
drop trigger if exists trg_product_categories_updated_at on public.product_categories;
create trigger trg_product_categories_updated_at
before update on public.product_categories
for each row execute function public.set_updated_at();

-- Enable RLS on product_categories
alter table public.product_categories enable row level security;

drop policy if exists "Allow read for authenticated" on public.product_categories;
create policy "Allow read for authenticated" on public.product_categories
for select using (auth.role() = 'authenticated');

drop policy if exists "Allow write for authenticated" on public.product_categories;
create policy "Allow write for authenticated" on public.product_categories
for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Create storage bucket for product images (idempotent)
do $$ begin
  if not exists (
    select 1 from storage.buckets where id = 'product-images'
  ) then
    insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true);
  end if;
end $$;

-- Storage policies for product-images bucket
-- Allow read for everyone (public bucket), write for authenticated
drop policy if exists "Public read product-images" on storage.objects;
create policy "Public read product-images" on storage.objects
for select using ( bucket_id = 'product-images' );

drop policy if exists "Authenticated write product-images" on storage.objects;
create policy "Authenticated write product-images" on storage.objects
for insert to authenticated with check ( bucket_id = 'product-images' );

drop policy if exists "Authenticated update product-images" on storage.objects;
create policy "Authenticated update product-images" on storage.objects
for update to authenticated using ( bucket_id = 'product-images' ) with check ( bucket_id = 'product-images' );

drop policy if exists "Authenticated delete product-images" on storage.objects;
create policy "Authenticated delete product-images" on storage.objects
for delete to authenticated using ( bucket_id = 'product-images' );

-- =============================
-- Customers and Orders schema
-- =============================

-- Customers
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure address column exists for existing deployments
alter table if exists public.customers add column if not exists address text;

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

alter table public.customers enable row level security;
drop policy if exists "Allow read for authenticated" on public.customers;
create policy "Allow read for authenticated" on public.customers for select using (auth.role() = 'authenticated');
drop policy if exists "Allow write for authenticated" on public.customers;
create policy "Allow write for authenticated" on public.customers for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create index if not exists idx_customers_phone on public.customers (phone);
create index if not exists idx_customers_name on public.customers (name);

-- Orders (sales)
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  date date not null default current_date,
  status text not null check (status in ('paid','refunded','pending')) default 'pending',
  total numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

alter table public.orders enable row level security;
drop policy if exists "Allow read for authenticated" on public.orders;
create policy "Allow read for authenticated" on public.orders for select using (auth.role() = 'authenticated');
drop policy if exists "Allow write for authenticated" on public.orders;
create policy "Allow write for authenticated" on public.orders for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create index if not exists idx_orders_customer on public.orders (customer_id);
create index if not exists idx_orders_date on public.orders (date);
create index if not exists idx_orders_status on public.orders (status);

-- Order items
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  qty integer not null check (qty > 0),
  price numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_order_items_updated_at on public.order_items;
create trigger trg_order_items_updated_at
before update on public.order_items
for each row execute function public.set_updated_at();

alter table public.order_items enable row level security;
drop policy if exists "Allow read for authenticated" on public.order_items;
create policy "Allow read for authenticated" on public.order_items for select using (auth.role() = 'authenticated');
drop policy if exists "Allow write for authenticated" on public.order_items;
create policy "Allow write for authenticated" on public.order_items for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create index if not exists idx_order_items_order on public.order_items (order_id);
create index if not exists idx_order_items_product on public.order_items (product_id);

-- View: customers with aggregate stats (orders count, total, last date)
drop view if exists public.customers_with_stats;
create view public.customers_with_stats as
select
  c.id,
  c.name,
  c.phone,
  c.email,
  c.address,
  max(o.date) as last_date,
  count(o.id) as orders_count,
  coalesce(sum(o.total), 0)::numeric as total
from public.customers c
left join public.orders o on o.customer_id = c.id and o.tenant_id = c.tenant_id
where exists (
  select 1 from public.user_tenants ut
  where ut.user_id = auth.uid() and ut.tenant_id = c.tenant_id
)
group by c.id, c.name, c.phone, c.email, c.address;

-- Materialized view or regular view for top products by sales amount
create or replace view public.top_products_sales as
select
  p.id,
  p.name,
  coalesce(sum(oi.qty), 0)::integer as total_qty,
  coalesce(sum(oi.qty * oi.price), 0)::numeric as total_amount
from public.products p
join public.order_items oi on oi.product_id = p.id and oi.tenant_id = p.tenant_id
join public.orders o on o.id = oi.order_id and o.status = 'paid' and o.tenant_id = p.tenant_id
where exists (
  select 1 from public.user_tenants ut
  where ut.user_id = auth.uid() and ut.tenant_id = p.tenant_id
)
group by p.id, p.name;

-- =============================
-- Sales aggregates by period
-- =============================

-- Daily totals (by orders.date)
create or replace view public.sales_totals_daily as
select
  o.date as day,
  coalesce(sum(o.total), 0)::numeric as total
from public.orders o
where o.status in ('paid')
  and exists (
    select 1 from public.user_tenants ut
    where ut.user_id = auth.uid() and ut.tenant_id = o.tenant_id
  )
group by o.date
order by day desc;

-- Weekly totals (ISO week)
create or replace view public.sales_totals_weekly as
select
  to_char(date_trunc('week', o.date), 'IYYY-IW') as iso_week,
  date_trunc('week', o.date)::date as week_start,
  coalesce(sum(o.total), 0)::numeric as total
from public.orders o
where o.status in ('paid')
  and exists (
    select 1 from public.user_tenants ut
    where ut.user_id = auth.uid() and ut.tenant_id = o.tenant_id
  )
group by 1, 2
order by week_start desc;

-- Monthly totals
create or replace view public.sales_totals_monthly as
select
  to_char(date_trunc('month', o.date), 'YYYY-MM') as ym,
  date_trunc('month', o.date)::date as month_start,
  coalesce(sum(o.total), 0)::numeric as total
from public.orders o
where o.status in ('paid')
  and exists (
    select 1 from public.user_tenants ut
    where ut.user_id = auth.uid() and ut.tenant_id = o.tenant_id
  )
group by 1, 2
order by month_start desc;

-- Performance indexes
create index if not exists idx_orders_status_date on public.orders (status, date);
create index if not exists idx_order_items_order_product on public.order_items (order_id, product_id);

-- Ensure non-negative stock
alter table public.products drop constraint if exists chk_products_stock_nonneg;
alter table public.products add constraint chk_products_stock_nonneg check (stock >= 0);

-- =============================
-- Order acceptance RPC
-- =============================

create or replace function public.accept_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  -- lock the order row
  select status into v_status from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  -- idempotent: if already paid do nothing
  if v_status = 'paid' then
    return;
  end if;

  -- only pending orders can be accepted
  if v_status <> 'pending' then
    raise exception 'Only pending orders can be accepted (current: %)', v_status;
  end if;

  -- validate sufficient stock for all items
  if exists (
    select 1
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.stock < oi.qty
  ) then
    raise exception 'Insufficient stock for one or more items';
  end if;

  -- decrement stock for each item
  update public.products p
  set stock = p.stock - oi.qty
  from public.order_items oi
  where oi.order_id = p_order_id
    and oi.product_id = p.id;

  -- mark order as paid
  update public.orders set status = 'paid' where id = p_order_id;
end;
$$;

-- Helper: sum of paid orders between dates (inclusive)
-- sales_total_between will be (re)defined after tenant tables exist

-- ==========================================
-- MULTI-TENANCY (Tenants, Membership, RLS)
-- ==========================================

-- Tenants and membership tables
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_tenants (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- Billing columns on tenants (idempotent)
alter table public.tenants
  add column if not exists billing_provider text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists is_active boolean not null default false,
  add column if not exists plan text,
  add column if not exists current_period_end timestamptz;

-- RLS for tenants/user_tenants (select only memberships)
alter table public.tenants enable row level security;
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
for select using (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = tenants.id)
);

-- Allow owners/admins to update their tenant billing fields
drop policy if exists tenants_update_owner on public.tenants;
create policy tenants_update_owner on public.tenants
for update using (
  exists (
    select 1 from public.user_tenants ut
    where ut.user_id = auth.uid() and ut.tenant_id = tenants.id and ut.role in ('owner','admin')
  )
) with check (
  exists (
    select 1 from public.user_tenants ut
    where ut.user_id = auth.uid() and ut.tenant_id = tenants.id and ut.role in ('owner','admin')
  )
);

alter table public.user_tenants enable row level security;
drop policy if exists user_tenants_select on public.user_tenants;
create policy user_tenants_select on public.user_tenants
for select using (user_id = auth.uid());

-- Helper returning a preferred tenant for current user
create or replace function public.preferred_tenant_for_user()
returns uuid
language sql stable as $$
  select ut.tenant_id
  from public.user_tenants ut
  where ut.user_id = auth.uid()
  order by role = 'owner' desc, created_at
  limit 1
$$;

-- Add tenant_id columns (idempotent)
alter table if exists public.product_categories add column if not exists tenant_id uuid;
alter table if exists public.products add column if not exists tenant_id uuid;
alter table if exists public.customers add column if not exists tenant_id uuid;
alter table if exists public.orders add column if not exists tenant_id uuid;
alter table if exists public.order_items add column if not exists tenant_id uuid;

-- Triggers to populate tenant_id on insert
create or replace function public.set_tenant_id_generic()
returns trigger language plpgsql as $$
begin
  if new.tenant_id is null then
    new.tenant_id := public.preferred_tenant_for_user();
  end if;
  return new;
end;
$$;

create or replace function public.set_order_item_tenant()
returns trigger language plpgsql as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.orders where id = new.order_id;
  new.tenant_id := v_tenant;
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_pc_set_tenant') then
    create trigger trg_pc_set_tenant before insert on public.product_categories
    for each row execute function public.set_tenant_id_generic();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_products_set_tenant') then
    create trigger trg_products_set_tenant before insert on public.products
    for each row execute function public.set_tenant_id_generic();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_customers_set_tenant') then
    create trigger trg_customers_set_tenant before insert on public.customers
    for each row execute function public.set_tenant_id_generic();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_orders_set_tenant') then
    create trigger trg_orders_set_tenant before insert on public.orders
    for each row execute function public.set_tenant_id_generic();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_order_items_set_tenant') then
    create trigger trg_order_items_set_tenant before insert on public.order_items
    for each row execute function public.set_order_item_tenant();
  end if;
end $$;

-- Backfill: create default tenant and assign earliest user as owner; set tenant_id on existing rows
do $$
declare v_tenant uuid; v_user uuid;
begin
  if not exists (select 1 from public.tenants) then
    insert into public.tenants (name) values ('Default Tenant');
  end if;
  select id into v_tenant from public.tenants order by created_at asc limit 1;
  select id into v_user from auth.users order by created_at asc limit 1;
  if v_user is not null then
    insert into public.user_tenants (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner')
    on conflict do nothing;
  end if;
  update public.product_categories set tenant_id = coalesce(tenant_id, v_tenant);
  update public.products set tenant_id = coalesce(tenant_id, v_tenant);
  update public.customers set tenant_id = coalesce(tenant_id, v_tenant);
  update public.orders set tenant_id = coalesce(tenant_id, v_tenant);
  update public.order_items oi
    set tenant_id = coalesce(oi.tenant_id, (select o.tenant_id from public.orders o where o.id = oi.order_id));
end $$;

-- Tenant-first indexes for performance
create index if not exists idx_products_tenant on public.products (tenant_id, id);
create index if not exists idx_customers_tenant on public.customers (tenant_id, id);
create index if not exists idx_orders_tenant_date on public.orders (tenant_id, date);
create index if not exists idx_order_items_tenant_order on public.order_items (tenant_id, order_id);

-- Replace broad RLS with tenant policies
-- product_categories
drop policy if exists "Allow read for authenticated" on public.product_categories;
drop policy if exists "Allow write for authenticated" on public.product_categories;
drop policy if exists pc_select on public.product_categories;
drop policy if exists pc_all on public.product_categories;
create policy pc_select on public.product_categories for select using (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = product_categories.tenant_id)
);
create policy pc_all on public.product_categories for all using (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = product_categories.tenant_id)
) with check (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = product_categories.tenant_id)
);

-- products
drop policy if exists "Allow read for authenticated" on public.products;
drop policy if exists "Allow write for authenticated" on public.products;
drop policy if exists products_select on public.products;
drop policy if exists products_all on public.products;
create policy products_select on public.products for select using (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = products.tenant_id
    where ut.user_id = auth.uid() and ut.tenant_id = products.tenant_id
  )
);
create policy products_all on public.products for all using (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = products.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = products.tenant_id
  )
) with check (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = products.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = products.tenant_id
  )
);

-- customers
drop policy if exists "Allow read for authenticated" on public.customers;
drop policy if exists "Allow write for authenticated" on public.customers;
drop policy if exists customers_select on public.customers;
drop policy if exists customers_all on public.customers;
create policy customers_select on public.customers for select using (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = customers.tenant_id)
);
create policy customers_all on public.customers for all using (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = customers.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = customers.tenant_id
  )
) with check (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = customers.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = customers.tenant_id
  )
);

-- orders
drop policy if exists "Allow read for authenticated" on public.orders;
drop policy if exists "Allow write for authenticated" on public.orders;
drop policy if exists orders_select on public.orders;
drop policy if exists orders_all on public.orders;
create policy orders_select on public.orders for select using (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = orders.tenant_id)
);
create policy orders_all on public.orders for all using (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = orders.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = orders.tenant_id
  )
) with check (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = orders.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = orders.tenant_id
  )
);

-- order_items
drop policy if exists "Allow read for authenticated" on public.order_items;
drop policy if exists "Allow write for authenticated" on public.order_items;
drop policy if exists order_items_select on public.order_items;
drop policy if exists order_items_all on public.order_items;
create policy order_items_select on public.order_items for select using (
  exists (select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = order_items.tenant_id)
);
create policy order_items_all on public.order_items for all using (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = order_items.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = order_items.tenant_id
  )
) with check (
  exists (
    select 1 from public.user_tenants ut
    join public.tenants t on t.id = order_items.tenant_id and t.is_active
    where ut.user_id = auth.uid() and ut.tenant_id = order_items.tenant_id
  )
);

-- Strengthen accept_order to enforce tenant membership
create or replace function public.accept_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_tenant uuid;
begin
  select status, tenant_id into v_status, v_tenant from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;
  if not exists (
    select 1 from public.user_tenants ut where ut.user_id = auth.uid() and ut.tenant_id = v_tenant
  ) then
    raise exception 'Forbidden';
  end if;
  if v_status = 'paid' then return; end if;
  if v_status <> 'pending' then raise exception 'Only pending orders can be accepted (current: %)', v_status; end if;
  if exists (
    select 1 from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.stock < oi.qty and p.tenant_id = v_tenant
  ) then
    raise exception 'Insufficient stock for one or more items';
  end if;
  update public.products p
  set stock = p.stock - oi.qty
  from public.order_items oi
  where oi.order_id = p_order_id and oi.product_id = p.id and p.tenant_id = v_tenant;
  update public.orders set status = 'paid' where id = p_order_id;
end;
$$;

-- RPC to bootstrap a tenant for the current user
create or replace function public.bootstrap_tenant(p_name text default 'My Workspace')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_tenant uuid; v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  v_name := coalesce(nullif(p_name, ''), 'My Workspace');
  insert into public.tenants(name) values (v_name) returning id into v_tenant;
  insert into public.user_tenants(user_id, tenant_id, role)
  values (auth.uid(), v_tenant, 'owner')
  on conflict do nothing;
  return v_tenant;
end;
$$;

-- Re-create sales_total_between now that user_tenants exists
create or replace function public.sales_total_between(p_start date, p_end date)
returns numeric
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(o.total), 0)::numeric
  from public.orders o
  where o.status = 'paid'
    and o.date between p_start and p_end
    and exists (
      select 1 from public.user_tenants ut
      where ut.user_id = auth.uid() and ut.tenant_id = o.tenant_id
    );
$$;