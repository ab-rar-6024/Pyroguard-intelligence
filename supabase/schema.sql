-- PyroGuard persistence schema for Supabase (Postgres).
-- Run this once in the Supabase project's SQL Editor before setting
-- SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the app's environment.

create table if not exists thermal_hotspots (
  grid_key text primary key,
  latitude double precision not null,
  longitude double precision not null,
  frp_mw double precision,
  brightness_kelvin double precision,
  satellite text,
  confidence text,
  acq_date text,
  acq_time text,
  daynight text,
  wind_speed_kmh double precision,
  wind_direction_deg double precision,
  nearest_facility jsonb,
  fire_type text,
  classification_confidence double precision,
  classification_reasoning text,
  is_persistent_source boolean not null default false,
  occurrences integer not null default 1,
  land_cover text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_thermal_hotspots_updated_at on thermal_hotspots (updated_at desc);

create table if not exists alerts (
  id text primary key,
  facility_id text,
  facility_name text,
  anomaly_id text,
  severity text,
  title text,
  message text,
  distance_km double precision,
  frp_mw double precision,
  dispatched_to jsonb,
  status text,
  evacuation_perimeter_km double precision,
  apparatus_assigned jsonb,
  "timestamp" text,
  created_at timestamptz not null default now()
);
create index if not exists idx_alerts_created_at on alerts (created_at desc);

create table if not exists fire_reports (
  id text primary key,
  reported_at text,
  latitude double precision not null,
  longitude double precision not null,
  location_source text,
  landmark text,
  description text,
  image_base64 text,
  status text not null default 'NEW',
  confirm_count integer not null default 0,
  dispute_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_fire_reports_created_at on fire_reports (created_at desc);

-- Atomic vote increment (the JS client's .update() would otherwise do a
-- plain read-then-write, which can lose a concurrent vote from another
-- viewer under a race).
create or replace function increment_report_vote(p_report_id text, p_vote_type text)
returns table(confirm_count integer, dispute_count integer)
language plpgsql
as $$
begin
  if p_vote_type = 'confirm' then
    update fire_reports set confirm_count = fire_reports.confirm_count + 1 where id = p_report_id;
  else
    update fire_reports set dispute_count = fire_reports.dispute_count + 1 where id = p_report_id;
  end if;
  return query select fire_reports.confirm_count, fire_reports.dispute_count from fire_reports where id = p_report_id;
end;
$$;

-- The app connects with the service_role key (server-side only, never
-- exposed to the browser), which bypasses Row Level Security entirely -
-- equivalent to how the Firebase Admin SDK bypassed Firestore security
-- rules. Row Level Security is enabled anyway as defense in depth in case
-- the anon key is ever used against these tables directly; no policies
-- are added, so the default-deny leaves the anon key unable to read or
-- write any of them.
alter table thermal_hotspots enable row level security;
alter table alerts enable row level security;
alter table fire_reports enable row level security;
