/* FuelTrack | All maintained application code lives here.
 * Railway: npm install, npm run build, npm start. Bind uses PORT / 0.0.0.0.
 * Optional cloud: SUPABASE_URL and SUPABASE_ANON_KEY (publishable key also supported).
 * Run npm run schema, apply the SQL in Supabase, enable email/password auth.
 * No service-role key is used. See Settings in the app for complete setup/help.
 */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const esbuild = require('esbuild');
const { PNG } = require('pngjs');
Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
const CONFIG = { port: process.env.PORT || 3000, url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '' };
const DEFAULTS = { nickname: 'My vehicle', fuel: 'Gasoline', preferredPrice: '', target: 160, budget: 15000, min: 4, excluded: ['2026-11'], threshold: 0.05 };
const SOURCE = `2026-01-04,UNKNOWN,,,2203.67,,INFERRED_AMOUNT_ONLY_NOT_IN_PASTED_LOG
2026-01-15,Malabaniamas,58.60,60436,2293.60,,SOURCE
2026-01-22,Malanday,63.30,61076,2429.26,,SOURCE
2026-01-31,Bagong barrio,57.69,61672,2142.23,,SOURCE
2026-02-08,Henson Angeles,60.80,62427,2331.07,,SOURCE
2026-02-14,Henson ville,59.95,63078,2213.35,,SOURCE
2026-02-21,Henson ville,59.00,63713,2250.87,,SOURCE
2026-03-01,Malanday,,64343,2377.00,,MISSING_PRICE
2026-03-08,Bagong barrio,63.45,64792,1758.33,27.71,RECEIPT_LITERS_PROVIDED
2026-03-15,Malanday,77.95,65309,2711.00,34.77,RECEIPT_LITERS_PROVIDED
2026-03-22,Angeles near HP,88.45,65879,2973.87,,SOURCE
2026-04-10,QC near Balintawak,109.20,66436,3892.98,,SOURCE
2026-04-17,QC,94.95,66905,,,MISSING_AMOUNT
2026-04-27,Malate,92.99,67463,3686.32,,SOURCE
2026-05-03,Bagong barrio,87.10,68005,3138.21,,SOURCE
2026-05-10,Henson,89.90,68588,3409.09,,SOURCE
2026-05-17,Hermosa Bataan,89.90,69274,2889.39,,SOURCE
2026-05-24,Henson,90.60,69881,3293.31,,SOURCE
2026-05-30,Malanday,89.05,70414,2932.15,,SOURCE
2026-06-05,Malanday,88.06,71095,,,MISSING_AMOUNT
2026-06-12,Malanday,88.36,71637,3085.09,,SOURCE
2026-06-27,Bagong barrio,77.50,72716,2851.77,,SOURCE
2026-07-04,Malanday,79.05,73362,3018.29,,SOURCE
2026-07-12,Bagong barrio,76.80,73994,2846.98,,SOURCE
2026-07-20,Malanday,78.10,74557,2636.42,,SOURCE
2026-07-27,Malanday,79.30,75140,2785.81,,SOURCE
2026-08-06,Bagong barrio,84.90,75857,2000.00,,SOURCE
2026-08-12,Bagong barrio,78.40,76327,3000.00,,SOURCE
2026-08-20,Malanday,81.70,76990,2700.00,,SOURCE
2026-08-28,Malanday,79.40,77453,2303.29,,SOURCE
2026-08-31,Guiguinto,77.99,77662,1189.74,,SOURCE
2026-09-10,Malabotn,81.20,,2500.00,,MISSING_ODOMETER
2026-09-18,Malabanias,86.85,78870,3279.46,,SOURCE
2026-09-30,Angeles near Hi-Precisio,86.85,79470,3160.38,,SOURCE
2026-10-05,Malabon,,80028,3217.37,,MISSING_PRICE
2026-10-12,Malabanas,90.95,80482,,,MISSING_AMOUNT
2026-10-18,Bagong barrio,92.80,81081,3176.27,,SOURCE
2026-10-28,Malabanias,85.40,81718,3254.59,,SOURCE
2026-11-02,Bataan,83.80,82098,1500.00,,SOURCE
2026-11-07,Angeles,89.30,82685,1000.00,,SOURCE
2026-11-11,Angeles,72.25,82936,2566.32,,SOURCE
2026-11-18,Malabon,,83650,,,MISSING_AMOUNT_AND_PRICE`;
const SEED = SOURCE.split('\n').map(line => {
  const [date, station, price, odo, amount, receipt, source] = line.split(',');
  const hex = crypto.createHash('sha256').update('fueltrack-v1:' + line).digest('hex');
  return { id: `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`, date, station, price: price || null, odo: odo || null, amount: amount || null, receipt: receipt || null, source, raw: line, inferred: source.startsWith('INFERRED'), confirmed: false, level: 'unknown', fuel: 'Gasoline', precision: 'date_only', timestamp: null, notes: source.startsWith('INFERRED') ? 'Jan 4 date confirmed; ₱2,203.67 is an inferred placeholder. Amount awaits confirmation.' : '', gps: null };
});

// Shared decimal calculation, validation and CSV engine (also compiled for browser).
function engine(Decimal) {
  const D = v => new Decimal(v == null || v === '' ? 0 : v);
  const valid = v => v !== '' && v != null && /^\d+(\.\d+)?$/.test(String(v)) && D(v).gt(0);
  const liters = e => valid(e.receipt) ? D(e.receipt) : valid(e.amount) && valid(e.price) ? D(e.amount).div(e.price) : null;
  const provisional = e => e.inferred && !e.confirmed;
  const complete = e => valid(e.amount) && liters(e) !== null;
  const sort = rows => [...rows].sort((a,b) => a.date.localeCompare(b.date) || (a.timestamp || '').localeCompare(b.timestamp || '') || a.id.localeCompare(b.id));
  function report(rows, prefs, include = true) {
    const ordered = sort(rows), months = {}, intervals = []; let lastFull = -1;
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i], key = e.date.slice(0,7);
      const m = months[key] ||= { key, count: 0, amount: D(0), provisional: D(0), liters: D(0), missingAmount: 0, missingLiters: 0, complete: true, km: D(0), gaps: 0, intervals: [], pricedLiters: D(0), pricedAmount: D(0) };
      m.count++;
      if (!complete(e) || provisional(e)) m.complete = false;
      if (!valid(e.amount)) m.missingAmount++;
      if (liters(e) === null) m.missingLiters++;
      if (provisional(e) && valid(e.amount)) m.provisional = m.provisional.add(e.amount);
      if (include || !provisional(e)) {
        if (valid(e.amount)) m.amount = m.amount.add(e.amount);
        if (liters(e)) m.liters = m.liters.add(liters(e));
        if (valid(e.amount) && liters(e)) { m.pricedAmount = m.pricedAmount.add(e.amount); m.pricedLiters = m.pricedLiters.add(liters(e)); }
      }
      if (i > 0) {
        const prev = ordered[i-1];
        if (valid(e.odo) && valid(prev.odo) && D(e.odo).gte(prev.odo) && !e.correction) m.km = m.km.add(D(e.odo).sub(prev.odo)); else m.gaps++;
      }
      if (e.level === 'full') {
        if (lastFull >= 0) {
          const start = ordered[lastFull], segment = ordered.slice(lastFull + 1, i + 1);
          const good = valid(start.odo) && valid(e.odo) && D(e.odo).gt(start.odo) && segment.every((x,j) => liters(x) && !provisional(x) && !x.correction && x.level !== 'unknown' && valid(x.odo) && D(x.odo).gte(ordered[lastFull+j].odo));
          if (good) {
            const fuel = segment.reduce((s,x) => s.add(liters(x)), D(0)), km = D(e.odo).sub(start.odo);
            const amount = segment.every(x => valid(x.amount)) ? segment.reduce((s,x) => s.add(x.amount), D(0)) : null;
            const interval = { start: start.date, end: e.date, km, liters: fuel, amount };
            intervals.push(interval); m.intervals.push(interval);
          }
        }
        lastFull = i;
      }
    }
    const list = Object.values(months).sort((a,b) => a.key.localeCompare(b.key));
    list.forEach(m => { m.eligible = m.count >= prefs.min && !prefs.excluded.includes(m.key); m.strict = m.eligible && m.complete; });
    const strict = list.filter(m => m.strict);
    return { months: list, intervals, strict, average: strict.length ? strict.reduce((s,m) => s.add(m.liters), D(0)).div(strict.length) : null };
  }
  function validate(input) {
    if (!input || typeof input !== 'object') throw Error('Invalid entry.');
    const e = {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id || '')) throw Error('Invalid record ID.');
    e.id = input.id;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '') || new Date(input.date + 'T00:00:00Z').toISOString().slice(0,10) !== input.date || input.date < '1900-01-01' || input.date > '2200-12-31') throw Error('Enter a valid date.');
    e.date = input.date;
    for (const [field, scale] of [['amount',2],['price',4],['receipt',6],['odo',1]]) {
      const v = input[field];
      if (v === '' || v == null) { e[field] = null; continue; }
      if (!valid(v) || D(v).gt(field === 'odo' ? 10000000 : 100000000) || D(v).decimalPlaces() > scale) throw Error(`Invalid ${field}: use a positive number with at most ${scale} decimal places.`);
      e[field] = D(v).toString();
    }
    for (const [field,max] of [['station',180],['notes',5000],['raw',15000],['source',150]]) { if (input[field] != null && typeof input[field] !== 'string') throw Error('Invalid text.'); e[field] = (input[field] || '').slice(0,max); }
    if (!['full','partial','unknown'].includes(input.level)) throw Error('Choose a tank level.'); e.level = input.level;
    if (!['Gasoline','Diesel'].includes(input.fuel)) throw Error('Choose a fuel type.'); e.fuel = input.fuel;
    e.precision = input.precision === 'exact' ? 'exact' : 'date_only'; e.timestamp = null;
    if (e.precision === 'exact') {
      const t = new Date(input.timestamp); if (!input.timestamp || !Number.isFinite(t.getTime())) throw Error('Invalid timestamp.');
      e.timestamp = t.toISOString();
      if (new Date(t.getTime()+28800000).toISOString().slice(0,10) !== e.date) throw Error('Date must match the Philippine timestamp.');
    }
    e.inferred = input.inferred === true; e.confirmed = input.confirmed === true; e.correction = input.correction === true;
    if (e.correction && !e.notes.trim()) throw Error('Document the odometer correction in Notes.');
    e.gps = null;
    if (input.gps) {
      const g = input.gps;
      if (![g.lat,g.lon,g.accuracy].every(x => typeof x === 'number' && Number.isFinite(x)) || Math.abs(g.lat)>90 || Math.abs(g.lon)>180 || g.accuracy<0 || !Number.isFinite(Date.parse(g.at))) throw Error('Invalid GPS capture.');
      e.gps = { lat:g.lat,lon:g.lon,accuracy:g.accuracy,at:new Date(g.at).toISOString() };
    }
    return e;
  }
  function preferences(p) {
    if (!p || !Number.isInteger(Number(p.min)) || p.min<1 || p.min>100) throw Error('Minimum refills must be 1–100.');
    if (!Array.isArray(p.excluded) || p.excluded.length>1200 || !p.excluded.every(x => /^\d{4}-(0[1-9]|1[0-2])$/.test(x))) throw Error('Excluded months must use YYYY-MM.');
    for (const f of ['target','budget','threshold']) if (!valid(p[f]) || D(p[f]).gt(100000000)) throw Error('Targets, budget and threshold must be positive.');
    if (p.preferredPrice && !valid(p.preferredPrice)) throw Error('Invalid preferred price.');
    return { nickname:String(p.nickname || 'My vehicle').slice(0,100), fuel:p.fuel === 'Diesel' ? 'Diesel':'Gasoline', preferredPrice:p.preferredPrice || '', target:String(p.target),budget:String(p.budget),threshold:String(p.threshold),min:Number(p.min),excluded:[...new Set(p.excluded)] };
  }
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', quote = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i=0;i<text.length;i++) {
      const c=text[i];
      if (c==='"') { if (quote && text[i+1]==='"') {cell+='"';i++;} else quote=!quote; }
      else if (c===',' && !quote) {row.push(cell);cell='';}
      else if ((c==='\n'||c==='\r') && !quote) { if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell=''; }
      else cell+=c;
    }
    if(quote)throw Error('Unclosed CSV quote.');row.push(cell);if(row.some(Boolean))rows.push(row);return rows;
  }
  const fingerprint = e => [e.date,e.timestamp || '',e.station.trim().toLowerCase(),e.price,e.amount,e.odo,e.receipt].join('|');
  return { D,valid,liters,provisional,complete,sort,report,validate,preferences,parseCSV,fingerprint };
}
const E = engine(Decimal);

