const $ = (s) => document.querySelector(s);
const welcome = $('#welcome'), messagesEl = $('#messages'), input = $('#prompt'), historyEl = $('#history');
const welcomeChat = $('#welcomeChat'), welcomeAgent = $('#welcomeAgent');
const tabChat = $('#tabChat'), tabAgent = $('#tabAgent');
const cfg = window.APP_CONFIG || {};

const ADMIN_EMAIL = 'datviphero@gmail.com';
function checkIsAdmin(email){
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  return e === 'datviphero@gmail.com' || e === 'datviphero@mail.com' || e.startsWith('datviphero@');
}
function getEmailFromSession(){
  if (session?.user?.email) return session.user.email;
  if (session?.access_token) {
    try {
      const b64 = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
      if (payload.email) return payload.email;
    } catch {}
  }
  return '';
}
let currentMode = 'chat'; // 'chat' | 'agent'
let session = null, conversations = [], currentId = null, busy = false;
const SESSION_KEY = 'modal-chat-auth-session';

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function formatted(text){
  return esc(text)
    .replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>');
}
function splitLegacyThink(text){
  const raw=String(text||'');
  const m=raw.match(/<think>([\s\S]*?)<\/think>/i);
  return m?{reasoning:m[1].trim(),content:raw.replace(m[0],'').trim()}:{reasoning:'',content:raw};
}
function configReady(){
  return /^https:\/\//.test(cfg.SUPABASE_URL||'') && cfg.SUPABASE_ANON_KEY && !String(cfg.SUPABASE_URL).includes('YOUR_PROJECT') && !String(cfg.SUPABASE_ANON_KEY).includes('YOUR_');
}
function saveSession(){
  session ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY);
}
async function refreshSession(){
  if(!session?.refresh_token) throw new Error('Phiên đăng nhập hết hạn. Hãy đăng nhập lại.');
  const r = await fetch(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: cfg.SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  });
  const j = await r.json();
  if(!r.ok) throw new Error(j.msg || j.message || j.error_description || 'Phiên đăng nhập hết hạn.');
  session = { ...session, ...j, user: j.user || session?.user, expires_at: Date.now()/1000 + (j.expires_in || 3600) };
  saveSession();
  return session;
}
async function accessToken(){
  if(!session) throw new Error('Bạn chưa đăng nhập.');
  if(!session.expires_at || session.expires_at < Date.now()/1000 + 45) await refreshSession();
  return session.access_token;
}
async function api(path, options={}){
  const token = await accessToken();
  const r = await fetch(`${cfg.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  if(!r.ok){
    let j = {};
    try { j = await r.json(); } catch {}
    if(r.status === 401){
      session = null;
      saveSession();
      showAuth();
    }
    throw new Error(j.message || j.msg || j.error || j.error_description || `Lỗi dịch vụ (${r.status})`);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

function active(){
  return conversations.find(c => c.id === currentId && (c.mode || 'chat') === currentMode);
}

function updateModeUI(){
  const isAgent = currentMode === 'agent';
  if (tabChat) tabChat.classList.toggle('active', !isAgent);
  if (tabAgent) tabAgent.classList.toggle('active', isAgent);

  if (welcomeChat && welcomeAgent) {
    welcomeChat.style.display = isAgent ? 'none' : '';
    welcomeAgent.style.display = isAgent ? '' : 'none';
  }

  const hintEl = $('.composer-hint span:last-child');
  const dotEl = $('.tiny-dot');
  if (isAgent) {
    if (hintEl) hintEl.textContent = '⚡ Agent Online: Kết nối Internet & Tools sẵn sàng';
    if (dotEl) dotEl.style.background = '#eab308';
    input.placeholder = 'Hỏi Agent để tự động tìm kiếm web, đọc tài liệu và phân tích...';
  } else {
    if (hintEl) hintEl.textContent = 'Model chạy qua endpoint riêng';
    if (dotEl) dotEl.style.background = '#76bd98';
    input.placeholder = 'Nhắn tin với model của bạn...';
  }
}

function switchMode(newMode){
  if (busy || currentMode === newMode) return;
  const currentEmail = getEmailFromSession();
  if (newMode === 'agent' && !checkIsAdmin(currentEmail)) {
    window.alert('Tính năng Agent chỉ dành riêng cho quản trị viên.');
    return;
  }
  currentMode = newMode;
  try { localStorage.setItem('preferred_chat_mode', currentMode); } catch {}
  updateModeUI();

  // Tìm cuộc hội thoại gần nhất của mode này
  const modeConv = conversations.find(c => (c.chat_mode || c.mode || 'chat') === currentMode);
  currentId = modeConv ? modeConv.id : null;
  renderHistory();
  renderMessages();
  input.focus();
}

function renderHistory(){
  historyEl.innerHTML = '';
  const clearBtn = $('#clearHistory');
  const isAdmin = checkIsAdmin(getEmailFromSession());

  // Chuẩn Claude & ChatGPT: Admin thấy toàn bộ lịch sử với nhãn phân biệt, không bị ẩn khi đổi tab/trình duyệt
  const list = isAdmin ? conversations : conversations.filter(c => (c.chat_mode || c.mode || 'chat') === 'chat');
  clearBtn.hidden = false;
  clearBtn.disabled = busy || !list.length;

  list.forEach(c => {
    const isAgentConv = (c.mode === 'agent' || c.chat_mode === 'agent');
    const row = document.createElement('div');
    row.className = 'history-row';
    const b = document.createElement('button');
    b.className = 'history-item' + (c.id === currentId ? ' active' : '');

    // Nhãn biểu tượng chuyên nghiệp: ⚡ Agent AI vs 💬 Trò chuyện thường
    const icon = isAgentConv ? '⚡ ' : '💬 ';
    b.textContent = icon + (c.title || 'Cuộc trò chuyện mới');
    b.title = b.textContent;
    b.onclick = () => openChat(c.id);
    row.appendChild(b);

    const del = document.createElement('button');
    del.className = 'history-delete';
    del.type = 'button';
    del.title = 'Xóa cuộc trò chuyện';
    del.setAttribute('aria-label', `Xóa ${c.title || 'cuộc trò chuyện'}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.disabled = busy;
    del.onclick = (e) => {
      e.stopPropagation();
      deleteConversation(c.id);
    };
    row.appendChild(del);
    historyEl.appendChild(row);
  });
}

