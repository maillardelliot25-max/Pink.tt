'use strict';
const express=require('express'),http=require('http'),WebSocket=require('ws'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{v4:uuidv4}=require('uuid'),path=require('path'),os=require('os'),rateLimit=require('express-rate-limit'),nodemailer=require('nodemailer');
const PORT=process.env.PORT||3000;
const JWT_SECRET=process.env.JWT_SECRET||'pinktt_2025_secure';
if(!process.env.JWT_SECRET)console.warn('⚠️  JWT_SECRET not set — using an insecure default. Set JWT_SECRET in production.');
if(!process.env.ANTHROPIC_API_KEY&&!process.env.GEMINI_API_KEY)console.warn('⚠️  No ID verification key set (ANTHROPIC_API_KEY or GEMINI_API_KEY) — ID verification will run in DEMO MODE (auto-approves).');
const TWILIO_READY=!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_FROM_NUMBER);
if(!TWILIO_READY)console.warn('⚠️  Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER) — SOS will log to the database and notify the admin panel only, no real call/SMS will be sent.');
const SHOW_DEMO_ACCOUNTS=process.env.SHOW_DEMO_ACCOUNTS==='true'||(process.env.NODE_ENV!=='production'&&process.env.SHOW_DEMO_ACCOUNTS!=='false');

// ── Admin email notifications (new signups, etc.) via Gmail SMTP ──────────────
// Uses a free Gmail "App Password" (console.google.com -> Security -> App Passwords,
// needs 2-Step Verification on) rather than a paid transactional email service.
const ADMIN_EMAIL=process.env.ADMIN_NOTIFICATION_EMAIL||'Maillardelliot25@gmail.com';
const EMAIL_READY=!!(process.env.GMAIL_USER&&process.env.GMAIL_APP_PASSWORD);
if(!EMAIL_READY)console.warn('⚠️  Email not configured (GMAIL_USER/GMAIL_APP_PASSWORD) — admin notifications will show in the dashboard only, no email will be sent.');
const mailer=EMAIL_READY?nodemailer.createTransport({service:'gmail',auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD}}):null;
async function sendAdminEmail(subject,text){
  if(!mailer)return{sent:false,reason:'not_configured'};
  try{
    await mailer.sendMail({from:`Pink.TT <${process.env.GMAIL_USER}>`,to:ADMIN_EMAIL,subject,text});
    return{sent:true};
  }catch(e){console.error('Admin email error',e.message);return{sent:false,reason:'send_error'};}
}

// Admin SMS via TextBelt's free tier — no signup, no card, no key needed (uses the
// shared "textbelt" key). Real limitation: capped at 1 free SMS/day, shared across
// EVERY free-tier TextBelt user worldwide, so it's best-effort, not guaranteed —
// email above is the reliable channel. Set TEXTBELT_KEY (a paid key) later to remove
// that cap if this becomes a real bottleneck.
const ADMIN_PHONE=process.env.ADMIN_NOTIFICATION_PHONE||'+18683092601';
async function sendAdminSMS(text){
  try{
    const r=await fetch('https://textbelt.com/text',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phone:ADMIN_PHONE,message:text.slice(0,300),key:process.env.TEXTBELT_KEY||'textbelt'})
    });
    const data=await r.json();
    if(!data.success)console.warn('Admin SMS not sent (likely the free-tier daily cap):',data.error);
    return{sent:!!data.success};
  }catch(e){console.error('Admin SMS error',e.message);return{sent:false};}
}

