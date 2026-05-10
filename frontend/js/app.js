const PhantomApp = (() => {
"use strict";
const loc = window.location;
const API_BASE = `${loc.protocol}//${loc.host}/api`;
const WS_BASE = `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const state = {
  userId: null, keys: null, ws: null, wsRetries: 0, activeChat: null,
  contacts: [], messages: {}, derivedKeys: {}, typingTimers: {},
  rtcConnections: {}, rtcDataChannels: {}, pendingFile: null, _unread: {}, _sidebar: null
};
let messageIdCounter = 0;
let authMode = "register";

function init() {
  setupAuthScreen();
  setupChatScreen();
  setupFileHandlers();
  renderTTLSelector();
  PhantomUI.initPanicButton();
  PhantomUI.initScreenshotProtection();
  PhantomUI.initLightbox();
  PhantomUI.initEmojiPicker();
  PhantomUI.initAutoResize();
  state._sidebar = PhantomUI.initMobileSidebar();
  showScreen("auth");
}

function showScreen(n) { $$(".screen").forEach(s => s.classList.add("hidden")); $(`#${n}-screen`)?.classList.remove("hidden"); }

function setupAuthScreen() {
  const hi = $("#handle-input"), pi = $("#password-input"), btn = $("#register-btn");
  const st = $("#auth-status"), av = $("#handle-availability");
  let ck = null;
  $$("#auth-screen .auth-tab").forEach(t => t.addEventListener("click", () => {
    authMode = t.dataset.mode;
    $$("#auth-screen .auth-tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active"); av.textContent = ""; st.textContent = "";
    btn.textContent = authMode === "register" ? "Create Account & Enter" : "Login & Enter";
    vld();
  }));
  const vld = () => { const h=hi?.value.trim()||"",p=pi?.value||""; btn.disabled=h.length<2||p.length<4||!/^[a-zA-Z0-9_]+$/.test(h); };
  hi?.addEventListener("input", () => {
    vld(); const h=hi.value.trim(); av.textContent=""; av.className="availability-indicator";
    if(h.length<2||!/^[a-zA-Z0-9_]+$/.test(h)) return;
    if(authMode==="register"){clearTimeout(ck);ck=setTimeout(async()=>{try{const r=await fetch(`${API_BASE}/check/${h}`);const d=await r.json();av.textContent=d.available?"✓ Available":"✗ Already registered (use Login)";av.classList.add(d.available?"available":"unavailable");}catch{av.textContent="⚠ Server unreachable";}},400);}
  });
  pi?.addEventListener("input", vld);
  btn?.addEventListener("click", async () => {
    const h=hi.value.trim(),p=pi.value; if(!h||h.length<2||p.length<4) return;
    btn.disabled=true; st.textContent="";
    try { if(authMode==="register") await doRegister(h,p); else await doLogin(h,p); }
    catch(e){ st.textContent=`Error: ${e.message}`; st.classList.add("error"); btn.disabled=false; hideAuthProgress(); }
  });
  $("#delete-account-btn")?.addEventListener("click", async () => {
    const pw=prompt("Enter password to permanently delete your account:"); if(!pw) return;
    try { const r=await fetch(`${API_BASE}/delete-account`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user_id:state.userId,password:pw})}); if(!r.ok){const e=await r.json();throw new Error(e.detail);} showToast("Account deleted","success"); state.ws?.close(); state.userId=null;state.keys=null; showScreen("auth"); }
    catch(e){ showToast(`Delete failed: ${e.message}`,"error"); }
  });
}