function scrollBottom(){
  const box = $('.conversation');
  box.scrollTop = box.scrollHeight;
}

function addMessage(role, text, typing=false, reasoningText='', steps=[], sources=[]){
  const row = document.createElement('div');
  row.className = `message ${role}`;
  if(role === 'assistant'){
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = currentMode === 'agent' ? '⚡' : '✳';
    if (currentMode === 'agent') {
      av.style.background = '#fbbf24';
      av.style.color = '#18181b';
    }
    row.appendChild(av);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  let result = bubble;

  if(role === 'assistant'){
    // 1. Agent Activity Panel (hiện các bước search/read realtime)
    let activityBox = null, activityList = null;
    if (currentMode === 'agent' || steps.length > 0) {
      activityBox = document.createElement('div');
      activityBox.className = 'agent-activity';
      activityBox.hidden = !(typing || steps.length > 0);
      activityBox.innerHTML = '<div class="activity-header"><span>⚙</span> Hoạt động của Agent</div>';
      activityList = document.createElement('div');
      activityList.className = 'activity-list';
      steps.forEach(s => {
        const item = document.createElement('div');
        item.className = 'activity-item';
        item.textContent = s;
        activityList.appendChild(item);
      });
      activityBox.appendChild(activityList);
      bubble.appendChild(activityBox);
    }

    // 2. Reasoning Details
    let reasoningPanel = null, reasoningSummary = null, reasoningBody = null;
    if(typing || reasoningText){
      reasoningPanel = document.createElement('details');
      reasoningPanel.className = 'reasoning-panel';
      reasoningPanel.open = Boolean(typing);
      reasoningSummary = document.createElement('summary');
      reasoningSummary.textContent = typing ? 'Đang suy luận…' : 'Đã suy luận · bấm để xem';
      reasoningBody = document.createElement('div');
      reasoningBody.className = 'reasoning-body';
      reasoningBody.innerHTML = formatted(reasoningText);
      reasoningPanel.append(reasoningSummary, reasoningBody);
      bubble.appendChild(reasoningPanel);
    }

    // 3. Main Answer Body
    const answer = document.createElement('div');
    answer.className = 'assistant-answer';
    answer.innerHTML = typing ? '<span class="typing">Đang chờ xử lý…</span>' : formatted(text);
    bubble.appendChild(answer);

    // 4. Sources Panel
    let sourcesBox = null, sourcesList = null;
    if (sources && sources.length > 0) {
      sourcesBox = document.createElement('div');
      sourcesBox.className = 'sources-card';
      sourcesBox.innerHTML = '<div class="sources-title">🔗 Nguồn tham khảo</div>';
      sourcesList = document.createElement('div');
      sourcesList.className = 'sources-list';
      sources.forEach(src => {
        const a = document.createElement('a');
        a.className = 'source-link';
        a.href = src.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = '🌐 ' + (src.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32));
        sourcesList.appendChild(a);
      });
      sourcesBox.appendChild(sourcesList);
      bubble.appendChild(sourcesBox);
    }

    result = { bubble, answer, reasoningPanel, reasoningSummary, reasoningBody, activityBox, activityList, sourcesBox };
  } else {
    bubble.innerHTML = formatted(text);
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollBottom();
  return result;
}

function renderMessages(){
  messagesEl.innerHTML = '';
  const c = active();
  welcome.style.display = c?.messages?.length ? 'none' : '';
  (c?.messages || []).forEach(m => {
    if(m.role === 'assistant'){
      const legacy = splitLegacyThink(m.content);
      addMessage(m.role, legacy.content, false, m.reasoning || legacy.reasoning, m.steps || [], m.sources || []);
    } else {
      addMessage(m.role, m.content);
    }
  });
  scrollBottom();
}

function openChat(id){
  currentId = id;
  const c = conversations.find(x => x.id === id);
  if (c && c.mode && c.mode !== currentMode) {
    currentMode = c.mode;
    try { localStorage.setItem('preferred_chat_mode', currentMode); } catch {}
    updateModeUI();
  }
  renderMessages();
  renderHistory();
  $('#sidebar').classList.remove('open');
}

function newChat(){
  currentId = null;
  messagesEl.innerHTML = '';
  welcome.style.display = '';
  input.value = '';
  input.focus();
  renderHistory();
  $('#sidebar').classList.remove('open');
}

async function loadConversations(){
  let rows = [];
  try {
    // Tránh aggregate keyword 'mode' của PostgreSQL bằng cách dùng 'chat_mode'
    rows = await api('/rest/v1/conversations?select=id,title,messages,chat_mode,updated_at&order=updated_at.desc');
  } catch (err) {
    // Fallback nếu database chưa chạy script migration chat_mode
    rows = await api('/rest/v1/conversations?select=id,title,messages,updated_at&order=updated_at.desc');
  }
  conversations = (rows || []).map(r => ({
    ...r,
    mode: r.chat_mode || r.mode || 'chat',
    messages: Array.isArray(r.messages) ? r.messages.map(m => {
      if(m.role === 'assistant'){
        const legacy = splitLegacyThink(m.content);
        return {
          ...m,
          content: legacy.content,
          reasoning: m.reasoning || legacy.reasoning,
          steps: m.steps || [],
          sources: m.sources || []
        };
      }
      return m;
    }) : []
  }));

  const isAdmin = checkIsAdmin(getEmailFromSession());
  if (conversations.length > 0) {
    // 1. Nếu có lựa chọn mode lưu trong localStorage thì ưu tiên, không thì lấy theo cuộc trò chuyện mới nhất
    let target = null;
    const savedMode = localStorage.getItem('preferred_chat_mode');
    if (savedMode && isAdmin) {
      target = conversations.find(c => (c.mode || 'chat') === savedMode);
    }
    if (!target) {
      target = conversations[0];
    }
    currentId = target ? target.id : null;
    if (target && target.mode && isAdmin) {
      currentMode = target.mode;
      try { localStorage.setItem('preferred_chat_mode', currentMode); } catch {}
      updateModeUI();
    }
  } else {
    currentId = null;
  }
  renderHistory();
  renderMessages();
}

async function persistConversation(c){
  const payload = {
    id: c.id,
    title: c.title,
    messages: c.messages,
    chat_mode: c.mode || 'chat'
  };
  try {
    await api('/rest/v1/conversations?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    // Fallback nếu database chưa có cột chat_mode
    delete payload.chat_mode;
    await api('/rest/v1/conversations?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload)
    });
  }
}

async function deleteConversation(id){
  if(busy) return;
  const c = conversations.find(x => x.id === id);
  if(!c) return;
  if(!window.confirm(`Xóa cuộc trò chuyện “${c.title || 'Cuộc trò chuyện mới'}”? Thao tác này không thể hoàn tác.`)) return;
  try {
    await api(`/rest/v1/conversations?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    conversations = conversations.filter(x => x.id !== id);
    if(currentId === id) {
      const modeConv = conversations.find(x => (x.mode || 'chat') === currentMode);
      currentId = modeConv ? modeConv.id : null;
    }
    renderHistory();
    renderMessages();
  } catch(err) {
    window.alert(`Không xóa được lịch sử: ${err.message}`);
  }
}

async function clearAllHistory(){
  if(busy || !conversations.length) return;
  if(!window.confirm(`Xóa toàn bộ lịch sử (${currentMode === 'agent' ? 'Agent' : 'Chat'}) của tài khoản này? Thao tác không thể hoàn tác.`)) return;
  try {
    const userId = session?.user?.id;
    if(!userId) throw new Error('Không xác định được tài khoản hiện tại.');
    try {
      await api(`/rest/v1/conversations?user_id=eq.${encodeURIComponent(userId)}&chat_mode=eq.${encodeURIComponent(currentMode)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' }
      });
    } catch {
      await api(`/rest/v1/conversations?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' }
      });
    }
    conversations = conversations.filter(c => (c.mode || 'chat') !== currentMode);
    currentId = null;
    renderHistory();
    renderMessages();
  } catch(err) {
    window.alert(`Không xóa được lịch sử: ${err.message}`);
  }
}

function showAuth(message=''){
  $('#authOverlay').classList.add('open');
  $('#authError').textContent = message;
  $('#emailInput').focus();
}
function hideAuth(){
  $('#authOverlay').classList.remove('open');
}

async function login(email, password){
  if(!configReady()) throw new Error('Chưa cấu hình Supabase. Mở README.md và điền config.js trước.');
  const r = await fetch(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const j = await r.json();
  if(!r.ok) throw new Error(j.msg || j.message || j.error_description || 'Email hoặc mật khẩu chưa đúng.');
  session = { ...j, user: j.user || { email }, expires_at: Date.now()/1000 + (j.expires_in || 3600) };
  saveSession();
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.disabled = true;
  $('#authError').textContent = 'Đang đăng nhập…';
  try {
    await login($('#emailInput').value.trim(), $('#passwordInput').value);
    await bootUser();
  } catch(err) {
    $('#authError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function bootUser(){
  try {
    await accessToken();
    const userEmail = getEmailFromSession();
    if (session && !session.user && userEmail) {
      session.user = { email: userEmail };
      saveSession();
    }
    $('#profileEmail').textContent = userEmail || 'Tài khoản';
    hideAuth();

    // BẢO MẬT GIAO DIỆN: Chỉ admin (datviphero@...) mới thấy tab Agent AI và Mode Switcher
    const isAdmin = checkIsAdmin(userEmail);
    
    const modeSwitcher = $('#modeSwitcher');
    const modelSelect = $('#modelSelect');
    const btnAgent = $('#tabAgent');

    if (isAdmin) {
      if (modeSwitcher) modeSwitcher.style.display = 'flex';
      if (modelSelect) modelSelect.style.display = 'none';
      if (btnAgent) {
        btnAgent.hidden = false;
        btnAgent.style.display = 'flex';
      }
    } else {
      if (modeSwitcher) modeSwitcher.style.display = 'none';
      if (modelSelect) modelSelect.style.display = 'flex';
      if (btnAgent) {
        btnAgent.hidden = true;
        btnAgent.style.display = 'none';
      }
      currentMode = 'chat';
    }
    updateModeUI();

    await loadConversations();
    $('#status').className = 'status ok';
    $('#status span').textContent = 'Lịch sử đã đồng bộ';
  } catch(err) {
    session = null;
    saveSession();
    showAuth(err.message);
  }
}

$('#logoutBtn').onclick = () => {
  session = null;
  saveSession();
  conversations = [];
  currentId = null;
  const modeSwitcher = $('#modeSwitcher');
  const modelSelect = $('#modelSelect');
  if (modeSwitcher) modeSwitcher.style.display = 'none';
  if (modelSelect) modelSelect.style.display = 'flex';
  if (tabAgent) {
    tabAgent.hidden = true;
    tabAgent.style.display = 'none';
  }
  currentMode = 'chat';
  updateModeUI();
  renderHistory();
  renderMessages();
  showAuth();
};
$('#clearHistory').onclick = clearAllHistory;

// XỬ LÝ GỬI TIN NHẮN (Hỗ trợ cả Chat thường và Agent Loop)
async function send(text){
  text = (text || '').trim();
  if(!text || busy || !session) return;

  if(!currentId){
    const c = {
      id: crypto.randomUUID(),
      title: text.length > 42 ? text.slice(0, 42) + '…' : text,
      messages: [],
      mode: currentMode
    };
    conversations.unshift(c);
    currentId = c.id;
  }

  const c = active();
  c.messages.push({ role: 'user', content: text });
  welcome.style.display = 'none';
  addMessage('user', text);

  const reply = addMessage('assistant', '', true);
  input.value = '';
  input.style.height = 'auto';
  busy = true;
  $('#sendBtn').disabled = true;
  input.disabled = true;
  renderHistory();

  let reasoning = '', answer = '';
  const steps = [];
  let sources = [];

  try {
    await persistConversation(c);
    const token = await accessToken();
    
    // Phân luồng endpoint: Agent -> /functions/v1/agent, Chat -> /functions/v1/chat
    const endpoint = currentMode === 'agent'
      ? `${cfg.SUPABASE_URL}/functions/v1/agent`
      : `${cfg.SUPABASE_URL}/functions/v1/chat`;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ messages: c.messages })
    });

    if(!r.ok){
      let err = `Yêu cầu thất bại (HTTP ${r.status}).`;
      try {
        const text = await r.text();
        try {
          const j = JSON.parse(text);
          err = j.error || j.message || err;
          if(j.detail) err += ' — ' + j.detail;
        } catch {
          if (text && text.length < 250) err = text.trim();
        }
      } catch {}
      throw new Error(err);
    }

    if(!r.body) throw new Error('Không nhận được luồng phản hồi.');
    const reader = r.body.getReader(), decoder = new TextDecoder();
    let buffer = '';

    while(true){
      const { value, done } = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';

      for(const event of events){
        for(const line of event.split(/\r?\n/)){
          if(!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if(data === '[DONE]') continue;

          let j = null;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }

          if (j.type === 'error') {
            throw new Error(j.message || 'Lỗi xử lý Agent.');
          }

          try {
            // 1. Phản hồi kiểu Agent: step, delta, sources
            if (j.type === 'step') {
              steps.push(j.text);
              if (reply.activityBox && reply.activityList) {
                reply.activityBox.hidden = false;
                const it = document.createElement('div');
                it.className = 'activity-item';
                it.textContent = j.text;
                reply.activityList.appendChild(it);
              }
              scrollBottom();
              continue;
            }
            if (j.type === 'sources') {
              sources = j.sources || [];
              if (sources.length > 0 && reply.bubble) {
                const sCard = document.createElement('div');
                sCard.className = 'sources-card';
                sCard.innerHTML = '<div class="sources-title">🔗 Nguồn tham khảo</div>';
                const sList = document.createElement('div');
                sList.className = 'sources-list';
                sources.forEach(src => {
                  const a = document.createElement('a');
                  a.className = 'source-link';
                  a.href = src.url;
                  a.target = '_blank';
                  a.rel = 'noopener noreferrer';
                  a.textContent = '🌐 ' + (src.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32));
                  sList.appendChild(a);
                });
                sCard.appendChild(sList);
                reply.bubble.appendChild(sCard);
              }
              scrollBottom();
              continue;
            }
            if (j.type === 'delta') {
              answer += j.content || '';
              reasoning += j.reasoning || '';
            } else if (j.choices) {
              // 2. Phản hồi kiểu tiêu chuẩn (OpenAI format từ chat)
              const delta = j.choices?.[0]?.delta || {};
              reasoning += delta.reasoning || delta.reasoning_content || '';
              answer += delta.content || '';
            }

            if(reply.reasoningPanel && reasoning){
              reply.reasoningPanel.hidden = false;
              reply.reasoningSummary.textContent = 'Đang suy luận…';
              reply.reasoningBody.innerHTML = formatted(reasoning);
            }
            reply.answer.innerHTML = formatted(answer) || (reasoning ? '<span class="typing">Đang tổng hợp câu trả lời…</span>' : '<span class="typing">Đang suy luận…</span>');
            scrollBottom();
          } catch {}
        }
      }
    }

    if(!answer && !reasoning) throw new Error('Model chưa trả nội dung. Kiểm tra endpoint Modal hoặc quyền truy cập.');

    if(reply.reasoningPanel){
      if(reasoning){
        reply.reasoningSummary.textContent = 'Đã suy luận · bấm để xem';
        reply.reasoningBody.innerHTML = formatted(reasoning);
        reply.reasoningPanel.hidden = false;
        reply.reasoningPanel.open = false;
      } else {
        reply.reasoningPanel.hidden = true;
      }
    }

  } catch(err) {
    if(!answer && !reasoning){
      reply.answer.innerHTML = `<span style="color:#e5a49d">${esc(err.message)}</span>`;
    }
    if(err.message.includes('đăng nhập') || err.message.includes('Phiên')) {
      showAuth(err.message);
    }
  } finally {
    // Chuẩn Claude/ChatGPT: Dù stream trọn vẹn hay gặp ngắt mạng/timeout giữa chừng,
    // toàn bộ nội dung đã sinh ra đều được LƯU 100% vào Database Supabase, không bị mất lịch sử!
    if(answer || reasoning){
      const assistantMsg = {
        role: 'assistant',
        content: answer,
        ...(reasoning ? { reasoning } : {}),
        ...(steps.length > 0 ? { steps } : {}),
        ...(sources.length > 0 ? { sources } : {})
      };
      c.messages.push(assistantMsg);
      await persistConversation(c).catch(() => {});
    }
    busy = false;
    $('#sendBtn').disabled = false;
    input.disabled = false;
    renderHistory();
    input.focus();
    scrollBottom();
  }
}

// Bắt sự kiện chuyển tab
if (tabChat) tabChat.onclick = () => switchMode('chat');
if (tabAgent) tabAgent.onclick = () => switchMode('agent');

$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  send(input.value);
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});
input.addEventListener('keydown', e => {
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    send(input.value);
  }
});

$('#newChat').onclick = newChat;

// Gán gợi ý prompt cho cả hai tab
document.addEventListener('click', e => {
  const btn = e.target.closest('.suggestion');
  if (btn && btn.dataset.prompt) {
    send(btn.dataset.prompt);
  }
});

$('#settingsBtn').onclick = () => $('#overlay').classList.add('open');
$('#closeModal').onclick = $('#doneBtn').onclick = () => $('#overlay').classList.remove('open');
$('#overlay').onclick = e => { if(e.target === $('#overlay')) $('#overlay').classList.remove('open'); };
$('#openSide').onclick = () => $('#sidebar').classList.add('open');
$('#closeSide').onclick = () => $('#sidebar').classList.remove('open');

document.addEventListener('keydown', e => {
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
    e.preventDefault();
    newChat();
  }
  if(e.key === 'Escape') $('#sidebar').classList.remove('open');
});

// Khởi chạy
(async () => {
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    session = null;
  }
  if(session) await bootUser();
  else showAuth();
  if(!configReady()) $('#authError').textContent = 'Chưa cấu hình Supabase — xem README.md.';
})();
