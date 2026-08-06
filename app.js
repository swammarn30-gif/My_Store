

const $ = (s,p=document)=>p.querySelector(s);
const $$ = (s,p=document)=>[...p.querySelectorAll(s)];
const STORAGE_KEYS = ['erp_v8', 'erp_v7', 'erp_v6', 'erp_v5', 'erp_v4', 'erp_v3', 'erp_v2_5'];
const STORAGE_KEY = STORAGE_KEYS[0];
const todayISO = () => new Date().toISOString().slice(0,10);
const deep = v => JSON.parse(JSON.stringify(v));
const VISS_TO_G = 1600;
const APP_VERSION = '13';

const firebaseConfig = {
  apiKey: "AIzaSyBs9BmqU_FdoG5Nq0N5MC-p3mB9gcDWf08",
  authDomain: "bakery-a3ce8.firebaseapp.com",
  projectId: "bakery-a3ce8",
  storageBucket: "bakery-a3ce8.firebasestorage.app",
  messagingSenderId: "814450940141",
  appId: "1:814450940141:web:e2193e80ea206aa2a994e4"
};

const ADMIN_BOOTSTRAP = {
  email: "swamman30@gmail.com",
  password: "Swam69"
};

const defaults = {
  settings: { shops: [], items: [], recipe: {}, prices: {}, lowStockLevel: 20 },
  purchases: [],
  days: {},
  inventory: {},
  lastDate: todayISO()
};

const ALL_PERMISSIONS = {
  dashboard: true,
  purchase: true,
  production: true,
  packaging: true,
  sale: true,
  more: true,
  items: true,
  shops: true,
  recipe: true,
  report: true,
  users: true
};

let firebaseApp = null;
let auth = null;
let creatorApp = null;
let creatorAuth = null;
let db = null;

let state = load();
let currentDate = state.lastDate || todayISO();
let currentView = 'dashboard';
let authReady = false;
let syncUnsub = null;
let cloudSaveTimer = null;
let suppressCloudSave = false;
let currentUser = null;
let currentProfile = null;
let loginError = '';
let remoteRenderPending = false;


function load(){
  for(const key of STORAGE_KEYS){
    const raw = localStorage.getItem(key);
    if(!raw) continue;
    try{
      const parsed = JSON.parse(raw);
      return mergeState(parsed);
    }catch(e){}
  }
  return deep(defaults);
}
function mergeState(src){
  const parsed = src || {};
  const merged = {
    ...deep(defaults),
    ...parsed,
    settings: {...deep(defaults.settings), ...(parsed.settings || {})}
  };
  if(!merged.settings.recipe) merged.settings.recipe = {};
  if(!merged.settings.prices) merged.settings.prices = {};
  if(!Array.isArray(merged.settings.items)) merged.settings.items = [];
  if(!Array.isArray(merged.settings.shops)) merged.settings.shops = [];
  if(!merged.purchases) merged.purchases = [];
  if(!merged.days) merged.days = {};
  if(!merged.inventory) merged.inventory = {};
  if(!merged.lastDate) merged.lastDate = todayISO();
  return merged;
}
function save(){
  state.lastDate = currentDate;
  const raw = JSON.stringify(state);
  for(const key of STORAGE_KEYS) localStorage.setItem(key, raw);
  scheduleCloudSave();
}
function toast(msg){
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._toastT);
  window._toastT = setTimeout(()=>el.classList.remove('show'), 1600);
}
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function money(n){ return Number(num(n)).toLocaleString(); }
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])); }