async function doRegister(h, p) {
  showAuthProgress("Generating cryptographic identity...",20);
  state.keys = await PhantomCrypto.generateKeyPairs();
  showAuthProgress("Encrypting key vault...",40);
  const vault = await PhantomCrypto.encryptKeyVault(p, state.keys);
  showAuthProgress("Exporting public keys...",55);
  const ep = await PhantomCrypto.exportPublicKey(state.keys.ecdh.publicKey);
  const sp = await PhantomCrypto.exportPublicKey(state.keys.ecdsa.publicKey);
  showAuthProgress("Registering on relay...",75);
  const r = await fetch(`${API_BASE}/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user_id:h,password:p,ecdh_public_key:ep,ecdsa_public_key:sp,encrypted_key_vault:vault})});
  if(!r.ok){const e=await r.json();throw new Error(e.detail||"Registration failed");}
  showAuthProgress("Establishing secure channel...",90);
  state.userId=h; await connectWebSocket();
  showAuthProgress("Identity sealed. Entering PhantomChat...",100);
  await sleep(600); enterChat();
}

async function doLogin(h, p) {
  showAuthProgress("Authenticating...",30);
  const r = await fetch(`${API_BASE}/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user_id:h,password:p})});
  if(!r.ok){const e=await r.json();throw new Error(e.detail||"Login failed");}
  const d = await r.json();
  showAuthProgress("Decrypting key vault...",60);
  state.keys = await PhantomCrypto.decryptKeyVault(p, d.encrypted_key_vault);
  showAuthProgress("Establishing secure channel...",85);
  state.userId=h; await connectWebSocket();
  showAuthProgress("Welcome back. Entering PhantomChat...",100);
  await sleep(600); enterChat();
}

function showAuthProgress(t,p){const b=$("#auth-progress-bar"),l=$("#auth-progress-label"),c=$("#auth-progress");c?.classList.remove("hidden");if(b)b.style.width=`${p}%`;if(l)l.textContent=t;}
function hideAuthProgress(){$("#auth-progress")?.classList.add("hidden");}

function setupChatScreen() {
  $("#send-btn")?.addEventListener("click", sendMessage);
  $("#message-input")?.addEventListener("keydown", e => { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();} });
  $("#message-input")?.addEventListener("input", () => { if(state.activeChat&&state.ws?.readyState===WebSocket.OPEN) state.ws.send(JSON.stringify({type:"typing",recipient_id:state.activeChat})); });
}

function enterChat() { showScreen("chat"); $("#current-user-label").textContent=state.userId; loadContacts(); startPresencePolling(); }

async function loadContacts() {
  try { const r=await fetch(`${API_BASE}/users`);const u=await r.json();state.contacts=u.filter(x=>x.user_id!==state.userId);renderContacts(); }
  catch(e){ console.error("[Contacts]",e); }
}

function renderContacts() {
  const list=$("#contact-list"); if(!list) return; list.innerHTML="";
  if(state.contacts.length===0){list.innerHTML=`<div class="no-contacts"><div class="no-contacts-icon">👻</div><p>No other phantoms yet</p></div>`;return;}
  state.contacts.forEach(c => {
    const el=document.createElement("div"); el.className=`contact-item ${c.user_id===state.activeChat?"active":""}`;
    el.id=`contact-${c.user_id}`; const unread=state._unread[c.user_id]||0;
    el.innerHTML=`<div class="contact-avatar">${c.user_id[0].toUpperCase()}</div><div class="contact-info"><span class="contact-name">${escapeHtml(c.user_id)}</span><span class="contact-status ${c.online?"online":"offline"}"><span class="status-dot"></span>${c.online?"Online":"Offline"}</span></div>${unread>0?`<span class="unread-badge">${unread}</span>`:""}`;
    el.addEventListener("click", () => openChat(c.user_id)); list.appendChild(el);
  });
}

function startPresencePolling(){setInterval(loadContacts,10000);}

async function openChat(rid) {
  state.activeChat=rid; state._unread[rid]=0; renderContacts();
  $("#chat-header-name").textContent=rid; $("#message-input-area")?.classList.remove("hidden");
  $("#chat-placeholder")?.classList.add("hidden"); $("#messages-area")?.classList.remove("hidden");
  renderMessages(rid); await ensureDerivedKey(rid); $("#message-input")?.focus();
  if(state.ws?.readyState===WebSocket.OPEN) state.ws.send(JSON.stringify({type:"read_receipt",recipient_id:rid}));
  state._sidebar?.closeSidebar();
  startRTCExchange(rid);
}