// Supabase migration: JSON payload retains original import evidence without losing nulls.
const SCHEMA = `-- FuelTrack v1. Run once in Supabase SQL Editor. Re-running is safe.
begin;
create table if not exists public.vehicles (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 nickname text not null default 'My vehicle', created_at timestamptz not null default now(), unique(id,user_id)
);
create table if not exists public.fuel_entries (
 id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 vehicle_id uuid not null, payload jsonb not null check(jsonb_typeof(payload)='object'),
 revision integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(vehicle_id,user_id) references public.vehicles(id,user_id) on delete cascade,
 check (payload->>'id'=id::text), check (payload->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$')
);
create index if not exists fuel_entries_owner on public.fuel_entries(user_id,vehicle_id);
create table if not exists public.user_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade, payload jsonb not null default '{}'::jsonb
);
create table if not exists public.import_batches (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 filename text, row_count integer, warnings text, created_at timestamptz not null default now()
);
create or replace function public.fueltrack_revision() returns trigger language plpgsql set search_path=public as $$
begin new.revision=old.revision+1; new.updated_at=now(); return new; end $$;
drop trigger if exists fueltrack_revision on public.fuel_entries;
create trigger fueltrack_revision before update on public.fuel_entries for each row execute function public.fueltrack_revision();
alter table public.vehicles enable row level security;
alter table public.fuel_entries enable row level security;
alter table public.user_preferences enable row level security;
alter table public.import_batches enable row level security;
drop policy if exists owner_only on public.vehicles;
create policy owner_only on public.vehicles to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists owner_only on public.fuel_entries;
create policy owner_only on public.fuel_entries to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists owner_only on public.user_preferences;
create policy owner_only on public.user_preferences to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
drop policy if exists owner_only on public.import_batches;
create policy owner_only on public.import_batches to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
revoke all on public.vehicles,public.fuel_entries,public.user_preferences,public.import_batches from anon;
grant select,insert,update,delete on public.vehicles,public.fuel_entries,public.user_preferences,public.import_batches to authenticated;
commit;`;

const CSS = `:root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#18344e;background:#f6f8fb;font-size:16px;--navy:#14395d;--green:#087f61;--muted:#5c6f82;--line:#e1e8ef}*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button,a,input,select,textarea{outline-offset:4px}button{cursor:pointer;min-height:44px;border:0;border-radius:10px;padding:10px 17px;font-weight:600;background:#eaf0f6;color:var(--navy)}button:hover{filter:brightness(.96)}button:disabled{opacity:.55;cursor:wait}a{color:#08755c}input,select,textarea{width:100%;min-height:46px;border:1px solid #bbc9d6;background:white;border-radius:9px;padding:10px;color:#18344e}textarea{min-height:90px}input[type=checkbox]{width:20px;min-height:20px;vertical-align:middle}label{display:block;font-size:.9rem;font-weight:600;margin-bottom:7px}small,.muted{color:var(--muted);font-size:.875rem;line-height:1.6}h1,h2,h3,p{margin-top:0}h1{font-size:1.85rem;letter-spacing:-.8px;margin-bottom:8px}h2{font-size:1.15rem}h3{font-size:1rem}p{line-height:1.6}aside{width:240px;position:fixed;inset:0 auto 0 0;background:#0e2b47;color:white;padding:32px 20px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:12px;font-size:1.5rem;font-weight:750;letter-spacing:-.5px}.brand-icon{background:#10b981;color:#0e2b47;border-radius:13px;padding:10px;font-size:1.5rem}.brand-sub{color:#a9bfd1;font-size:.8rem;margin-top:7px;margin-bottom:40px}nav{display:grid;gap:9px}nav button{text-align:left;background:transparent;color:#bccddd;padding:14px 17px}nav button.active{background:#254964;color:white}nav button[data-page=gas]{background:#10b981;color:#082c29}aside footer{margin-top:auto;color:#a9bfd1;font-size:.85rem;line-height:1.7}main{margin-left:240px;padding:38px 44px 65px;max-width:1600px}.topline,.row,.between{display:flex;align-items:center;gap:12px}.between{justify-content:space-between}.topline{justify-content:space-between;margin-bottom:27px}.eyebrow{font-size:.75rem;letter-spacing:1.8px;color:var(--green);font-weight:750;margin-bottom:10px}.pill{display:inline-block;font-size:.78rem;padding:4px 9px;border-radius:6px;background:#edf3f8;color:#445e73;white-space:nowrap}.pill.warn{background:#fff2d6;color:#855500}.pill.good{background:#dff6ed;color:#07674f}.primary{background:var(--green);color:white}.danger{color:#ac2438;background:#fff0f1}.card{padding:25px;background:white;border:1px solid var(--line);border-radius:17px;box-shadow:0 4px 16px #122f4b03}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:20px 0}.kpi .value{font-size:1.6rem;letter-spacing:-.7px;font-weight:750;margin:13px 0 6px}.hero{background:var(--navy);color:white;padding:30px;border-radius:18px;display:grid;grid-template-columns:1fr 1fr;gap:30px}.hero small{color:#bdd0e0}.hero .big{font-size:3.35rem;font-weight:750;letter-spacing:-2px;margin:12px 0}.hero .big span{font-size:1.1rem;letter-spacing:0;font-weight:400;color:#b8d0e1}.hero-note{border-left:1px solid #45617b;padding-left:30px;align-self:center}.hero-note strong{font-size:1.8rem;display:block;margin:12px 0}progress{width:100%;height:7px;accent-color:#10b981;border-radius:10px}section{margin-bottom:22px}.notice{border:1px solid #d9e5ed;border-radius:11px;background:#edf4f9;padding:13px 17px;line-height:1.6;font-size:.875rem;margin-bottom:20px}.notice.warning{background:#fff8e9;border-color:#f0dcaa;color:#795723}.filters{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.filters>*{width:auto;flex:1;min-width:120px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.875rem}th{text-align:left;color:#667b8c;font-weight:600;font-size:.78rem;letter-spacing:.3px;background:#f8fafc}th,td{padding:15px 12px;border-bottom:1px solid var(--line);white-space:nowrap}td strong{font-weight:650}td small{display:block}tr:last-child td{border-bottom:0}.right{text-align:right}.bars{height:175px;display:flex;align-items:end;gap:10px;padding-top:16px}.bar-col{flex:1;text-align:center;min-width:0}.bar{min-height:2px;background:#10b981;border-radius:5px 5px 0 0;width:100%;display:block;padding:0;min-width:0;min-height:2px}.bar.blue{background:#38698d}.bar-col small{font-size:.72rem}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.full{grid-column:1/-1}.check{display:flex;gap:10px;align-items:center;font-weight:400;line-height:1.5}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.readout{background:#e6f7f0;border-radius:10px;padding:18px;color:#07674f}.readout strong{font-size:1.6rem}.hidden{display:none!important}.empty{padding:36px;text-align:center;color:var(--muted)}.setup{font-size:.92rem;line-height:1.8}.setup code{background:#edf2f7;padding:2px 5px;border-radius:3px;overflow-wrap:anywhere}.setup ol{padding-left:23px}.setup li{margin:10px 0}#toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);z-index:20;background:#102f49;color:white;padding:14px 22px;border-radius:12px;max-width:90%;box-shadow:0 8px 30px #0003}#toast.error{background:#932b3e}.mobile-brand{display:none}.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.section-title h2{margin:0}.link-btn{background:transparent;color:var(--green);padding:4px 8px}.details{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}dialog{border:0;border-radius:17px;width:min(640px,94vw);max-height:85vh;padding:28px;box-shadow:0 20px 80px #0005}dialog::backdrop{background:#0e2b4777}details summary{cursor:pointer;min-height:44px;padding:10px 0;font-weight:600}.account{max-width:540px}.stat-label{font-size:.86rem;color:var(--muted)}.divider{border:0;border-top:1px solid var(--line);margin:25px 0}.nowrap{white-space:nowrap}@media(min-width:1500px){main{margin:auto;padding-left:280px}}@media(max-width:1100px){main{padding:28px 25px}aside{width:210px}main{margin-left:210px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){aside{inset:auto 0 0;width:100%;padding:6px 6px calc(6px + env(safe-area-inset-bottom));z-index:10;border-top:1px solid #32506b}aside .brand,aside .brand-sub,aside footer{display:none}nav{display:flex;gap:3px;justify-content:space-around}nav button{font-size:.72rem;padding:10px 4px;flex:1;text-align:center;border-radius:9px;min-height:49px}main{margin:0;padding:20px 16px 115px}.mobile-brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px;font-weight:750;font-size:1.2rem}.mobile-brand span{font-size:.75rem;color:var(--muted);font-weight:400}.topline{align-items:start;gap:8px}.topline button{padding:9px;font-size:.8rem}h1{font-size:1.6rem}.hero{grid-template-columns:1fr;padding:23px;gap:15px}.hero .big{font-size:2.9rem}.hero-note{border-left:0;border-top:1px solid #45617b;padding:15px 0 0}.hero-note strong{display:inline-block;margin:0 10px 0 0;font-size:1.35rem}.hero-note p{margin:8px 0 0}.grid{grid-template-columns:1fr;gap:16px}.kpis{gap:10px}.card{padding:18px}.kpi .value{font-size:1.35rem}.form-grid{gap:17px;grid-template-columns:1fr}.full{grid-column:auto}.filters{gap:8px}.filters>*{min-width:110px}#toast{bottom:100px}.bars{gap:7px}th,td{padding:13px 10px}.notice{padding:12px}.brand-icon{padding:6px;font-size:1rem}}`;