// ── Database abstraction: Postgres (Supabase/any) > Turso cloud > local SQLite ─
let dbGet,dbAll,dbRun,dbInit;
const SCHEMA_SQL=[
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL COLLATE NOCASE,password_hash TEXT NOT NULL,first_name TEXT,last_name TEXT,phone TEXT DEFAULT'',role TEXT DEFAULT'rider',gender TEXT DEFAULT'female',is_verified INTEGER DEFAULT 0,is_active INTEGER DEFAULT 1,emergency_contact_name TEXT DEFAULT'',emergency_contact_phone TEXT DEFAULT'',wallet_balance REAL DEFAULT 0,total_rides INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS driver_profiles(id TEXT PRIMARY KEY,user_id TEXT UNIQUE,license_number TEXT DEFAULT'',license_photo TEXT DEFAULT'',vehicle_make TEXT DEFAULT'',vehicle_model TEXT DEFAULT'',vehicle_year TEXT DEFAULT'',vehicle_color TEXT DEFAULT'',vehicle_plate TEXT DEFAULT'',status TEXT DEFAULT'pending',is_online INTEGER DEFAULT 0,current_lat REAL DEFAULT 10.6549,current_lng REAL DEFAULT -61.5019,total_trips INTEGER DEFAULT 0,total_earnings REAL DEFAULT 0,balance REAL DEFAULT 0,today_earnings REAL DEFAULT 0,rating REAL DEFAULT 5.0,rating_count INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(user_id)REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS rides(id TEXT PRIMARY KEY,rider_id TEXT,driver_id TEXT,status TEXT DEFAULT'requested',pickup_address TEXT,pickup_lat REAL,pickup_lng REAL,destination_address TEXT,destination_lat REAL,destination_lng REAL,estimated_fare REAL,final_fare REAL,distance_km REAL,duration_minutes INTEGER,rider_rating INTEGER,requested_at TEXT DEFAULT(datetime('now')),accepted_at TEXT,started_at TEXT,completed_at TEXT,cancelled_at TEXT,created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,ride_id TEXT,rider_id TEXT,driver_id TEXT,amount REAL,platform_fee REAL,driver_earning REAL,status TEXT DEFAULT'pending',method TEXT DEFAULT'cash',created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sos_events(id TEXT PRIMARY KEY,user_id TEXT,ride_id TEXT,status TEXT DEFAULT'active',lat REAL,lng REAL,message TEXT DEFAULT'',created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT,type TEXT DEFAULT'info',message TEXT,is_read INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT DEFAULT'',updated_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,admin_id TEXT,admin_email TEXT,action TEXT,target_type TEXT DEFAULT'',target_id TEXT DEFAULT'',details TEXT DEFAULT'',created_at TEXT DEFAULT(datetime('now')))`
];
// Public-safe settings keys: readable by any authenticated user via buildDB() (e.g.
// so a rider can see the real safety contact number). Anything more sensitive than
// a contact number/note should not go through this table.
const DEFAULT_SETTINGS={
  safety_team_phone:'',
  support_email:'support@pink.tt',
  support_phone:'',
  ttps_integration_note:'No formal dispatch integration with TTPS exists yet. SOS alerts the Pink.TT safety team directly; a human decides whether to contact police.'
};
// Additive migrations for DBs created before a column existed — safe to fail if already applied.
const MIGRATIONS_SQL=[
  `ALTER TABLE driver_profiles ADD COLUMN license_photo TEXT DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN pink_points INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN pink_points_lifetime INTEGER DEFAULT 0`,
  `ALTER TABLE rides ADD COLUMN points_redeemed INTEGER DEFAULT 0`,
  `ALTER TABLE rides ADD COLUMN points_discount REAL DEFAULT 0`,
  `ALTER TABLE rides ADD COLUMN points_earned INTEGER DEFAULT 0`,
  `ALTER TABLE driver_profiles ADD COLUMN license_expiry TEXT DEFAULT ''`
];
// Postgres-flavored schema: same tables, but datetime('now') and COLLATE NOCASE
// aren't valid Postgres syntax. Email case-insensitivity is handled at the app
// layer already (every query lowercases the email first), so COLLATE NOCASE is
// simply dropped rather than replicated.
const SCHEMA_SQL_PG=SCHEMA_SQL.map(s=>s.replace(/ COLLATE NOCASE/g,''));
const MIGRATIONS_SQL_PG=[
  `ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS license_photo TEXT DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pink_points INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pink_points_lifetime INTEGER DEFAULT 0`,
  `ALTER TABLE rides ADD COLUMN IF NOT EXISTS points_redeemed INTEGER DEFAULT 0`,
  `ALTER TABLE rides ADD COLUMN IF NOT EXISTS points_discount REAL DEFAULT 0`,
  `ALTER TABLE rides ADD COLUMN IF NOT EXISTS points_earned INTEGER DEFAULT 0`,
  `ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS license_expiry TEXT DEFAULT ''`
];
// Both SCHEMA_SQL and the app's query strings use SQLite syntax (`?` placeholders,
// datetime('now')); translate to Postgres syntax (`$1,$2,...`, now()) at the call
// site so the rest of the file stays backend-agnostic.
function pgify(sql){
  let i=0;
  return sql.replace(/datetime\('now'\)/g,'now()').replace(/\?/g,()=>'$'+(++i));
}

if(process.env.DATABASE_URL){
  const{Pool}=require('pg');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});
  dbGet=async(sql,args=[])=>{const r=await pool.query(pgify(sql),args);return r.rows[0]??null;};
  dbAll=async(sql,args=[])=>{const r=await pool.query(pgify(sql),args);return r.rows;};
  dbRun=async(sql,args=[])=>{await pool.query(pgify(sql),args);};
  dbInit=async()=>{
    for(const sql of SCHEMA_SQL_PG)await pool.query(pgify(sql));
    for(const sql of MIGRATIONS_SQL_PG){try{await pool.query(pgify(sql));}catch{}}
    console.log('✅ Connected to Postgres (DATABASE_URL)');
  };
}else if(process.env.TURSO_DATABASE_URL){
  const{createClient}=require('@libsql/client');
  const turso=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN||''});
  const toPlain=(rows,cols)=>rows.map(row=>{const o={};cols.forEach((c,i)=>{o[c]=row[i];});return o;});
  dbGet=async(sql,args=[])=>{const r=await turso.execute({sql,args});return r.rows.length?toPlain(r.rows,r.columns)[0]:null;};
  dbAll=async(sql,args=[])=>{const r=await turso.execute({sql,args});return toPlain(r.rows,r.columns);};
  dbRun=async(sql,args=[])=>{await turso.execute({sql,args});};
  dbInit=async()=>{
    await turso.batch(SCHEMA_SQL.map(sql=>({sql})),'write');
    for(const sql of MIGRATIONS_SQL){try{await turso.execute({sql,args:[]});}catch{}}
    console.log('✅ Connected to Turso cloud database');
  };
}else{
  const Database=require('better-sqlite3');
  const sqlite=new Database(path.join(__dirname,'pinktt.db'));
  sqlite.pragma('journal_mode = WAL');
  dbGet=async(sql,args=[])=>sqlite.prepare(sql).get(...args)??null;
  dbAll=async(sql,args=[])=>sqlite.prepare(sql).all(...args);
  dbRun=async(sql,args=[])=>{sqlite.prepare(sql).run(...args);};
  dbInit=async()=>{
    SCHEMA_SQL.forEach(s=>sqlite.exec(s));
    for(const sql of MIGRATIONS_SQL){try{sqlite.exec(sql);}catch{}}
    console.log('✅ Using local SQLite (no TURSO_DATABASE_URL or DATABASE_URL set)');
  };
}

// ── Business logic ────────────────────────────────────────────────────────────
const COORDS={'Port of Spain':[10.6549,-61.5019],'Independence Square':[10.653,-61.5105],"Queen's Park Savannah":[10.663,-61.5178],'Maraval':[10.672,-61.522],'Airport':[10.5954,-61.3372],'Piarco':[10.5954,-61.3372],'Chaguanas':[10.517,-61.4115],'San Fernando':[10.2796,-61.4688],'Arima':[10.637,-61.283],'Tunapuna':[10.637,-61.383],'Trincity':[10.604,-61.350],'Diego Martin':[10.69,-61.56],'Woodbrook':[10.652,-61.514],'St. Clair':[10.668,-61.523],'Curepe':[10.639,-61.408],'Barataria':[10.63,-61.43],'Point Fortin':[10.17,-61.685],'Princes Town':[10.27,-61.373]};
function getCoord(a){for(const k in COORDS){if(a&&a.toLowerCase().includes(k.toLowerCase()))return COORDS[k];}return[10.6549+(Math.random()-.5)*.05,-61.5019+(Math.random()-.5)*.05];}
// Rough Trinidad & Tobago bounding box -- rejects garbage/out-of-range coords (e.g. a
// browser geolocation glitch or a spoofed value) rather than trusting client input blindly.
function isValidTTCoord(lat,lng){return typeof lat==='number'&&typeof lng==='number'&&lat>=9.5&&lat<=11.5&&lng>=-62&&lng<=-60;}

// Real geocoding (free, no API key) via OpenStreetMap's Nominatim, for typed addresses
// that don't match one of the ~18 hardcoded neighborhood names in COORDS -- without
// this, an address like "81 Sunset Drive" fell back to a random point that could land
// anywhere nearby, including in the ocean, and the resulting "distance" (and therefore
// fare) was meaningless. Cached per address for the process lifetime since Nominatim's
// usage policy asks for at most ~1 request/sec and addresses repeat often (quick
// destinations, common streets).
const _geocodeCache=new Map();
async function geocodeAddress(address){
  if(!address)return null;
  const key=address.trim().toLowerCase();
  if(_geocodeCache.has(key))return _geocodeCache.get(key);
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),4000);
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tt&q=${encodeURIComponent(address+', Trinidad and Tobago')}`;
    const apiRes=await fetch(url,{headers:{'User-Agent':'PinkTT-Rideshare/1.0 (support@pink.tt)'},signal:controller.signal});
    clearTimeout(timer);
    if(!apiRes.ok){_geocodeCache.set(key,null);return null;}
    const results=await apiRes.json();
    if(!results.length){_geocodeCache.set(key,null);return null;}
    const coord=[parseFloat(results[0].lat),parseFloat(results[0].lon)];
    if(!isValidTTCoord(coord[0],coord[1])){_geocodeCache.set(key,null);return null;}
    _geocodeCache.set(key,coord);
    return coord;
  }catch(e){console.error('Geocoding error',e.message);_geocodeCache.set(key,null);return null;}
}
// Resolves an address to a coordinate: known neighborhood name (instant) -> real
// geocoding (Nominatim) -> last-resort nearby-jitter placeholder, flagged as approximate
// so callers/UI can be honest about it rather than presenting it as an exact match.
async function resolveCoord(address){
  for(const k in COORDS){if(address&&address.toLowerCase().includes(k.toLowerCase()))return{coord:COORDS[k],approx:false};}
  const geo=await geocodeAddress(address);
  if(geo)return{coord:geo,approx:false};
  return{coord:[10.6549+(Math.random()-.5)*.02,-61.5019+(Math.random()-.5)*.02],approx:true};
}
// Matches TTRS's publicly reported "Regular" tier rates (Dec 2022 fare increase --
// the most recent public numbers found; TTRS may have adjusted since, worth
// re-confirming against their current in-app rates): $28 minimum, $1.75/km up to
// 20km then $3.00/km beyond, $1.10/min flat regardless of distance. No surge/peak
// multiplier -- TTRS's public rate sheet doesn't document one, so none is applied
// here rather than guessing at an amount.
function calcFare(km,min){
  const perKm=km<=20?km*1.75:20*1.75+(km-20)*3.00;
  const raw=perKm+min*1.10;
  return Math.round(Math.max(28,raw)*100)/100;
}

// ── Bullet Pink Points loyalty program ─────────────────────────────────────────
// Points are earned on what the rider ACTUALLY pays (after any points discount),
// not the pre-discount fare -- earning points on a discount funded by other points
// would let a balance regenerate itself indefinitely. Redemption is capped at 50%
// of the fare so a ride can never be reduced to $0 via points alone.
// Driver payout is calculated from the FULL pre-discount fare (see the ride_status
// 'completed' handler) -- the points discount comes out of the platform's margin,
// never the driver's earnings, matching the "without diminishing driver payouts"
// requirement directly.
const PINK_POINTS_EARN_RATE=1; // 1 point per TTD $1 actually paid, before tier multiplier
const PINK_POINTS_REDEEM_RATE=20; // 20 points = TTD $1 off
const PINK_POINTS_MAX_REDEEM_PCT=0.5; // can't discount more than half the fare
function pinkPointsTier(lifetimePoints){
  if(lifetimePoints>=2000)return{name:'Gold',multiplier:1.5};
  if(lifetimePoints>=500)return{name:'Silver',multiplier:1.25};
  return{name:'Bronze',multiplier:1.0};
}
// Converts a requested point redemption into an actual (points,discount$) pair,
// clamped to what the rider actually has and the per-ride redemption cap.
function clampPointsRedemption(requestedPoints,availablePoints,fare){
  const maxByBalance=Math.max(0,Math.floor(availablePoints||0));
  const maxByFareCap=Math.floor(fare*PINK_POINTS_MAX_REDEEM_PCT*PINK_POINTS_REDEEM_RATE);
  const points=Math.max(0,Math.min(Math.floor(requestedPoints||0),maxByBalance,maxByFareCap));
  const discount=Math.round((points/PINK_POINTS_REDEEM_RATE)*100)/100;
  return{points,discount};
}
function dist(p,d){const R=6371,dLat=(d[0]-p[0])*Math.PI/180,dLon=(d[1]-p[1])*Math.PI/180,a=Math.sin(dLat/2)**2+Math.cos(p[0]*Math.PI/180)*Math.cos(d[0]*Math.PI/180)*Math.sin(dLon/2)**2;return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))*10)/10;}

