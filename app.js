const $ = (s) => document.querySelector(s);
const welcome = $('#welcome'), messagesEl = $('#messages'), input = $('#prompt'), historyEl = $('#history');
const welcomeChat = $('#welcomeChat');
const tabChat = $('#tabChat'), tabImage = $('#tabImage');
const conversationSection = $('#conversation'), chatComposerWrap = $('#chatComposerWrap');
const imageStudio = $('#imageStudio');
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

let currentMode = 'chat'; // 'chat' | 'image'
let session = null, conversations = [], currentId = null, busy = false;
let pendingImage = null; // Base64 data URL của ảnh người dùng đính kèm trong chat
const SESSION_KEY = 'modal-chat-auth-session';
const RECENT_IMAGES_KEY = 'modal-studio-recent-images';

// Quản lý kích thước ảnh được chọn
let currentWidth = 1024;
let currentHeight = 1024;
let recentImages = [];
let referenceImage = null; // Base64 của ảnh mẫu khuôn mặt/dáng người (Image-to-Image)

// Quản lý Ảnh Mẫu Tham Chiếu (Reference Image / Face Guidance)
function setReferenceImage(dataUrl){
  referenceImage = dataUrl;
  const dropzone = $('#refDropzone');
  const previewWrap = $('#refPreviewWrap');
  const previewImg = $('#refPreviewImg');
  const clearLink = $('#clearRefBtn');
  if (previewImg) previewImg.src = dataUrl;
  if (dropzone) dropzone.style.display = 'none';
  if (previewWrap) previewWrap.style.display = 'flex';
  if (clearLink) clearLink.style.display = 'inline-block';
}

function clearReferenceImage(){
  referenceImage = null;
  const dropzone = $('#refDropzone');
  const previewWrap = $('#refPreviewWrap');
  const previewImg = $('#refPreviewImg');
  const clearLink = $('#clearRefBtn');
  const fileInput = $('#refImageInput');
  if (previewImg) previewImg.src = '';
  if (dropzone) dropzone.style.display = 'block';
  if (previewWrap) previewWrap.style.display = 'none';
  if (clearLink) clearLink.style.display = 'none';
  if (fileInput) fileInput.value = '';
}

function handleRefImageFile(file){
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const raw = e.target.result;
    const img = new Image();
    img.onload = () => {
      const maxDim = 1344;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      setReferenceImage(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.src = raw;
  };
  reader.readAsDataURL(file);
}

// =========================================================================
// XỬ LÝ NÉN VÀ ĐỌC HÌNH ẢNH TRONG CHAT
// =========================================================================
function setPendingImage(dataUrl){
  pendingImage = dataUrl;
  const previewBox = $('#imagePreviewContainer');
  const previewImg = $('#imagePreviewImg');
  const attachBtn = $('#attachBtn');
  if (previewBox && previewImg) {
    previewImg.src = dataUrl;
    previewBox.style.display = 'flex';
  }
  if (attachBtn) attachBtn.classList.add('active');
}

function clearPendingImage(){
  pendingImage = null;
  const previewBox = $('#imagePreviewContainer');
  const previewImg = $('#imagePreviewImg');
  const attachBtn = $('#attachBtn');
  const fileInput = $('#imageInput');
  if (previewBox) previewBox.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (attachBtn) attachBtn.classList.remove('active');
  if (fileInput) fileInput.value = '';
}

function handleImageFile(file){
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const rawDataUrl = e.target.result;
    const img = new Image();
    img.onload = () => {
      const maxDim = 1600;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const optimizedUrl = canvas.toDataURL('image/jpeg', 0.88);
      setPendingImage(optimizedUrl);
    };
    img.src = rawDataUrl;
  };
  reader.readAsDataURL(file);
}

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
  return conversations.find(c => c.id === currentId);
}

