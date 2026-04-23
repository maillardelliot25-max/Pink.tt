'use strict';
const express=require('express'),http=require('http'),WebSocket=require('ws'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{v4:uuidv4}=require('uuid'),path=require('path'),os=require('os');
const JWT_SECRET='pinktt_2025_secure',PORT=process.env.PORT||3000;

// ── Database abstraction: Turso cloud if env set, else local SQLite ───────────
let dbGet,dbAll,dbRun,dbInit;
const SCHEMA_SQL=[
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL COLLATE NOCASE,password_hash TEXT NOT NULL,first_name TEXT,last_name TEXT,phone TEXT DEFAULT'',role TEXT DEFAULT'rider',gender TEXT DEFAULT'female',is_verified INTEGER DEFAULT 0,is_active INTEGER DEFAULT 1,emergency_contact_name TEXT DEFAULT'',emergency_contact_phone TEXT DEFAULT'',wallet_balance REAL DEFAULT 0,total_rides INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS driver_profiles(id TEXT PRIMARY KEY,user_id TEXT UNIQUE,license_number TEXT DEFAULT'',vehicle_make TEXT DEFAULT'',vehicle_model TEXT DEFAULT'',vehicle_year TEXT DEFAULT'',vehicle_color TEXT DEFAULT'',vehicle_plate TEXT DEFAULT'',status TEXT DEFAULT'pending',is_online INTEGER DEFAULT 0,current_lat REAL DEFAULT 10.6549,current_lng REAL DEFAULT -61.5019,total_trips INTEGER DEFAULT 0,total_earnings REAL DEFAULT 0,balance REAL DEFAULT 0,today_earnings REAL DEFAULT 0,rating REAL DEFAULT 5.0,rating_count INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')),FOREIGN KEY(user_id)REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS rides(id TEXT PRIMARY KEY,rider_id TEXT,driver_id TEXT,status TEXT DEFAULT'requested',pickup_address TEXT,pickup_lat REAL,pickup_lng REAL,destination_address TEXT,destination_lat REAL,destination_lng REAL,estimated_fare REAL,final_fare REAL,distance_km REAL,duration_minutes INTEGER,rider_rating INTEGER,requested_at TEXT DEFAULT(datetime('now')),accepted_at TEXT,started_at TEXT,completed_at TEXT,cancelled_at TEXT,created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,ride_id TEXT,rider_id TEXT,driver_id TEXT,amount REAL,platform_fee REAL,driver_earning REAL,status TEXT DEFAULT'pending',method TEXT DEFAULT'cash',created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sos_events(id TEXT PRIMARY KEY,user_id TEXT,ride_id TEXT,status TEXT DEFAULT'active',lat REAL,lng REAL,message TEXT DEFAULT'',created_at TEXT DEFAULT(datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT,type TEXT DEFAULT'info',message TEXT,is_read INTEGER DEFAULT 0,created_at TEXT DEFAULT(datetime('now')))`
];

if(process.env.TURSO_DATABASE_URL){
  const{createClient}=require('@libsql/client');
  const turso=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN||''});
  const toPlain=(rows,cols)=>rows.map(row=>{const o={};cols.forEach((c,i)=>{o[c]=row[i];});return o;});
  dbGet=async(sql,args=[])=>{const r=await turso.execute({sql,args});return r.rows.length?toPlain(r.rows,r.columns)[0]:null;};
  dbAll=async(sql,args=[])=>{const r=await turso.execute({sql,args});return toPlain(r.rows,r.columns);};
  dbRun=async(sql,args=[])=>{await turso.execute({sql,args});};
  dbInit=async()=>{await turso.batch(SCHEMA_SQL.map(sql=>({sql})),'write');console.log('✅ Connected to Turso cloud database');};
}else{
  const Database=require('better-sqlite3');
  const sqlite=new Database(path.join(__dirname,'pinktt.db'));
  sqlite.pragma('journal_mode = WAL');
  dbGet=async(sql,args=[])=>sqlite.prepare(sql).get(...args)??null;
  dbAll=async(sql,args=[])=>sqlite.prepare(sql).all(...args);
  dbRun=async(sql,args=[])=>{sqlite.prepare(sql).run(...args);};
  dbInit=async()=>{SCHEMA_SQL.forEach(s=>sqlite.exec(s));console.log('✅ Using local SQLite (no TURSO_DATABASE_URL set)');};
}