// Address suggestions as the rider types (Nominatim search, up to 6 candidates) -- so
// pickup/destination aren't limited to the ~18 hardcoded neighborhood names or a single
// best-guess match. Free, no API key; same host/policy as geocodeAddress above.
async function suggestAddresses(query){
  if(!query||query.trim().length<3)return[];
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),4000);
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=tt&q=${encodeURIComponent(query)}`;
    const apiRes=await fetch(url,{headers:{'User-Agent':'PinkTT-Rideshare/1.0 (support@pink.tt)'},signal:controller.signal});
    clearTimeout(timer);
    if(!apiRes.ok)return[];
    const results=await apiRes.json();
    return results.filter(r=>isValidTTCoord(parseFloat(r.lat),parseFloat(r.lon)))
      .map(r=>({label:r.display_name,lat:parseFloat(r.lat),lng:parseFloat(r.lon)}));
  }catch(e){console.error('Address suggest error',e.message);return[];}
}

// Real driving route (actual roads, not a straight line) via OSRM's free public demo
// server -- no API key. Returns road distance/duration plus the route geometry so the
// same path can be drawn on the map for both rider and driver. Falls back to the
// haversine straight-line distance (already used elsewhere) if OSRM is unreachable,
// so a booking never fails outright over a routing-service hiccup.
async function getRoute(pickup,destination){
  try{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),5000);
    const url=`https://router.project-osrm.org/route/v1/driving/${pickup[1]},${pickup[0]};${destination[1]},${destination[0]}?overview=full&geometries=geojson`;
    const apiRes=await fetch(url,{signal:controller.signal});
    clearTimeout(timer);
    if(!apiRes.ok)throw new Error('OSRM HTTP '+apiRes.status);
    const data=await apiRes.json();
    const route=data.routes?.[0];
    if(!route)throw new Error('No route found');
    return{
      km:Math.round(route.distance/100)/10,
      min:Math.round(route.duration/60),
      geometry:route.geometry.coordinates.map(([lng,lat])=>[lat,lng]),
      real:true
    };
  }catch(e){
    console.warn('Route lookup failed, using straight-line estimate:',e.message);
    const km=dist(pickup,destination);
    return{km,min:Math.round(km*2.5+5),geometry:[pickup,destination],real:false};
  }
}

