/* eslint-disable */
import pg from '/tmp/work-proof-v1/apps/server/node_modules/pg/lib/index.js';
const B='http://127.0.0.1:3461', db=new pg.Pool({connectionString:process.env.DATABASE_URL});
const r=[]; const ok=(n,c,d='')=>{r.push(`${c?'PASS':'FAIL'} ${n} ${d}`);};
const req=async(m,p,ck,body)=>{const x=await fetch(B+p,{method:m,headers:{...(body?{'content-type':'application/json'}:{}),...(ck?{cookie:ck}:{})},body:body?JSON.stringify(body):undefined});
 let j;try{j=await x.json()}catch{} return {s:x.status,j,sc:x.headers.get('set-cookie')}};
const tag=Date.now(); const pw='unique-password-123';
async function acct(n){const email=`${n}-${tag}@example.test`;
 const s=await req('POST','/api/signup',null,{email,password:pw,displayName:n,birthdate:'1990-01-01',termsVersion:'v1'});
 if(s.s!==202) throw new Error('signup '+s.s+JSON.stringify(s.j));
 await db.query(`UPDATE accounts SET status='active' WHERE email=$1`,[email]); // setup shortcut: email token is never exposed by ConsoleEmailSender
 return email;}
const login=async e=>{const l=await req('POST','/api/login',null,{email:e,password:pw}); if(l.s!==200) throw new Error('login '+l.s+JSON.stringify(l.j)); return l.sc.split(';')[0];};
const host=await acct('host'), j1=await acct('joinerA'), j2=await acct('joinerB'), out=await acct('outsider');
const h1=await login(host);
const c=await req('POST','/api/rooms',h1,{name:'Proof Room'});
const room=c.j.room, code1=c.j.room.code;
ok('create returns 201 + invite code',c.s===201&&!!code1,`status=${c.s}`);
const lst=await req('GET','/api/rooms',h1); ok('list after create has no code (hash-only)',lst.j.rooms[0].code===undefined);
const g=await req('GET','/api/rooms/'+room.id,h1); ok('GET room has no code',g.j.room.code===undefined);
// reload = brand-new login session for the same host
const h2=await login(host); ok('new host session distinct',h1!==h2);
const g2=await req('GET','/api/rooms/'+room.id,h2); ok('after reload host still isHost, no code',g2.j.room.isHost===true&&g2.j.room.code===undefined);
// old code still valid before regen?
const pre=await req('POST','/api/join/'+code1,await login(j1)); ok('old invite works BEFORE regeneration',pre.s===200,`status=${pre.s}`);
const reg=await req('POST',`/api/rooms/${room.id}/invite`,h2); if(!reg.j?.room){console.log('REG',reg.s,JSON.stringify(reg.j));process.exit(2)} const code2=reg.j.room.code;
ok('regenerate by host in new session -> 200 + new code',reg.s===200&&!!code2&&code2!==code1,`status=${reg.s}`);
const old=await req('POST','/api/join/'+code1,await login(j2)); ok('OLD invite rejected after regen (404 INVITE_INVALID)',old.s===404&&old.j.code==='INVITE_INVALID',`status=${old.s}`);
const jb=await login(j2); const n1=await req('POST','/api/join/'+code2,jb); ok('joiner B with new link joins',n1.s===200,`status=${n1.s}`);
const n2=await req('POST','/api/join/'+code2,jb); ok('joiner B re-join idempotent',n2.s===200);
const jbIn=await req('POST','/api/invites/'+code2+'/join',jb); ok('alt join route ok',jbIn.s===200);
const seatsB=(await db.query(`SELECT count(*)::int n FROM events WHERE session_id=$1 AND type='SeatJoined' AND payload->>'accountId'=(SELECT id::text FROM accounts WHERE email=$2)`,[room.id,j2]).catch(e=>({rows:[{n:'ERR '+e.message}]}))).rows[0].n;
ok('joiner B has exactly one seat (DB)',seatsB===1,`seats=${seatsB}`);
const ja=await login(j1); const jAfter=await req('POST','/api/join/'+code2,ja);
// non-host
const nh=await req('POST',`/api/rooms/${room.id}/invite`,jb); ok('seated non-host regenerate -> 403',nh.s===403,`status=${nh.s}`);
const nh2=await req('DELETE',`/api/rooms/${room.id}/invite`,jb); ok('seated non-host revoke -> 403',nh2.s===403,`status=${nh2.s}`);
const ou=await req('POST',`/api/rooms/${room.id}/invite`,await login(out)); ok('unseated outsider regenerate -> 404 (no existence leak)',ou.s===404,`status=${ou.s}`);
const an=await req('POST',`/api/rooms/${room.id}/invite`,null); ok('anonymous -> 401',an.s===401,`status=${an.s}`);
// db plaintext
const row=(await db.query('SELECT invite_hash FROM sessions WHERE id=$1',[room.id])).rows[0];
ok('DB invite_hash is not plaintext code2',row.invite_hash!==code2&&/^[0-9a-f]{64}$/.test(row.invite_hash),row.invite_hash.slice(0,12)+'…');
const all=JSON.stringify((await db.query(`SELECT to_jsonb(s) j FROM sessions s WHERE id=$1`,[room.id])).rows);
const ev=await db.query(`SELECT count(*)::int n FROM information_schema.columns WHERE column_name ILIKE '%invite%'`);
let leak=0; for(const t of (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows){const x=await db.query(`SELECT count(*)::int n FROM ${t.table_name} t WHERE t::text LIKE $1 OR t::text LIKE $2`,[`%${code1}%`,`%${code2}%`]); leak+=x.rows[0].n;}
ok('neither plaintext code appears in any row of any table',leak===0,`rows=${leak}`);
ok('only invite column is sessions.invite_hash',ev.rows[0].n===1,`invite-ish columns=${ev.rows[0].n}`);
// revoke
const rv=await req('DELETE',`/api/rooms/${room.id}/invite`,h2); const after=await req('POST','/api/join/'+code2,ja);
ok('host revoke then join -> 404',rv.s===200&&after.s===404);
console.log(r.join('\n')); await db.end(); process.exit(r.some(x=>x.startsWith('FAIL'))?1:0);