// ── Business logic ────────────────────────────────────────────────────────────
const COORDS={'Port of Spain':[10.6549,-61.5019],'Independence Square':[10.653,-61.5105],"Queen's Park Savannah":[10.663,-61.5178],'Maraval':[10.672,-61.522],'Airport':[10.5954,-61.3372],'Piarco':[10.5954,-61.3372],'Chaguanas':[10.517,-61.4115],'San Fernando':[10.2796,-61.4688],'Arima':[10.637,-61.283],'Tunapuna':[10.637,-61.383],'Trincity':[10.604,-61.350],'Diego Martin':[10.69,-61.56],'Woodbrook':[10.652,-61.514],'St. Clair':[10.668,-61.523],'Curepe':[10.639,-61.408],'Barataria':[10.63,-61.43],'Point Fortin':[10.17,-61.685],'Princes Town':[10.27,-61.373]};
function getCoord(a){for(const k in COORDS){if(a&&a.toLowerCase().includes(k.toLowerCase()))return COORDS[k];}return[10.6549+(Math.random()-.5)*.05,-61.5019+(Math.random()-.5)*.05];}
function calcFare(km,min){const h=new Date().getHours(),raw=25+km*3.5+min*1.5,s=(h>=22||h<5)?1.25:((h>=6&&h<9)||(h>=16&&h<19))?1.20:1;return Math.round(raw*s*100)/100;}
function dist(p,d){const R=6371,dLat=(d[0]-p[0])*Math.PI/180,dLon=(d[1]-p[1])*Math.PI/180,a=Math.sin(dLat/2)**2+Math.cos(p[0]*Math.PI/180)*Math.cos(d[0]*Math.PI/180)*Math.sin(dLon/2)**2;return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))*10)/10;}

async function buildDB(){
  const users=(await dbAll('SELECT id,email,password_hash,first_name,last_name,phone,role,gender,is_verified,is_active,emergency_contact_name,emergency_contact_phone,wallet_balance,total_rides,created_at FROM users')).map(u=>({...u,is_verified:!!u.is_verified,is_active:!!u.is_active}));
  const driver_profiles=(await dbAll('SELECT * FROM driver_profiles')).map(d=>({...d,is_online:!!d.is_online,approved_at:d.status==='approved'?d.created_at:null}));
  const rides=await dbAll('SELECT * FROM rides');
  const payments=await dbAll('SELECT * FROM payments');
  const sos_events=await dbAll('SELECT * FROM sos_events');
  const notifications=await dbAll('SELECT * FROM notifications');
  const promotions=[{id:'p1',code:'WELCOME25',title:'Welcome Discount',description:'25% off your first ride',type:'percentage',value:25,is_active:true,valid_until:'2026-12-31T00:00:00Z'},{id:'p2',code:'PINK10',title:'Pink Loyalty',description:'TTD $10 off any ride over $50',type:'fixed',value:10,is_active:true,valid_until:'2026-12-31T00:00:00Z'},{id:'p3',code:'SAFE20',title:'Safety Bonus',description:'20% off for referring a friend',type:'percentage',value:20,is_active:true,valid_until:'2026-12-31T00:00:00Z'}];
  const businesses=[{id:'b1',name:'Luxe Nail Lounge',category:'nail_salon',description:'Premium nail care & nail art',address:'Long Circular Road, St. James, POS',phone:'+1 868 222 1001',rating:4.9,rating_count:89,is_featured:true,discount:'Pink.TT Rider Special — 15% OFF',discount_code:'PINK15',lat:10.665,lng:-61.521},{id:'b2',name:'Serenity Spa & Wellness',category:'spa',description:'Full-service day spa & wellness',address:'Ariapita Avenue, Woodbrook, POS',phone:'+1 868 222 1003',rating:4.9,rating_count:223,is_featured:true,discount:'Weekday Special — 10% OFF',discount_code:'WEEKDAY10',lat:10.652,lng:-61.514},{id:'b3',name:'TT Skincare Clinic',category:'skincare',description:'Medical skincare & facial treatments',address:'Trincity Mall, Trincity',phone:'+1 868 222 1008',rating:4.9,rating_count:205,is_featured:true,discount:'New Client Package — 25% OFF',discount_code:'NEWCLIENT25',lat:10.604,lng:-61.350},{id:'b4',name:'The Curl Bar T&T',category:'hair',description:'Natural hair & protective styles',address:'Maraval Road, POS',phone:'+1 868 222 1002',rating:4.8,rating_count:134,is_featured:true,discount:'New Client Welcome — 20% OFF',discount_code:'NEWCURL20',lat:10.672,lng:-61.522}];
  return{users,driver_profiles,rides,payments,sos_events,notifications,promotions,businesses,business_services:[],business_discounts:[],reports:[],trip_shares:[]};
}