async function buildDB(){
  const users=(await dbAll('SELECT id,email,first_name,last_name,phone,role,gender,is_verified,is_active,emergency_contact_name,emergency_contact_phone,wallet_balance,total_rides,pink_points,pink_points_lifetime,created_at FROM users')).map(u=>({...u,is_verified:!!u.is_verified,is_active:!!u.is_active,pink_points:u.pink_points||0,pink_points_lifetime:u.pink_points_lifetime||0,pink_points_tier:pinkPointsTier(u.pink_points_lifetime||0).name}));
  const driver_profiles=(await dbAll('SELECT id,user_id,license_number,license_expiry,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,status,is_online,current_lat,current_lng,total_trips,total_earnings,balance,today_earnings,rating,rating_count,created_at FROM driver_profiles')).map(d=>({...d,is_online:!!d.is_online,approved_at:d.status==='approved'?d.created_at:null}));
  const rides=await dbAll('SELECT * FROM rides');
  const payments=await dbAll('SELECT * FROM payments');
  const sos_events=await dbAll('SELECT * FROM sos_events');
  const notifications=await dbAll('SELECT * FROM notifications');
  const promotions=[{id:'p1',code:'WELCOME25',title:'Welcome Discount',description:'25% off your first ride',type:'percentage',value:25,is_active:true,valid_until:'2026-12-31T00:00:00Z'},{id:'p2',code:'PINK10',title:'Pink Loyalty',description:'TTD $10 off any ride over $50',type:'fixed',value:10,is_active:true,valid_until:'2026-12-31T00:00:00Z'},{id:'p3',code:'SAFE20',title:'Safety Bonus',description:'20% off for referring a friend',type:'percentage',value:20,is_active:true,valid_until:'2026-12-31T00:00:00Z'}];
  const businesses=[{id:'b1',name:'Luxe Nail Lounge',category:'nail_salon',description:'Premium nail care & nail art',address:'Long Circular Road, St. James, POS',phone:'+1 868 222 1001',rating:4.9,rating_count:89,is_featured:true,is_active:true,discount:'Pink.TT Rider Special — 15% OFF',discount_code:'PINK15',lat:10.665,lng:-61.521},{id:'b2',name:'Serenity Spa & Wellness',category:'spa',description:'Full-service day spa & wellness',address:'Ariapita Avenue, Woodbrook, POS',phone:'+1 868 222 1003',rating:4.9,rating_count:223,is_featured:true,is_active:true,discount:'Weekday Special — 10% OFF',discount_code:'WEEKDAY10',lat:10.652,lng:-61.514},{id:'b3',name:'TT Skincare Clinic',category:'skincare',description:'Medical skincare & facial treatments',address:'Trincity Mall, Trincity',phone:'+1 868 222 1008',rating:4.9,rating_count:205,is_featured:true,is_active:true,discount:'New Client Package — 25% OFF',discount_code:'NEWCLIENT25',lat:10.604,lng:-61.350},{id:'b4',name:'The Curl Bar T&T',category:'hair',description:'Natural hair & protective styles',address:'Maraval Road, POS',phone:'+1 868 222 1002',rating:4.8,rating_count:134,is_featured:true,is_active:true,discount:'New Client Welcome — 20% OFF',discount_code:'NEWCURL20',lat:10.672,lng:-61.522}];
  const settingsRows=await dbAll('SELECT key,value FROM settings');
  const settings={...DEFAULT_SETTINGS};
  settingsRows.forEach(r=>{settings[r.key]=r.value;});
  return{users,driver_profiles,rides,payments,sos_events,notifications,promotions,businesses,business_services:[],business_discounts:[],reports:[],trip_shares:[],settings};
}

async function setSetting(key,value){
  const ex=await dbGet('SELECT key FROM settings WHERE key=?',[key]);
  if(ex)await dbRun("UPDATE settings SET value=?,updated_at=datetime('now') WHERE key=?",[value,key]);
  else await dbRun('INSERT INTO settings(key,value)VALUES(?,?)',[key,value]);
}

async function logAudit(admin,action,targetType,targetId,details){
  await dbRun('INSERT INTO audit_log(id,admin_id,admin_email,action,target_type,target_id,details)VALUES(?,?,?,?,?,?,?)',[uuidv4(),admin.id,admin.email,action,targetType||'',targetId||'',details||'']);
}

function escapeXml(s){return String(s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));}

// Automated safety-team call + SMS via Twilio. Never contacts real police/emergency
// services directly -- that requires a real TTPS integration this app doesn't have.
// A human on the Pink.TT safety team receives this and decides whether to call police.
async function triggerSafetyAlert(message){
  if(!TWILIO_READY)return{sent:false,reason:'twilio_not_configured'};
  const safetyPhone=await dbGet('SELECT value FROM settings WHERE key=?',['safety_team_phone']);
  const phone=safetyPhone?.value;
  if(!phone)return{sent:false,reason:'no_safety_phone_configured'};
  try{
    const auth=Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const base='https://api.twilio.com/2010-04-01/Accounts/'+process.env.TWILIO_ACCOUNT_SID;
    const twimlUrl=(process.env.PUBLIC_URL||'').replace(/\/$/,'')+'/api/twiml-sos?msg='+encodeURIComponent(message.slice(0,300));
    const callRes=await fetch(base+'/Calls.json',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:phone,From:process.env.TWILIO_FROM_NUMBER,Url:twimlUrl})});
    const smsRes=await fetch(base+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:phone,From:process.env.TWILIO_FROM_NUMBER,Body:message})});
    if(!callRes.ok&&!smsRes.ok){console.error('Twilio SOS alert failed: both call and SMS rejected');return{sent:false,reason:'twilio_rejected'};}
    return{sent:true};
  }catch(e){console.error('Twilio SOS alert error',e.message);return{sent:false,reason:'twilio_error'};}
}

// ── Express ───────────────────────────────────────────────────────────────────
const app=express();
app.use(express.json({limit:'5mb'}));
// index.html and sw.js must always be revalidated -- a stale cached copy of either on a
// real device would keep serving old app code indefinitely after a fix ships. Everything
// else in public/ (vendor assets, icons) can use normal caching.
app.use(express.static(path.join(__dirname,'public'),{
  setHeaders:(res,filePath)=>{
    if(filePath.endsWith('index.html')||filePath.endsWith('sw.js')){
      res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
    }
  }
}));
function authMW(req,res,next){const t=(req.headers.authorization||'').replace('Bearer ','').trim();if(!t)return res.status(401).json({error:'No token'});try{req.jwt=jwt.verify(t,JWT_SECRET);next();}catch{res.status(401).json({error:'Session expired — please log in again'});}}

// ── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false,message:{error:'Too many attempts — please try again in a few minutes'}});
const mutationLimiter=rateLimit({windowMs:60*1000,max:60,standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests — please slow down'}});
const verifyLimiter=rateLimit({windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false,message:{error:'Too many verification attempts — please try again later'}});

app.get('/api/config',(req,res)=>{res.json({showDemoAccounts:SHOW_DEMO_ACCOUNTS});});

// Notifies every active admin (dashboard notification + email) that a new account
// signed up. DB inserts are awaited so the notification is already there by the time
// broadcastDBUpdate() below pushes fresh state to connected admin sessions; the email
// itself is fire-and-forget (sendAdminEmail catches its own errors) so a slow/failed
// send never delays the registration response.
async function notifyAdminsOfSignup(user){
  const admins=await dbAll("SELECT id FROM users WHERE role='admin' AND is_active=1");
  const msg=`🆕 New ${user.role} signup: ${user.first_name} ${user.last_name} (${user.email})`;
  for(const a of admins){
    await dbRun('INSERT INTO notifications(id,user_id,type,message)VALUES(?,?,?,?)',[uuidv4(),a.id,'signup',msg]);
  }
  sendAdminEmail(
    `New Pink.TT ${user.role} signup — ${user.first_name} ${user.last_name}`,
    `A new ${user.role} just registered on Pink.TT.\n\nName: ${user.first_name} ${user.last_name}\nEmail: ${user.email}\nPhone: ${user.phone||'—'}\n\nReview in the admin dashboard${process.env.PUBLIC_URL?': '+process.env.PUBLIC_URL:''}.`
  );
  sendAdminSMS(msg);
}

app.post('/api/register',authLimiter,async(req,res)=>{
  const{first_name,last_name,email,password,phone,role,emergency_contact_name,emergency_contact_phone}=req.body;
  if(!first_name||!last_name||!email||!password)return res.status(400).json({error:'Missing required fields'});
  if(password.length<8)return res.status(400).json({error:'Password must be 8+ characters'});
  if(!['rider','driver'].includes(role))return res.status(400).json({error:'Invalid role'});
  if(await dbGet('SELECT id FROM users WHERE email=?',[email.toLowerCase()]))return res.status(400).json({error:'Email already registered'});
  const hash=bcrypt.hashSync(password,10),id=uuidv4();
  await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,phone,role,emergency_contact_name,emergency_contact_phone,is_active,is_verified)VALUES(?,?,?,?,?,?,?,?,?,1,0)',[id,email.toLowerCase(),hash,first_name,last_name,phone||'',role,emergency_contact_name||'',emergency_contact_phone||'']);
  const token=jwt.sign({id,role,email:email.toLowerCase()},JWT_SECRET,{expiresIn:'30d'});
  await notifyAdminsOfSignup({first_name,last_name,email:email.toLowerCase(),phone:phone||'',role});
  broadcastDBUpdate();
  res.json({ok:true,token,user_id:id});
});

// Per-account lockout (independent of the per-IP rate limiter above) — stops
// distributed brute-force against one specific account from many IPs.
const loginAttempts=new Map(); // email -> {count, lockedUntil}
const LOGIN_LOCKOUT_THRESHOLD=5,LOGIN_LOCKOUT_MS=15*60*1000;
app.post('/api/login',authLimiter,async(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password)return res.status(400).json({error:'Email and password required'});
  const key=email.toLowerCase();
  const attempt=loginAttempts.get(key);
  if(attempt?.lockedUntil&&attempt.lockedUntil>Date.now()){
    return res.status(429).json({error:`Too many failed attempts. Try again in ${Math.ceil((attempt.lockedUntil-Date.now())/60000)} minute(s).`});
  }
  const user=await dbGet('SELECT * FROM users WHERE email=?',[key]);
  if(!user||!bcrypt.compareSync(password,user.password_hash)){
    const next={count:(attempt?.count||0)+1,lockedUntil:null};
    if(next.count>=LOGIN_LOCKOUT_THRESHOLD)next.lockedUntil=Date.now()+LOGIN_LOCKOUT_MS;
    loginAttempts.set(key,next);
    return res.status(401).json({error:'Invalid email or password'});
  }
  loginAttempts.delete(key);
  if(!user.is_active)return res.status(403).json({error:'Account suspended. Contact support@pink.tt'});
  const token=jwt.sign({id:user.id,role:user.role,email:user.email},JWT_SECRET,{expiresIn:'30d'});
  res.json({ok:true,token,user_id:user.id});
});

app.get('/api/db',authMW,async(req,res)=>{
  const dbObj=await buildDB();
  const user=dbObj.users.find(u=>u.id===req.jwt.id)||null;
  res.json({db:dbObj,user});
});

app.post('/api/fare',async(req,res)=>{
  const{pickup,destination,pickup_lat,pickup_lng,destination_lat,destination_lng}=req.body;
  const p=isValidTTCoord(pickup_lat,pickup_lng)?[pickup_lat,pickup_lng]:(await resolveCoord(pickup)).coord;
  const dResolved=isValidTTCoord(destination_lat,destination_lng)?{coord:[destination_lat,destination_lng],approx:false}:(await resolveCoord(destination));
  const d=dResolved.coord;
  const route=await getRoute(p,d);
  const fare=calcFare(route.km,route.min);
  res.json({km:route.km,min:route.min,fare,pickup_lat:p[0],pickup_lng:p[1],dest_lat:d[0],dest_lng:d[1],destination_approx:dResolved.approx,route:route.geometry,routeIsReal:route.real});
});

// Address suggestions dropdown -- returns up to 6 candidate addresses as the rider types.
app.get('/api/geocode-suggest',async(req,res)=>{
  const results=await suggestAddresses(req.query.q||'');
  res.json({results});
});

// Route geometry for an existing ride's pickup/destination -- used to (re)draw the map
// (e.g. on page reload, or when a driver accepts and needs the same route the rider sees).
app.get('/api/route',async(req,res)=>{
  const{pickup_lat,pickup_lng,dest_lat,dest_lng}=req.query;
  const p=[parseFloat(pickup_lat),parseFloat(pickup_lng)],d=[parseFloat(dest_lat),parseFloat(dest_lng)];
  if(!isValidTTCoord(p[0],p[1])||!isValidTTCoord(d[0],d[1]))return res.status(400).json({error:'Invalid coordinates'});
  const route=await getRoute(p,d);
  res.json(route);
});

// ── ID verification (server-side, key never reaches the client) ──────────────
const ID_VERIFY_PROMPT='This photo was submitted for identity verification on a women-only rideshare platform. Respond with exactly one lowercase word and nothing else: "female", "male", or "unclear" — describing the apparent gender presentation of the person in the photo.';

// Returns the model's lowercase answer, or null if this provider couldn't be reached/failed
// (caller falls back to the next configured provider rather than failing the request outright).
async function classifyWithAnthropic(mediaType,base64Data){
  try{
    const apiRes=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({
        model:'claude-haiku-4-5-20251001',
        max_tokens:10,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:mediaType,data:base64Data}},
          {type:'text',text:ID_VERIFY_PROMPT}
        ]}]
      })
    });
    if(!apiRes.ok){console.error('Anthropic verify-id error',apiRes.status,await apiRes.text());return null;}
    const apiData=await apiRes.json();
    return(apiData.content?.[0]?.text||'').trim().toLowerCase();
  }catch(e){console.error('Anthropic verify-id error',e.message);return null;}
}

async function classifyWithGemini(mediaType,base64Data){
  const model=process.env.GEMINI_MODEL||'gemini-3.6-flash';
  try{
    const apiRes=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        contents:[{parts:[
          {inline_data:{mime_type:mediaType,data:base64Data}},
          {text:ID_VERIFY_PROMPT}
        ]}],
        generationConfig:{maxOutputTokens:10}
      })
    });
    if(!apiRes.ok){console.error('Gemini verify-id error',apiRes.status,await apiRes.text());return null;}
    const apiData=await apiRes.json();
    return(apiData.candidates?.[0]?.content?.parts?.[0]?.text||'').trim().toLowerCase();
  }catch(e){console.error('Gemini verify-id error',e.message);return null;}
}