// =========================================================================
// CHUYỂN ĐỔI CHẾ ĐỘ: CHAT vs TẠO HÌNH ẢNH
// =========================================================================
function updateModeUI(){
  const isImg = currentMode === 'image';
  if (tabChat) tabChat.classList.toggle('active', !isImg);
  if (tabImage) tabImage.classList.toggle('active', isImg);

  const modelPill = $('#modelPill');
  const modelName = $('#modelName');

  if (isImg) {
    if (conversationSection) conversationSection.style.display = 'none';
    if (chatComposerWrap) chatComposerWrap.style.display = 'none';
    if (imageStudio) imageStudio.style.display = 'flex';
    if (modelPill) modelPill.textContent = 'IMAGE GPU';
    if (modelName) modelName.textContent = 'Studio Tạo Ảnh (Uncensored)';
  } else {
    if (conversationSection) conversationSection.style.display = '';
    if (chatComposerWrap) chatComposerWrap.style.display = '';
    if (imageStudio) imageStudio.style.display = 'none';
    if (modelPill) modelPill.textContent = 'MODAL';
    if (modelName) modelName.textContent = 'Model của bạn';
  }
}

function switchMode(newMode){
  if (busy || currentMode === newMode) return;
  const currentEmail = getEmailFromSession();
  if (newMode === 'image' && !checkIsAdmin(currentEmail)) {
    window.alert('Tính năng Tạo Ảnh chỉ dành riêng cho tài khoản datviphero@gmail.com.');
    return;
  }
  currentMode = newMode;
  try { localStorage.setItem('preferred_mode', currentMode); } catch {}
  updateModeUI();

  if (currentMode === 'chat') {
    renderHistory();
    renderMessages();
    input.focus();
  }
}