async function ensureDerivedKey(rid) {
  if(state.derivedKeys[rid]) return state.derivedKeys[rid];
  try { const r=await fetch(`${API_BASE}/keys/${rid}`);if(!r.ok)throw new Error("Key fetch failed");const k=await r.json();
    const pub=await PhantomCrypto.importECDHPublicKey(k.ecdh_public_key);
    const sk=await PhantomCrypto.deriveSharedSecret(state.keys.ecdh.privateKey,pub);
    state.derivedKeys[rid]=sk; return sk;
  } catch(e){console.error("[KeyExchange]",e);return null;}
}

async function sendMessage() {
  const input=$("#message-input"), text=input?.value.trim();
  if((!text&&!state.pendingFile)||!state.activeChat) return;
  const ttl=getCurrentTTL(), rid=state.activeChat;
  try {
    const rk=await ensureDerivedKey(rid); if(!rk)throw new Error("No shared key");
    const kr=await fetch(`${API_BASE}/keys/${rid}`); const kd=await kr.json();
    const rpub=await PhantomCrypto.importECDHPublicKey(kd.ecdh_public_key);
    const env=await PhantomCrypto.buildSealedEnvelope({senderId:state.userId,recipientId:rid,text:text||"",ttl,ecdsaPrivate:state.keys.ecdsa.privateKey,recipientEcdhPublic:rpub,mediaBuffer:state.pendingFile?.buffer,mediaType:state.pendingFile?.type,fileName:state.pendingFile?.name});
    const dc=state.rtcDataChannels[rid];
    if(dc&&dc.readyState==="open"){try{dc.send(JSON.stringify(env));}catch{state.ws.send(JSON.stringify(env));}}
    else{state.ws.send(JSON.stringify(env));}
    addMessage(rid,{id:++messageIdCounter,senderId:state.userId,text:text||"",timestamp:Date.now(),ttl,isMine:true,hasMedia:!!state.pendingFile,mediaUrl:state.pendingFile?URL.createObjectURL(new Blob([state.pendingFile.buffer],{type:state.pendingFile.type})):null,mediaType:state.pendingFile?.type,fileName:state.pendingFile?.name});
    if(input)input.value=""; clearPendingFile(); input?.focus();
  } catch(e){console.error("[Send]",e);showToast("Send failed","error");}
}

function getCurrentTTL(){const s=$("#ttl-select");if(!s)return 30;if(s.value==="custom"){const c=$("#ttl-custom-input");return parseInt(c?.value)||30;}return parseInt(s.value)||30;}

function addMessage(cid,msg){if(!state.messages[cid])state.messages[cid]=[];state.messages[cid].push(msg);if(cid===state.activeChat)appendMessageToDOM(msg);startTTLTimer(cid,msg);}

function renderMessages(rid){const a=$("#messages-area");if(!a)return;a.innerHTML="";const m=state.messages[rid]||[];if(m.length===0){a.innerHTML=`<div class="no-messages-yet"><span class="nmy-icon">🔐</span><span class="nmy-text">No messages yet. Say hello!</span></div>`;return;}m.forEach(x=>appendMessageToDOM(x));}