app.post('/api/verify-id',verifyLimiter,authMW,async(req,res)=>{
  const{image}=req.body;
  if(!image||typeof image!=='string')return res.status(400).json({ok:false,error:'No photo provided'});
  const m=image.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if(!m)return res.status(400).json({ok:false,error:'Invalid image format — please upload a JPEG, PNG, or WebP photo'});
  const[,mediaType,base64Data]=m;

  if(!process.env.ANTHROPIC_API_KEY&&!process.env.GEMINI_API_KEY){
    console.warn(`⚠️  DEMO MODE: no verification key set — auto-approving ID verification for ${req.jwt.email}`);
    await dbRun('UPDATE users SET is_verified=1 WHERE id=?',[req.jwt.id]);
    broadcastDBUpdate();
    return res.json({ok:true,verified:true,demo:true});
  }

  try{
    let answer=null;
    if(process.env.ANTHROPIC_API_KEY)answer=await classifyWithAnthropic(mediaType,base64Data);
    if(answer===null&&process.env.GEMINI_API_KEY)answer=await classifyWithGemini(mediaType,base64Data);
    if(answer===null)return res.status(502).json({ok:false,error:'Verification service is temporarily unavailable — please try again shortly'});

    if(answer.includes('female')){
      await dbRun('UPDATE users SET is_verified=1 WHERE id=?',[req.jwt.id]);
      broadcastDBUpdate();
      return res.json({ok:true,verified:true});
    }else if(answer.includes('male')){
      return res.json({ok:false,verified:false,error:'This photo did not pass verification. Pink.TT is a women-only platform — contact support@pink.tt if you believe this is an error.'});
    }else{
      return res.json({ok:false,verified:false,retry:true,error:'Could not verify clearly — please retake the photo in good lighting with your face visible.'});
    }
  }catch(e){
    console.error('verify-id error',e.message);
    res.status(500).json({ok:false,error:'Verification failed — please try again'});
  }
});

// Admin-only: fetch a pending driver's licence photo for review (kept out of the general /api/db broadcast for privacy).
app.get('/api/driver-license-photo/:userId',authMW,async(req,res)=>{
  if(req.jwt.role!=='admin')return res.status(403).json({error:'Admin only'});
  const dp=await dbGet('SELECT license_photo FROM driver_profiles WHERE user_id=?',[req.params.userId]);
  res.json({license_photo:dp?.license_photo||''});
});