function renderHistory(){
  historyEl.innerHTML = '';
  const clearBtn = $('#clearHistory');
  clearBtn.hidden = false;
  clearBtn.disabled = busy || !conversations.length;

  conversations.forEach(c => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const b = document.createElement('button');
    b.className = 'history-item' + (c.id === currentId ? ' active' : '');
    b.textContent = '💬 ' + (c.title || 'Cuộc trò chuyện mới');
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

function addMessage(role, text, typing=false, reasoningText='', steps=[], sources=[], image=''){
  const row = document.createElement('div');
  row.className = `message ${role}`;
  if(role === 'assistant'){
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.textContent = '✳';
    row.appendChild(av);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  let result = bubble;

  if(image){
    const imgContainer = document.createElement('div');
    imgContainer.className = 'chat-attached-image';
    const img = document.createElement('img');
    img.src = image;
    img.alt = 'Ảnh đính kèm';
    img.onclick = () => window.open(image, '_blank');
    imgContainer.appendChild(img);
    bubble.appendChild(imgContainer);
  }

  let reasoningPanel = null, reasoningSummary = null, reasoningBody = null;
  if(role === 'assistant'){
    reasoningPanel = document.createElement('details');
    reasoningPanel.className = 'think-panel';
    reasoningSummary = document.createElement('summary');
    reasoningSummary.className = 'think-summary';
    reasoningSummary.textContent = reasoningText ? 'Đã suy luận · bấm để xem' : 'Đang suy luận…';
    reasoningBody = document.createElement('div');
    reasoningBody.className = 'think-body';
    reasoningBody.innerHTML = formatted(reasoningText);
    reasoningPanel.appendChild(reasoningSummary);
    reasoningPanel.appendChild(reasoningBody);
    reasoningPanel.hidden = !reasoningText && !typing;
    bubble.appendChild(reasoningPanel);
  }

  const answer = document.createElement('div');
  answer.className = 'answer';
  answer.innerHTML = typing ? '<span class="typing">Đang suy luận…</span>' : formatted(text);
  bubble.appendChild(answer);

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollBottom();
  return { row, bubble, reasoningPanel, reasoningSummary, reasoningBody, answer };
}

function renderMessages(){
  messagesEl.innerHTML = '';
  const c = active();
  if(!c || !c.messages || !c.messages.length){
    welcome.style.display = 'block';
    return;
  }
  welcome.style.display = 'none';
  c.messages.forEach(m => {
    let reasoning = m.reasoning || '';
    let content = m.content || '';
    if(!reasoning && m.role === 'assistant'){
      const parsed = splitLegacyThink(content);
      reasoning = parsed.reasoning;
      content = parsed.content;
    }
    addMessage(m.role, content, false, reasoning, m.steps || [], m.sources || [], m.image || '');
  });
}

async function loadConversations(){
  try {
    const data = await api('/rest/v1/conversations?select=id,title,messages,created_at,updated_at&order=updated_at.desc');
    conversations = (data || []).map(row => ({
      id: row.id,
      title: row.title,
      messages: Array.isArray(row.messages) ? row.messages : []
    }));
    if(!currentId && conversations.length) currentId = conversations[0].id;
    renderHistory();
    renderMessages();
  } catch(err) {
    console.error('Lỗi tải lịch sử:', err);
    conversations = [];
    renderHistory();
    renderMessages();
  }
}

async function persistConversation(c){
  await api(`/rest/v1/conversations?id=eq.${c.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      title: c.title,
      messages: c.messages,
      updated_at: new Date().toISOString()
    })
  });
}

function newChat(){
  if(busy) return;
  if(currentMode === 'image'){
    switchMode('chat');
  }
  currentId = null;
  renderHistory();
  renderMessages();
  input.value = '';
  input.focus();
}

function openChat(id){
  if(busy || currentId === id) return;
  if(currentMode === 'image'){
    switchMode('chat');
  }
  currentId = id;
  renderHistory();
  renderMessages();
  input.focus();
}

async function deleteConversation(id){
  if(busy) return;
  try {
    await api(`/rest/v1/conversations?id=eq.${id}`, { method: 'DELETE' });
    conversations = conversations.filter(c => c.id !== id);
    if(currentId === id){
      currentId = conversations.length ? conversations[0].id : null;
    }
    renderHistory();
    renderMessages();
  } catch(err) {
    window.alert(`Không xóa được cuộc trò chuyện: ${err.message}`);
  }
}

async function clearAllHistory(){
  if(busy || !conversations.length) return;
  if(!window.confirm('Xóa toàn bộ lịch sử trò chuyện của tài khoản này? Thao tác không thể hoàn tác.')) return;
  try {
    const ids = conversations.map(c => c.id);
    await api(`/rest/v1/conversations?id=in.(${ids.join(',')})`, { method: 'DELETE' });
    conversations = [];
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

    // BẢO MẬT: Chỉ tài khoản datviphero@gmail.com mới thấy Tab Tạo Ảnh & Mode Switcher
    const isAdmin = checkIsAdmin(userEmail);
    const modeSwitcher = $('#modeSwitcher');
    const modelSelect = $('#modelSelect');
    const btnImage = $('#tabImage');

    if (isAdmin) {
      if (modeSwitcher) modeSwitcher.style.display = 'flex';
      if (modelSelect) modelSelect.style.display = 'none';
      if (btnImage) {
        btnImage.hidden = false;
        btnImage.style.display = 'flex';
      }
    } else {
      if (modeSwitcher) modeSwitcher.style.display = 'none';
      if (modelSelect) modelSelect.style.display = 'flex';
      if (btnImage) {
        btnImage.hidden = true;
        btnImage.style.display = 'none';
      }
      currentMode = 'chat';
    }
    updateModeUI();

    await loadConversations();
    loadRecentImages();
    $('#status').className = 'status ok';
    $('#status span').textContent = 'Sẵn sàng';
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
  if (tabImage) {
    tabImage.hidden = true;
    tabImage.style.display = 'none';
  }
  currentMode = 'chat';
  updateModeUI();
  renderHistory();
  renderMessages();
  showAuth();
};
$('#clearHistory').onclick = clearAllHistory;

// =========================================================================
// XỬ LÝ CHAT THƯỜNG
// =========================================================================
async function send(text){
  text = (text || '').trim();
  const imgToSend = pendingImage;
  if((!text && !imgToSend) || busy || !session) return;

  if(!text && imgToSend){
    text = 'Hãy đọc hiểu và phân tích chi tiết hình ảnh này.';
  }

  if(!currentId){
    const c = {
      id: crypto.randomUUID(),
      title: text.length > 42 ? text.slice(0, 42) + '…' : text,
      messages: []
    };
    conversations.unshift(c);
    currentId = c.id;
  }

  const c = active();
  const userMsg = { role: 'user', content: text };
  if(imgToSend){
    userMsg.image = imgToSend;
  }
  c.messages.push(userMsg);
  welcome.style.display = 'none';
  addMessage('user', text, false, '', [], [], imgToSend);
  clearPendingImage();

  const reply = addMessage('assistant', '', true);
  input.value = '';
  input.style.height = 'auto';
  busy = true;
  $('#sendBtn').disabled = true;
  input.disabled = true;
  renderHistory();

  let reasoning = '', answer = '';

  try {
    await persistConversation(c);
    const token = await accessToken();
    
    const r = await fetch(`${cfg.SUPABASE_URL}/functions/v1/chat`, {
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
        const textErr = await r.text();
        const j = JSON.parse(textErr);
        err = j.error || j.message || err;
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
          try { j = JSON.parse(data); } catch { continue; }

          if (j.choices) {
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
        }
      }
    }

    if(!answer && !reasoning) throw new Error('Model chưa trả nội dung. Kiểm tra endpoint Modal.');

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
    if(answer || reasoning){
      const assistantMsg = {
        role: 'assistant',
        content: answer,
        ...(reasoning ? { reasoning } : {})
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

// =========================================================================
// STUDIO TẠO HÌNH ẢNH (IMAGE GENERATION STUDIO)
// =========================================================================

// Quản lý số lượng ảnh sinh ra (Batch Size)
let currentNumImages = 1;
document.querySelectorAll('#batchGrid .batch-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#batchGrid .batch-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentNumImages = Number(btn.dataset.n) || 1;
  });
});

// Lựa chọn tỉ lệ khung hình (Aspect Ratio)
document.querySelectorAll('.ratio-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentWidth = Number(btn.dataset.w) || 1024;
    currentHeight = Number(btn.dataset.h) || 1024;
  });
});

// Điều khiển Slider realtime
const stepsInput = $('#imgSteps');
const stepsVal = $('#stepsVal');
if (stepsInput && stepsVal) {
  stepsInput.addEventListener('input', () => { stepsVal.textContent = stepsInput.value; });
}

const cfgInput = $('#imgGuidance');
const cfgVal = $('#cfgVal');
if (cfgInput && cfgVal) {
  cfgInput.addEventListener('input', () => { cfgVal.textContent = cfgInput.value; });
}

// Bắt sự kiện tải và xử lý Ảnh mẫu tham chiếu
const refDropzone = $('#refDropzone');
const refImageInput = $('#refImageInput');
const removeRefBtn = $('#removeRefBtn');
const clearRefBtn = $('#clearRefBtn');
const refStrength = $('#refStrength');
const strengthVal = $('#strengthVal');
const strengthDesc = $('#strengthDesc');

if (refDropzone && refImageInput) {
  refDropzone.onclick = () => refImageInput.click();
  refImageInput.onchange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleRefImageFile(e.target.files[0]);
    }
  };

  ['dragenter', 'dragover'].forEach(ev => {
    refDropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      refDropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    refDropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      refDropzone.classList.remove('dragover');
    });
  });
  refDropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files[0] && dt.files[0].type.startsWith('image/')) {
      handleRefImageFile(dt.files[0]);
    }
  });
}

if (removeRefBtn) removeRefBtn.onclick = clearReferenceImage;
if (clearRefBtn) clearRefBtn.onclick = clearReferenceImage;

if (refStrength && strengthVal) {
  refStrength.addEventListener('input', () => {
    const val = Number(refStrength.value);
    strengthVal.textContent = Math.round(val * 100) + '%';
    if (strengthDesc) {
      if (val < 0.50) {
        strengthDesc.textContent = '⚠️ Quá thấp: Giữ nguyên 80% ảnh mẫu (Không đổi được dáng ngồi hay bối cảnh theo Prompt)';
      } else if (val <= 0.75) {
        strengthDesc.textContent = '🔥 Chuẩn nhất: Đổi tư thế, trang phục & bối cảnh theo Prompt, vẫn giữ nét mặt ảnh mẫu';
      } else {
        strengthDesc.textContent = 'Biến đổi mạnh: Ưu tiên 90% theo Prompt, chỉ lấy cảm hứng từ ảnh mẫu';
      }
    }
  });
}

// Bộ từ điển thông minh tự động dịch tiếng Việt sang Tag tiếng Anh chuyên dụng cho Model SDXL
function enhanceAndTranslatePrompt(text) {
  let p = (text || '').trim();
  if (!p) return p;

  const isVietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(p);
  if (!isVietnamese) return p;

  let en = p.toLowerCase();
  en = en.replace(/^(tạo ảnh|vẽ ảnh|hãy vẽ|hãy tạo|tạo cho tôi|vẽ cho tôi|hình ảnh|tạo 1 ảnh|vẽ 1 ảnh|vẽ một bức ảnh|tạo một bức ảnh)\s+/i, '');

  const dict = [
    [/người phụ nữ|phụ nữ|cô gái|cô em|gái xinh|baddie|em gái/g, 'beautiful woman, 1girl'],
    [/người đàn ông|đàn ông|chàng trai|trai đẹp/g, 'handsome man, 1boy'],
    [/châu á|người việt|việt nam/g, 'asian, vietnamese'],
    [/không mặc gì|khỏa thân|nude|cởi hết|không quần áo|trần như nhộng|không mặc đồ|lộ hết/g, 'completely naked, nude, full body nude, explicit, bare skin, bare breasts, bare nipples, uncensored'],
    [/đồ lót|nội y/g, 'sexy lingerie, lace underwear'],
    [/bikini|áo tắm/g, 'sexy micro bikini'],
    [/váy ngắn|chân váy/g, 'tight mini skirt'],
    [/áo sơ mi/g, 'unbuttoned shirt'],
    [/đang đứng ở biển|đang đứng biển|đứng ở biển|ở biển|bờ biển|bãi biển|biển/g, 'standing on a tropical sunny beach, ocean background, gentle sea waves, soft golden sand, outdoor natural lighting, full body shot'],
    [/đang đứng|đứng/g, 'standing, full body standing pose, head to toe shot'],
    [/đang ngồi|ngồi/g, 'sitting, seated, full body shot'],
    [/đang nằm|nằm/g, 'lying down, reclining'],
    [/quỳ|đang quỳ/g, 'kneeling pose'],
    [/nhìn vào ống kính|nhìn thẳng/g, 'looking at camera'],
    [/tự sướng|selfie/g, 'mirror selfie, direct flash'],
    [/nhà vệ sinh công cộng|nhà vệ sinh|toilet/g, 'in a public restroom, ceramic wall tiles, toilet stall, realistic bathroom lighting'],
    [/phòng ngủ|giường/g, 'in a cozy bedroom, on the bed, warm indoor lighting'],
    [/phòng tắm|bồn tắm/g, 'in a luxurious bathroom, bathtub'],
    [/khách sạn/g, 'in a luxury hotel room'],
    [/đường phố|ngoài đường/g, 'on a city street at night'],
    [/ảnh thật|chân thực|như thật|siêu thực/g, 'photorealistic, raw photo, realistic skin texture, 8k uhd, soft natural lighting']
  ];

  dict.forEach(([rgx, repl]) => {
    en = en.replace(rgx, repl);
  });

  if (!en.includes('photorealistic') && !en.includes('photo')) {
    en = `${en}, photorealistic, raw photo, ultra detailed skin texture, realistic natural lighting, 8k uhd`;
  }
  return en;
}

// Cập nhật giá trị khuyên dùng khi đổi model
const modelSelectEl = $('#imgModelSelect');
if (modelSelectEl) {
  modelSelectEl.addEventListener('change', () => {
    const m = modelSelectEl.value.toLowerCase();
    if (m.includes('schnell')) {
      stepsInput.value = 4;
      stepsVal.textContent = '4';
      cfgInput.value = 0.0;
      cfgVal.textContent = '0.0';
    } else if (m.includes('dev')) {
      stepsInput.value = 25;
      stepsVal.textContent = '25';
      cfgInput.value = 3.5;
      cfgVal.textContent = '3.5';
    } else {
      stepsInput.value = 25;
      stepsVal.textContent = '25';
      cfgInput.value = 6.5;
      cfgVal.textContent = '6.5';
    }
  });
}

function loadRecentImages(){
  try {
    const raw = localStorage.getItem(RECENT_IMAGES_KEY);
    recentImages = raw ? JSON.parse(raw) : [];
  } catch {
    recentImages = [];
  }
  renderGallery();
}

function saveRecentImages(){
  try {
    localStorage.setItem(RECENT_IMAGES_KEY, JSON.stringify(recentImages.slice(0, 30)));
  } catch {}
}

function renderGallery(){
  const grid = $('#galleryGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!recentImages.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;font-size:12px;color:#7e7e8b;padding:8px 0">Chưa có ảnh nào trong phiên này.</div>';
    return;
  }
  recentImages.forEach((item, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumb';
    thumb.title = item.prompt || 'Ảnh đã tạo';
    const img = document.createElement('img');
    img.src = item.image;
    img.alt = 'Thumbnail';
    thumb.appendChild(img);
    thumb.onclick = () => displayResult(item);
    grid.appendChild(thumb);
  });
}

function displayResult(item){
  const placeholder = $('#viewportPlaceholder');
  const loading = $('#viewportLoading');
  const result = $('#viewportResult');
  const mainImg = $('#mainResultImg');
  const batchBar = $('#batchResultsBar');
  const batchSwitcher = $('#batchSwitcher');
  const downloadAllBtn = $('#batchDownloadAllBtn');

  if (placeholder) placeholder.style.display = 'none';
  if (loading) loading.style.display = 'none';
  if (result) result.style.display = 'flex';
  if (mainImg) mainImg.src = item.image;

  $('#metaModel').textContent = item.model || 'SDXL';
  $('#metaDimensions').textContent = `${item.width || currentWidth} × ${item.height || currentHeight}px`;
  $('#metaElapsed').textContent = item.elapsed_seconds ? `${item.elapsed_seconds}s` : 'N/A';
  $('#metaSeed').textContent = item.seed !== undefined ? item.seed : 'N/A';

  // Quản lý hiển thị Batch khi tạo nhiều ảnh (2, 3, 4 ảnh)
  const allImages = (item.images && item.images.length > 1) ? item.images : null;
  const allSeeds = (item.seeds && item.seeds.length > 1) ? item.seeds : null;

  if (batchBar && batchSwitcher) {
    if (allImages) {
      batchBar.style.display = 'flex';
      batchSwitcher.innerHTML = '';
      allImages.forEach((imgUrl, idx) => {
        const tabBtn = document.createElement('button');
        tabBtn.type = 'button';
        tabBtn.className = `batch-tab ${item.image === imgUrl ? 'active' : ''}`;
        tabBtn.innerHTML = `<span>Ảnh #${idx + 1}</span>`;
        tabBtn.onclick = () => {
          document.querySelectorAll('.batch-tab').forEach(t => t.classList.remove('active'));
          tabBtn.classList.add('active');
          if (mainImg) mainImg.src = imgUrl;
          item.image = imgUrl;
          if (allSeeds && allSeeds[idx] !== undefined) {
            item.seed = allSeeds[idx];
            $('#metaSeed').textContent = allSeeds[idx];
          }
        };
        batchSwitcher.appendChild(tabBtn);
      });

      if (downloadAllBtn) {
        downloadAllBtn.onclick = () => {
          allImages.forEach((imgUrl, i) => {
            setTimeout(() => {
              const a = document.createElement('a');
              a.href = imgUrl;
              a.download = `ai-image-batch-${i + 1}-${Date.now()}.png`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }, i * 350);
          });
        };
      }
    } else {
      batchBar.style.display = 'none';
    }
  }

  const dlBtn = $('#downloadImgBtn');
  if (dlBtn) {
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = item.image;
      a.download = `ai-image-${item.seed || Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
  }

  const openBtn = $('#openFullBtn');
  if (openBtn) {
    openBtn.onclick = () => {
      const w = window.open('');
      w.document.write(`<title>Xem ảnh kích thước gốc</title><body style="margin:0;background:#0d0d0f;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${item.image}" style="max-width:100%;max-height:100vh;object-fit:contain;box-shadow:0 0 40px #000;"></body>`);
    };
  }
}

// Submit Tạo Hình Ảnh
const imageGenForm = $('#imageGenForm');
if (imageGenForm) {
  imageGenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const promptText = ($('#imgPrompt').value || '').trim();
    if (!promptText) {
      window.alert('Vui lòng nhập mô tả hình ảnh (Prompt).');
      return;
    }

    const currentEmail = getEmailFromSession();
    if (!checkIsAdmin(currentEmail)) {
      window.alert('Quyền truy cập bị từ chối: Chỉ tài khoản datviphero@gmail.com mới được phép tạo ảnh.');
      return;
    }

    const btn = $('#generateImgBtn');
    const btnSpinner = btn.querySelector('.btn-spinner');
    const btnIcon = btn.querySelector('.btn-icon');
    const btnText = btn.querySelector('.btn-text');

    const placeholder = $('#viewportPlaceholder');
    const loading = $('#viewportLoading');
    const result = $('#viewportResult');
    const timerBadge = $('#elapsedTimer');
    const loadingStatusText = $('#loadingStatusText');

    busy = true;
    btn.disabled = true;
    if (btnSpinner) btnSpinner.style.display = 'inline-block';
    if (btnIcon) btnIcon.style.display = 'none';
    if (btnText) btnText.textContent = currentNumImages > 1 ? `Đang render bộ ${currentNumImages} ảnh...` : 'Đang render trên GPU...';

    if (placeholder) placeholder.style.display = 'none';
    if (result) result.style.display = 'none';
    if (loading) loading.style.display = 'flex';

    let startTime = Date.now();
    timerBadge.textContent = '0.0s';
    const timerInterval = setInterval(() => {
      const sec = ((Date.now() - startTime) / 1000).toFixed(1);
      timerBadge.textContent = `${sec}s`;
      if (sec > 12) {
        loadingStatusText.textContent = 'Đang khử nhiễu và xử lý chi tiết (Denoising)...';
      }
    }, 100);

    try {
      const token = await accessToken();
      const optimizedPrompt = enhanceAndTranslatePrompt(promptText);
      const payload = {
        prompt: optimizedPrompt,
        negative_prompt: ($('#imgNegativePrompt').value || '').trim(),
        width: currentWidth,
        height: currentHeight,
        steps: Number($('#imgSteps').value) || 25,
        guidance_scale: Number($('#imgGuidance').value) || 6.5,
        seed: Number($('#imgSeed').value),
        model_id: $('#imgModelSelect').value,
        init_image: referenceImage || null,
        strength: referenceImage ? Number($('#refStrength')?.value || 0.70) : null,
        num_images: currentNumImages,
      };

      const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/image`, {
        method: 'POST',
        headers: {
          apikey: cfg.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errMessage = `Lỗi tạo ảnh (${res.status})`;
        if (res.status === 546) {
          errMessage = 'Hết thời gian chờ (Timeout 546): GPU Modal đang trong quá trình khởi động hoặc nạp model lần đầu. Hãy bấm "Tạo Hình Ảnh Ngay" thêm một lần nữa để kết nối lại GPU!';
        } else {
          try {
            const errData = await res.json();
            errMessage = errData.error || errData.detail || errMessage;
          } catch {}
        }
        throw new Error(errMessage);
      }

      const data = await res.json();
      if (!data.image && (!data.images || !data.images.length)) {
        throw new Error('Không nhận được dữ liệu ảnh trả về từ GPU.');
      }

      const imgs = (data.images && data.images.length) ? data.images : [data.image];
      const seeds = (data.seeds && data.seeds.length) ? data.seeds : [data.seed];

      const item = {
        image: imgs[0],
        images: imgs,
        seeds: seeds,
        prompt: promptText,
        seed: seeds[0],
        elapsed_seconds: data.elapsed_seconds,
        model: data.model || payload.model_id,
        width: data.width || currentWidth,
        height: data.height || currentHeight,
      };

      // Đẩy tất cả ảnh được tạo vào danh sách phiên để người dùng lưu lại
      imgs.forEach((imgUrl, i) => {
        recentImages.unshift({
          image: imgUrl,
          prompt: imgs.length > 1 ? `${promptText} (Ảnh #${i + 1})` : promptText,
          seed: seeds[i] !== undefined ? seeds[i] : data.seed,
          elapsed_seconds: data.elapsed_seconds,
          model: data.model || payload.model_id,
          width: data.width || currentWidth,
          height: data.height || currentHeight,
        });
      });

      saveRecentImages();
      renderGallery();
      displayResult(item);

    } catch (err) {
      clearInterval(timerInterval);
      if (loading) loading.style.display = 'none';
      if (placeholder) placeholder.style.display = 'flex';
      window.alert(`Không thể tạo ảnh: ${err.message}`);
    } finally {
      clearInterval(timerInterval);
      busy = false;
      btn.disabled = false;
      if (btnSpinner) btnSpinner.style.display = 'none';
      if (btnIcon) btnIcon.style.display = 'inline-block';
      if (btnText) btnText.textContent = 'Tạo Hình Ảnh Ngay';
    }
  });
}

