const $ = (s) => document.querySelector(s);
const welcome = $('#welcome'), messagesEl = $('#messages'), input = $('#prompt'), historyEl = $('#history');
const cfg = window.APP_CONFIG || {};
let session = null, conversations = [], currentId = null, busy = false;
const SESSION_KEY = 'modal-chat-auth-session';
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function formatted(text){return esc(text).replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>')}
function splitLegacyThink(text){const raw=String(text||'');const m=raw.match(/<think>([\s\S]*?)<\/think>/i);return m?{reasoning:m[1].trim(),content:raw.replace(m[0],'').trim()}:{reasoning:'',content:raw}}
function configReady(){return /^https:\/\//.test(cfg.SUPABASE_URL||'') && cfg.SUPABASE_ANON_KEY && !String(cfg.SUPABASE_URL).includes('YOUR_PROJECT') && !String(cfg.SUPABASE_ANON_KEY).includes('YOUR_')}
function saveSession(){session?localStorage.setItem(SESSION_KEY,JSON.stringify(session)):localStorage.removeItem(SESSION_KEY)}
async function refreshSession(){
 if(!session?.refresh_token)throw new Error('Phiên đăng nhập hết hạn. Hãy đăng nhập lại.');
 const r=await fetch(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{method:'POST',headers:{apikey:cfg.SUPABASE_ANON_KEY,'content-type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})});
 const j=await r.json();if(!r.ok)throw new Error(j.msg||j.message||j.error_description||'Phiên đăng nhập hết hạn.');
 session={...j,expires_at:Date.now()/1000+(j.expires_in||3600)};saveSession();return session;
}
async function accessToken(){if(!session)throw new Error('Bạn chưa đăng nhập.');if(!session.expires_at||session.expires_at<Date.now()/1000+45)await refreshSession();return session.access_token}
async function api(path, options={}){
 const token=await accessToken();const r=await fetch(`${cfg.SUPABASE_URL}${path}`,{...options,headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`,'content-type':'application/json',...(options.headers||{})}});
 if(!r.ok){let j={};try{j=await r.json()}catch{};if(r.status===401){session=null;saveSession();showAuth()}throw new Error(j.message||j.msg||j.error||j.error_description||`Lỗi dịch vụ (${r.status})`)}
 return r.status===204?null:r.json().catch(()=>null)
}
function active(){return conversations.find(c=>c.id===currentId)}
function saveLocallyAuthOnly(){saveSession()}
function renderHistory(){historyEl.innerHTML='';const clearBtn=$('#clearHistory');clearBtn.hidden=false;clearBtn.disabled=busy||!conversations.length;conversations.forEach(c=>{const row=document.createElement('div');row.className='history-row';const b=document.createElement('button');b.className='history-item'+(c.id===currentId?' active':'');b.textContent=c.title||'Cuộc trò chuyện mới';b.title=b.textContent;b.onclick=()=>openChat(c.id);row.appendChild(b);const del=document.createElement('button');del.className='history-delete';del.type='button';del.title='Xóa cuộc trò chuyện';del.setAttribute('aria-label',`Xóa ${c.title||'cuộc trò chuyện'}`);del.innerHTML='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';del.disabled=busy;del.onclick=e=>{e.stopPropagation();deleteConversation(c.id)};row.appendChild(del);historyEl.appendChild(row)})}
function scrollBottom(){const box=$('.conversation');box.scrollTop=box.scrollHeight}
function addMessage(role,text,typing=false,reasoningText=''){const row=document.createElement('div');row.className=`message ${role}`;if(role==='assistant'){const av=document.createElement('div');av.className='msg-avatar';av.textContent='✳';row.appendChild(av)}const bubble=document.createElement('div');bubble.className='bubble';let result=bubble;if(role==='assistant'){let reasoningPanel=null,reasoningSummary=null,reasoningBody=null;if(typing||reasoningText){reasoningPanel=document.createElement('details');reasoningPanel.className='reasoning-panel';reasoningPanel.open=Boolean(typing);reasoningSummary=document.createElement('summary');reasoningSummary.textContent=typing?'Đang suy luận…':'Đã suy luận · bấm để xem';reasoningBody=document.createElement('div');reasoningBody.className='reasoning-body';reasoningBody.innerHTML=formatted(reasoningText);reasoningPanel.append(reasoningSummary,reasoningBody);bubble.appendChild(reasoningPanel)}const answer=document.createElement('div');answer.className='assistant-answer';answer.innerHTML=typing?'<span class="typing">Đang chờ câu trả lời…</span>':formatted(text);bubble.appendChild(answer);result={bubble,answer,reasoningPanel,reasoningSummary,reasoningBody}}else{bubble.innerHTML=formatted(text)}row.appendChild(bubble);messagesEl.appendChild(row);scrollBottom();return result}
function renderMessages(){messagesEl.innerHTML='';const c=active();welcome.style.display=c?.messages?.length?'none':'';(c?.messages||[]).forEach(m=>{if(m.role==='assistant'){const legacy=splitLegacyThink(m.content);addMessage(m.role,legacy.content,false,m.reasoning||legacy.reasoning)}else addMessage(m.role,m.content)});scrollBottom()}
function openChat(id){currentId=id;renderMessages();renderHistory();$('#sidebar').classList.remove('open')}
function newChat(){currentId=null;messagesEl.innerHTML='';welcome.style.display='';input.value='';input.focus();renderHistory();$('#sidebar').classList.remove('open')}
async function loadConversations(){
 const rows=await api('/rest/v1/conversations?select=id,title,messages,updated_at&order=updated_at.desc');
 conversations=(rows||[]).map(r=>({...r,messages:Array.isArray(r.messages)?r.messages.map(m=>{if(m.role==='assistant'){const legacy=splitLegacyThink(m.content);return{...m,content:legacy.content,reasoning:m.reasoning||legacy.reasoning}}return m}):[]}));currentId=conversations[0]?.id||null;renderHistory();renderMessages();
}
async function persistConversation(c){
 await api('/rest/v1/conversations?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id:c.id,title:c.title,messages:c.messages})});
}
async function deleteConversation(id){
 if(busy)return;const c=conversations.find(x=>x.id===id);if(!c)return;
 if(!window.confirm(`Xóa cuộc trò chuyện “${c.title||'Cuộc trò chuyện mới'}”? Thao tác này không thể hoàn tác.`))return;
 try{await api(`/rest/v1/conversations?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});conversations=conversations.filter(x=>x.id!==id);if(currentId===id)currentId=conversations[0]?.id||null;renderHistory();renderMessages()}catch(err){window.alert(`Không xóa được lịch sử: ${err.message}`)}
}
async function clearAllHistory(){
 if(busy||!conversations.length)return;
 if(!window.confirm('Xóa toàn bộ lịch sử chat của tài khoản này? Thao tác này không thể hoàn tác.'))return;
 try{const userId=session?.user?.id;if(!userId)throw new Error('Không xác định được tài khoản hiện tại.');await api(`/rest/v1/conversations?user_id=eq.${encodeURIComponent(userId)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});conversations=[];currentId=null;renderHistory();renderMessages()}catch(err){window.alert(`Không xóa được lịch sử: ${err.message}`)}
}
function showAuth(message=''){$('#authOverlay').classList.add('open');$('#authError').textContent=message;$('#emailInput').focus()}
function hideAuth(){$('#authOverlay').classList.remove('open')}
async function login(email,password){
 if(!configReady())throw new Error('Chưa cấu hình Supabase. Mở README.md và điền config.js trước.');
 const r=await fetch(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:cfg.SUPABASE_ANON_KEY,'content-type':'application/json'},body:JSON.stringify({email,password})});
 const j=await r.json();if(!r.ok)throw new Error(j.msg||j.message||j.error_description||'Email hoặc mật khẩu chưa đúng.');
 session={...j,expires_at:Date.now()/1000+(j.expires_in||3600)};saveSession();
}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const btn=$('#loginBtn');btn.disabled=true;$('#authError').textContent='Đang đăng nhập…';try{await login($('#emailInput').value.trim(),$('#passwordInput').value);await bootUser()}catch(err){$('#authError').textContent=err.message}finally{btn.disabled=false}});
async function bootUser(){
 try{await accessToken();$('#profileEmail').textContent=session.user?.email||'Tài khoản';hideAuth();await loadConversations();$('#status').className='status ok';$('#status span').textContent='Lịch sử đã đồng bộ'}catch(err){session=null;saveSession();showAuth(err.message)}
}
$('#logoutBtn').onclick=()=>{session=null;saveSession();conversations=[];currentId=null;renderHistory();renderMessages();showAuth()};$('#clearHistory').onclick=clearAllHistory;
async function send(text){
 text=(text||'').trim();if(!text||busy||!session)return;
 if(!currentId){const c={id:crypto.randomUUID(),title:text.length>42?text.slice(0,42)+'…':text,messages:[]};conversations.unshift(c);currentId=c.id;}
 const c=active();c.messages.push({role:'user',content:text});welcome.style.display='none';addMessage('user',text);const reply=addMessage('assistant','',true);input.value='';input.style.height='auto';busy=true;$('#sendBtn').disabled=true;input.disabled=true;renderHistory();let reasoning='',answer='';
 try{
   await persistConversation(c);
   const token=await accessToken();const r=await fetch(`${cfg.SUPABASE_URL}/functions/v1/chat`,{method:'POST',headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({messages:c.messages})});
   if(!r.ok){let err='Yêu cầu thất bại.';try{const j=await r.json();err=j.error||j.message||err;if(j.detail)err+=' — '+j.detail}catch{}throw new Error(err)}
   if(!r.body)throw new Error('Không nhận được luồng phản hồi.');
   const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
   while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const events=buffer.split(/\r?\n\r?\n/);buffer=events.pop()||'';for(const event of events){for(const line of event.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;try{const j=JSON.parse(data);const delta=j.choices?.[0]?.delta||{};reasoning+=delta.reasoning||delta.reasoning_content||'';answer+=delta.content||'';if(reply.reasoningPanel&&reasoning){reply.reasoningPanel.hidden=false;reply.reasoningSummary.textContent='Đang suy luận…';reply.reasoningBody.innerHTML=formatted(reasoning)}reply.answer.innerHTML=formatted(answer)||(reasoning?'<span class="typing">Đang tổng hợp câu trả lời…</span>':'<span class="typing">Đang suy luận…</span>');scrollBottom()}catch{}}}}
   if(!answer)throw new Error('Model chưa trả nội dung. Kiểm tra endpoint OpenAI-compatible.');
   if(reply.reasoningPanel){if(reasoning){reply.reasoningSummary.textContent='Đã suy luận · bấm để xem';reply.reasoningBody.innerHTML=formatted(reasoning);reply.reasoningPanel.hidden=false;reply.reasoningPanel.open=false}else reply.reasoningPanel.hidden=true}
   c.messages.push({role:'assistant',content:answer,...(reasoning?{reasoning}:{})});await persistConversation(c);
 }catch(err){reply.answer.innerHTML=`<span style="color:#e5a49d">${esc(err.message)}</span>`;if(reply.reasoningPanel&&reasoning){reply.reasoningSummary.textContent='Suy luận chưa hoàn tất · bấm để xem';reply.reasoningBody.innerHTML=formatted(reasoning);reply.reasoningPanel.hidden=false;reply.reasoningPanel.open=false}if(err.message.includes('đăng nhập')||err.message.includes('Phiên'))showAuth(err.message)}finally{busy=false;$('#sendBtn').disabled=false;input.disabled=false;renderHistory();input.focus();scrollBottom()}
}
$('#chatForm').addEventListener('submit',e=>{e.preventDefault();send(input.value)});input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px'});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(input.value)}});
$('#newChat').onclick=newChat;document.querySelectorAll('.suggestion').forEach(b=>b.onclick=()=>send(b.dataset.prompt));
$('#settingsBtn').onclick=()=>$('#overlay').classList.add('open');$('#closeModal').onclick=$('#doneBtn').onclick=()=>$('#overlay').classList.remove('open');$('#overlay').onclick=e=>{if(e.target===$('#overlay'))$('#overlay').classList.remove('open')};$('#openSide').onclick=()=>$('#sidebar').classList.add('open');$('#closeSide').onclick=()=>$('#sidebar').classList.remove('open');
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();newChat()}if(e.key==='Escape')$('#sidebar').classList.remove('open')});
(async()=>{try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{session=null}if(session)await bootUser();else showAuth();if(!configReady())$('#authError').textContent='Chưa cấu hình Supabase — xem README.md.'})();
