-- ─────────────────────────────────────────────────────────────────────────────
-- Alpha Engine scheduler — runs INSIDE Supabase (pg_cron + pg_net).
-- Paste once into Supabase SQL editor. Server-side, survives laptop-off,
-- no third-party cron account needed.
--
-- Schedules (pg_cron runs in UTC):
--   • signal scan     every 15 min, 04:00–09:45 UTC weekdays
--                     (= 9:30 AM–3:15 PM IST; the endpoint's own gate
--                      enforces the precise 9:45–2:45 trading window)
--   • token refresh   03:00 UTC (8:30 AM IST) weekdays
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Clear old versions if re-running this file
select cron.unschedule(jobname)
from cron.job
where jobname in ('alpha_signal_15min', 'kite_refresh_daily');

select cron.schedule(
  'alpha_signal_15min',
  '*/15 4-9 * * 1-5',
  $$ select net.http_get('https://project-tcc78.vercel.app/api/trade/signal') $$
);

select cron.schedule(
  'kite_refresh_daily',
  '0 3 * * 1-5',
  $$ select net.http_get('https://project-tcc78.vercel.app/api/kite/refresh') $$
);

-- Verify: should list both jobs
select jobid, jobname, schedule, active from cron.job order by jobname;