function cssEscapeValue(v){
  if(window.CSS && typeof CSS.escape === 'function') return CSS.escape(String(v));
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function buildFocusSelector(el){
  if(!el || !el.matches('input, select, textarea')) return '';
  const attrs = ['data-kind','data-id','data-field','data-purchase-field','data-idx','data-sale-id','data-row','data-item-field','data-recipe-item','data-recipe-qty'];
  const parts = [];
  attrs.forEach(a=>{
    if(el.hasAttribute(a)) parts.push(`[${a}="${cssEscapeValue(el.getAttribute(a))}"]`);
  });
  return parts.join('');
}
function captureFocusState(){
  const el = document.activeElement;
  if(!el || !el.matches('input, select, textarea')) return null;
  const selector = buildFocusSelector(el);
  if(!selector) return null;
  return { selector, isInput: el.tagName === 'INPUT', selectionStart: el.selectionStart, selectionEnd: el.selectionEnd };
}
function restoreFocusState(state){
  if(!state || !state.selector) return;
  const el = document.querySelector(state.selector);
  if(!el || typeof el.focus !== 'function') return;
  requestAnimationFrame(()=>{
    try{
      el.focus({preventScroll:true});
      if(state.isInput && typeof el.setSelectionRange === 'function' && typeof state.selectionStart === 'number'){
        const len = String(el.value ?? '').length;
        const start = Math.min(state.selectionStart, len);
        const end = Math.min(state.selectionEnd ?? start, len);
        el.setSelectionRange(start, end);
      }else if(typeof el.select === 'function' && el.tagName === 'INPUT'){
        el.select();
      }
    }catch(e){}
  });
}
function downloadText(filename, text, mime='text/plain;charset=utf-8'){
  const blob = new Blob([text], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try{
    a.click();
  }catch(e){
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(()=>{
    URL.revokeObjectURL(url);
    a.remove();
  }, 1500);
}
function csvCell(v){
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}
function downloadCSV(rows, filename){
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
  downloadText(filename, csv, 'text/csv;charset=utf-8');
}
function downloadJSON(obj, filename){
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
}
function normalizeId(id){ return String(id||'').trim().toUpperCase(); }

function parseSmartNumber(raw, current=0){
  const s = String(raw ?? '').trim();
  if(s === '') return 0;
  if(s === '+' || s === '-') return null;
  if(/^[+-]\d+(?:\.\d+)?$/.test(s)) return current + Number(s);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function smartInputAttrs(){ return 'type="text" inputmode="decimal" autocomplete="off"'; }
function displayNum(v){
  const n = num(v);
  return n === 0 ? '' : String(n);
}
function displayMoney(v){
  const n = num(v);
  return n === 0 ? '' : money(n);
}
function displayBase(id, qtyBase){
  const n = num(qtyBase);
  return n === 0 ? '' : `${n} ${baseLabel(id)}`;
}
function formatSmartNumber(v){ return displayNum(v); }

function canAccess(page){
  if(!currentProfile) return false;
  if(currentProfile.role === 'admin') return true;
  return !!currentProfile.permissions?.[page];
}
function allowedStartPage(){
  for(const page of ['dashboard','purchase','production','packaging','sale','more']){
    if(canAccess(page)) return page;
  }
  return 'dashboard';
}
function isAdmin(){
  return currentProfile?.role === 'admin';
}
function pageLabel(page){
  return ({dashboard:'Dashboard', purchase:'Purchase', production:'Production', packaging:'Packaging', sale:'Sale', more:'More'})[page] || page;
}
function allPermissions(){
  return {...ALL_PERMISSIONS};
}
function permissionList(){
  return ['dashboard','purchase','production','packaging','sale','more','items','shops','recipe','report','users'];
}


function initFirebase(){
  if(!window.firebase || !firebaseConfig) return false;
  if(!firebaseApp){
    firebaseApp = firebase.apps?.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
    try{ db.enablePersistence({ synchronizeTabs: true }).catch(()=>{}); }catch(e){}
  }
  if(!creatorApp){
    creatorApp = firebase.apps?.find(a => a.name === 'creator') || firebase.initializeApp(firebaseConfig, 'creator');
    creatorAuth = creatorApp.auth();
  }
  return true;
}
function currentStateDoc(){
  return db?.collection('appData').doc('main');
}
function scheduleCloudSave(){
  if(!db || !authReady || suppressCloudSave || !currentUser) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(pushStateToCloud, 450);
}
function shouldDeferRemoteRender(){
  const el = document.activeElement;
  return !!el && el.matches('input, select, textarea');
}
function queueRemoteRender(){
  remoteRenderPending = true;
  clearTimeout(window.__remoteRenderT);
  window.__remoteRenderT = setTimeout(()=>{
    if(remoteRenderPending && !shouldDeferRemoteRender()){
      remoteRenderPending = false;
      render();
    }
  }, 300);
}
async function pushStateToCloud(){
  if(!db || suppressCloudSave || !currentUser) return;
  try{
    await currentStateDoc().set({
      state: deep(state),
      lastDate: currentDate,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser.uid,
      version: '8'
    }, { merge: true });
  }catch(err){
    console.warn('cloud save failed', err);
  }
}
function applyRemoteState(remote){
  suppressCloudSave = true;
  try{
    state = mergeState(remote?.state || remote || {});
    currentDate = state.lastDate || currentDate || todayISO();
    normalizeCarryForward();
    const raw = JSON.stringify(state);
    for(const key of STORAGE_KEYS) localStorage.setItem(key, raw);
  }finally{
    suppressCloudSave = false;
  }
  if(shouldDeferRemoteRender()){
    queueRemoteRender();
    return;
  }
  render();
}
function startCloudListener(){
  if(syncUnsub) syncUnsub();
  if(!db || !currentUser) return;
  syncUnsub = currentStateDoc().onSnapshot(snap => {
    if(!snap.exists) return;
    const data = snap.data() || {};
    if(data.state) applyRemoteState(data);
  }, err => {
    console.warn('sync listener error', err);
    toast('Firebase sync error');
  });
}
async function ensureProfile(user){
  const ref = db.collection('users').doc(user.uid);
  const snap = await ref.get();
  if(snap.exists){
    return normalizeProfile(user, snap.data() || {});
  }
  const isAdminSeed = user.email?.toLowerCase() === ADMIN_BOOTSTRAP.email.toLowerCase();
  const profile = {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
    role: isAdminSeed ? 'admin' : 'staff',
    active: true,
    permissions: isAdminSeed ? allPermissions() : {
      dashboard: true,
      purchase: true,
      production: true,
      packaging: true,
      sale: true,
      more: true,
      items: false,
      shops: false,
      recipe: false,
      report: true,
      users: false
    }
  };
  await ref.set(profile, { merge: true });
  return profile;
}
function normalizeProfile(user, data){
  const role = data.role === 'admin' ? 'admin' : 'staff';
  return {
    uid: user.uid,
    email: data.email || user.email || '',
    displayName: data.displayName || user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
    role,
    active: data.active !== false,
    permissions: role === 'admin' ? allPermissions() : {
      dashboard: !!data.permissions?.dashboard,
      purchase: !!data.permissions?.purchase,
      production: !!data.permissions?.production,
      packaging: !!data.permissions?.packaging,
      sale: !!data.permissions?.sale,
      more: !!data.permissions?.more,
      items: !!data.permissions?.items,
      shops: !!data.permissions?.shops,
      recipe: !!data.permissions?.recipe,
      report: !!data.permissions?.report,
      users: !!data.permissions?.users
    }
  };
}
function syncNavButtons(){
  const pages = ['dashboard','purchase','production','packaging','sale','more'].filter(canAccess);
  $$('.bottom-nav button').forEach(btn => {
    const visible = pages.includes(btn.dataset.go);
    btn.style.display = visible ? '' : 'none';
    btn.disabled = !visible;
  });
}
function renderShellUser(){
  const box = $('#userBox');
  if(!box) return;
  if(!currentUser){
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <div class="userpill">
      <div class="small muted">${esc(currentProfile?.role || 'user')}</div>
      <div>${esc(currentProfile?.displayName || currentUser.email || '')}</div>
      <button class="btn secondary" id="logoutBtn">Logout</button>
    </div>
  `;
  $('#logoutBtn').onclick = ()=>auth?.signOut();
}
function renderAuthVisibility(){
  const authView = $('#authView');
  const appRoot = $('#appRoot');
  if(authView && appRoot){
    const loggedIn = !!currentUser;
    authView.style.display = loggedIn ? 'none' : 'flex';
    appRoot.style.display = loggedIn ? 'block' : 'none';
  }
}
function ensureViewPermission(name){
  return canAccess(name) ? name : allowedStartPage();
}
function idCompare(a,b){ return normalizeId(a).localeCompare(normalizeId(b), undefined, {numeric:true, sensitivity:'base'}); }
function byId(id){ return state.settings.items.find(x=>x.id === id); }
function itemList(kind){ return state.settings.items.filter(x=>x.kind === kind && x.status === 'active').sort((a,b)=>idCompare(a.id,b.id)); }
function itemAll(){ return state.settings.items.slice().sort((a,b)=>idCompare(a.id,b.id)); }
function itemUnit(id){ return byId(id)?.unit || 'pcs'; }
function itemName(id){ return byId(id)?.name || id; }
function itemKind(id){ return byId(id)?.kind || ''; }
function baseLabel(id){ return itemUnit(id) === 'pcs' ? 'pcs' : 'g'; }
function nextItemId(){
  let n = 1;
  while(state.settings.items.some(it => it.id === `ITM${String(n).padStart(3,'0')}`)) n += 1;
  return `ITM${String(n).padStart(3,'0')}`;
}
function hydrateItemAcrossDays(item){
  if(!item) return;
  for(const d of Object.keys(state.days)){
    const day = state.days[d];
    if(!day.production) day.production = {};
    if(!day.packaging) day.packaging = {};
    if(!day.sale) day.sale = {};
    if(item.kind === 'sale'){
      if(!day.sale[item.id]) day.sale[item.id] = blankSaleRow();
    }else{
      if(!day[item.kind][item.id]) day[item.kind][item.id] = blankDeptRow();
    }
  }
}
function toBase(id, qty, unit){
  qty = num(qty);
  const u = unit || itemUnit(id);
  if(u === 'kg') return qty * 1000;
  if(u === 'viss') return qty * VISS_TO_G;
  if(u === 'g') return qty;
  return qty;
}
function blankDeptRow(){ return {opening:0,in:0,issued:0,return:0,damage:0,used:0,closing:0,note:''}; }
function blankSaleRow(){ return {opening:0,produce:0,buyers:[{shop:'',sell:0,price:0}],closing:0}; }
function makeDeptCarryRow(prevRow){
  const row = blankDeptRow();
  row.opening = num(prevRow?.closing);
  recalcDept(row);
  return row;
}
function makeSaleCarryRow(prevRow){
  const row = blankSaleRow();
  row.opening = num(prevRow?.closing);
  recalcSale(row);
  return row;
}
function sortedDayKeys(fromDate=null){
  return Object.keys(state.days || {})
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter(d => !fromDate || d >= fromDate)
    .sort();
}
function normalizeCarryForward(fromDate=null){
  const dates = sortedDayKeys(fromDate);
  if(!dates.length) return false;
  let changed = false;
  for(const kind of ['production','packaging']){
    const items = itemList(kind);
    for(const it of items){
      let prevClosing = null;
      for(let i=0;i<dates.length;i++){
        const d = dates[i];
        const day = state.days[d];
        if(!day[kind]) day[kind] = {};
        let row = day[kind][it.id];
        if(!row){ row = day[kind][it.id] = blankDeptRow(); changed = true; }
        if(i === 0){
          // keep the first visible opening as-is, just recompute closing.
          if(typeof row.note !== 'string') { row.note = row.note ? String(row.note) : ''; changed = true; }
          const before = JSON.stringify(row);
          recalcDept(row);
          if(JSON.stringify(row) !== before) changed = true;
        }else{
          if(num(row.opening) !== num(prevClosing)) changed = true;
          row.opening = num(prevClosing);
          if(typeof row.note !== 'string') { row.note = row.note ? String(row.note) : ''; changed = true; }
          const before = JSON.stringify(row);
          recalcDept(row);
          if(JSON.stringify(row) !== before) changed = true;
        }
        prevClosing = num(row.closing);
      }
    }
  }
  const saleItems = itemList('sale');
  for(const it of saleItems){
    let prevClosing = null;
    for(let i=0;i<dates.length;i++){
      const d = dates[i];
      const day = state.days[d];
      if(!day.sale) day.sale = {};
      let row = day.sale[it.id];
      if(!row){ row = day.sale[it.id] = blankSaleRow(); changed = true; }
      if(i === 0){
        const before = JSON.stringify(row);
        recalcSale(row);
        if(JSON.stringify(row) !== before) changed = true;
      }else{
        if(num(row.opening) !== num(prevClosing)) changed = true;
        row.opening = num(prevClosing);
        const before = JSON.stringify(row);
        recalcSale(row);
        if(JSON.stringify(row) !== before) changed = true;
      }
      prevClosing = num(row.closing);
    }
  }
  return changed;
}

function previousDate(date){
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0,10);
}
function ensureDay(date){
  if(!state.days[date]){
    const prev = state.days[previousDate(date)];
    state.days[date] = {production:{}, packaging:{}, sale:{}};
    for(const it of itemList('production')) state.days[date].production[it.id] = makeDeptCarryRow(prev?.production?.[it.id]);
    for(const it of itemList('packaging')) state.days[date].packaging[it.id] = makeDeptCarryRow(prev?.packaging?.[it.id]);
    for(const it of itemList('sale')) state.days[date].sale[it.id] = makeSaleCarryRow(prev?.sale?.[it.id]);
    save();
  }else{
    const day = state.days[date];
    if(!day.production) day.production = {};
    if(!day.packaging) day.packaging = {};
    if(!day.sale) day.sale = {};
    for(const it of itemList('production')) if(!day.production[it.id]) day.production[it.id] = blankDeptRow();
    for(const it of itemList('packaging')) if(!day.packaging[it.id]) day.packaging[it.id] = blankDeptRow();
    for(const it of itemList('sale')) if(!day.sale[it.id]) day.sale[it.id] = blankSaleRow();
  }
}
function currentDay(){ ensureDay(currentDate); return state.days[currentDate]; }
function recalcDept(r){ r.used = Math.max(0, num(r.issued) - num(r.return) - num(r.damage)); r.closing = num(r.opening) + num(r.in) + num(r.return) - num(r.issued); }
function recalcSale(r){ const total = (r.buyers||[]).reduce((s,b)=>s + num(b.sell),0); r.closing = num(r.opening) + num(r.produce) - total; }
function avgCost(itemId){
  const inv = state.inventory?.[itemId];
  if(!inv || !inv.qtyBase) return 0;
  return inv.value / inv.qtyBase;
}
function updateInventory(itemId, qtyBase, price){
  const inv = state.inventory[itemId] || {qtyBase:0, value:0};
  inv.qtyBase += num(qtyBase);
  inv.value += num(qtyBase) * num(price);
  state.inventory[itemId] = inv;
}

function sheetMoveFocus(input, direction=1){
  const scope = input.closest('.sheet-table, .sale-card, .panel') || document;
  const fields = [...scope.querySelectorAll('input, select, textarea')].filter(el => !el.disabled && el.offsetParent !== null);
  const idx = fields.indexOf(input);
  if(idx < 0) return;
  const next = fields[idx + direction];
  if(next && typeof next.focus === 'function'){
    next.focus();
    if(typeof next.select === 'function' && next.tagName === 'INPUT') next.select();
  }
}
function wireSheetKeyboard(scope){
  scope.querySelectorAll('input, select, textarea').forEach(el=>{
    el.addEventListener('keydown', e=>{
      if(e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)){
        if(e.key !== 'Tab') e.preventDefault();
        sheetMoveFocus(el, 1);
      }else if(e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)){
        e.preventDefault();
        sheetMoveFocus(el, -1);
      }
    });
  });
}

function setView(name){
  if(!canAccess(name)) name = allowedStartPage();
  currentView = name;
  $$('.view').forEach(v=>v.classList.remove('active'));
  const target = $('#view-' + name);
  if(target) target.classList.add('active');
  $$('.bottom-nav button').forEach(b=>b.classList.toggle('active', b.dataset.go === name));
  $('#subTitle').textContent = pageLabel(name);
  render();
}
function render(){
  const focusState = captureFocusState();
  renderAuthVisibility();
  if(!currentUser){
    renderLogin();
    return;
  }
  ensureDay(currentDate);
  $('#datePicker').value = currentDate;
  syncNavButtons();
  renderShellUser();
  if(!canAccess(currentView)) currentView = allowedStartPage();
  $$('.view').forEach(v=>v.classList.remove('active'));
  const viewEl = $('#view-' + currentView);
  if(viewEl) viewEl.classList.add('active');
  $$('.bottom-nav button').forEach(b=>b.classList.toggle('active', b.dataset.go === currentView));
  $('#subTitle').textContent = pageLabel(currentView);
  if(currentView === 'dashboard') renderDashboard();
  if(currentView === 'purchase') renderPurchase();
  if(currentView === 'production') renderDept('production');
  if(currentView === 'packaging') renderDept('packaging');
  if(currentView === 'sale') renderSale();
  if(currentView === 'more') renderMore();
  restoreFocusState(focusState);
}
function filterRows(bodyId, q){
  q = String(q || '').trim().toLowerCase();
  $$('#' + bodyId + ' tr').forEach(tr=>{
    tr.style.display = !q || (tr.dataset.search || '').toLowerCase().includes(q) ? '' : 'none';
  });
}
function renderDashboard(){
  const day = currentDay();
  const prodValue = Object.entries(day.production).reduce((s,[id,r])=>s + num(r.closing) * avgCost(id), 0);
  const packValue = Object.entries(day.packaging).reduce((s,[id,r])=>s + num(r.closing) * avgCost(id), 0);
  $('#view-dashboard').innerHTML = `
    <div class="panel">
      <div class="sectionhead">
        <div>
          <div class="pill">Today: ${currentDate}</div>
          <div class="small muted" style="margin-top:8px">Blank build. Add items in More.</div>
        </div>
        <button class="btn secondary" id="printDash">Print</button>
      </div>
      <div class="grid">
        <div class="card kpi"><div class="l">Production Items</div><div class="v">${itemList('production').length}</div></div>
        <div class="card kpi"><div class="l">Packaging Items</div><div class="v">${itemList('packaging').length}</div></div>
        <div class="card kpi"><div class="l">Production Value</div><div class="v">${money(prodValue)}</div></div>
        <div class="card kpi"><div class="l">Packaging Value</div><div class="v">${money(packValue)}</div></div>
      </div>
    </div>
  `;
  $('#printDash').onclick = ()=>window.print();
}
function purchaseDeptOf(id){ return itemKind(id) === 'production' ? 'production' : 'packaging'; }
function renderPurchase(){
  const options = itemAll().filter(x=>x.kind==='production' || x.kind==='packaging')
    .map(x=>`<option value="${esc(x.id)}">${esc(x.id)} — ${esc(x.name)} (${x.kind})</option>`).join('');
  const list = state.purchases.filter(p=>p.date===currentDate);
  $('#view-purchase').innerHTML = `
    <div class="panel">
      <div class="sectionhead">
        <h3>Purchase</h3>
        <div class="row no-print">
          <button class="btn secondary" id="exportPurchase">Export CSV</button>
          <button class="btn secondary" id="exportPurchaseJson">Export JSON</button>
          <button class="btn secondary" id="printPurchase">Print</button>
        </div>
      </div>
      <div class="stack no-print">
        <div class="grid">
          <div><label class="small muted">Item</label><select id="pItem">${options || '<option value="">No items</option>'}</select></div>
          <div><label class="small muted">Actual Qty</label><input id="pQty" type="text" inputmode="decimal" autocomplete="off" placeholder=""></div>
          <div><label class="small muted">Unit</label><select id="pUnit"><option value="pcs">pcs</option><option value="g">g</option><option value="kg">kg</option><option value="viss">viss</option></select></div>
          <div><label class="small muted">Unit Price</label><input id="pPrice" type="text" inputmode="decimal" autocomplete="off" placeholder=""></div>
          <div><label class="small muted">Confirmed</label><select id="pConfirmed"><option value="0">No</option><option value="1">Yes</option></select></div>
        </div>
        <button class="btn good" id="addPurchase">Add Purchase Row</button>
      </div>
    </div>
    <div class="panel">
      <div class="sectionhead">
        <h3>Today Purchases</h3>
        <input class="no-print" id="purchaseSearch" placeholder="Search..." style="max-width:220px">
      </div>
      <div class="tblwrap">
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Price</th><th>Total</th><th>Confirmed</th><th>Action</th></tr></thead>
          <tbody id="purchaseBody">${list.map((p,idx)=>purchaseRowHtml(p, idx)).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  $('#exportPurchase').onclick = ()=>downloadCSV(purchaseExportRows(list), `purchase-${currentDate}.csv`);
  $('#exportPurchaseJson').onclick = ()=>downloadJSON({date: currentDate, purchases: list}, `purchase-${currentDate}.json`);
  $('#printPurchase').onclick = ()=>window.print();
  $('#addPurchase').onclick = ()=>{
    const itemId = $('#pItem').value;
    if(!itemId) return toast('Add an item first');
    const row = {
      date: currentDate,
      itemId,
      qty: num($('#pQty').value),
      unit: $('#pUnit').value,
      price: num($('#pPrice').value),
      confirmed: $('#pConfirmed').value === '1',
      applied: false
    };
    state.purchases.push(row);
    if(row.confirmed) applyPurchase(row);
    save();
    render();
  };
  $('#purchaseSearch').oninput = e => filterRows('purchaseBody', e.target.value);
  attachPurchaseHandlers();
}

function purchaseRowHtml(p, idx){
  return `
    <tr data-search="${esc(p.itemId)} ${esc(itemName(p.itemId))}">
      <td>${esc(itemName(p.itemId))}</td>
      <td><input data-purchase-field="qty" data-idx="${idx}" ${smartInputAttrs()} value="${displayNum(p.qty)}"></td>
      <td><select data-purchase-field="unit" data-idx="${idx}">${['pcs','g','kg','viss'].map(u=>`<option value="${u}"${p.unit===u?' selected':''}>${u}</option>`).join('')}</select></td>
      <td><input data-purchase-field="price" data-idx="${idx}" ${smartInputAttrs()} value="${displayNum(p.price)}"></td>
      <td>${money(num(p.qty)*num(p.price))}</td>
      <td><select data-purchase-field="confirmed" data-idx="${idx}"><option value="0"${!p.confirmed?' selected':''}>No</option><option value="1"${p.confirmed?' selected':''}>Yes</option></select></td>
      <td><button class="btn danger" data-purchase-del="${idx}">Delete</button></td>
    </tr>
  `;
}
function applyPurchase(row){
  const item = byId(row.itemId);
  if(!item) return;
  const baseQty = toBase(row.itemId, row.qty, row.unit);
  const dept = purchaseDeptOf(row.itemId);
  const day = currentDay();
  if(!day[dept][row.itemId]) day[dept][row.itemId] = blankDeptRow();
  day[dept][row.itemId].in = num(day[dept][row.itemId].in) + baseQty;
  recalcDept(day[dept][row.itemId]);
  updateInventory(row.itemId, baseQty, row.price);
  row.applied = true;
  save();
}

function attachPurchaseHandlers(){
  $$("[data-purchase-field]").forEach(el=>{
    el.oninput = e=>{
      const idx = Number(e.target.dataset.idx);
      const list = state.purchases.filter(p=>p.date===currentDate);
      const row = list[idx];
      if(!row) return;
      const field = e.target.dataset.purchaseField;
      if(field === 'qty' || field === 'price'){
        const current = num(row[field]);
        const parsed = parseSmartNumber(e.target.value, current);
        if(parsed === null) return;
        row[field] = parsed;
        e.target.value = formatSmartNumber(parsed);
      }else if(field === 'unit'){
        row.unit = e.target.value;
      }else if(field === 'confirmed'){
        const val = e.target.value === '1';
        if(val && !row.applied) applyPurchase(row);
        row.confirmed = val;
      }
      save();
      const tr = e.target.closest('tr');
      if(tr){
        tr.children[4].textContent = displayMoney(num(row.qty) * num(row.price));
      }
    };
  });
  $$("[data-purchase-del]").forEach(btn=>btn.onclick=()=>{
    const idx = Number(btn.dataset.purchaseDel);
    const list = state.purchases.filter(p=>p.date===currentDate);
    const row = list[idx];
    state.purchases = state.purchases.filter(p=>p !== row);
    save();
    render();
  });
}
function updateDeptField(row, field, raw){
  if(field === 'note'){
    row.note = String(raw ?? '');
    return;
  }
  // Used is read-only and always calculated from Issued - Return - Damage
  if(field === 'used') return;
  const current = num(row[field]);
  const parsed = parseSmartNumber(raw, current);
  if(parsed === null) return;
  row[field] = parsed;
  recalcDept(row);
  if(typeof currentDate === 'string') normalizeCarryForward(currentDate);
}


function deptExportRows(kind, rows){
  const headers = ['Item ID','Item Name','Opening','In','Issued','Return','Damage','Used','Closing','Unit','Value','Note'];
  const out = [headers];
  itemList(kind).forEach(it=>{
    const r = rows[it.id] || blankDeptRow();
    out.push([
      it.id,
      itemName(it.id),
      num(r.opening),
      num(r.in),
      num(r.issued),
      num(r.return),
      num(r.damage),
      num(r.used),
      num(r.closing),
      baseLabel(it.id),
      num(r.closing) * avgCost(it.id),
      r.note || ''
    ]);
  });
  return out;
}
function purchaseExportRows(list){
  return [
    ['Date','Item ID','Item Name','Qty','Unit','Unit Price','Total','Confirmed'],
    ...list.map(p=>[
      p.date,
      p.itemId,
      itemName(p.itemId),
      num(p.qty),
      p.unit || '',
      num(p.price),
      num(p.qty) * num(p.price),
      p.confirmed ? 'Yes' : 'No'
    ])
  ];
}
function saleExportRows(day){
  const rows = [['Date','Item ID','Item Name','Shop','Sell Qty','Price','Total']];
  itemList('sale').forEach(it=>{
    const sale = day.sale[it.id] || blankSaleRow();
    (sale.buyers || []).forEach(b=>{
      const price = num(b.price || state.settings.prices[it.id]?.[b.shop] || 0);
      rows.push([currentDate, it.id, itemName(it.id), b.shop || '', num(b.sell), price, num(b.sell)*price]);
    });
  });
  return rows;
}
function itemExportRows(){
  return [['Item ID','Name','Type','Unit','Status'], ...itemAll().map(it => [it.id, it.name, it.kind, it.unit, it.status])];
}

function renderDept(kind){
  const items = itemList(kind);
  const day = currentDay();
  const rows = day[kind];
  $('#view-' + kind).innerHTML = `
    <div class="panel">
      <div class="sectionhead">
        <h3>${kind[0].toUpperCase()+kind.slice(1)}</h3>
        <div class="row no-print">
          <button class="btn secondary" id="print${kind}">Print</button>
          <button class="btn secondary" id="export${kind}">Export CSV</button>
          <button class="btn secondary" id="export${kind}Json">Export JSON</button>
        </div>
      </div>
      <div class="grid no-print">
        <div><label class="small muted">Search</label><input id="${kind}Search" placeholder="Search item / id"></div>
        <div></div>
      </div>
    </div>
    <div class="panel">
      <div class="tblwrap">
        <table class="sheet-table">
          <thead>
            <tr>
              <th>Item</th><th>Opening</th><th>In</th><th>Issued</th><th>Return</th><th>Damage</th><th>Used</th><th>Closing</th><th>Unit</th><th>Value</th><th>Note</th>
            </tr>
          </thead>
          <tbody id="${kind}Body">${items.map(it=>deptRowHtml(kind, it.id, rows[it.id])).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  $('#print'+kind).onclick = ()=>window.print();
  $('#export'+kind).onclick = ()=>downloadCSV(deptExportRows(kind, rows), `${kind}-${currentDate}.csv`);
  $('#export'+kind+'Json').onclick = ()=>downloadJSON({date: currentDate, [kind]: rows}, `${kind}-${currentDate}.json`);
  $('#'+kind+'Search').oninput = e => filterRows(kind+'Body', e.target.value);
  attachDeptHandlers(kind);
  wireSheetKeyboard($('#view-' + kind));
}
function deptRowHtml(kind, id, r){
  recalcDept(r);
  const bad = num(r.closing) < 0;
  return `
    <tr data-search="${esc(id)} ${esc(itemName(id))} ${esc(r.note || '')}">
      <td class="item-name">${esc(itemName(id))}</td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="opening" ${smartInputAttrs()} value="${displayNum(r.opening)}" ${bad?'class="bad"':''}></td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="in" ${smartInputAttrs()} value="${displayNum(r.in)}" ${bad?'class="bad"':''}></td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="issued" ${smartInputAttrs()} value="${displayNum(r.issued)}" ${bad?'class="bad"':''}></td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="return" ${smartInputAttrs()} value="${displayNum(r.return)}" ${bad?'class="bad"':''}></td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="damage" ${smartInputAttrs()} value="${displayNum(r.damage)}" ${bad?'class="bad"':''}></td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="used" ${smartInputAttrs()} value="${displayNum(r.used)}" readonly ${bad?'class="bad"':''}></td>
      <td class="closing-cell ${bad?'bad':''}">${displayBase(id, r.closing)}</td>
      <td>${baseLabel(id)}</td>
      <td class="value-cell">${displayMoney(num(r.closing) * avgCost(id))}</td>
      <td><input data-kind="${kind}" data-id="${esc(id)}" data-field="note" type="text" autocomplete="off" value="${esc(r.note || '')}" placeholder="Reason / note"></td>
    </tr>
  `;
}
function attachDeptHandlers(kind){
  $$(`input[data-kind="${kind}"]`).forEach(el=>{
    el.oninput = e=>{
      const id = e.target.dataset.id;
      const field = e.target.dataset.field;
      const row = currentDay()[kind][id];
      updateDeptField(row, field, e.target.value);
      const tr = e.target.closest('tr');
      if(tr){
        if(field !== 'note'){
          // Only update the Used field since it's calculated
          const usedInput = tr.querySelector('input[data-field="used"]');
          if(usedInput) usedInput.value = formatSmartNumber(row.used);
          // Update closing display
          tr.querySelector('.closing-cell').textContent = displayBase(id, row.closing);
          tr.querySelector('.value-cell').textContent = displayMoney(num(row.closing) * avgCost(id));
        }
      }
      if(field !== 'note' && num(row.closing) < 0) toast('Closing cannot be negative');
      save();
    };
  });
}

function renderSale(){
  const day = currentDay();
  const items = itemList('sale');
  $('#view-sale').innerHTML = `
    <div class="panel">
      <div class="sectionhead">
        <h3>Sale</h3>
        <div class="row no-print">
          <button class="btn secondary" id="exportSale">Export CSV</button>
          <button class="btn secondary" id="exportSaleJson">Export JSON</button>
          <button class="btn secondary" id="printSale">Print</button>
        </div>
      </div>
      <div class="small muted">Each product is fixed row. Buyer rows under it are dynamic.</div>
      <div class="grid no-print" style="margin-top:10px">
        <div><label class="small muted">Search</label><input id="saleSearch" placeholder="Search item / buyer"></div>
        <div></div>
      </div>
    </div>
    <div id="saleContainer" class="stack">
      ${items.map(it=>saleCardHtml(it.id, day.sale[it.id])).join('')}
    </div>
  `;
  $('#exportSale').onclick = ()=>downloadCSV(saleExportRows(day), `sale-${currentDate}.csv`);
  $('#exportSaleJson').onclick = ()=>downloadJSON({date: currentDate, sale: day.sale}, `sale-${currentDate}.json`);
  $('#printSale').onclick = ()=>window.print();
  $('#saleSearch').oninput = e => filterRows('saleContainer', e.target.value);
  attachSaleHandlers();
}
function saleCardHtml(id, row){
  recalcSale(row);
  const buyers = row.buyers || [{shop:'',sell:0,price:0}];
  return `
    <div class="panel sale-card" data-search="${esc(id)} ${esc(itemName(id))}">
      <div class="sectionhead">
        <h3>${esc(itemName(id))}</h3>
        <span class="pill">Closing: ${displayBase(id, row.closing)}</span>
      </div>
      <div class="grid">
        <div><label class="small muted">Opening</label><input data-sale-id="${esc(id)}" data-field="opening" ${smartInputAttrs()} value="${displayNum(row.opening)}"></div>
        <div><label class="small muted">Produce</label><input data-sale-id="${esc(id)}" data-field="produce" ${smartInputAttrs()} value="${displayNum(row.produce)}"></div>
      </div>
      <div class="tblwrap" style="margin-top:10px">
        <table>
          <thead><tr><th>Buyer</th><th>Sell</th><th>Price</th><th>Total</th><th></th></tr></thead>
          <tbody>
            ${buyers.map((b,idx)=>{
              const price = b.price || state.settings.prices[id]?.[b.shop] || 0;
              return `
                <tr data-buy-row="${idx}" data-search="${esc(b.shop)} ${esc(id)}">
                  <td>
                    <select data-sale-id="${esc(id)}" data-row="${idx}" data-field="shop">
                      <option value="">Select</option>
                      ${state.settings.shops.map(s=>`<option value="${esc(s)}"${b.shop===s?' selected':''}>${esc(s)}</option>`).join('')}
                    </select>
                  </td>
                  <td><input data-sale-id="${esc(id)}" data-row="${idx}" data-field="sell" ${smartInputAttrs()} value="${displayNum(b.sell)}"></td>
                  <td><input data-sale-id="${esc(id)}" data-row="${idx}" data-field="price" ${smartInputAttrs()} value="${displayNum(price)}"></td>
                  <td class="buyer-total">${displayMoney(num(b.sell) * num(price))}</td>
                  <td><button class="btn danger" data-del-buyer="${esc(id)}" data-row="${idx}">X</button></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="row no-print" style="margin-top:10px">
        <button class="btn good" data-add-buyer="${esc(id)}">Add Buyer Row</button>
      </div>
    </div>
  `;
}
function attachSaleHandlers(){
  $$("[data-sale-id]").forEach(el=>{
    el.oninput = e=>{
      const id = e.target.dataset.saleId;
      const row = currentDay().sale[id];
      const field = e.target.dataset.field;
      if(field === 'opening' || field === 'produce'){
        const parsed = parseSmartNumber(e.target.value, num(row[field]));
        if(parsed === null) return;
        row[field] = parsed;
        e.target.value = formatSmartNumber(parsed);
      }else{
        const idx = Number(e.target.dataset.row);
        const b = row.buyers[idx];
        if(!b) return;
        if(field === 'shop'){
          b.shop = e.target.value;
          b.price = state.settings.prices[id]?.[b.shop] || 0;
        }else if(field === 'sell' || field === 'price'){
          const parsed = parseSmartNumber(e.target.value, num(b[field]));
          if(parsed === null) return;
          b[field] = parsed;
          e.target.value = formatSmartNumber(parsed);
        }
      }
      recalcSale(row);
      updateSaleCard(id);
      save();
    };
  });
  $$("[data-add-buyer]").forEach(btn=>btn.onclick=()=>{
    const id = btn.dataset.addBuyer;
    currentDay().sale[id].buyers.push({shop:'',sell:0,price:0});
    renderSale();
  });
  $$("[data-del-buyer]").forEach(btn=>btn.onclick=()=>{
    const id = btn.dataset.delBuyer;
    const idx = Number(btn.dataset.row);
    const row = currentDay().sale[id];
    row.buyers.splice(idx,1);
    if(!row.buyers.length) row.buyers = [{shop:'',sell:0,price:0}];
    recalcSale(row);
    renderSale();
  });
}
function updateSaleCard(id){
  const row = currentDay().sale[id];
  recalcSale(row);
  const card = [...document.querySelectorAll('.sale-card')].find(el=>el.dataset.search.includes(id));
  if(!card) return;
  const head = card.querySelector('.pill');
  if(head) head.textContent = `Closing: ${displayBase(id, row.closing)}`;
  [...card.querySelectorAll('tbody tr')].forEach(tr=>{
    const idx = Number(tr.dataset.buyRow);
    const b = row.buyers[idx];
    if(!b) return;
    const price = b.price || state.settings.prices[id]?.[b.shop] || 0;
    tr.querySelector('.buyer-total').textContent = displayMoney(num(b.sell) * num(price));
  });
}

function renderMore(){
  const buttons = [
    canAccess('items') ? `<button class="btn secondary" id="btnItems">Item Dashboard</button>` : '',
    canAccess('shops') ? `<button class="btn secondary" id="btnShops">Shops</button>` : '',
    canAccess('recipe') ? `<button class="btn secondary" id="btnRecipe">Recipe</button>` : '',
    canAccess('report') ? `<button class="btn secondary" id="btnReport">Report Filter</button>` : '',
    canAccess('users') ? `<button class="btn secondary" id="btnUsers">Users</button>` : '',
    `<button class="btn secondary" id="btnBackup">Export Backup</button>`,
    `<button class="btn secondary" id="btnImport">Import Backup</button>`
  ].filter(Boolean).join('');
  $('#view-more').innerHTML = `
    <div class="panel">
      <div class="sectionhead"><h3>More / Settings</h3><span class="muted small">Setup, item dashboard, report filter, backup</span></div>
      <div class="grid">
        ${buttons}
      </div>
    </div>
    <div id="moreBody"></div>
  `;
  if($('#btnItems')) $('#btnItems').onclick = ()=>renderMoreItems();
  if($('#btnShops')) $('#btnShops').onclick = ()=>renderMoreShops();
  if($('#btnRecipe')) $('#btnRecipe').onclick = ()=>renderMoreRecipe();
  if($('#btnReport')) $('#btnReport').onclick = ()=>renderMoreReport();
  if($('#btnUsers')) $('#btnUsers').onclick = ()=>renderMoreUsers();
  $('#btnBackup').onclick = ()=>downloadJSON(state, `backup-${currentDate}.json`);
  $('#btnImport').onclick = openImport;
  if(canAccess('items')) renderMoreItems();
  else if(canAccess('report')) renderMoreReport();
  else if(canAccess('users')) renderMoreUsers();
  else if(canAccess('shops')) renderMoreShops();
  else if(canAccess('recipe')) renderMoreRecipe();
}

function renderMoreItems(){
  const activeItems = itemAll();
  $('#moreBody').innerHTML = `
    <div class="panel">
      <div class="sectionhead"><h3>Item Dashboard</h3><span class="muted small">Manage items • ID auto-generated</span></div>
      <div class="grid no-print">
        <div><label class="small muted">Item Name</label><input id="newName" placeholder="Flour"></div>
        <div><label class="small muted">Type</label>
          <select id="newKind">
            <option value="production">Production</option>
            <option value="packaging">Packaging</option>
            <option value="sale">Sale</option>
          </select>
        </div>
        <div><label class="small muted">Unit</label>
          <select id="newUnit">
            <option value="pcs">pcs</option>
            <option value="g">g</option>
            <option value="kg">kg</option>
            <option value="viss">viss</option>
          </select>
        </div>
        <div class="row" style="align-self:end">
          <button class="btn good" id="addItemBtn">Add Item</button>
          <button class="btn secondary" id="exportItemsBtn">Export CSV</button>
          <button class="btn secondary" id="exportItemsJsonBtn">Export JSON</button>
        </div>
      </div>
      <div class="tblwrap" style="margin-top:12px">
        <table class="sheet-table">
          <thead><tr><th>Name</th><th>Type</th><th>Unit</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${activeItems.map(it=>itemRowHtml(it)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  $('#addItemBtn').onclick = addItem;
  $('#exportItemsBtn').onclick = ()=>downloadCSV(itemExportRows(), `items-${currentDate}.csv`);
  $('#exportItemsJsonBtn').onclick = ()=>downloadJSON({items: itemAll()}, `items-${currentDate}.json`);
  wireSheetKeyboard($('#moreBody'));
  $$('[data-item-field]').forEach(inp=>{
    inp.oninput = e=>{
      const item = byId(e.target.dataset.id);
      if(!item) return;
      const field = e.target.dataset.field;
      if(field === 'name'){
        const newName = e.target.value.trim();
        if(!newName) return toast('Enter item name');
        if(state.settings.items.some(x => x.name.toLowerCase() === newName.toLowerCase() && x.id !== item.id)) return toast(`Item name "${newName}" already exists`);
        item.name = newName;
      }else if(field === 'kind'){
        const oldKind = item.kind;
        const newKind = e.target.value;
        if(oldKind !== newKind){
          item.kind = newKind;
          for(const d of Object.keys(state.days)){
            const day = state.days[d];
            if(!day[oldKind]) day[oldKind] = {};
            if(!day[newKind]) day[newKind] = {};
            const row = day[oldKind]?.[item.id];
            if(row){
              delete day[oldKind][item.id];
              day[newKind][item.id] = oldKind === 'sale' ? deep(blankSaleRow()) : deep(row);
            }
          }
        }
      }else if(field === 'unit'){
        item.unit = e.target.value;
      }else if(field === 'status'){
        item.status = e.target.value;
      }
      sortItems();
      save();
    };
  });
  $$('[data-item-del]').forEach(btn=>btn.onclick=()=>{
    const item = byId(btn.dataset.itemDel);
    if(!item) return;
    item.status = 'offline';
    save();
    renderMoreItems();
    renderDept('production');
    renderDept('packaging');
    renderSale();
  });
}

function itemRowHtml(it){
  return `
    <tr data-search="${esc(it.id)} ${esc(it.name)} ${esc(it.kind)} ${esc(it.unit)}">
      <td><input data-item-field data-id="${esc(it.id)}" data-field="name" value="${esc(it.name)}"></td>
      <td>
        <select data-item-field data-id="${esc(it.id)}" data-field="kind">
          <option value="production"${it.kind==='production'?' selected':''}>Production</option>
          <option value="packaging"${it.kind==='packaging'?' selected':''}>Packaging</option>
          <option value="sale"${it.kind==='sale'?' selected':''}>Sale</option>
        </select>
      </td>
      <td>
        <select data-item-field data-id="${esc(it.id)}" data-field="unit">
          <option value="pcs"${it.unit==='pcs'?' selected':''}>pcs</option>
          <option value="g"${it.unit==='g'?' selected':''}>g</option>
          <option value="kg"${it.unit==='kg'?' selected':''}>kg</option>
          <option value="viss"${it.unit==='viss'?' selected':''}>viss</option>
        </select>
      </td>
      <td>
        <select data-item-field data-id="${esc(it.id)}" data-field="status">
          <option value="active"${it.status==='active'?' selected':''}>Active</option>
          <option value="offline"${it.status!=='active'?' selected':''}>Offline</option>
        </select>
      </td>
      <td><button class="btn danger" data-item-del="${esc(it.id)}">Off</button></td>
    </tr>
  `;
}

function addItem(){
  const name = $('#newName')?.value.trim();
  const kind = $('#newKind')?.value || 'production';
  const unit = $('#newUnit')?.value || 'pcs';
  if(!name) return toast('Enter item name');
  if(state.settings.items.some(x => x.name.toLowerCase() === name.toLowerCase())) return toast(`Item name "${name}" already exists`);
  const id = nextItemId();
  const item = { id, name, kind, unit, status: 'active' };
  state.settings.items.push(item);
  state.settings.prices[id] = state.settings.prices[id] || {};
  hydrateItemAcrossDays(item);
  sortItems();
  save();
  toast(`Added ${id}`);
  render();
}


function renderMoreShops(){
  const shops = state.settings.shops || [];
  const items = itemList('sale');
  const selectedShop = $('#priceShop')?.value || shops[0] || '';
  const priceRows = items.map(it=>{
    const price = state.settings.prices?.[it.id]?.[selectedShop] ?? '';
    return `<tr data-search="${esc(it.id)} ${esc(it.name)}">
      <td class="item-name">${esc(it.name)}</td>
      <td>${esc(it.id)}</td>
      <td><input data-shop-price data-item="${esc(it.id)}" data-shop="${esc(selectedShop)}" ${smartInputAttrs()} value="${esc(price)}"></td>
    </tr>`;
  }).join('') || '<tr><td colspan="3">Add sale items first</td></tr>';
  $('#moreBody').innerHTML = `
    <div class="panel">
      <div class="sectionhead"><h3>Shops</h3><span class="muted small">Manage buyer/customer names and fixed prices.</span></div>
      <div class="grid no-print">
        <div><label class="small muted">Shop Name</label><input id="shopName" placeholder="Shop A"></div>
        <div class="row" style="align-self:end"><button class="btn good" id="addShopBtn">Add Shop</button></div>
      </div>
      <div class="list" style="margin-top:12px">
        ${shops.map(s=>`
          <div class="row space card">
            <div>${esc(s)}</div>
            <button class="btn danger" data-del-shop="${esc(s)}">Delete</button>
          </div>
        `).join('') || '<div class="muted">No shops yet</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="sectionhead"><h3>Shop Prices</h3><span class="muted small">Pick a shop and set fixed item prices</span></div>
      <div class="grid no-print">
        <div><label class="small muted">Shop</label><select id="priceShop">${shops.map(s=>`<option value="${esc(s)}"${s===selectedShop?' selected':''}>${esc(s)}</option>`).join('') || '<option value="">No shops</option>'}</select></div>
        <div class="row" style="align-self:end"><button class="btn secondary" id="savePricesBtn">Save Prices</button></div>
      </div>
      <div class="tblwrap" style="margin-top:12px">
        <table class="sheet-table">
          <thead><tr><th>Item</th><th>ID</th><th>Price</th></tr></thead>
          <tbody id="shopPriceBody">${priceRows}</tbody>
        </table>
      </div>
    </div>
  `;
  $('#addShopBtn').onclick = ()=>{
    const name = $('#shopName').value.trim();
    if(!name) return toast('Enter shop name');
    if(state.settings.shops.some(s => s.toLowerCase() === name.toLowerCase())) return toast('Shop already exists');
    state.settings.shops.push(name);
    state.settings.shops.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true, sensitivity:'base'}));
    save();
    renderMoreShops();
    renderSale();
  };
  $('#priceShop').onchange = ()=>renderMoreShops();
  $('#savePricesBtn').onclick = ()=>{
    const shop = $('#priceShop').value;
    if(!shop) return toast('Select shop');
    const inputs = [...document.querySelectorAll('[data-shop-price]')];
    state.settings.prices = state.settings.prices || {};
    inputs.forEach(inp=>{
      const id = inp.dataset.item;
      const parsed = parseSmartNumber(inp.value, num(state.settings.prices?.[id]?.[shop] ?? 0));
      if(parsed === null) return;
      state.settings.prices[id] = state.settings.prices[id] || {};
      state.settings.prices[id][shop] = parsed;
    });
    save();
    toast('Prices saved');
    renderSale();
  };
  $$('[data-del-shop]').forEach(btn=>btn.onclick=()=>{
    state.settings.shops = state.settings.shops.filter(s => s !== btn.dataset.delShop);
    save();
    renderMoreShops();
    renderSale();
  });
  $$('[data-shop-price]').forEach(inp=>{
    inp.oninput = e=>{
      const shop = e.target.dataset.shop;
      const id = e.target.dataset.item;
      const parsed = parseSmartNumber(e.target.value, num(state.settings.prices?.[id]?.[shop] ?? 0));
      if(parsed === null) return;
      state.settings.prices[id] = state.settings.prices[id] || {};
      state.settings.prices[id][shop] = parsed;
      save();
    };
  });
}

function recipeRowHtml(row){

  const items = itemAll().filter(x => x.status === 'active');
  return `
    <tr>
      <td>
        <select data-recipe-item>
          <option value="">Select item</option>
          ${items.map(it=>`<option value="${esc(it.id)}"${row.itemId===it.id?' selected':''}>${esc(it.id)} — ${esc(it.name)}</option>`).join('')}
        </select>
      </td>
      <td><input data-recipe-qty ${smartInputAttrs()} value="${displayNum(row.qty)}"></td>
      <td><button class="btn danger" data-recipe-del>Delete</button></td>
    </tr>
  `;
}

function renderMoreRecipe(){
  const items = itemAll().filter(x => x.status === 'active');
  if(!items.length){
    $('#moreBody').innerHTML = `<div class="panel"><div class="muted">Add items first.</div></div>`;
    return;
  }
  const selected = $('#recipeItem')?.value || items[0].id;
  const rows = state.settings.recipe?.[selected] || [];
  $('#moreBody').innerHTML = `
    <div class="panel">
      <div class="sectionhead"><h3>Recipe</h3><span class="muted small">Ingredient mapping by item.</span></div>
      <div class="grid no-print">
        <div><label class="small muted">Product Item</label><select id="recipeItem">${items.map(it=>`<option value="${esc(it.id)}"${it.id===selected?' selected':''}>${esc(it.id)} — ${esc(it.name)}</option>`).join('')}</select></div>
        <div class="row" style="align-self:end"><button class="btn good" id="addRecipeRow">Add Ingredient</button><button class="btn secondary" id="saveRecipe">Save</button></div>
      </div>
      <div class="tblwrap" style="margin-top:12px">
        <table>
          <thead><tr><th>Ingredient</th><th>Qty</th><th>Action</th></tr></thead>
          <tbody id="recipeBody">
            ${rows.map(r=>recipeRowHtml(r)).join('') || '<tr><td colspan="3">No ingredients</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  const collect = ()=>{
    const rowEls = [...$('#recipeBody').querySelectorAll('tr')];
    return rowEls.map(tr => {
      const sel = tr.querySelector('[data-recipe-item]');
      const qty = tr.querySelector('[data-recipe-qty]');
      return { itemId: sel ? sel.value : '', qty: num(qty ? qty.value : 0) };
    }).filter(r => r.itemId);
  };
  $('#saveRecipe').onclick = ()=>{
    state.settings.recipe = state.settings.recipe || {};
    state.settings.recipe[selected] = collect();
    save();
    toast('Recipe saved');
    renderMoreRecipe();
  };
  $('#addRecipeRow').onclick = ()=>{
    const tbody = $('#recipeBody');
    if(tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
    const tr = document.createElement('tr');
    tr.innerHTML = recipeRowHtml({itemId:'', qty:0});
    tbody.appendChild(tr);
  };
  $('#recipeItem').onchange = ()=>renderMoreRecipe();
  $$('[data-recipe-del]').forEach(btn=>btn.onclick=()=>btn.closest('tr')?.remove());
}
function renderLogin(){
  renderAuthVisibility();
  const el = $('#authView');
  if(!el) return;
  el.innerHTML = `
    <div class="auth-card">
      <div class="brand">ERP Version 8</div>
      <div class="sub" style="margin-top:6px">Firebase login</div>
      <div class="stack" style="margin-top:14px">
        <div>
          <label class="small muted">Email</label>
          <input id="loginEmail" type="email" placeholder="admin@email.com" value="${esc(ADMIN_BOOTSTRAP.email)}">
        </div>
        <div>
          <label class="small muted">Password</label>
          <input id="loginPass" type="password" placeholder="Password" value="${esc(ADMIN_BOOTSTRAP.password)}">
        </div>
        <button class="btn good" id="loginBtn">Login</button>
        <div class="small muted">${loginError ? esc(loginError) : 'Admin login is prefilled. Staff users are created in Settings.'}</div>
      </div>
    </div>
  `;
  $('#loginBtn').onclick = async()=>{
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPass').value;
    if(!email || !password) return toast('Enter email and password');
    loginError = '';
    try{
      if(!auth) initFirebase();
      let user;
      try{
        const cred = await auth.signInWithEmailAndPassword(email, password);
        user = cred.user;
      }catch(err){
        if(email.toLowerCase() === ADMIN_BOOTSTRAP.email.toLowerCase() && password === ADMIN_BOOTSTRAP.password){
          const methods = await auth.fetchSignInMethodsForEmail(email);
          if(!methods || !methods.length){
            const cred = await auth.createUserWithEmailAndPassword(email, password);
            user = cred.user;
            await db.collection('users').doc(user.uid).set({
              uid: user.uid,
              email,
              displayName: 'Admin',
              role: 'admin',
              active: true,
              permissions: allPermissions()
            }, { merge: true });
          }else{
            throw err;
          }
        }else{
          throw err;
        }
      }
      await afterLogin(user);
    }catch(err){
      loginError = err?.message || 'Login failed';
      renderLogin();
    }
  };
}
async function afterLogin(user){
  currentUser = user;
  currentProfile = await ensureProfile(user);
  if(currentProfile.active === false){
    loginError = 'This user is disabled';
    await auth.signOut().catch(()=>{});
    renderLogin();
    return;
  }
  renderAuthVisibility();
  startCloudListener();
  syncNavButtons();
  if(!canAccess(currentView)) currentView = allowedStartPage();
  render();
  scheduleCloudSave();
}

function openImport(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async()=>{
    const file = input.files[0];
    if(!file) return;
    try{
      const parsed = JSON.parse(await file.text());
      state = mergeState(parsed);
      normalizeCarryForward();
      save();
      toast('Imported');
      render();
    }catch(e){
      alert('Invalid JSON');
    }
  };
  input.click();
}
function sortItems(){ state.settings.items.sort((a,b)=>idCompare(a.id,b.id)); }




let usersUnsub = null;

function normalizeRangeStartEnd(from, to){
  const a = String(from || todayISO());
  const b = String(to || todayISO());
  return a <= b ? [a, b] : [b, a];
}
function isoDateList(from, to){
  const [start, end] = normalizeRangeStartEnd(from, to);
  const out = [];
  let cur = new Date(start + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  if(Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime())) return out;
  while(cur <= last){
    out.push(cur.toISOString().slice(0,10));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
function reportItemRows(itemId, from, to){
  const item = byId(itemId);
  if(!item) return [];
  const kind = item.kind;
  return isoDateList(from, to).map(date => {
    const row = state.days?.[date]?.[kind]?.[itemId] || blankDeptRow();
    return {
      date,
      opening: num(row.opening),
      in: num(row.in),
      issued: num(row.issued),
      return: num(row.return),
      damage: num(row.damage),
      used: num(row.used),
      closing: num(row.closing),
      note: row.note || ''
    };
  });
}
function reportItemSummary(rows){
  return rows.reduce((acc, r) => {
    acc.opening += num(r.opening);
    acc.in += num(r.in);
    acc.issued += num(r.issued);
    acc.return += num(r.return);
    acc.damage += num(r.damage);
    acc.used += num(r.used);
    acc.closing = num(r.closing);
    return acc;
  }, { opening:0, in:0, issued:0, return:0, damage:0, used:0, closing:0 });
}
function reportItemExportRows(itemId, from, to){
  const item = byId(itemId);
  const rows = reportItemRows(itemId, from, to);
  const summary = reportItemSummary(rows);
  const [start, end] = normalizeRangeStartEnd(from, to);
  return [
    ['Item ID', item?.id || ''],
    ['Item Name', item?.name || ''],
    ['Type', item?.kind || ''],
    ['From', start],
    ['To', end],
    [],
    ['Date','Opening','In','Issued','Return','Damage','Used','Closing','Note'],
    ...rows.map(r=>[
      r.date, r.opening, r.in, r.issued, r.return, r.damage, r.used, r.closing, r.note
    ]),
    [],
    ['Summary'],
    ['Total Opening', summary.opening],
    ['Total In', summary.in],
    ['Total Issued', summary.issued],
    ['Total Return', summary.return],
    ['Total Damage', summary.damage],
    ['Total Used', summary.used],
    ['Last Closing', summary.closing]
  ];
}

function renderMoreReport(){
  const allItems = itemAll();
  const active = allItems.filter(it => it.status === 'active');
  const low = active.map(it => {
    const value = num(currentDay()[it.kind]?.[it.id]?.closing);
    return { it, value };
  }).filter(x => x.value <= num(state.settings.lowStockLevel));

  const reportState = state.report || (state.report = { itemId: '', from: todayISO(), to: todayISO() });
  const reportItems = active.slice();
  if(reportState.itemId && !reportItems.some(it => it.id === reportState.itemId)) reportState.itemId = reportItems[0]?.id || '';
  if(!reportState.from) reportState.from = todayISO();
  if(!reportState.to) reportState.to = todayISO();

  const selectedItem = byId(reportState.itemId) || reportItems[0] || null;
  const selectedItemId = selectedItem?.id || '';
  const historyRows = selectedItemId ? reportItemRows(selectedItemId, reportState.from, reportState.to) : [];
  const summary = reportItemSummary(historyRows);
  const totals = {
    items: active.length,
    low: low.length,
    productionValue: Object.entries(currentDay().production).reduce((s,[id,r])=>s + num(r.closing) * avgCost(id), 0),
    packagingValue: Object.entries(currentDay().packaging).reduce((s,[id,r])=>s + num(r.closing) * avgCost(id), 0)
  };
  const [rangeFrom, rangeTo] = normalizeRangeStartEnd(reportState.from, reportState.to);

  $('#moreBody').innerHTML = `
    <div class="panel">
      <div class="sectionhead">
        <h3>Report Filter</h3>
        <div class="row no-print">
          <button class="btn secondary" id="exportReportCsv">Export CSV</button>
          <button class="btn secondary" id="exportReportJson">Export JSON</button>
        </div>
      </div>
      <div class="grid">
        <div class="card kpi"><div class="l">Active Items</div><div class="v">${totals.items}</div></div>
        <div class="card kpi"><div class="l">Low Stock</div><div class="v">${totals.low}</div></div>
        <div class="card kpi"><div class="l">Production Value</div><div class="v">${money(totals.productionValue)}</div></div>
        <div class="card kpi"><div class="l">Packaging Value</div><div class="v">${money(totals.packagingValue)}</div></div>
      </div>
      <div class="tblwrap" style="margin-top:12px">
        <table class="sheet-table">
          <thead><tr><th>Item</th><th>Type</th><th>Closing</th><th>Min</th><th>Status</th></tr></thead>
          <tbody>
            ${allItems.map(it => {
              const row = currentDay()[it.kind]?.[it.id] || blankDeptRow();
              const closing = num(row.closing);
              const min = num(state.settings.lowStockLevel);
              const cls = closing <= min ? 'bad' : '';
              return `<tr class="${cls}"><td class="item-name">${esc(it.name)}</td><td>${esc(it.kind)}</td><td>${displayBase(it.id, closing)}</td><td>${min}</td><td>${closing <= min ? 'Low' : 'OK'}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel" style="margin-top:8px">
      <div class="sectionhead">
        <h3>Item History</h3>
        <span class="muted small">Date range by item</span>
      </div>
      <div class="grid no-print">
        <div>
          <label class="small muted">Item</label>
          <select id="reportItem">
            ${reportItems.map(it=>`<option value="${esc(it.id)}"${it.id===selectedItemId?' selected':''}>${esc(it.id)} — ${esc(it.name)}</option>`).join('') || '<option value="">No items</option>'}
          </select>
        </div>
        <div>
          <label class="small muted">From</label>
          <input id="reportFrom" type="date" value="${esc(rangeFrom)}">
        </div>
        <div>
          <label class="small muted">To</label>
          <input id="reportTo" type="date" value="${esc(rangeTo)}">
        </div>
        <div class="row" style="align-self:end">
          <button class="btn good" id="applyReportFilter">Apply</button>
          <button class="btn secondary" id="printHistory">Print</button>
        </div>
      </div>

      <div class="grid" style="margin-top:10px">
        <div class="card kpi"><div class="l">Opening</div><div class="v">${displayNum(summary.opening)}</div></div>
        <div class="card kpi"><div class="l">In</div><div class="v">${displayNum(summary.in)}</div></div>
        <div class="card kpi"><div class="l">Issued</div><div class="v">${displayNum(summary.issued)}</div></div>
        <div class="card kpi"><div class="l">Used</div><div class="v">${displayNum(summary.used)}</div></div>
      </div>

      <div class="tblwrap" style="margin-top:12px">
        <table class="sheet-table">
          <thead>
            <tr><th>Date</th><th>Opening</th><th>In</th><th>Issued</th><th>Return</th><th>Damage</th><th>Used</th><th>Closing</th></tr>
          </thead>
          <tbody>
            ${selectedItemId ? historyRows.map(r=>`
              <tr>
                <td>${esc(r.date)}</td>
                <td>${displayNum(r.opening)}</td>
                <td>${displayNum(r.in)}</td>
                <td>${displayNum(r.issued)}</td>
                <td>${displayNum(r.return)}</td>
                <td>${displayNum(r.damage)}</td>
                <td>${displayNum(r.used)}</td>
                <td>${displayBase(selectedItemId, r.closing)}</td>
              </tr>
            `).join('') : '<tr><td colspan="8">No item selected</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="small muted" style="margin-top:8px">
        Summary: Opening ${displayNum(summary.opening)} • In ${displayNum(summary.in)} • Issued ${displayNum(summary.issued)} • Return ${displayNum(summary.return)} • Damage ${displayNum(summary.damage)} • Used ${displayNum(summary.used)} • Closing ${displayBase(selectedItemId, summary.closing)}
      </div>
    </div>
  `;
  $('#exportReportCsv').onclick = ()=>{
    const item = selectedItem || reportItems[0] || null;
    const itemId = item?.id || '';
    const rows = itemId ? reportItemExportRows(itemId, reportState.from, reportState.to) : [['No item selected']];
    downloadCSV(rows, `report-${itemId || 'history'}-${rangeFrom}-to-${rangeTo}.csv`);
  };
  $('#exportReportJson').onclick = ()=>{
    const item = selectedItem || reportItems[0] || null;
    const itemId = item?.id || '';
    const payload = itemId ? {
      item: { id: item.id, name: item.name, kind: item.kind, unit: item.unit },
      from: rangeFrom,
      to: rangeTo,
      rows: historyRows,
      summary
    } : { message: 'No item selected' };
    downloadJSON(payload, `report-${itemId || 'history'}-${rangeFrom}-to-${rangeTo}.json`);
  };
  $('#applyReportFilter').onclick = ()=>{
    const itemId = $('#reportItem').value;
    state.report = state.report || {};
    state.report.itemId = itemId;
    state.report.from = $('#reportFrom').value || rangeFrom;
    state.report.to = $('#reportTo').value || rangeTo;
    save();
    renderMoreReport();
  };
  $('#reportItem').onchange = e=>{
    state.report = state.report || {};
    state.report.itemId = e.target.value;
    save();
  };
  $('#reportFrom').onchange = e=>{
    state.report = state.report || {};
    state.report.from = e.target.value || rangeFrom;
    save();
  };
  $('#reportTo').onchange = e=>{
    state.report = state.report || {};
    state.report.to = e.target.value || rangeTo;
    save();
  };
  $('#printHistory').onclick = ()=>window.print();
}
async function refreshUsersList(){
  if(!db) return [];
  const snap = await db.collection('users').get();
  return snap.docs.map(d => d.data()).filter(Boolean).sort((a,b)=>String(a.displayName||a.email||'').localeCompare(String(b.displayName||b.email||''), undefined, {numeric:true,sensitivity:'base'}));
}
async function createStaffUser(email, password, displayName, permissions){
  if(!creatorAuth) initFirebase();
  const cred = await creatorAuth.createUserWithEmailAndPassword(email, password);
  const user = cred.user;
  await db.collection('users').doc(user.uid).set({
    uid: user.uid,
    email,
    displayName,
    role: 'staff',
    active: true,
    permissions
  }, { merge: true });
  await creatorAuth.signOut().catch(()=>{});
  return user;
}
function renderMoreUsers(){
  $('#moreBody').innerHTML = `
    <div class="panel">
      <div class="sectionhead"><h3>Users</h3><span class="muted small">Admin only</span></div>
      <div class="grid no-print">
        <div><label class="small muted">Display Name</label><input id="uName" placeholder="Staff Name"></div>
        <div><label class="small muted">Email</label><input id="uEmail" type="email" placeholder="staff@email.com"></div>
        <div><label class="small muted">Password</label><input id="uPass" type="password" placeholder="Password"></div>
        <div><label class="small muted">Allowed Pages</label>
          <div class="small muted" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:8px 0">
            ${permissionList().filter(p=>['dashboard','purchase','production','packaging','sale','more','report'].includes(p)).map(p=>`
              <label><input type="checkbox" data-perm="${p}" ${['dashboard','purchase','production','packaging','sale','more','report'].includes(p) ? 'checked' : ''}> ${p}</label>
            `).join('')}
          </div>
        </div>
        <div class="row" style="align-self:end"><button class="btn good" id="createUserBtn">Create Staff</button><button class="btn secondary" id="reloadUsersBtn">Reload</button></div>
      </div>
      <div class="tblwrap" style="margin-top:12px">
        <table class="sheet-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th>Permissions</th></tr></thead>
          <tbody id="usersBody"><tr><td colspan="5">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  `;
  $('#createUserBtn').onclick = async ()=>{
    const email = $('#uEmail').value.trim();
    const password = $('#uPass').value;
    const displayName = $('#uName').value.trim() || email.split('@')[0];
    if(!email || !password) return toast('Enter email and password');
    const permissions = {};
    permissionList().forEach(p => permissions[p] = !!document.querySelector(`[data-perm="${p}"]`)?.checked);
    permissions.items = false; permissions.shops = false; permissions.recipe = false; permissions.users = false;
    try{
      await createStaffUser(email, password, displayName, permissions);
      toast('Staff created');
      renderMoreUsers();
    }catch(err){
      console.warn(err);
      toast(err?.message || 'Create user failed');
    }
  };
  $('#reloadUsersBtn').onclick = ()=>renderMoreUsers();
  refreshUsersList().then(users => {
    const rows = users.map(u => `
      <tr>
        <td>${esc(u.displayName || u.email || '')}</td>
        <td>${esc(u.email || '')}</td>
        <td>${esc(u.role || 'staff')}</td>
        <td>${u.active === false ? 'No' : 'Yes'}</td>
        <td>${Object.entries(u.permissions || {}).filter(([,v])=>v).map(([k])=>k).join(', ') || '-'}</td>
      </tr>
    `).join('');
    $('#usersBody').innerHTML = rows || '<tr><td colspan="5">No users yet</td></tr>';
  });
}
function bootApp(){
  initFirebase();
  document.title = `ERP Version ${APP_VERSION}`;
  renderLogin();
  $('#datePicker').addEventListener('change', e=>{
    currentDate = e.target.value;
    ensureDay(currentDate);
    normalizeCarryForward(currentDate);
    save();
    render();
  });
  $$('.bottom-nav button').forEach(btn=>btn.onclick=()=>setView(btn.dataset.go));
  if(auth){
    auth.onAuthStateChanged(async user=>{
      authReady = true;
      if(syncUnsub) syncUnsub();
      if(user){
        currentUser = user;
        currentProfile = await ensureProfile(user);
        if(currentProfile.active === false){
          currentUser = null;
          currentProfile = null;
          await auth.signOut().catch(()=>{});
          loginError = 'This user is disabled';
          renderLogin();
          renderAuthVisibility();
          return;
        }
        renderAuthVisibility();
        startCloudListener();
        syncNavButtons();
        if(!canAccess(currentView)) currentView = allowedStartPage();
        render();
        scheduleCloudSave();
      }else{
        currentUser = null;
        currentProfile = null;
        renderLogin();
        renderAuthVisibility();
      }
    });
  }else{
    renderLogin();
  }
  ensureDay(currentDate);
  sortItems();
  normalizeCarryForward();
  save();
  renderAuthVisibility();
}
bootApp();