function appendMessageToDOM(msg){
  const a=$("#messages-area"); if(!a)return;
  // Remove no-messages placeholder
  const nmy=a.querySelector(".no-messages-yet"); if(nmy)nmy.remove();
  const el=document.createElement("div"); el.className=`message-bubble ${msg.isMine?"sent":"received"}`; el.id=`msg-${msg.id}`;
  const ts=new Date(msg.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  let mh="";
  if(msg.hasMedia&&msg.mediaUrl){const mt=msg.mediaType||"";if(mt.startsWith("video/"))mh=`<div class="message-image-container"><video src="${msg.mediaUrl}" class="message-video" controls preload="metadata"></video></div>`;else if(mt.startsWith("image/"))mh=`<div class="message-image-container"><img src="${msg.mediaUrl}" class="message-image" alt="Encrypted"></div>`;else{const fn=msg.fileName||"file";mh=`<a href="${msg.mediaUrl}" download="${fn}" class="message-file"><span class="file-icon">📄</span><div class="file-info"><div class="file-name">${escapeHtml(fn)}</div></div><span class="file-download">⬇</span></a>`;}}
  el.innerHTML=`<div class="message-header"><span class="message-sender">${msg.isMine?"You":escapeHtml(msg.senderId)}</span><span class="message-lock">🔒</span><span class="pfs-badge">PFS</span></div><div class="message-text">${escapeHtml(msg.text)}</div>${mh}<div class="message-footer"><span class="message-time">${ts}${msg.isMine?`<span class="read-receipt delivered" id="rr-${msg.id}">✓</span>`:""}</span><span class="ttl-countdown" id="ttl-${msg.id}"><svg class="ttl-ring" viewBox="0 0 20 20"><circle class="ttl-ring-bg" cx="10" cy="10" r="8"/><circle class="ttl-ring-progress" cx="10" cy="10" r="8" id="ttl-ring-${msg.id}"/></svg><span class="ttl-text" id="ttl-text-${msg.id}">${formatTTL(msg.ttl)}</span></span></div>`;
  if(msg.hasMedia&&(msg.mediaType||"").startsWith("image/")){el.querySelector(".message-image")?.addEventListener("click",e=>{e.stopPropagation();PhantomUI.openLightbox(msg.mediaUrl);});}
  a.appendChild(el); a.scrollTop=a.scrollHeight;
}

function startTTLTimer(cid,msg){let rem=msg.ttl;const ci=50.27;const iv=setInterval(()=>{rem--;const te=$(`#ttl-text-${msg.id}`),rg=$(`#ttl-ring-${msg.id}`);if(te)te.textContent=formatTTL(rem);if(rg)rg.style.strokeDashoffset=ci*(1-rem/msg.ttl);if(rem<=0){clearInterval(iv);const el=$(`#msg-${msg.id}`);if(el){el.classList.add("dissolving");setTimeout(()=>el.remove(),800);}const ms=state.messages[cid];if(ms){const i=ms.findIndex(x=>x.id===msg.id);if(i!==-1)ms.splice(i,1);}if(msg.mediaUrl)URL.revokeObjectURL(msg.mediaUrl);}},1000);}

function formatTTL(s){if(s<=0)return"0s";if(s<60)return`${s}s`;if(s<3600){const m=Math.floor(s/60),r=s%60;return r>0?`${m}m ${r}s`:`${m}m`;}const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return m>0?`${h}h ${m}m`:`${h}h`;}

async function handleIncomingMessage(data){
  const sid=data.sender_id; if(!sid)return;
  try{await ensureDerivedKey(sid);const r=await PhantomCrypto.openSealedEnvelope(data,state.keys.ecdh.privateKey);
    addMessage(sid,{id:++messageIdCounter,senderId:sid,text:r.text,timestamp:r.timestamp,ttl:r.ttl,isMine:false,sharedKey:r.sharedKey,hasMedia:r.hasMedia,mediaUrl:r.mediaBlob?URL.createObjectURL(r.mediaBlob):null,mediaType:r.mediaType,fileName:r.fileName});
    if(sid!==state.activeChat){state._unread[sid]=(state._unread[sid]||0)+1;renderContacts();playNotificationSound();showToast(`New message from ${sid}`,"info");highlightContact(sid);}
    else if(state.ws?.readyState===WebSocket.OPEN){state.ws.send(JSON.stringify({type:"read_receipt",recipient_id:sid}));}
  }catch(e){console.error("[Decrypt]",e);}
}

function handleReadReceipt(data){const ms=state.messages[data.sender_id]||[];ms.forEach(m=>{if(m.isMine){const r=$(`#rr-${m.id}`);if(r){r.textContent="✓✓";r.classList.remove("delivered");r.classList.add("read");}}});}

function connectWebSocket(){return new Promise((res,rej)=>{state.ws=new WebSocket(`${WS_BASE}/${state.userId}`);state.ws.onopen=()=>{state.wsRetries=0;updateConnectionStatus(true);res();};state.ws.onmessage=e=>{try{routeWSMessage(JSON.parse(e.data));}catch(x){console.error("[WS]",x);}};state.ws.onclose=()=>{updateConnectionStatus(false);scheduleReconnect();};state.ws.onerror=e=>rej(e);});}

function scheduleReconnect(){if(!state.userId)return;const d=Math.min(1000*Math.pow(2,state.wsRetries),30000);state.wsRetries++;showToast(`Reconnecting in ${d/1000}s...`,"info");setTimeout(()=>{if(state.userId&&(!state.ws||state.ws.readyState===WebSocket.CLOSED))connectWebSocket().catch(()=>scheduleReconnect());},d);}

function routeWSMessage(d){switch(d.type){case"message":case"image":case"file":handleIncomingMessage(d);break;case"presence":handlePresence(d);break;case"typing":handleTypingIndicator(d);break;case"receipt":handleReceipt(d);break;case"read_receipt":handleReadReceipt(d);break;case"webrtc_offer":handleRTCOffer(d);break;case"webrtc_answer":handleRTCAnswer(d);break;case"webrtc_ice":handleRTCICE(d);break;case"pong":break;default:console.log("[WS] Unknown:",d.type);}}

function handlePresence(d){const c=state.contacts.find(x=>x.user_id===d.user_id);if(c){c.online=d.online;renderContacts();if(d.online)showToast(`${d.user_id} is now online`,"info");}else loadContacts();}
function handleTypingIndicator(d){if(d.sender_id===state.activeChat){const i=$("#typing-indicator");if(i){i.classList.remove("hidden");clearTimeout(state.typingTimers[d.sender_id]);state.typingTimers[d.sender_id]=setTimeout(()=>i.classList.add("hidden"),3000);}}}
function handleReceipt(d){}
function updateConnectionStatus(on){const el=$("#connection-status");if(el){el.className=`connection-status ${on?"connected":"disconnected"}`;}}
function highlightContact(uid){const el=$(`#contact-${uid}`);if(el){el.classList.add("has-new-message");setTimeout(()=>el.classList.remove("has-new-message"),5000);}}
function playNotificationSound(){try{const ac=new(window.AudioContext||window.webkitAudioContext)();const o=ac.createOscillator();const g=ac.createGain();o.connect(g);g.connect(ac.destination);o.frequency.setValueAtTime(800,ac.currentTime);g.gain.setValueAtTime(0.1,ac.currentTime);g.gain.exponentialRampToValueAtTime(0.01,ac.currentTime+0.3);o.start(ac.currentTime);o.stop(ac.currentTime+0.3);}catch{}}

function renderTTLSelector(){const s=$("#ttl-select");if(!s)return;[{l:"30s",v:30},{l:"1m",v:60},{l:"5m",v:300},{l:"15m",v:900},{l:"1h",v:3600},{l:"Custom",v:"custom"}].forEach(o=>{const op=document.createElement("option");op.value=o.v;op.textContent=o.l;s.appendChild(op);});s.addEventListener("change",()=>{const cc=$("#ttl-custom-container");if(cc){cc.classList.toggle("hidden",s.value!=="custom");}});}

function setupFileHandlers(){
  const ab=$("#attach-btn"),fi=$("#file-input"),cb=$("#cancel-image-btn");
  ab?.addEventListener("click",()=>fi?.click());
  fi?.addEventListener("change",e=>{const f=e.target.files[0];if(!f)return;if(f.size>50*1024*1024){showToast("File too large (max 50MB)","error");fi.value="";return;}const r=new FileReader();r.onload=ev=>{state.pendingFile={file:f,buffer:ev.target.result,type:f.type,name:f.name,size:f.size};showFilePreview();};r.readAsArrayBuffer(f);});
  cb?.addEventListener("click",clearPendingFile);
}
function showFilePreview(){const b=$("#image-preview-bar"),t=$("#image-preview-thumb"),n=$("#image-preview-name"),s=$("#image-preview-size");if(state.pendingFile&&b&&t){t.src=state.pendingFile.type.startsWith("image/")?URL.createObjectURL(new Blob([state.pendingFile.buffer],{type:state.pendingFile.type})):"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='70'>📄</text></svg>";n.textContent=state.pendingFile.name;const kb=state.pendingFile.size/1024;s.textContent=kb>1024?`${(kb/1024).toFixed(1)} MB`:`${kb.toFixed(1)} KB`;b.classList.remove("hidden");}}
function clearPendingFile(){state.pendingFile=null;$("#image-preview-bar")?.classList.add("hidden");const f=$("#file-input");if(f)f.value="";}

function showToast(msg,type="info"){const c=$("#toast-container");if(!c)return;const t=document.createElement("div");t.className=`toast toast-${type}`;t.textContent=msg;c.appendChild(t);requestAnimationFrame(()=>t.classList.add("show"));setTimeout(()=>{t.classList.add("hide");setTimeout(()=>t.remove(),400);},3000);}
function escapeHtml(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

setInterval(()=>{if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:"ping"}));},30000);