// ── Express ───────────────────────────────────────────────────────────────────
const app=express();
app.use(express.json({limit:'5mb'}));
app.use(express.static(path.join(__dirname,'public')));
function authMW(req,res,next){const t=(req.headers.authorization||'').replace('Bearer ','').trim();if(!t)return res.status(401).json({error:'No token'});try{req.jwt=jwt.verify(t,JWT_SECRET);next();}catch{res.status(401).json({error:'Session expired — please log in again'});}}

app.post('/api/register',async(req,res)=>{
  const{first_name,last_name,email,password,phone,role,emergency_contact_name,emergency_contact_phone}=req.body;
  if(!first_name||!last_name||!email||!password)return res.status(400).json({error:'Missing required fields'});
  if(password.length<8)return res.status(400).json({error:'Password must be 8+ characters'});
  if(!['rider','driver'].includes(role))return res.status(400).json({error:'Invalid role'});
  if(await dbGet('SELECT id FROM users WHERE email=?',[email.toLowerCase()]))return res.status(400).json({error:'Email already registered'});
  const hash=bcrypt.hashSync(password,10),id=uuidv4();
  await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,phone,role,emergency_contact_name,emergency_contact_phone,is_active,is_verified)VALUES(?,?,?,?,?,?,?,?,?,1,0)',[id,email.toLowerCase(),hash,first_name,last_name,phone||'',role,emergency_contact_name||'',emergency_contact_phone||'']);
  const token=jwt.sign({id,role,email:email.toLowerCase()},JWT_SECRET,{expiresIn:'30d'});
  broadcastDBUpdate();
  res.json({ok:true,token,user_id:id});
});

app.post('/api/login',async(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password)return res.status(400).json({error:'Email and password required'});
  const user=await dbGet('SELECT * FROM users WHERE email=?',[email.toLowerCase()]);
  if(!user||!bcrypt.compareSync(password,user.password_hash))return res.status(401).json({error:'Invalid email or password'});
  if(!user.is_active)return res.status(403).json({error:'Account suspended. Contact support@pink.tt'});
  const token=jwt.sign({id:user.id,role:user.role,email:user.email},JWT_SECRET,{expiresIn:'30d'});
  res.json({ok:true,token,user_id:user.id});
});

app.get('/api/db',authMW,async(req,res)=>{
  const dbObj=await buildDB();
  const user=dbObj.users.find(u=>u.id===req.jwt.id)||null;
  res.json({db:dbObj,user});
});

app.post('/api/fare',(req,res)=>{
  const{pickup,destination}=req.body;
  const p=getCoord(pickup),d=getCoord(destination);
  const km=dist(p,d),min=Math.round(km*2.5+5),fare=calcFare(km,min);
  const h=new Date().getHours(),s=(h>=22||h<5)?'night':((h>=6&&h<9)||(h>=16&&h<19))?'peak':'standard';
  res.json({km,min,fare,pickup_lat:p[0],pickup_lng:p[1],dest_lat:d[0],dest_lng:d[1],surge:s});
});