// Xóa danh sách ảnh vừa tạo
const clearRecentBtn = $('#clearRecentBtn');
if (clearRecentBtn) {
  clearRecentBtn.onclick = () => {
    if (!recentImages.length) return;
    if (window.confirm('Xóa toàn bộ lịch sử ảnh vừa tạo trong phiên?')) {
      recentImages = [];
      saveRecentImages();
      renderGallery();
      $('#viewportResult').style.display = 'none';
      $('#viewportPlaceholder').style.display = 'flex';
    }
  };
}

// Sự kiện đổi tab
if (tabChat) tabChat.onclick = () => switchMode('chat');
if (tabImage) tabImage.onclick = () => switchMode('image');

// =========================================================================
// BẮT SỰ KIỆN ĐÍNH KÈM VÀ KÉO THẢ ẢNH CHAT
// =========================================================================
const attachBtn = $('#attachBtn');
const imageInput = $('#imageInput');
const removeImageBtn = $('#removeImageBtn');
if (attachBtn && imageInput) {
  attachBtn.onclick = () => imageInput.click();
  imageInput.onchange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleImageFile(e.target.files[0]);
    }
  };
}
if (removeImageBtn) {
  removeImageBtn.onclick = clearPendingImage;
}

window.addEventListener('paste', (e) => {
  const items = (e.clipboardData || window.clipboardData)?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        if (currentMode === 'image') {
          handleRefImageFile(file);
        } else {
          handleImageFile(file);
        }
        e.preventDefault();
        break;
      }
    }
  }
});

const composerForm = $('#chatForm');
if (composerForm) {
  ['dragenter', 'dragover'].forEach(ev => {
    composerForm.addEventListener(ev, (e) => {
      e.preventDefault();
      composerForm.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    composerForm.addEventListener(ev, (e) => {
      e.preventDefault();
      composerForm.classList.remove('drag-over');
    });
  });
  composerForm.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files[0] && dt.files[0].type.startsWith('image/')) {
      handleImageFile(dt.files[0]);
    }
  });
}

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

// Khởi chạy hệ thống
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