async function initWebRTC(rid){if(state.rtcConnections[rid])return;const pc=new RTCPeerConnection(RTC_CONFIG);state.rtcConnections[rid]=pc;pc.onicecandidate=e=>{if(e.candidate&&state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:"webrtc_ice",recipient_id:rid,candidate:e.candidate}));};pc.onconnectionstatechange=()=>{const b=$("#webrtc-badge");if(b&&rid===state.activeChat){if(pc.connectionState==="connected"){b.textContent="P2P";b.className="webrtc-badge p2p";b.classList.remove("hidden");}else if(pc.connectionState==="failed"||pc.connectionState==="closed"){b.textContent="RELAY";b.className="webrtc-badge relay";}}};pc.ondatachannel=e=>setupDC(rid,e.channel);return pc;}
function setupDC(rid,ch){ch.onopen=()=>console.log("[DC] OPEN",rid);ch.onclose=()=>console.log("[DC] CLOSED",rid);ch.onmessage=e=>{try{handleIncomingMessage(JSON.parse(e.data));}catch(x){console.error("[DC]",x);}};state.rtcDataChannels[rid]=ch;}
async function startRTCExchange(rid){const pc=await initWebRTC(rid);const dc=pc.createDataChannel("phantom");setupDC(rid,dc);const o=await pc.createOffer();await pc.setLocalDescription(o);state.ws.send(JSON.stringify({type:"webrtc_offer",recipient_id:rid,offer:o}));}
async function handleRTCOffer(d){const pc=await initWebRTC(d.sender_id);await pc.setRemoteDescription(new RTCSessionDescription(d.offer));const a=await pc.createAnswer();await pc.setLocalDescription(a);state.ws.send(JSON.stringify({type:"webrtc_answer",recipient_id:d.sender_id,answer:a}));}
async function handleRTCAnswer(d){const pc=state.rtcConnections[d.sender_id];if(pc)await pc.setRemoteDescription(new RTCSessionDescription(d.answer));}
async function handleRTCICE(d){const pc=state.rtcConnections[d.sender_id];if(pc)await pc.addIceCandidate(new RTCIceCandidate(d.candidate));}

return { init };
})();
document.addEventListener("DOMContentLoaded", PhantomApp.init);
