/* Template cloud storage. Public key only; account ownership is enforced by RLS. */
(function(){
'use strict';
const URL='https://kwczpxuzdzcdwlzhltjj.supabase.co';
const KEY='sb_publishable_xRdslEYpIjPWxIMOpvTFdA_Q0JjSbkm';
const RETURN='https://gayeon2tina-sudo.github.io/MyAIAgentOffice/template/';
const native=window.localStorage;
const allowed=k=>k==='friendhq:settings:v1'||k.startsWith('friendhq:v1:');
const copy=o=>JSON.parse(JSON.stringify(o));
let client, user, record, cacheKey, busy=false, timer, blocked=false, opened=false;
let state='Saved only in this browser';
const domReady=new Promise(r=>document.readyState==='loading'?document.addEventListener('DOMContentLoaded',r,{once:true}):r());
function guestData(){const out={};for(let i=0;i<native.length;i++){const k=native.key(i);if(allowed(k))out[k]=native.getItem(k);}return out;}
function validPayload(p){return p&&typeof p==='object'&&!Array.isArray(p)&&Object.entries(p).every(([k,v])=>allowed(k)&&typeof v==='string');}
function label(s){state=s;const el=document.getElementById('hqCloudStatus');if(el)el.textContent=s;}
function persist(){native.setItem(cacheKey,JSON.stringify(record));}
function download(payload,name='my-hq-backup'){const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob([JSON.stringify({format:'myhq-cloud-v1',exportedAt:new Date().toISOString(),payload},null,2)],{type:'application/json'}));a.download=name+'.json';a.click();setTimeout(()=>window.URL.revokeObjectURL(a.href),1000);}
function panel(title,description){const d=document.createElement('dialog');d.className='hq-cloud-dialog';const h=document.createElement('h2');h.textContent=title;const p=document.createElement('p');p.textContent=description;d.append(h,p);document.body.append(d);d.addEventListener('cancel',e=>e.preventDefault());d.showModal();return d;}
function button(d,text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;d.append(b);return b;}
function stop(message){blocked=true;label('Action needed — cloud save paused');if(document.getElementById('hqCloudBlock'))return;const d=panel('Your work is preserved',message);d.id='hqCloudBlock';button(d,'Download this device’s copy',()=>download(record?record.payload:guestData()));button(d,'Reload and check again',()=>location.reload());}
async function conflict(remote){blocked=true;label('Two versions need review');const d=panel('Another device saved changes', 'Your local copy has not overwritten the cloud. Download your local copy before loading the cloud version. You can refer to the backup when re-entering any missing changes.');const load=button(d,'Load cloud version',()=>{record={revision:remote?remote.revision:0,payload:remote?remote.payload:{},dirty:false};persist();location.reload();});load.disabled=true;button(d,'Download local copy first',()=>{download(record.payload,'my-hq-unsynced-copy');load.disabled=false;});return new Promise(()=>{});}
async function readRemote(){const {data,error}=await client.from('hq_documents').select('revision,payload').eq('user_id',user.id).maybeSingle();if(error)throw error;if(data&&!validPayload(data.payload))throw Error('Cloud data format is invalid');return data;}
async function sync(){
 if(!user||!record||!record.dirty||busy||blocked)return;
 busy=true;const snapshot=copy(record.payload);label('Saving to cloud…');
 try{
  const {data,error}=await client.rpc('hq_save_document',{expected_revision:record.revision,new_payload:snapshot});
  if(error){if(error.code==='40001'){const remote=await readRemote();if(remote&&JSON.stringify(remote.payload)===JSON.stringify(snapshot)){record.revision=remote.revision;}else{conflict(remote);return;}}else throw error;}
  else record.revision=data;
  record.dirty=JSON.stringify(record.payload)!==JSON.stringify(snapshot);persist();label(record.dirty?'Changes waiting to save':'Saved to cloud');
 }catch(e){label('Not synced — saved on this device. Retry in Account.');}
 finally{busy=false;if(record.dirty&&!blocked&&state==='Changes waiting to save')timer=setTimeout(sync,500);}
}
function changed(){record.dirty=true;try{persist();}catch(e){stop('This browser cannot save more data. Download your current copy now. Cloud saving is paused so no changes are lost silently.');throw e;}label('Changes waiting to save');clearTimeout(timer);timer=setTimeout(sync,700);}
window.HQStore={
 get length(){return this.keys().length;},
 keys(){return user?Object.keys(record.payload):Object.keys(guestData());},
 key(i){return this.keys()[i]||null;},
 getItem(k){return user?(Object.hasOwn(record.payload,k)?record.payload[k]:null):native.getItem(k);},
 setItem(k,v){if(!allowed(k))throw Error('Unexpected storage key');if(blocked)throw Error('Saving paused; resolve the account notice first');v=String(v);if(user){if(record.payload[k]===v)return;record.payload[k]=v;changed();}else native.setItem(k,v);},
 removeItem(k){if(!allowed(k))return;if(blocked)throw Error('Saving paused');if(user){if(!Object.hasOwn(record.payload,k))return;delete record.payload[k];changed();}else native.removeItem(k);}
};
async function loginGate(){
 const d=panel('Welcome to your HQ','Sign in with an email link to save your office to your account, or continue with this browser only.');
 const note=document.createElement('p');note.textContent='Email sign-in is in setup: currently available only to the project owner. Friends can use browser-only mode until the email service is connected.';d.append(note);
 const form=document.createElement('form');const l=document.createElement('label');l.textContent='Email address';const input=document.createElement('input');input.type='email';input.required=true;input.autocomplete='email';l.append(input);form.append(l);const send=document.createElement('button');send.textContent='Email me a sign-in link';form.append(send);const msg=document.createElement('p');msg.setAttribute('role','status');form.append(msg);d.append(form);
 form.onsubmit=async e=>{e.preventDefault();send.disabled=true;msg.textContent='Sending…';try{if(!client)throw Error('Sign-in service unavailable. Reload while online.');const {error}=await client.auth.signInWithOtp({email:input.value.trim(),options:{emailRedirectTo:RETURN}});if(error)throw error;msg.textContent='Check your inbox and spam folder. Open the newest link to sign in. Keep this page open.';}catch(e){msg.textContent='Could not send the link. Email delivery is currently limited to the project owner; otherwise try again later.';}finally{setTimeout(()=>send.disabled=false,60000);}};
 return new Promise(resolve=>button(d,'Continue in this browser only',()=>{d.remove();resolve();}));
}
async function account(){
 if(!user){await loginGate();return;}
 const d=panel('Your account',user.email+' · '+state);
 button(d,'Close',()=>d.remove());button(d,'Save now',async()=>{await sync();d.querySelector('p').textContent=user.email+' · '+state;});button(d,'Download full backup',()=>download(record.payload));
 button(d,'Saved versions',async()=>{const {data,error}=await client.from('hq_document_history').select('revision,saved_at').eq('user_id',user.id).order('revision',{ascending:false}).limit(50);if(error){d.querySelector('p').textContent='Could not load saved versions. Try again while online.';return;}const list=document.createElement('div');d.append(list);for(const v of data)button(list,'Download version '+v.revision+' · '+new Date(v.saved_at).toLocaleString(),async()=>{const {data:item,error:err}=await client.from('hq_document_history').select('payload').eq('user_id',user.id).eq('revision',v.revision).single();if(!err)download(item.payload,'my-hq-version-'+v.revision);});});
 button(d,'Sign out',async()=>{await sync();if(record.dirty){d.querySelector('p').textContent='Some changes have not reached the cloud. Download a backup and retry Save now before signing out.';return;}const {error}=await client.auth.signOut({scope:'local'});if(error){d.querySelector('p').textContent='Sign-out failed; please try again.';return;}native.removeItem(cacheKey);location.reload();});
}
async function initialize(){
 await domReady;
 const style=document.createElement('style');style.textContent='.hq-cloud-dialog{box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-height:85vh;overflow:auto;border:3px solid #a8d3ef;border-radius:20px;padding:24px;color:#23334b;background:#f4faff;font:20px/1.4 "VT323",monospace}.hq-cloud-dialog::backdrop{background:#102338dd}.hq-cloud-dialog h2{margin-top:0}.hq-cloud-dialog button{font:inherit;background:#daf1ff;border:2px solid #a8d3ef;border-radius:10px;margin:6px;padding:8px 12px;cursor:pointer}.hq-cloud-dialog button:disabled{opacity:.5}.hq-cloud-dialog input{box-sizing:border-box;display:block;width:100%;font:18px system-ui;padding:10px;margin:8px 0;border:2px solid #a8d3ef;border-radius:8px}#hqCloudBar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 24px;font:20px "VT323",monospace}#hqCloudBar button{font:inherit;border:2px solid #a8d3ef;border-radius:10px;background:#daf1ff;padding:6px 12px}';document.head.append(style);
 try{client=window.supabase.createClient(URL,KEY,{auth:{storageKey:'friendhq-auth-v1',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});const {data,error}=await client.auth.getSession();if(error)throw error;user=data.session?.user;}catch(e){user=null;}
 if(!user){await loginGate();}
 if(user){
  cacheKey='friendhq-cloud:'+user.id;
  // Only one editing tab per account/device. Cross-device writes use revision checks.
  if(!navigator.locks){stop('This browser does not support safe account editing. Use a current Chrome browser.');return new Promise(()=>{});}
  const locked=await new Promise(resolve=>navigator.locks.request('myhq-edit:'+user.id,{ifAvailable:true},lock=>{resolve(!!lock);return lock?new Promise(()=>{}):undefined;}));
  if(!locked){stop('Your account is open in another tab or app window. Close that window, then reload this one.');return new Promise(()=>{});}
  try{record=JSON.parse(native.getItem(cacheKey));}catch(e){record=null;}
  if(record&&(!validPayload(record.payload)||!Number.isInteger(record.revision)))record=null;
  try{const remote=await readRemote();if(record?.dirty&&record.revision!==(remote?.revision||0)){if(remote&&JSON.stringify(remote.payload)===JSON.stringify(record.payload)){record={revision:remote.revision,payload:remote.payload,dirty:false};}else return conflict(remote);}
   if(!record?.dirty)record={revision:remote?.revision||0,payload:remote?.payload||{},dirty:false};persist();label('Saved to cloud');
  }catch(e){if(!record){stop('Could not load your account. Check your connection and reload. No local data was moved or erased.');return new Promise(()=>{});}label('Offline copy — cloud not checked');}
  if(record.revision===0&&!Object.keys(record.payload).length&&Object.keys(guestData()).length){await new Promise(resolve=>{const d=panel('Bring your existing office?','This browser has an office saved without an account. Copy it into your signed-in account only if it belongs to you. The original browser copy will remain.');button(d,'Copy my browser office to this account',()=>{record.payload=guestData();changed();d.remove();resolve();});button(d,'Start a separate office',()=>{d.remove();resolve();});});}
  if(record.dirty)sync();
 }
 const bar=document.createElement('div');bar.id='hqCloudBar';const status=document.createElement('span');status.id='hqCloudStatus';status.textContent=state;bar.append(status);button(bar,user?'Account & backup':'Email sign-in',account);document.body.prepend(bar);
 client?.auth.onAuthStateChange((event,session)=>{if(opened&&((session?.user?.id||null)!==(user?.id||null)))setTimeout(()=>location.reload(),0);});opened=true;
 window.addEventListener('online',sync);
 window.addEventListener('beforeunload',e=>{if(record?.dirty){e.preventDefault();e.returnValue='';}});
 document.addEventListener('visibilitychange',async()=>{if(document.hidden||!user||blocked)return;if(record.dirty){sync();return;}try{const remote=await readRemote();if(remote&&remote.revision!==record.revision){if(record.dirty){conflict(remote);return;}record={revision:remote.revision,payload:remote.payload,dirty:false};persist();location.reload();}}catch(e){label('Cloud unavailable — this device retains a copy');}});
}
window.HQCloud={ready:initialize(),sync,account};
})();