// Admin-only: audit log of sensitive admin actions (kept out of the general /api/db broadcast — no reason for every client to receive it).
app.get('/api/audit-log',authMW,async(req,res)=>{
  if(req.jwt.role!=='admin')return res.status(403).json({error:'Admin only'});
  const rows=await dbAll('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json({log:rows});
});

// Twilio fetches this URL when the safety-team call connects, to know what to say.
// Public by necessity (Twilio can't send our JWT), but the message is capped/short-lived
// SOS text only -- nothing sensitive enough to justify auth here.
app.get('/api/twiml-sos',(req,res)=>{
  const msg=escapeXml((req.query.msg||'Pink T T emergency alert. Please check the admin dashboard immediately.').toString().slice(0,300));
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${msg}</Say><Pause length="1"/><Say voice="Polly.Joanna">Repeating. ${msg}</Say></Response>`);
});

app.post('/api/mutation',mutationLimiter,authMW,async(req,res)=>{
  const{type,data}=req.body,userId=req.jwt.id;
  try{
    if(type==='driver_apply'){
      const{vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,license_expiry,license_photo}=data;
      const ex=await dbGet('SELECT id FROM driver_profiles WHERE user_id=?',[userId]);
      if(ex)await dbRun('UPDATE driver_profiles SET vehicle_make=?,vehicle_model=?,vehicle_year=?,vehicle_color=?,vehicle_plate=?,license_number=?,license_expiry=?,license_photo=COALESCE(?,license_photo) WHERE user_id=?',[vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,license_expiry||'',license_photo||null,userId]);
      else await dbRun('INSERT INTO driver_profiles(id,user_id,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,license_expiry,license_photo,status)VALUES(?,?,?,?,?,?,?,?,?,?,?)',[uuidv4(),userId,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,license_expiry||'',license_photo||'','pending']);
    }else if(type==='book_ride'){
      const ex=await dbGet("SELECT id FROM rides WHERE rider_id=? AND status NOT IN('completed','cancelled')",[userId]);
      if(ex)return res.json({ok:false,error:'You already have an active ride'});
      const p=isValidTTCoord(data.pickup_lat,data.pickup_lng)?[data.pickup_lat,data.pickup_lng]:(await resolveCoord(data.pickup_address)).coord;
      const d=isValidTTCoord(data.destination_lat,data.destination_lng)?[data.destination_lat,data.destination_lng]:(await resolveCoord(data.destination_address)).coord;
      const route=await getRoute(p,d);
      const km=route.km,min=route.min,fullFare=calcFare(km,min);
      const rider=await dbGet('SELECT pink_points FROM users WHERE id=?',[userId]);
      const{points,discount}=clampPointsRedemption(data.points_to_redeem,rider?.pink_points||0,fullFare);
      const fare=Math.round((fullFare-discount)*100)/100;
      if(points>0)await dbRun('UPDATE users SET pink_points=pink_points-? WHERE id=?',[points,userId]);
      await dbRun('INSERT INTO rides(id,rider_id,status,pickup_address,pickup_lat,pickup_lng,destination_address,destination_lat,destination_lng,estimated_fare,distance_km,duration_minutes,points_redeemed,points_discount)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[uuidv4(),userId,'requested',data.pickup_address,p[0],p[1],data.destination_address,d[0],d[1],fare,km,min,points,discount]);
    }else if(type==='accept_ride'){
      const ride=await dbGet("SELECT * FROM rides WHERE id=? AND status='requested'",[data.ride_id]);
      if(!ride)return res.json({ok:false,error:'Ride no longer available'});
      const dp=await dbGet('SELECT * FROM driver_profiles WHERE user_id=?',[userId]);
      if(!dp||dp.status!=='approved')return res.json({ok:false,error:'Your account is pending approval'});
      await dbRun("UPDATE rides SET driver_id=?,status='accepted',accepted_at=datetime('now') WHERE id=?",[userId,data.ride_id]);
      broadcastTo(ride.rider_id,{type:'ride_accepted',ride_id:data.ride_id});
    }else if(type==='ride_status'){
      const ride=await dbGet('SELECT * FROM rides WHERE id=?',[data.ride_id]);
      if(!ride)return res.json({ok:false,error:'Ride not found'});
      if(data.status==='arriving'){await dbRun("UPDATE rides SET status='arriving' WHERE id=?",[data.ride_id]);}
      else if(data.status==='in_progress'){await dbRun("UPDATE rides SET status='in_progress',started_at=datetime('now') WHERE id=?",[data.ride_id]);}
      else if(data.status==='completed'){
        // fare = what the rider actually pays (estimated_fare already has any points
        // discount baked in). Driver earnings are calculated from the full pre-discount
        // fare (fare + points_discount) so a points redemption never reduces payout.
        const fare=ride.final_fare||ride.estimated_fare||18,fullFare=fare+(ride.points_discount||0),earn=fullFare*.8;
        const rider=await dbGet('SELECT pink_points,pink_points_lifetime FROM users WHERE id=?',[ride.rider_id]);
        const tier=pinkPointsTier(rider?.pink_points_lifetime||0);
        const pointsEarned=Math.round(fare*PINK_POINTS_EARN_RATE*tier.multiplier);
        await dbRun("UPDATE rides SET status='completed',completed_at=datetime('now'),final_fare=?,points_earned=? WHERE id=?",[fare,pointsEarned,data.ride_id]);
        await dbRun('UPDATE driver_profiles SET total_trips=total_trips+1,total_earnings=total_earnings+?,balance=balance+?,today_earnings=today_earnings+? WHERE user_id=?',[earn,earn,earn,ride.driver_id]);
        await dbRun('UPDATE users SET total_rides=total_rides+1,pink_points=pink_points+?,pink_points_lifetime=pink_points_lifetime+? WHERE id=?',[pointsEarned,pointsEarned,ride.rider_id]);
        await dbRun('INSERT INTO payments(id,ride_id,rider_id,driver_id,amount,platform_fee,driver_earning,status,method)VALUES(?,?,?,?,?,?,?,?,?)',[uuidv4(),ride.id,ride.rider_id,ride.driver_id,fare,fullFare-earn,earn,'completed','cash']);
        broadcastTo(ride.rider_id,{type:'ride_completed',fare,pointsEarned});
      }else if(data.status==='cancelled'){
        await dbRun("UPDATE rides SET status='cancelled',cancelled_at=datetime('now') WHERE id=?",[data.ride_id]);
        if(ride.points_redeemed>0)await dbRun('UPDATE users SET pink_points=pink_points+? WHERE id=?',[ride.points_redeemed,ride.rider_id]);
        if(ride.rider_id)broadcastTo(ride.rider_id,{type:'ride_cancelled'});
        if(ride.driver_id)broadcastTo(ride.driver_id,{type:'ride_cancelled'});
      }
      if(ride.rider_id)broadcastTo(ride.rider_id,{type:'ride_update',status:data.status});
      if(ride.driver_id)broadcastTo(ride.driver_id,{type:'ride_update',status:data.status});
    }else if(type==='toggle_online'){
      const dp=await dbGet('SELECT * FROM driver_profiles WHERE user_id=?',[userId]);
      if(!dp)return res.json({ok:false,error:'No driver profile found'});
      if(dp.status!=='approved')return res.json({ok:false,error:'Account pending admin approval'});
      await dbRun('UPDATE driver_profiles SET is_online=? WHERE user_id=?',[dp.is_online?0:1,userId]);
    }else if(type==='driver_location'){
      await dbRun('UPDATE driver_profiles SET current_lat=?,current_lng=? WHERE user_id=?',[data.lat,data.lng,userId]);
      const activeRide=await dbGet("SELECT rider_id FROM rides WHERE driver_id=? AND status IN('accepted','arriving','in_progress') LIMIT 1",[userId]);
      if(activeRide)broadcastTo(activeRide.rider_id,{type:'driver_location',lat:data.lat,lng:data.lng,driver_id:userId});
    }else if(type==='sos'){
      const id=uuidv4();
      await dbRun('INSERT INTO sos_events(id,user_id,ride_id,lat,lng,message)VALUES(?,?,?,?,?,?)',[id,userId,data.ride_id||null,data.lat||10.6549,data.lng||-61.5019,data.message||'SOS Alert']);
      const u=await dbGet('SELECT first_name,last_name,phone,emergency_contact_name FROM users WHERE id=?',[userId]);
      const admins=await dbAll("SELECT id FROM users WHERE role='admin' AND is_active=1");
      const msg=`🚨 SOS from ${u.first_name} ${u.last_name} (${u.phone}) — GPS: ${data.lat}, ${data.lng}`;
      for(const a of admins){
        await dbRun('INSERT INTO notifications(id,user_id,type,message)VALUES(?,?,?,?)',[uuidv4(),a.id,'sos',msg]);
      }
      const mapLink=`https://www.google.com/maps?q=${data.lat},${data.lng}`;
      sendAdminEmail(`🚨 Pink.TT SOS — ${u.first_name} ${u.last_name}`,`${msg}\n\nLive location: ${mapLink}\n\nReview immediately in the admin dashboard.`);
      sendAdminSMS(`${msg} — ${mapLink}`);
      const alertResult=await triggerSafetyAlert(msg);
      broadcastAll({type:'sos_alert',user:`${u.first_name} ${u.last_name}`,phone:u.phone,ec:u.emergency_contact_name,lat:data.lat,lng:data.lng,message:msg,safetyTeamAlerted:alertResult.sent});
      broadcastDBUpdate();
      return res.json({ok:true,db:await buildDB(),safetyTeamAlerted:alertResult.sent});
    }else if(type==='approve_driver'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      await dbRun("UPDATE driver_profiles SET status='approved' WHERE user_id=?",[data.user_id]);
      await dbRun('INSERT INTO notifications(id,user_id,type,message)VALUES(?,?,?,?)',[uuidv4(),data.user_id,'approval','✅ Your Pink.TT driver account has been approved! Log in and go online to start accepting rides.']);
      broadcastTo(data.user_id,{type:'driver_approved'});
    }else if(type==='reject_driver'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      await dbRun("UPDATE driver_profiles SET status='rejected' WHERE user_id=?",[data.user_id]);
    }else if(type==='suspend_driver'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      await dbRun("UPDATE driver_profiles SET status='suspended',is_online=0 WHERE user_id=?",[data.user_id]);
    }else if(type==='toggle_user_active'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      if(data.user_id===req.jwt.id)return res.json({ok:false,error:"You can't suspend your own account"});
      await dbRun('UPDATE users SET is_active=? WHERE id=?',[data.active?1:0,data.user_id]);
      await logAudit(req.jwt,data.active?'activate_user':'suspend_user','user',data.user_id,'');
    }else if(type==='update_user_role'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      if(!['rider','driver','admin'].includes(data.role))return res.json({ok:false,error:'Invalid role'});
      if(data.user_id===req.jwt.id&&data.role!=='admin')return res.json({ok:false,error:"You can't remove your own admin role"});
      const target=await dbGet('SELECT role FROM users WHERE id=?',[data.user_id]);
      if(!target)return res.json({ok:false,error:'User not found'});
      if(target.role==='admin'&&data.role!=='admin'){
        const adminCount=await dbGet("SELECT COUNT(*) as n FROM users WHERE role='admin' AND is_active=1");
        if(Number(adminCount?.n)<=1)return res.json({ok:false,error:'Cannot remove the last remaining admin'});
      }
      await dbRun('UPDATE users SET role=? WHERE id=?',[data.role,data.user_id]);
      await logAudit(req.jwt,'update_user_role','user',data.user_id,`${target.role} -> ${data.role}`);
    }else if(type==='create_staff'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      const{first_name,last_name,email,password}=data;
      if(!first_name||!last_name||!email||!password||password.length<8)return res.json({ok:false,error:'First/last name, email, and an 8+ character password are required'});
      if(await dbGet('SELECT id FROM users WHERE email=?',[email.toLowerCase()]))return res.json({ok:false,error:'Email already registered'});
      const staffId=uuidv4();
      await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,role,is_active,is_verified)VALUES(?,?,?,?,?,?,1,1)',[staffId,email.toLowerCase(),bcrypt.hashSync(password,10),first_name,last_name,'admin']);
      await logAudit(req.jwt,'create_staff','user',staffId,email.toLowerCase());
    }else if(type==='update_settings'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      const allowedKeys=Object.keys(DEFAULT_SETTINGS);
      for(const k of Object.keys(data||{})){
        if(!allowedKeys.includes(k))continue;
        await setSetting(k,String(data[k]??''));
      }
      await logAudit(req.jwt,'update_settings','settings','',Object.keys(data||{}).filter(k=>allowedKeys.includes(k)).join(','));
    }else if(type==='admin_reset_test_data'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      await dbRun('DELETE FROM payments');
      await dbRun('DELETE FROM rides');
      await dbRun('UPDATE users SET total_rides=0,pink_points=0,pink_points_lifetime=0,wallet_balance=0');
      await dbRun('UPDATE driver_profiles SET total_trips=0,total_earnings=0,today_earnings=0,balance=0');
      await logAudit(req.jwt,'reset_test_data','platform','','Cleared all ride/payment history and reset earnings/points counters');
    }else if(type==='rate_ride'){
      await dbRun('UPDATE rides SET rider_rating=? WHERE id=?',[data.score,data.ride_id]);
      const ride=await dbGet('SELECT driver_id FROM rides WHERE id=?',[data.ride_id]);
      if(ride?.driver_id){const dp=await dbGet('SELECT rating,rating_count FROM driver_profiles WHERE user_id=?',[ride.driver_id]);if(dp)await dbRun('UPDATE driver_profiles SET rating=?,rating_count=rating_count+1 WHERE user_id=?',[(dp.rating*dp.rating_count+data.score)/(dp.rating_count+1),ride.driver_id]);}
    }else if(type==='cashout'){
      const dp=await dbGet('SELECT balance FROM driver_profiles WHERE user_id=?',[userId]);
      if(!dp||dp.balance<10)return res.json({ok:false,error:'Minimum TTD $10 to cash out'});
      await dbRun('UPDATE driver_profiles SET balance=0,today_earnings=0 WHERE user_id=?',[userId]);
    }else if(type==='mark_notifs_read'){
      await dbRun('UPDATE notifications SET is_read=1 WHERE user_id=?',[userId]);
    }
    broadcastDBUpdate();
    res.json({ok:true,db:await buildDB()});
  }catch(e){console.error('Mutation',type,e.message);res.status(500).json({ok:false,error:e.message});}
});