app.post('/api/mutation',authMW,async(req,res)=>{
  const{type,data}=req.body,userId=req.jwt.id;
  try{
    if(type==='driver_apply'){
      const{vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number}=data;
      const ex=await dbGet('SELECT id FROM driver_profiles WHERE user_id=?',[userId]);
      if(ex)await dbRun('UPDATE driver_profiles SET vehicle_make=?,vehicle_model=?,vehicle_year=?,vehicle_color=?,vehicle_plate=?,license_number=? WHERE user_id=?',[vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,userId]);
      else await dbRun('INSERT INTO driver_profiles(id,user_id,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,status)VALUES(?,?,?,?,?,?,?,?,?)',[uuidv4(),userId,vehicle_make,vehicle_model,vehicle_year,vehicle_color,vehicle_plate,license_number,'pending']);
    }else if(type==='book_ride'){
      const ex=await dbGet("SELECT id FROM rides WHERE rider_id=? AND status NOT IN('completed','cancelled')",[userId]);
      if(ex)return res.json({ok:false,error:'You already have an active ride'});
      const p=getCoord(data.pickup_address),d=getCoord(data.destination_address),km=dist(p,d),min=Math.round(km*2.5+5),fare=calcFare(km,min);
      await dbRun('INSERT INTO rides(id,rider_id,status,pickup_address,pickup_lat,pickup_lng,destination_address,destination_lat,destination_lng,estimated_fare,distance_km,duration_minutes)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[uuidv4(),userId,'requested',data.pickup_address,p[0],p[1],data.destination_address,d[0],d[1],fare,km,min]);
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
        const fare=ride.final_fare||ride.estimated_fare||25,earn=fare*.8;
        await dbRun("UPDATE rides SET status='completed',completed_at=datetime('now'),final_fare=? WHERE id=?",[fare,data.ride_id]);
        await dbRun('UPDATE driver_profiles SET total_trips=total_trips+1,total_earnings=total_earnings+?,balance=balance+?,today_earnings=today_earnings+? WHERE user_id=?',[earn,earn,earn,ride.driver_id]);
        await dbRun('UPDATE users SET total_rides=total_rides+1 WHERE id=?',[ride.rider_id]);
        await dbRun('INSERT INTO payments(id,ride_id,rider_id,driver_id,amount,platform_fee,driver_earning,status,method)VALUES(?,?,?,?,?,?,?,?,?)',[uuidv4(),ride.id,ride.rider_id,ride.driver_id,fare,fare*.2,earn,'completed','cash']);
        broadcastTo(ride.rider_id,{type:'ride_completed',fare});
      }else if(data.status==='cancelled'){
        await dbRun("UPDATE rides SET status='cancelled',cancelled_at=datetime('now') WHERE id=?",[data.ride_id]);
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
      const admin=await dbGet("SELECT id FROM users WHERE role='admin' LIMIT 1");
      const msg=`🚨 SOS from ${u.first_name} ${u.last_name} (${u.phone}) — GPS: ${data.lat}, ${data.lng}`;
      if(admin)await dbRun('INSERT INTO notifications(id,user_id,type,message)VALUES(?,?,?,?)',[uuidv4(),admin.id,'sos',msg]);
      broadcastAll({type:'sos_alert',user:`${u.first_name} ${u.last_name}`,phone:u.phone,ec:u.emergency_contact_name,lat:data.lat,lng:data.lng,message:msg});
    }else if(type==='approve_driver'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      await dbRun("UPDATE driver_profiles SET status='approved' WHERE user_id=?",[data.user_id]);
      await dbRun('INSERT INTO notifications(id,user_id,type,message)VALUES(?,?,?,?)',[uuidv4(),data.user_id,'approval','✅ Your Pink.TT driver account has been approved! Log in and go online to start accepting rides.']);
      broadcastTo(data.user_id,{type:'driver_approved'});
    }else if(type==='reject_driver'){
      if(req.jwt.role!=='admin')return res.json({ok:false,error:'Admin only'});
      await dbRun("UPDATE driver_profiles SET status='rejected' WHERE user_id=?",[data.user_id]);
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
    await dbRun('INSERT INTO users(id,email,password_hash,first_name,last_name,role,is_active,is_verified)VALUES(?,?,?,?,?,?,1,1)',[uuidv4(),'admin@pink.tt',bcrypt.hashSync('Admin@2024',10),'Admin','Pink.TT','admin']);
    console.log('✅ Admin seeded: admin@pink.tt / Admin@2024');
  }
  server.listen(PORT,'0.0.0.0',()=>{
    let ip='localhost';
    try{Object.values(os.networkInterfaces()).flat().forEach(i=>{if(i.family==='IPv4'&&!i.internal)ip=i.address;});}catch{}
    console.log('\n🌸 ─────────────────────────────────────────────');
    console.log('   Pink.TT Server LIVE');
    console.log(`   Local  →  http://localhost:${PORT}`);
    console.log(`   Network→  http://${ip}:${PORT}  ← Share with others`);
    console.log('   Admin  →  admin@pink.tt / Admin@2024');
    console.log('🌸 ─────────────────────────────────────────────\n');
  });
})();