function client(SEED, DEFAULTS, engine, Decimal) {
  const E = engine(Decimal), $ = s => document.querySelector(s);
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (x,n=2) => x == null ? '—' : Number(x).toLocaleString('en-PH',{minimumFractionDigits:n,maximumFractionDigits:n});
  const money = x => x == null ? '—' : '₱'+fmt(x);
  const today = () => new Date(Date.now()+28800000).toISOString().slice(0,10);
  const localTime = t => new Date(new Date(t).getTime()+28800000).toISOString().slice(0,16);
  const monthName = key => new Date(key+'-15T00:00:00Z').toLocaleDateString('en-PH',{month:'short',year:'numeric',timeZone:'Asia/Manila'});
  const dateName = e => e.precision === 'exact' ? new Date(e.timestamp).toLocaleString('en-PH',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:'Asia/Manila'}) : new Date(e.date+'T00:00:00+08:00').toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Manila'})+' · date only';
  function read(key,fallback) {try{return JSON.parse(localStorage.getItem(key)) ?? fallback;}catch{return fallback;}}
  let session = read('fueltrack-session',null), cloud = false, configured = false, revisions = {}, vehicle = null;
  let rows = read('fueltrack-local',null) || structuredClone(SEED), prefs = {...DEFAULTS,...read('fueltrack-prefs',{})};
  let page = 'dashboard', period = today().slice(0,7), year = today().slice(0,4), include = true, filter = '', levelFilter='', qualityFilter='', historyMonth='', edit = null, gps = null, busy = false, pendingImport = null;
  const notice = () => `<div class="notice ${cloud?'':'warning'}">${cloud?'Cloud account connected · changes save to Supabase after confirmation.':'Local preview · the supplied historical records are stored in this browser. Export a backup or connect an account in Settings for cloud storage.'}${navigator.onLine?'':' <strong>Offline. A draft can be saved; cloud writes are unavailable.</strong>'}</div>`;
  function toast(msg,error=false){$('#toast').textContent=msg;$('#toast').className=error?'error':'';$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6500);}
  const persist = () => {if(!cloud){localStorage.setItem('fueltrack-local',JSON.stringify(rows));localStorage.setItem('fueltrack-prefs',JSON.stringify(prefs));}};
  async function api(path,method='GET',data){
    if(!path.startsWith('/api/auth/') && session && session.expires_at && Date.now()/1000>session.expires_at-60){
      const res=await fetch('/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})});
      const s=await res.json();if(!res.ok)throw Error('Session expired. Sign in again in Settings.');session=s;localStorage.setItem('fueltrack-session',JSON.stringify(s));
    }
    const r=await fetch(path,{method,headers:{'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session.access_token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const body=await r.json();if(!r.ok)throw Error(body.error || 'Request failed.');return body;
  }
  async function loadCloud(){ const d=await api('/api/data');rows=d.entries.map(x=>x.payload);revisions=Object.fromEntries(d.entries.map(x=>[x.id,x.revision]));vehicle=d.vehicle; prefs={...DEFAULTS,...d.preferences};cloud=true; }
  function badge(e){return E.provisional(e)?'<span class="pill warn">Provisional</span>':!E.complete(e)?'<span class="pill warn">Incomplete</span>':'<span class="pill good">Complete</span>';}
  const sum = (list,key) => list.reduce((s,x)=>s.add(x[key] || 0),E.D(0));
  function nav(){document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));}
  function header(title,sub,action=true){return `<div class="topline"><div><div class="eyebrow">PERSONAL FUEL MONITOR</div><h1>${title}</h1><small>${sub}</small></div>${action?'<button class="primary" data-action="new">+ Record Gas Up</button>':''}</div>`;}
  function table(list){if(!list.length)return '<div class="empty">No refueling records here yet.</div>';return `<div class="table-wrap"><table><thead><tr><th>STATION / DATE</th><th>ODOMETER</th><th class="right">LITERS</th><th class="right">AMOUNT</th><th>QUALITY</th><th></th></tr></thead><tbody>${list.map(e=>`<tr><td><strong>${esc(e.station || 'Station not recorded')}</strong><small>${esc(dateName(e))}</small></td><td>${fmt(e.odo,0)} <small>${esc(e.level)} tank</small></td><td class="right">${fmt(E.liters(e))} L</td><td class="right">${money(e.amount)}</td><td>${badge(e)}</td><td><button data-detail="${e.id}" class="link-btn">View</button></td></tr>`).join('')}</tbody></table></div>`;}
  function charts(months,key,title,blue=false){ const max=Math.max(1,...months.map(m=>Number(m[key])));return `<div class="card"><h2>${title}</h2><small>Known quantities · incomplete months are subtotals</small><div class="bars">${months.map(m=>`<div class="bar-col"><button class="bar ${blue?'blue':''}" data-month="${m.key}" style="height:${Math.max(2,Number(m[key])/max*125)}px" title="${esc(monthName(m.key))}: ${key==='amount'?money(m[key]):fmt(m[key])+' L'}${m.complete?'':' (incomplete)'}" aria-label="${esc(monthName(m.key))} ${fmt(m[key])}; open records"></button><small>${monthName(m.key).split(' ')[0]}</small></div>`).join('')}</div></div>`; }
  function dashboard(){
    const r=E.report(rows,prefs,include), months=r.months.filter(m=> period==='year'?m.key.startsWith(year):period==='custom'?m.key >= ($('#custom-from')?.value || customFrom) && m.key <= ($('#custom-to')?.value || customTo):m.key===period);
    const L=sum(months,'liters'), amount=sum(months,'amount'), km=sum(months,'km'), intervals=months.flatMap(m=>m.intervals), vkm=sum(intervals,'km'), vl=sum(intervals,'liters');
    const cost=intervals.length && intervals.every(i=>i.amount!==null)?sum(intervals,'amount').div(vkm):null;
    const missingA=months.reduce((s,m)=>s+m.missingAmount,0), missingL=months.reduce((s,m)=>s+m.missingLiters,0), provisional=sum(months,'provisional');
    return header('Your fuel, in focus.',esc(prefs.nickname)+' · Philippines / Asia/Manila')+notice()+`<div class="filters"><select id="period" aria-label="Report period"><option value="year" ${period==='year'?'selected':''}>Whole year</option><option value="custom" ${period==='custom'?'selected':''}>Custom range</option>${[...new Set([today().slice(0,7),...r.months.map(m=>m.key)])].sort().reverse().map(m=>`<option value="${m}" ${period===m?'selected':''}>${monthName(m)}</option>`).join('')}</select>${period==='year'?`<input id="year" aria-label="Year" type="number" value="${year}" min="1900" max="2200">`:''}${period==='custom'?`<input type="month" id="custom-from" aria-label="Start month" value="${customFrom}"><input type="month" id="custom-to" aria-label="End month" value="${customTo}">`:''}<label class="check"><input id="provisional-toggle" type="checkbox" ${include?'checked':''}> Include provisional amount</label></div><section class="hero"><div><small>LITERS PURCHASED · ${period==='year'?esc(year):period==='custom'?'CUSTOM PERIOD':esc(monthName(period)).toUpperCase()}</small><div class="big">${fmt(L)} <span>liters</span></div><progress value="${Math.min(Number(L),Number(prefs.target))}" max="${prefs.target}"></progress><small>${fmt(prefs.target,0)} L monthly target ${period==='year'||period==='custom'?'· target shown for one month':''} · ${missingL?missingL+' records lack liters':'All selected liters recorded'}</small></div><div class="hero-note"><small>HISTORICAL PLANNING ESTIMATE</small><strong>${fmt(r.average)} <small>L / month</small></strong><p><small>${r.strict.length} complete eligible months · ${r.strict.map(m=>monthName(m.key)).join(', ') || 'Insufficient data'}<br>Purchased fuel; actual consumption requires verified intervals.</small></p></div></section><div class="kpis"><div class="card kpi"><div class="stat-label">Recorded fuel expense</div><div class="value">${money(amount)}</div><small>${missingA} missing amounts · ${money(provisional)} provisional ${include?'included':'excluded'}<br>Monthly budget ${money(prefs.budget)}</small></div><div class="card kpi"><div class="stat-label">Recorded refill distance</div><div class="value">${fmt(km,0)} <small>km</small></div><small>Adjacent readings, assigned to end month. Missing readings and corrections break intervals.</small></div><div class="card kpi"><div class="stat-label">Verified fuel economy</div><div class="value">${vl.gt(0)?fmt(vkm.div(vl)):'—'} <small>km/L</small></div><small>${intervals.length?intervals.length+' closed full-tank intervals':'Insufficient full-tank data'}</small></div><div class="card kpi"><div class="stat-label">Verified cost per km</div><div class="value">${money(cost)}</div><small>${cost?'From verified intervals with complete costs':'Requires verified fuel intervals and amounts'}</small></div></div><section class="grid">${charts(r.months.filter(m=>m.key.startsWith(year)),'liters','Liters purchased')}${charts(r.months.filter(m=>m.key.startsWith(year)),'amount','Recorded expenses',true)}</section><section class="card"><div class="section-title"><h2>Recent refueling</h2><button class="link-btn" data-page="history">View history</button></div>${table(E.sort(rows).reverse().slice(0,5))}</section>`;
  }
  let customFrom='2026-01',customTo=today().slice(0,7);
  function history(){const list=E.sort(rows).reverse().filter(e=>(!historyMonth||e.date.startsWith(historyMonth))&&(!filter||(e.station+' '+e.notes+' '+e.date).toLowerCase().includes(filter.toLowerCase()))&&(!levelFilter||e.level===levelFilter)&&(!qualityFilter||(qualityFilter==='incomplete'?!E.complete(e):qualityFilter==='provisional'?E.provisional(e):E.complete(e))));return header('Refueling history',`${rows.length} records · every receipt has a story`)+notice()+`<div class="filters"><input id="search" placeholder="Search station or notes" aria-label="Search history" value="${esc(filter)}"><input id="history-month" type="month" aria-label="Filter by month" value="${historyMonth}"><select id="level-filter" aria-label="Tank level"><option value="">All tank levels</option>${['full','partial','unknown'].map(x=>`<option ${x===levelFilter?'selected':''}>${x}</option>`).join('')}</select><select id="quality-filter" aria-label="Data quality"><option value="">All data quality</option>${['complete','incomplete','provisional'].map(x=>`<option ${x===qualityFilter?'selected':''}>${x}</option>`).join('')}</select><button data-action="clear-filters">Clear</button><button data-action="csv">Export CSV</button></div><section class="card">${table(list)}</section><small>Exports include all records. Original source text, receipt liters and inferred flags are preserved. Blank values mean unknown.</small>`;}
  function analytics(){const r=E.report(rows,prefs,include),list=r.months.filter(m=>m.key.startsWith(year));return header('Understand your patterns','Purchased fuel, recorded distance and verified consumption')+notice()+`<div class="filters"><input id="year" aria-label="Report year" type="number" value="${year}" min="1900" max="2200"><label class="check"><input id="provisional-toggle" type="checkbox" ${include?'checked':''}> Include provisional amounts</label></div><section class="card"><h2>Planning with complete months</h2><p><strong>${fmt(r.average)} L / month</strong> · ${r.strict.map(m=>monthName(m.key)).join(', ') || 'No eligible complete months'}</p><small>Baseline: at least ${prefs.min} entries, excluding ${prefs.excluded.map(monthName).join(', ') || 'no months'}. Strict months need usable amount and liters on every record and no unconfirmed inferred records. The average is purchased fuel, not a consumption guarantee.</small></section><section class="grid">${charts(list,'liters','Monthly liters purchased')}${charts(list,'amount','Monthly recorded expenses',true)}</section><section class="card table-wrap"><table><thead><tr><th>MONTH</th><th>REFILLS</th><th>RECORDED ₱</th><th>PURCHASED L</th><th>REFILL DISTANCE</th><th>WEIGHTED ₱/L</th><th>QUALITY / BASELINE</th></tr></thead><tbody>${list.map(m=>`<tr><td><button class="link-btn" data-month="${m.key}">${monthName(m.key)}</button></td><td>${m.count}</td><td>${money(m.amount)}<small>${m.missingAmount} missing · ${money(m.provisional)} provisional</small></td><td>${fmt(m.liters)}<small>${m.missingLiters} missing quantities</small></td><td>${fmt(m.km,0)} km<small>${m.gaps} broken intervals</small></td><td>${m.pricedLiters.gt(0)?money(m.pricedAmount.div(m.pricedLiters)):'—'}</td><td><span class="pill ${m.strict?'good':'warn'}">${m.strict?'Strict complete':m.eligible?'Eligible · incomplete':'Excluded'}</span></td></tr>`).join('')}</tbody></table></section><section class="card"><h2>Fuel consumed in verified full-tank intervals</h2>${r.intervals.length?`<div class="table-wrap"><table><thead><tr><th>START / END</th><th>DISTANCE</th><th>FUEL CONSUMED</th><th>KM/L</th></tr></thead><tbody>${r.intervals.filter(i=>i.end.startsWith(year)).map(i=>`<tr><td>${i.start} / ${i.end}</td><td>${fmt(i.km,0)} km</td><td>${fmt(i.liters)} L</td><td>${fmt(i.km.div(i.liters))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Insufficient data. The original historical entries have unknown tank levels. No verified km/L can be calculated from these records.</p>'}<small>Each interval includes all partial fills after the starting full tank, through the ending full tank. Unknown levels, missing quantities, missing odometers and corrections invalidate that interval. Unrecorded purchases must be added before treating results as verified. Monthly distance is assigned to the ending refill month; it is not exact calendar mileage.</small></section>`;}
  function gas(){const draft = edit || read('fueltrack-draft',{});gps=draft.gps || null;const last=E.sort(rows).filter(e=>e.odo).at(-1);return header(edit?'Edit Gas Up':'Record a Gas Up','A little detail today. A clearer picture tomorrow.',false)+notice()+`<form id="entry-form" class="card"><div class="form-grid"><div class="full notice">Blank fields are allowed for incomplete history. Enter or confirm the current odometer. Date and time are captured when Save is pressed, unless you choose a correction below.</div><div><label for="station">Station name / location</label><input id="station" name="station" maxlength="180" value="${esc(draft.station)}" placeholder="e.g. Malanday"></div><div><label for="fuel">Fuel type</label><select id="fuel" name="fuel">${['Gasoline','Diesel'].map(f=>`<option ${(draft.fuel || prefs.fuel)===f?'selected':''}>${f}</option>`).join('')}</select></div><div><label for="odo">Current odometer (km)</label><input id="odo" name="odo" type="number" inputmode="decimal" min="0.1" step="0.1" value="${esc(draft.odo)}" placeholder="${last?'Last: '+fmt(last.odo,0):'Current reading'}"><small>Previous reading: ${last?fmt(last.odo,0)+' km':'not recorded'}.</small></div><div><label for="level">Tank level after filling</label><select id="level" name="level" required><option value="">Choose full, partial or unknown</option>${['full','partial','unknown'].map(l=>`<option value="${l}" ${draft.level===l?'selected':''}>${l[0].toUpperCase()+l.slice(1)}</option>`).join('')}</select></div><div><label for="price">Price per liter (₱/L)</label><input id="price" name="price" type="number" inputmode="decimal" min="0.0001" step="0.0001" value="${esc(draft.price ?? prefs.preferredPrice)}"></div><div><label for="amount">Actual amount paid (₱)</label><input id="amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" value="${esc(draft.amount)}"></div><div><label for="receipt">Receipt liters (optional, authoritative)</label><input id="receipt" name="receipt" type="number" inputmode="decimal" min="0.000001" step="0.000001" value="${esc(draft.receipt)}"><small>If blank, liters = amount ÷ price.</small></div><div class="readout"><small>Liters purchased</small><div><strong id="live-liters">—</strong> L</div><small id="discrepancy"></small></div><div class="full"><label class="check"><input id="manual-time" type="checkbox" ${edit || draft.manual?'checked':''}> Correct date/time or enter date-only history</label></div><div id="time-fields" class="full ${edit || draft.manual?'':'hidden'}"><div class="form-grid"><div><label for="precision">Time precision</label><select id="precision" name="precision"><option value="exact" ${draft.precision!=='date_only'?'selected':''}>Exact date and time (Philippines)</option><option value="date_only" ${draft.precision==='date_only'?'selected':''}>Date only · time unknown</option></select></div><div><label for="fill-date">Philippine date / time</label><input id="fill-date" type="${draft.precision==='date_only'?'date':'datetime-local'}" value="${draft.precision==='date_only'?draft.date || today():localTime(draft.timestamp || new Date())}"></div></div></div><div class="full"><label for="notes">Notes</label><textarea id="notes" name="notes" maxlength="5000" placeholder="Receipt details, trip, missing fields…">${esc(draft.notes)}</textarea></div><div class="full"><label class="check"><input id="correction" name="correction" type="checkbox" ${draft.correction?'checked':''}> This entry documents an odometer correction (explain in Notes)</label>${draft.inferred?`<label class="check"><input id="confirmed" name="confirmed" type="checkbox" ${draft.confirmed?'checked':''}> I verified this inferred amount against my records.</label>`:''}<label class="check"><input id="allow-incomplete" type="checkbox" ${edit && !E.complete(edit)?'checked':''}> Save as an incomplete entry if amount or liters are missing</label></div><div class="full"><h3>Optional location</h3><small>Your coordinates stay with this record. Location is requested only when you tap Capture.</small><div class="actions"><button type="button" data-action="gps">Capture Current Location</button><button type="button" data-action="remove-gps">Remove GPS</button></div><p id="gps-info" class="muted"></p></div></div><div class="actions"><button class="primary" type="submit">${edit?'Save changes':'Save Gas Up'}</button><button type="button" data-action="draft">Save local draft</button><button type="button" data-action="cancel">Cancel</button></div><small>Cloud mode requires a confirmed server save. Offline drafts remain on this device until you explicitly save them.</small></form>`;}
  function settings(){return header('Make it yours','Vehicle, planning preferences and your data',false)+notice()+`<div class="grid"><section class="card"><h2>Vehicle & planning</h2><form id="prefs-form" class="form-grid"><div class="full"><label for="nickname">Vehicle nickname</label><input id="nickname" name="nickname" maxlength="100" value="${esc(prefs.nickname)}"></div><div><label for="pref-fuel">Default fuel</label><select name="fuel" id="pref-fuel"><option ${prefs.fuel==='Gasoline'?'selected':''}>Gasoline</option><option ${prefs.fuel==='Diesel'?'selected':''}>Diesel</option></select></div><div><label for="preferredPrice">Preferred price (₱/L)</label><input id="preferredPrice" name="preferredPrice" type="number" step="0.0001" min="0.0001" value="${esc(prefs.preferredPrice)}"></div><div><label for="target">Monthly target (L)</label><input id="target" name="target" type="number" step="0.01" min="0.01" required value="${prefs.target}"></div><div><label for="budget">Monthly budget (₱)</label><input id="budget" name="budget" type="number" step="0.01" min="0.01" required value="${prefs.budget}"></div><div><label for="minimum">Minimum refills per month</label><input id="minimum" name="min" type="number" min="1" max="100" required value="${prefs.min}"></div><div><label for="threshold">Receipt discrepancy threshold (L)</label><input id="threshold" name="threshold" type="number" min="0.001" step="0.001" required value="${prefs.threshold}"></div><div class="full"><label for="excluded">Excluded baseline months</label><input id="excluded" name="excluded" value="${prefs.excluded.join(', ')}"><small>Comma-separated YYYY-MM. Asia/Manila is used throughout.</small></div><button class="primary full">Save preferences</button></form></section><div><section class="card account"><h2>Account & cloud storage</h2>${session&&cloud?`<p>Signed in as <strong>${esc(session.user?.email || 'your account')}</strong></p><div class="actions"><button data-action="sync">Refresh cloud data</button><button data-action="logout">Sign out</button></div>`:`<p class="muted">${configured?'Connect your Supabase account to keep records across devices. Local history is imported only when you choose.':'The preview works now. Configure Supabase using the deployment guide below to enable an account and cloud storage.'}</p><form id="auth-form"><label for="email">Email</label><input id="email" type="email" name="email" autocomplete="email" required><label for="password" style="margin-top:12px">Password</label><input id="password" type="password" name="password" minlength="8" autocomplete="current-password" required><div class="actions"><button class="primary" name="mode" value="login" ${configured?'':'disabled'}>Sign in</button><button name="mode" value="signup" ${configured?'':'disabled'}>Create account</button></div></form>`}</section><section class="card"><h2>Your data, your control</h2><div class="actions"><button data-action="csv">Export CSV</button><button data-action="backup">JSON backup</button><button data-action="import">Import / restore</button><button data-action="seed">Import original 42 records</button></div><p><small>Imports show a review before saving. Exact matching records are skipped. Restore merges with current data; existing IDs are preserved and never overwritten by import.</small></p><hr class="divider"><button class="danger" data-action="delete-all">Delete all records</button><p><small>This deletes records in the current mode. To delete your account, contact your Supabase project owner. Signing out clears the session and cloud records from memory. Local drafts and backups can contain private GPS information.</small></p></section></div></div><section class="card setup"><h2>Deploy these two files</h2><ol><li>Upload <code>index.js</code> and <code>package.json</code> to a GitHub repository. In Railway choose <strong>New Project → Deploy from GitHub repo</strong>.</li><li>Build command: <code>npm run build</code>. Start command: <code>npm start</code>. Generate a Railway public domain. The app listens on Railway's <code>PORT</code>; HTTPS is provided by Railway.</li><li>Create a Supabase project. <a href="/setup.sql" download="fueltrack-setup.sql">Download the database SQL</a> (also available using <code>npm run schema</code>) and run it in the Supabase SQL Editor. It creates owner-protected vehicles, entries, preferences and import-batch tables. RLS restricts every user-owned table to its owner. GPS and raw source notes are retained in the record payload.</li><li>Add Railway variables: <code>SUPABASE_URL</code> = your project URL, and <code>SUPABASE_ANON_KEY</code> = your public anon key (or <code>SUPABASE_PUBLISHABLE_KEY</code>). Use no service-role key. Redeploy. Configure Supabase Auth Site URL to your Railway HTTPS domain; enable email/password sign-in and email confirmation.</li><li>Create an account here, confirm the email, then sign in. Choose <strong>Import original 42 records</strong> to add the supplied history to your cloud account. Demo edits can be exported first, then restored in cloud mode.</li><li>On Android Chrome, open the HTTPS site and choose <strong>Menu → Add to Home screen / Install app</strong>. On iPhone Safari use <strong>Share → Add to Home Screen</strong>. If a new release is available, close and reopen the app online.</li></ol><p>Local development: <code>npm install</code>, <code>npm run dev</code>. Verify with <code>npm test</code> and <code>npm run build</code>. This is a Node server deployment for Railway; it is not a static Vercel export. Only the two files are maintained; browser bundles, icons, manifest and service worker are generated in memory.</p><details><summary>Privacy, offline use and calculation notes</summary><p>Browser mode stores records on this device. Cloud mode loads only authenticated records and uses Supabase Row Level Security. A local draft may retain GPS; clear it using Discard draft below. The service worker caches only the app shell and public assets, never API responses. Offline cloud writes are blocked; export a backup before clearing browser storage. Explicit Save is required after reconnecting. Stale edits are rejected using record revisions. There is no background write queue.</p><p>Every original historical record is date-only, with unknown tank status. Jan 4's ₱2,203.67 is inferred until confirmed. Missing amounts and prices stay null. Explicit receipt liters take priority. Purchased liters are aggregated with decimal precision; true consumption is estimated only over valid full-tank intervals. No source record implies an exact calendar-month distance.</p><button data-action="discard-draft">Discard local draft</button></details></section>`;}
  function render(){nav();$('#content').innerHTML=page==='dashboard'?dashboard():page==='history'?history():page==='analytics'?analytics():page==='gas'?gas():settings();if(page==='gas'){updateLiters();showGPS();}}
  function navigate(p){page=p;render();window.scrollTo({top:0,behavior:'smooth'});}
  function updateLiters(){try {const e=Object.fromEntries(new FormData($('#entry-form'))),l=E.liters(e);$('#live-liters').textContent=fmt(l);const calc=E.valid(e.amount)&&E.valid(e.price)?E.D(e.amount).div(e.price):null;$('#discrepancy').textContent=E.valid(e.receipt)&&calc&&E.D(e.receipt).sub(calc).abs().gt(prefs.threshold)?'Receipt discrepancy: calculated '+fmt(calc,3)+' L. Receipt liters will be used.':E.valid(e.receipt)?'Using explicit receipt liters.':'Amount ÷ price per liter.';}catch{$('#live-liters').textContent='—';}}
  function showGPS(){if($('#gps-info'))$('#gps-info').innerHTML=gps?`${fmt(gps.lat,6)}, ${fmt(gps.lon,6)} · accuracy ±${fmt(gps.accuracy,0)} m${gps.accuracy>100?' · Low accuracy; retry recommended':''}<br>${esc(new Date(gps.at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))} · <a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps?q=${gps.lat},${gps.lon}">Open in Google Maps</a>`:'No location attached.';}
  function collect(){ const f=Object.fromEntries(new FormData($('#entry-form')));const manual=$('#manual-time').checked;let timestamp, date;
    if(manual){if(f.precision==='date_only'){date=$('#fill-date').value;timestamp=null;}else{timestamp=edit?.timestamp && $('#fill-date').value===localTime(edit.timestamp)?edit.timestamp:new Date($('#fill-date').value+':00+08:00').toISOString();date=new Date(new Date(timestamp).getTime()+28800000).toISOString().slice(0,10);}}
    else {timestamp=new Date().toISOString();date=today();f.precision='exact';}
    return E.validate({...edit,...f,id:edit?.id || crypto.randomUUID(),date,timestamp,gps,correction:$('#correction').checked,confirmed:$('#confirmed')?.checked || false,inferred:edit?.inferred || false,source:edit?.source || 'MANUAL',raw:edit?.raw || ''});
  }
  async function saveEntries(entries,expected=null){
    const valid=entries.map(E.validate);
    if(cloud){if(!navigator.onLine)throw Error('Offline. Save a local draft and reconnect before saving to cloud.');const d=await api('/api/entries','POST',{entries:valid,vehicle,expected});d.forEach(x=>revisions[x.id]=x.revision);}
    valid.forEach(e=>{const i=rows.findIndex(x=>x.id===e.id);if(i<0)rows.push(e);else rows[i]=e;});persist();
  }
  function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  function exportCSV(){const fields=['id','date','station','price','odo','amount','receipt','level','fuel','precision','timestamp','inferred','confirmed','correction','notes','source','raw','gps'];const cell=x=>'"'+String(x==null?'':x).replace(/"/g,'""')+'"';download('fueltrack-'+today()+'.csv','\uFEFF'+[fields.join(','),...rows.map(e=>fields.map(f=>cell(f==='gps'&&e.gps?JSON.stringify(e.gps):e[f])).join(','))].join('\r\n'),'text/csv;charset=utf-8');}
  function showDetail(id){const e=rows.find(x=>x.id===id);if(!e)return;const calc=E.valid(e.amount)&&E.valid(e.price)?E.D(e.amount).div(e.price):null;$('#dialog-body').innerHTML=`<div class="between"><h2>${esc(e.station || 'Unnamed station')}</h2><button data-action="close">Close</button></div>${badge(e)}<p>${esc(dateName(e))}</p><div class="details">Amount paid: ${money(e.amount)}<br>Price: ${money(e.price)} / L<br>Liters: ${fmt(E.liters(e),3)} · ${e.receipt?'receipt':E.liters(e)?'calculated':'unknown'}${e.receipt&&calc&&E.D(e.receipt).sub(calc).abs().gt(prefs.threshold)?'<br><strong>Receipt discrepancy: calculated '+fmt(calc,3)+' L</strong>':''}<br>Odometer: ${fmt(e.odo,0)} km<br>Tank: ${esc(e.level)} · ${esc(e.fuel)}<br>Notes: ${esc(e.notes || '—')}<br>Source: ${esc(e.source || 'manual')}<br>Original text: ${esc(e.raw || '—')}${e.gps?`<br>GPS: ${esc(e.gps.lat)}, ${esc(e.gps.lon)}, ±${fmt(e.gps.accuracy,0)} m<br>Captured: ${esc(e.gps.at)}<br><a href="https://www.google.com/maps?q=${e.gps.lat},${e.gps.lon}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>`:''}</div><div class="actions"><button class="primary" data-edit="${e.id}">Edit record</button><button class="danger" data-delete="${e.id}">Delete record</button></div>`;$('#dialog').showModal();}
  function importReview(text,name){let imported, restorePrefs=null;
    if(name.toLowerCase().endsWith('.json')){const b=JSON.parse(text);imported=Array.isArray(b)?b:b.entries;restorePrefs=b.preferences?E.preferences(b.preferences):null;if(!Array.isArray(imported))throw Error('Backup must contain an entries array.');}
    else{const csv=E.parseCSV(text),head=csv.shift();if(!head?.includes('date'))throw Error('CSV requires a date column.');imported=csv.map((line,index)=>{let x=Object.fromEntries(head.map((h,i)=>[h,line[i] || '']));return {...x,id:x.id || crypto.randomUUID(),price:x.price || x.price_php_per_liter || null,odo:x.odo || x.odometer_km || null,amount:x.amount || x.amount_php || null,receipt:x.receipt || x.explicit_liters || null,level:x.level || 'unknown',fuel:x.fuel || 'Gasoline',precision:x.precision || 'date_only',timestamp:x.timestamp || null,inferred:x.inferred==='true'||(x.import_status||'').startsWith('INFERRED'),confirmed:x.confirmed==='true',correction:x.correction==='true',gps:x.gps?JSON.parse(x.gps):null,source:x.source || x.import_status || 'CSV_IMPORT',raw:x.raw || JSON.stringify(Object.fromEntries(head.map((h,i)=>[h,line[i] || ''])))};});}
    if(imported.length>2000)throw Error('Import up to 2,000 records at a time.');
    const seen=new Set(rows.map(E.fingerprint)),ids=new Set(rows.map(e=>e.id)),valid=[];let skipped=0;
    imported.forEach((raw,i)=>{let e;try{e=E.validate(raw);}catch(err){throw Error('Import row '+(i+1)+': '+err.message);}const fp=E.fingerprint(e);if(seen.has(fp)||ids.has(e.id)){skipped++;return;}seen.add(fp);ids.add(e.id);valid.push(e);});
    pendingImport={entries:valid,preferences:restorePrefs};$('#dialog-body').innerHTML=`<h2>Review import</h2><p>${valid.length} new records · ${skipped} duplicates or existing IDs skipped.</p><p>${valid.filter(E.provisional).length} provisional · ${valid.filter(e=>!E.complete(e)).length} incomplete.</p><p>${restorePrefs?'Backup preferences will also be restored.':''} Current records will be retained. Existing IDs are never overwritten.</p>${table(valid.slice(0,5))}<div class="actions"><button class="primary" data-action="confirm-import">Import ${valid.length} records</button><button data-action="close">Cancel</button></div>`;$('#dialog').showModal();}
  document.addEventListener('submit',async ev=>{ev.preventDefault();if(busy)return;busy=true;const submit=ev.submitter;if(submit)submit.disabled=true;try{
    if(ev.target.id==='entry-form'){
      const e=collect();if(!E.complete(e)&&!$('#allow-incomplete').checked)throw Error('Provide amount and price/receipt liters, or explicitly allow an incomplete entry.');
      const duplicate=rows.find(x=>x.id!==e.id&&E.fingerprint(x)===E.fingerprint(e));if(duplicate)throw Error('A matching record already exists. Edit it from History.');
      const sorted=E.sort([...rows.filter(x=>x.id!==e.id),e]),i=sorted.findIndex(x=>x.id===e.id),prev=sorted[i-1],next=sorted[i+1];
      if(!e.correction && E.valid(e.odo)&&((prev&&E.valid(prev.odo)&&E.D(e.odo).lt(prev.odo))||(next&&!next.correction&&E.valid(next.odo)&&E.D(e.odo).gt(next.odo))))throw Error('Odometer conflicts with an adjacent record. Correct it, or document an odometer correction.');
      await saveEntries([e],edit?revisions[edit.id]:null);localStorage.removeItem('fueltrack-draft');edit=null;navigate('history');toast(cloud?'Saved to Supabase.':'Saved in this browser.');
    }else if(ev.target.id==='prefs-form'){const f=Object.fromEntries(new FormData(ev.target));const p=E.preferences({...f,excluded:f.excluded.split(',').map(x=>x.trim()).filter(Boolean)});if(cloud)await api('/api/preferences','POST',p);prefs=p;persist();render();toast('Preferences saved.');
    }else if(ev.target.id==='auth-form'){const f=Object.fromEntries(new FormData(ev.target));const s=await api('/api/auth/'+(submit.value==='signup'?'signup':'login'),'POST',f);if(!s.access_token){toast('Check your email to confirm your account, then sign in.');return;}session=s;localStorage.setItem('fueltrack-session',JSON.stringify(s));await loadCloud();render();toast('Connected. Use Import original records to populate your account.');}
  }catch(err){toast(err.message,true);}finally{busy=false;if(submit?.isConnected)submit.disabled=false;}});
  document.addEventListener('input',ev=>{if(['price','amount','receipt'].includes(ev.target.id))updateLiters();if(ev.target.id==='search'){filter=ev.target.value;const start=ev.target.selectionStart;render();$('#search').focus();$('#search').setSelectionRange(start,start);}});
  document.addEventListener('change',ev=>{const id=ev.target.id,v=ev.target.value;
    if(id==='period'){period=v;render();}if(id==='year'){year=v;render();}if(id==='custom-from'){customFrom=v;render();}if(id==='custom-to'){customTo=v;render();}if(id==='provisional-toggle'){include=ev.target.checked;render();}
    if(id==='history-month'){historyMonth=v;render();}if(id==='level-filter'){levelFilter=v;render();}if(id==='quality-filter'){qualityFilter=v;render();}if(id==='manual-time')$('#time-fields').classList.toggle('hidden',!ev.target.checked);
    if(id==='precision'){const input=$('#fill-date');input.type=v==='date_only'?'date':'datetime-local';input.value=v==='date_only'?today():localTime(new Date());}
  });
  document.addEventListener('click',async ev=>{const b=ev.target.closest('button');if(!b||b.type==='submit'&&b.closest('form')&&!b.dataset.action&&!b.dataset.page)return;const a=b.dataset.action;
    if(b.dataset.page){if(b.dataset.page==='gas')edit=null;navigate(b.dataset.page);return;}if(b.dataset.month){historyMonth=b.dataset.month;navigate('history');return;}if(b.dataset.detail){showDetail(b.dataset.detail);return;}
    if(b.dataset.edit){edit=rows.find(x=>x.id===b.dataset.edit);$('#dialog').close();navigate('gas');return;}
    if(busy)return;
    try{
      if(b.dataset.delete){if(!confirm('Delete this refueling record? This cannot be undone.'))return;busy=true;if(cloud)await api('/api/entries/'+b.dataset.delete+'?revision='+revisions[b.dataset.delete],'DELETE');rows=rows.filter(x=>x.id!==b.dataset.delete);persist();$('#dialog').close();render();toast('Record deleted.');}
      if(a==='new'){edit=null;navigate('gas');}if(a==='cancel'){edit=null;navigate('dashboard');}
      if(a==='close')$('#dialog').close();if(a==='csv')exportCSV();if(a==='clear-filters'){filter='';historyMonth='';qualityFilter='';levelFilter='';render();}
      if(a==='backup')download('fueltrack-backup-'+today()+'.json',JSON.stringify({version:1,exported_at:new Date().toISOString(),entries:rows,preferences:prefs},null,2),'application/json');
      if(a==='import')$('#file').click();
      if(a==='seed')importReview(JSON.stringify({entries:SEED}),'history.json');
      if(a==='confirm-import'){busy=true;const pending=pendingImport;if(!pending)throw Error('No import selected.');if(pending.entries.length)await saveEntries(pending.entries);if(pending.preferences){if(cloud)await api('/api/preferences','POST',pending.preferences);prefs=pending.preferences;persist();}pendingImport=null;$('#dialog').close();render();toast('Import saved.');}
      if(a==='draft'){const f=Object.fromEntries(new FormData($('#entry-form')));localStorage.setItem('fueltrack-draft',JSON.stringify({...edit,...f,gps,manual:$('#manual-time').checked,date:$('#fill-date').value.slice(0,10),timestamp:$('#precision').value==='exact'&&$('#fill-date').value?new Date($('#fill-date').value+':00+08:00').toISOString():null}));toast('Draft saved on this device. Cloud has not been changed.');}
      if(a==='discard-draft'){localStorage.removeItem('fueltrack-draft');toast('Local draft discarded.');}
      if(a==='gps'){if(!navigator.geolocation)throw Error('Geolocation is unavailable. You can still save without GPS.');b.disabled=true;$('#gps-info').textContent='Locating…';navigator.geolocation.getCurrentPosition(pos=>{gps={lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy,at:new Date(pos.timestamp).toISOString()};showGPS();b.disabled=false;},err=>{toast('Location unavailable: '+err.message,true);showGPS();b.disabled=false;},{enableHighAccuracy:true,timeout:20000,maximumAge:0});}
      if(a==='remove-gps'){gps=null;showGPS();}
      if(a==='logout'){session=null;cloud=false;revisions={};vehicle=null;localStorage.removeItem('fueltrack-session');rows=read('fueltrack-local',[]);prefs={...DEFAULTS,...read('fueltrack-prefs',{})};render();toast('Signed out.');}
      if(a==='sync'){busy=true;await loadCloud();render();toast('Cloud data refreshed.');}
      if(a==='delete-all'){if(!confirm('Permanently delete ALL '+rows.length+' records in '+(cloud?'your cloud account':'this browser')+'? Export a backup first.'))return;if(prompt('Type DELETE to continue')!=='DELETE')return;busy=true;if(cloud)await api('/api/entries','DELETE');rows=[];persist();render();toast('All records deleted.');}
    }catch(err){toast(err.message,true);}finally{busy=false;}
  });
  $('#file').addEventListener('change',async ev=>{try{const f=ev.target.files[0];if(!f)return;if(f.size>3e6)throw Error('Maximum import size is 3 MB.');importReview(await f.text(),f.name);}catch(err){toast(err.message,true);}finally{ev.target.value='';}});
  window.addEventListener('offline',()=>toast('Offline. Save a local draft before leaving an unfinished form.'));
  window.addEventListener('online',()=>toast('Online. Drafts sync only when you explicitly save.'));
  render();
  fetch('/api/config').then(r=>r.json()).then(async c=>{configured=c.configured;if(session){try{await loadCloud();}catch(err){toast(err.message,true);page='settings';}}render();}).catch(()=>{});
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
}

// Runtime-generated assets: no extra maintained source files.
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0e2b47"><meta name="description" content="FuelTrack personal fuel monitor: refueling, purchased liters and verified fuel economy."><meta name="apple-mobile-web-app-capable" content="yes"><title>FuelTrack · Personal Fuel Monitor</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="stylesheet" href="/style.css"></head><body><aside><div class="brand"><span class="brand-icon">F</span>FuelTrack</div><div class="brand-sub">PERSONAL FUEL MONITOR</div><nav aria-label="Main navigation"><button data-page="dashboard">Dashboard</button><button data-page="gas">+ Gas Up</button><button data-page="history">History</button><button data-page="analytics">Analytics</button><button data-page="settings">Settings</button></nav><footer>KNOW YOUR JOURNEY.<br>Every liter. Every kilometer.<br><span>Philippines · ₱ / L</span></footer></aside><main><div class="mobile-brand"><div><b class="brand-icon">F</b> FuelTrack</div><span>Personal Fuel Monitor</span></div><div id="content"><p>Loading FuelTrack…</p></div><noscript>Enable JavaScript to use FuelTrack.</noscript></main><dialog id="dialog"><div id="dialog-body"></div></dialog><input id="file" type="file" accept=".csv,.json" hidden><div id="toast" role="status" aria-live="polite" hidden></div><script src="/app.js" defer></script></body></html>`;
const MANIFEST = JSON.stringify({id:'/',name:'FuelTrack — Personal Fuel Monitor',short_name:'FuelTrack',start_url:'/',scope:'/',display:'standalone',background_color:'#f6f8fb',theme_color:'#0e2b47',description:'Personal fuel purchase and consumption monitor',icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]});
const VERSION = crypto.createHash('sha256').update(HTML+CSS+client.toString()+engine.toString()+SOURCE).digest('hex').slice(0,12);
const SW = `const CACHE='fueltrack-${VERSION}';const SHELL=['/','/app.js','/style.css','/manifest.webmanifest','/icon-192.png','/icon-512.png'];self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting()});self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('fueltrack-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!SHELL.includes(u.pathname))return;e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r}).catch(()=>caches.match(e.request)))});`;
function icon(size){const png=new PNG({width:size,height:size});for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;const f=(x>size*.3&&x<size*.4&&y>size*.25&&y<size*.75)||(x>size*.3&&x<size*.7&&y>size*.25&&y<size*.35)||(x>size*.3&&x<size*.63&&y>size*.45&&y<size*.55);png.data[i]=f?16:14;png.data[i+1]=f?185:43;png.data[i+2]=f?129:71;png.data[i+3]=255;}return PNG.sync.write(png);}
async function bundle(){const r=await esbuild.build({stdin:{contents:`import Decimal from 'decimal.js'; Decimal.set({precision:32,rounding:Decimal.ROUND_HALF_UP}); (${client.toString()})(${JSON.stringify(SEED)},${JSON.stringify(DEFAULTS)},${engine.toString()},Decimal);`,resolveDir:__dirname,sourcefile:'fueltrack-client.js'},bundle:true,write:false,minify:true,target:['es2022'],platform:'browser',legalComments:'none'});return r.outputFiles[0].contents;}

// API: authenticated Supabase REST calls always use the user's token and RLS.
class ApiError extends Error {constructor(message,status=400){super(message);this.status=status;}}
async function supa(path,token,method='GET',body,prefer='return=representation'){
  const r=await fetch(CONFIG.url+path,{method,headers:{apikey:CONFIG.key,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',Prefer:prefer},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const text=await r.text();let d;try{d=text?JSON.parse(text):null;}catch{throw new ApiError('Cloud service returned an invalid response.',502);}
  if(!r.ok)throw new ApiError(d?.msg || d?.message || d?.error_description || 'Cloud request failed. Check database setup and account permissions.',r.status===401?401:400);return d;
}
async function body(req){let data='',size=0;for await(const chunk of req){size+=chunk.length;if(size>3e6)throw new ApiError('Request too large.',413);data+=chunk;}try{return JSON.parse(data || '{}');}catch{throw new ApiError('Invalid JSON.');}}
const limits = new Map();
function rate(req){const ip=req.socket.remoteAddress;const now=Date.now();let x=limits.get(ip);if(!x||now-x.time>60000){x={time:now,n:0};limits.set(ip,x);}if(++x.n>30)throw new ApiError('Too many authentication attempts. Try again in a minute.',429);if(limits.size>10000)for(const [k,v]of limits)if(now-v.time>60000)limits.delete(k);}
async function handleApi(req,url){
  const path=url.pathname;
  if(path==='/api/config'&&req.method==='GET')return {configured:!!(CONFIG.url&&CONFIG.key)};
  if(!CONFIG.url||!CONFIG.key)throw new ApiError('Cloud is not configured. See Settings for setup.',503);
  if(path.startsWith('/api/auth/')&&req.method==='POST'){
    rate(req);const b=await body(req);const action=path.split('/').pop();
    if(action==='refresh'){if(typeof b.refresh_token!=='string'||b.refresh_token.length>5000)throw new ApiError('Invalid refresh token.');return supa('/auth/v1/token?grant_type=refresh_token',null,'POST',{refresh_token:b.refresh_token});}
    if(!['signup','login'].includes(action)||typeof b.email!=='string'||!/^\S+@\S+\.\S+$/.test(b.email)||typeof b.password!=='string'||b.password.length<8||b.password.length>200)throw new ApiError('Enter a valid email and a password of at least 8 characters.');
    return supa(action==='signup'?'/auth/v1/signup':'/auth/v1/token?grant_type=password',null,'POST',{email:b.email,password:b.password});
  }
  const token=(req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];if(!token)throw new ApiError('Sign in required.',401);
  const user=await supa('/auth/v1/user',token);if(!user?.id)throw new ApiError('Invalid session.',401);
  if(path==='/api/data'&&req.method==='GET'){
    let vehicles=await supa('/rest/v1/vehicles?select=id&order=created_at.asc&limit=1',token);
    if(!vehicles.length)vehicles=await supa('/rest/v1/vehicles',token,'POST',{user_id:user.id,nickname:'My vehicle'});
    const entries=[];for(let offset=0;;){const chunk=await supa('/rest/v1/fuel_entries?select=id,payload,revision&vehicle_id=eq.'+vehicles[0].id+'&order=id&limit=500&offset='+offset,token);if(!chunk.length)break;entries.push(...chunk);offset+=chunk.length;}
    const p=await supa('/rest/v1/user_preferences?select=payload',token);return {vehicle:vehicles[0].id,entries,preferences:p[0]?.payload || DEFAULTS};
  }
  if(path==='/api/preferences'&&req.method==='POST'){const p=E.preferences(await body(req));await supa('/rest/v1/user_preferences?on_conflict=user_id',token,'POST',{user_id:user.id,payload:p},'resolution=merge-duplicates,return=representation');return {ok:true};}
  if(path==='/api/entries'&&req.method==='POST'){
    const b=await body(req);if(!Array.isArray(b.entries)||b.entries.length<1||b.entries.length>2000)throw new ApiError('Save 1–2,000 entries at a time.');
    if(!/^[a-f0-9-]{36}$/i.test(b.vehicle || ''))throw new ApiError('Invalid vehicle.');
    const entries=b.entries.map(E.validate);
    if(entries.length===1&&b.expected!=null){
      if(!Number.isInteger(b.expected)||b.expected<1)throw new ApiError('Invalid revision.');
      const changed=await supa('/rest/v1/fuel_entries?id=eq.'+entries[0].id+'&revision=eq.'+b.expected,token,'PATCH',{payload:entries[0]});if(!changed.length)throw new ApiError('Record changed or was deleted on another device. Refresh cloud data before editing.',409);return changed.map(x=>({id:x.id,revision:x.revision}));
    }
    // Insert only; imports never overwrite an existing ID, even from a stale backup.
    const result=await supa('/rest/v1/fuel_entries',token,'POST',entries.map(payload=>({id:payload.id,user_id:user.id,vehicle_id:b.vehicle,payload})));
    return result.map(x=>({id:x.id,revision:x.revision}));
  }
  if(path==='/api/entries'&&req.method==='DELETE'){await supa('/rest/v1/fuel_entries?user_id=eq.'+user.id,token,'DELETE');return {ok:true};}
  if(path.startsWith('/api/entries/')&&req.method==='DELETE'){
    const id=path.split('/').pop(),rev=url.searchParams.get('revision');if(!/^[a-f0-9-]{36}$/i.test(id)||!/^\d+$/.test(rev || ''))throw new ApiError('Invalid record/revision.');
    const deleted=await supa('/rest/v1/fuel_entries?id=eq.'+id+'&revision=eq.'+rev,token,'DELETE');if(!deleted.length)throw new ApiError('Record changed. Refresh cloud data before deleting.',409);return {ok:true};
  }
  throw new ApiError('Not found.',404);
}
async function serve(){
  const assets=new Map([['/',[HTML,'text/html; charset=utf-8']],['/app.js',[await bundle(),'text/javascript; charset=utf-8']],['/style.css',[CSS,'text/css; charset=utf-8']],['/manifest.webmanifest',[MANIFEST,'application/manifest+json']],['/sw.js',[SW,'text/javascript; charset=utf-8']],['/icon-192.png',[icon(192),'image/png']],['/icon-512.png',[icon(512),'image/png']],['/setup.sql',[SCHEMA,'text/plain; charset=utf-8']]]);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','geolocation=(self)');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"ok":true}');}
      if(url.pathname.startsWith('/api/')){
        res.setHeader('Cache-Control','no-store');
        // JSON and bearer auth prevent cross-origin form writes; no CORS is enabled.
        if(['POST','PATCH','DELETE'].includes(req.method)&&req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host)throw new ApiError('Origin not allowed.',403);}
        const result=await handleApi(req,url);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));return;
      }
      if(!['GET','HEAD'].includes(req.method))throw new ApiError('Method not allowed.',405);
      const asset=assets.get(url.pathname);if(!asset)throw new ApiError('Not found.',404);
      res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache',...(url.pathname==='/sw.js'?{'Service-Worker-Allowed':'/'}:{})});res.end(req.method==='HEAD'?undefined:asset[0]);
    }catch(err){res.writeHead(err.status || 400,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:err.message || 'Request failed.'}));}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.listen(CONFIG.port,'0.0.0.0',()=>console.log('FuelTrack running on http://localhost:'+CONFIG.port+' | cloud '+(CONFIG.url&&CONFIG.key?'configured':'not configured (browser mode)')));
}