// ── Fallbacks ─────────────────────────────────────────────────────────────────
app.use((req,res,next)=>{
  if(req.path.startsWith('/api/'))return res.status(404).json({error:'Not found'});
  res.status(404).sendFile(path.join(__dirname,'public','offline.html'));
});
app.use((err,req,res,next)=>{
  console.error('Unhandled error',err);
  if(req.path.startsWith('/api/'))return res.status(500).json({error:'Something went wrong'});
  res.status(500).sendFile(path.join(__dirname,'public','offline.html'));
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server=http.createServer(app);
const wss=new WebSocket.Server({server});
const clients=new Map();
function broadcastDBUpdate(){buildDB().then(d=>{const m=JSON.stringify({type:'db_update',db:d});clients.forEach(ws=>{if(ws.readyState===WebSocket.OPEN)ws.send(m);});}).catch(console.error);}
function broadcastAll(data){const m=JSON.stringify(data);clients.forEach(ws=>{if(ws.readyState===WebSocket.OPEN)ws.send(m);});}
function broadcastTo(uid,data){const ws=clients.get(uid);if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));}
wss.on('connection',ws=>{
  let uid=null;
  ws.on('message',raw=>{
    try{const msg=JSON.parse(raw);
      if(msg.type==='auth'){try{const p=jwt.verify(msg.token,JWT_SECRET);uid=p.id;clients.set(uid,ws);ws.send(JSON.stringify({type:'auth_ok'}));buildDB().then(d=>ws.send(JSON.stringify({type:'db_update',db:d}))).catch(console.error);}catch{ws.send(JSON.stringify({type:'auth_err'}));}}
      else if(msg.type==='ping')ws.send(JSON.stringify({type:'pong'}));
    }catch{}
  });
  ws.on('close',()=>{if(uid)clients.delete(uid);});
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async()=>{
  await dbInit();
  if(!(await dbGet("SELECT id FROM users WHERE role='admin' LIMIT 1"))){
    await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,role,is_active,is_verified)VALUES(?,?,?,?,?,?,1,1)',[uuidv4(),'admin@pink.tt',bcrypt.hashSync('Admin@PinkTT2024',10),'Admin','Pink.TT','admin']);
    console.log('✅ Admin seeded: admin@pink.tt / Admin@PinkTT2024');
  }
  for(const[k,v]of Object.entries(DEFAULT_SETTINGS)){
    if(!(await dbGet('SELECT key FROM settings WHERE key=?',[k])))await dbRun('INSERT INTO settings(key,value)VALUES(?,?)',[k,v]);
  }
  if(SHOW_DEMO_ACCOUNTS&&!(await dbGet('SELECT id FROM users WHERE email=?',['sarah@demo.pink.tt']))){
    const riderId=uuidv4(),drv1Id=uuidv4(),drv2Id=uuidv4();
    await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,phone,role,is_active,is_verified,emergency_contact_name,emergency_contact_phone)VALUES(?,?,?,?,?,?,?,1,1,?,?)',[riderId,'sarah@demo.pink.tt',bcrypt.hashSync('Rider@2024',10),'Sarah','Mohammed','+18681111001','rider','Mom','+18681111000']);
    await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,phone,role,is_active,is_verified)VALUES(?,?,?,?,?,?,?,1,1)',[drv1Id,'aminah@demo.pink.tt',bcrypt.hashSync('Driver@2024',10),'Aminah','Ali','+18681112001','driver']);
    await dbRun('INSERT INTO driver_profiles(id,user_id,license_number,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,status,rating,rating_count,total_trips,total_earnings)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[uuidv4(),drv1Id,'TT-DL-AM2021','Toyota','Corolla','2021','Silver','PAB 1234','approved',4.8,43,47,2340.50]);
    await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,phone,role,is_active,is_verified)VALUES(?,?,?,?,?,?,?,1,1)',[drv2Id,'priya@demo.pink.tt',bcrypt.hashSync('Driver@2024',10),'Priya','Ramkissoon','+18681112002','driver']);
    await dbRun('INSERT INTO driver_profiles(id,user_id,license_number,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,status)VALUES(?,?,?,?,?,?,?,?,?)',[uuidv4(),drv2Id,'TT-DL-PR2019','Nissan','Tiida','2019','White','PCE 5678','pending']);
    console.log('✅ Demo accounts seeded (rider, approved driver, pending driver) — set SHOW_DEMO_ACCOUNTS=false to skip this in production');
  }
  server.listen(PORT,'0.0.0.0',()=>{
    let ip='localhost';
    try{Object.values(os.networkInterfaces()).flat().forEach(i=>{if(i.family==='IPv4'&&!i.internal)ip=i.address;});}catch{}
    console.log('\n🌸 ─────────────────────────────────────────────');
    console.log('   Pink.TT Server LIVE');
    console.log(`   Local  →  http://localhost:${PORT}`);
    console.log(`   Network→  http://${ip}:${PORT}  ← Share with others`);
    console.log('   Admin  →  admin@pink.tt / Admin@PinkTT2024');
    console.log('🌸 ─────────────────────────────────────────────\n');
  });
})();