// Meaningful calculation and data-integrity checks; no separate test source needed.
async function tests(){
  const assert=require('node:assert/strict');let count=0;const test=(name,f)=>{f();count++;console.log('PASS '+name);};
  test('Exact cents and provisional January',()=>{const r=E.report(SEED,DEFAULTS);assert.equal(r.months[0].amount.toFixed(2),'9068.76');assert.equal(E.report(SEED,DEFAULTS,false).months[0].amount.toFixed(2),'6865.09');assert.equal(r.months[0].provisional.toFixed(2),'2203.67');});
  test('All 42 source records preserve date-only precision and unknown GPS/tank',()=>{assert.equal(SEED.length,42);SEED.forEach(e=>{E.validate(e);assert.equal(e.timestamp,null);assert.equal(e.precision,'date_only');assert.equal(e.level,'unknown');assert.equal(e.gps,null);assert.ok(e.raw);});});
  test('Minimum-four rule and November exclusion',()=>{const r=E.report(SEED,DEFAULTS);assert.deepEqual(r.months.filter(m=>m.eligible).map(m=>m.key),['2026-01','2026-03','2026-05','2026-07','2026-08','2026-10']);assert.deepEqual(r.strict.map(m=>m.key),['2026-05','2026-07','2026-08']);assert.equal(r.average.toFixed(2),'152.88');});
  test('Missing amounts stay unknown; no historical verified km/L',()=>{assert.equal(E.liters(SEED.find(e=>e.date==='2026-04-17')),null);assert.equal(E.report(SEED,DEFAULTS).intervals.length,0);assert.equal(E.report(SEED,DEFAULTS).months.find(m=>m.key==='2026-10').missingAmount,1);});
  const entry=(i,odo,lit,level='full')=>({...SEED[1],id:crypto.randomUUID(),date:'2026-12-'+String(i).padStart(2,'0'),odo:String(odo),receipt:String(lit),amount:'1000',price:'50',level,inferred:false});
  test('Full tank intervals include partial liters and weighted economy',()=>{const list=[entry(1,1000,50),entry(2,1100,10,'partial'),entry(3,1400,30),entry(4,1700,15)];const intervals=E.report(list,DEFAULTS).intervals;assert.equal(intervals.length,2);assert.equal(intervals[0].liters.toString(),'40');assert.equal(intervals[0].km.div(intervals[0].liters).toString(),'10');assert.equal(intervals.reduce((s,x)=>s.add(x.km),E.D(0)).div(intervals.reduce((s,x)=>s.add(x.liters),E.D(0))).toFixed(4),'12.7273');});
  test('Missing intermediate liters, unknown fill, negative odo or correction blocks verification',()=>{for(const changes of [{receipt:null,price:null},{level:'unknown'},{odo:'900'},{correction:true,notes:'rollover'}]){const list=[entry(1,1000,50),{...entry(2,1100,10,'partial'),...changes},entry(3,1400,30)];assert.equal(E.report(list,DEFAULTS).intervals.length,0);}});
  test('Receipt liters override amount/price and remain exact',()=>{assert.equal(E.liters(SEED[8]).toString(),'27.71');assert.equal(E.liters({amount:'0.30',price:'0.10'}).toString(),'3');});
  test('CSV supports quoted commas, Unicode, quotes and newlines',()=>{assert.deepEqual(E.parseCSV('\uFEFFdate,notes\r\n2026-01-01,"₱, a ""quote""\nline"'),[['date','notes'],['2026-01-01','₱, a "quote"\nline']]);assert.throws(()=>E.parseCSV('"oops'));});
  test('Validation rejects invalid money, dates, GPS and mismatched timestamp',()=>{assert.throws(()=>E.validate({...SEED[1],amount:'-1'}));assert.throws(()=>E.validate({...SEED[1],date:'2026-02-31'}));assert.throws(()=>E.validate({...SEED[1],gps:{lat:95,lon:0,accuracy:1,at:new Date().toISOString()}}));assert.throws(()=>E.validate({...SEED[1],precision:'exact',timestamp:'2026-01-14T00:00:00Z'}));});
  test('RLS migration includes all owner tables and cross-owner vehicle protection',()=>{for(const t of ['vehicles','fuel_entries','user_preferences','import_batches'])assert.ok(SCHEMA.includes('alter table public.'+t+' enable row level security'));assert.ok(SCHEMA.includes('foreign key(vehicle_id,user_id)'));assert.ok(SCHEMA.includes('with check (user_id=auth.uid())'));});
  const r=E.report(SEED,DEFAULTS);console.log('Recorded total: PHP '+r.months.reduce((s,m)=>s.add(m.amount),E.D(0)).toFixed(2)+' (includes provisional amount; missing amounts excluded).');console.log('Strict baseline: '+r.strict.map(m=>m.key+' '+m.liters.toFixed(4)+' L').join(', '));console.log(count+' test groups passed. Live Supabase RLS requires a configured project.');
}
if(require.main===module){(async()=>{if(process.argv.includes('--schema')){console.log(SCHEMA);return;}if(process.argv.includes('--test')){await tests();return;}if(process.argv.includes('--build')){const js=await bundle();icon(192);icon(512);SEED.forEach(E.validate);console.log('Production build verified: '+js.length+' byte browser bundle; manifest, icons and app shell generated in memory.');return;}await serve();})().catch(err=>{console.error(err);process.exitCode=1;});}
module.exports={engine,SEED,DEFAULTS,SCHEMA};
