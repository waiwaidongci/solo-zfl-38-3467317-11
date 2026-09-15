import http from "node:http";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeLiftingPlan } from "./lifting.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = join(__dirname, "data", "model-rigging-calibration.json");
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ]
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

let idCounter = 0;
function uid(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + (idCounter++).toString(36); }
function newId() { return "MR-" + Date.now(); }
function toNum(v) { return v === null || v === undefined || v === "" ? NaN : Number(v); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:12px 0 8px; font-size:15px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button:disabled { opacity:.45; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; }
    .lift-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
    .lift-grid > div { border:1px solid var(--line); border-radius:8px; padding:12px; }
    .checkline { display:block; margin:4px 0; font-size:13px; } .checkline input { width:auto; margin-right:6px; }
    table.slings { width:100%; border-collapse:collapse; font-size:13px; margin:8px 0; } table.slings th,table.slings td { border:1px solid var(--line); padding:5px 7px; text-align:left; }
    .reasons { margin:6px 0 0; padding-left:18px; } .reasons li { margin:3px 0; }
    #plansList { display:grid; gap:10px; max-height:520px; overflow:auto; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联 · 吊装配平</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
    </section>
    <section style="grid-column:1/-1">
      <div class="panel">
        <h2>吊装配平</h2>
        <div class="meta" style="margin-bottom:10px">登记整船质量、重心坐标与各吊点位置、吊索额定载荷；选择吊点组合与吊高后按重力平衡计算每根吊索受力、水平夹角与重心投影。载荷超限、夹角超过 60°、重心落在支撑多边形外、吊点重复或几何数据缺失时拒绝确认。</div>
        <label>选择模型</label><select id="liftShip"></select>
        <div class="lift-grid" style="margin-top:10px">
          <div>
            <h3>整船质量与重心</h3>
            <div class="meta" id="liftGeoSummary"></div>
            <label>整船质量 (kg)</label><input id="liftMass" type="number" step="any">
            <label>重心 X</label><input id="liftCgX" type="number" step="any">
            <label>重心 Y</label><input id="liftCgY" type="number" step="any">
            <label>重心 Z</label><input id="liftCgZ" type="number" step="any">
            <button id="saveGeo" type="button">保存吊装数据</button>
            <h3>新增吊点</h3>
            <label>吊点名称</label><input id="ptName">
            <label>X</label><input id="ptX" type="number" step="any">
            <label>Y</label><input id="ptY" type="number" step="any">
            <label>Z</label><input id="ptZ" type="number" step="any">
            <label>吊索额定载荷 (kg)</label><input id="ptRated" type="number" step="any">
            <button id="addPoint" type="button">添加吊点</button>
            <div id="geoMsg" class="meta" style="margin-top:8px"></div>
          </div>
          <div>
            <h3>方案计算</h3>
            <label>吊点组合</label>
            <div id="pointChecks"></div>
            <label>吊高（吊钩高度 z）</label><input id="hookHeight" type="number" step="any">
            <div style="display:flex;gap:8px;margin-top:10px"><button id="calcBtn" type="button">计算受力</button><button id="confirmBtn" type="button" class="secondary" disabled>确认方案</button></div>
            <div id="calcResult" style="margin-top:10px"></div>
            <div id="liftMsg" class="meta"></div>
          </div>
          <div>
            <h3>方案记录</h3>
            <label>风险筛选</label>
            <select id="riskFilter"><option value="">全部风险</option><option>安全</option><option>危险</option></select>
            <div id="plansList" style="margin-top:10px"></div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); renderLifting(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;

    // ---------- 吊装配平 ----------
    const liftShip = document.querySelector('#liftShip');
    const pointChecks = document.querySelector('#pointChecks');
    const calcResult = document.querySelector('#calcResult');
    const confirmBtn = document.querySelector('#confirmBtn');
    const plansList = document.querySelector('#plansList');
    const riskFilter = document.querySelector('#riskFilter');
    const geoMsg = document.querySelector('#geoMsg');
    const liftMsg = document.querySelector('#liftMsg');
    let checkedPoints = new Set();
    let lastCalc = null;
    function shipKey(item) { return item.id || item.code; }
    function currentShip() { return items.find(i => shipKey(i) === liftShip.value); }
    function fmt(v, d) { return typeof v === 'number' && isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : '-'; }
    function reasonsHtml(reasons) {
      if (!reasons || !reasons.length) return '';
      return '<div class="warn">拒绝原因：</div><ul class="reasons warn">'+reasons.map(r => '<li>'+r.message+'</li>').join('')+'</ul>';
    }
    function slingsTable(slings) {
      if (!slings || !slings.length) return '';
      return '<table class="slings"><tr><th>吊索</th><th>受力 (kg)</th><th>水平夹角</th><th>额定 (kg)</th><th>利用率</th><th>危险项</th></tr>' +
        slings.map(s => '<tr><td>'+(s.name || s.pointId)+'</td><td><b>'+fmt(s.forceKg)+'</b></td><td>'+fmt(s.angleDeg,1)+'°</td><td>'+fmt(s.ratedKg)+'</td><td>'+fmt(s.utilization*100,0)+'%</td><td>'+(s.hazards && s.hazards.length ? '<span class="warn">'+s.hazards.map(h => h.message).join('；')+'</span>' : '无')+'</td></tr>').join('') + '</table>';
    }
    function calcHtml(result) {
      let html = '';
      if (!result.ok) html += reasonsHtml(result.reasons);
      if (result.plan && result.plan.slings && result.plan.slings.length) {
        const p = result.plan;
        html += slingsTable(p.slings) +
          '<div class="meta">重心投影 ('+fmt(p.projection.x)+', '+fmt(p.projection.y)+') · '+(p.projection.insidePolygon ? '位于支撑多边形内' : '超出支撑多边形')+'</div>';
        if (result.ok) html += p.hazards.length ? '<div class="warn">危险项：'+p.hazards.map(h => h.message).join('；')+'</div>' : '<div class="ok">计算通过，无危险项</div>';
      }
      return html || '<span class="meta">无计算结果</span>';
    }
    function fillGeoInputs(ship) {
      const lifting = ship && ship.lifting;
      document.querySelector('#liftMass').value = lifting && lifting.massKg != null ? lifting.massKg : '';
      document.querySelector('#liftCgX').value = lifting && lifting.cg ? lifting.cg.x : '';
      document.querySelector('#liftCgY').value = lifting && lifting.cg ? lifting.cg.y : '';
      document.querySelector('#liftCgZ').value = lifting && lifting.cg ? lifting.cg.z : '';
    }
    function renderLifting() {
      const prev = liftShip.value;
      liftShip.innerHTML = items.map(i => '<option value="'+shipKey(i)+'">'+(i.code || i.id)+' · '+(i.shipType || '')+'</option>').join('');
      if (prev && items.some(i => shipKey(i) === prev)) liftShip.value = prev;
      const ship = currentShip();
      const lifting = ship && ship.lifting;
      const pts = (lifting && lifting.points) || [];
      document.querySelector('#liftGeoSummary').textContent = !ship ? '' : (lifting && lifting.massKg != null
        ? '已登记：质量 '+lifting.massKg+' kg · 重心 ('+lifting.cg.x+', '+lifting.cg.y+', '+lifting.cg.z+') · 吊点 '+pts.length+' 个'
        : '尚未登记吊装数据（几何数据缺失）');
      pointChecks.innerHTML = pts.length ? pts.map(p => '<label class="checkline"><input type="checkbox" value="'+p.id+'"'+(checkedPoints.has(p.id) ? ' checked' : '')+'> '+p.name+' ('+p.x+', '+p.y+', '+p.z+') 额定 '+p.ratedKg+' kg</label>').join('') : '<span class="meta">暂无吊点，请先添加</span>';
      pointChecks.querySelectorAll('input').forEach(cb => cb.onchange = () => { if (cb.checked) checkedPoints.add(cb.value); else checkedPoints.delete(cb.value); lastCalc = null; confirmBtn.disabled = true; });
      renderPlans();
    }
    function planCard(p) {
      const slings = (p.slings || []).map(s => '<div>吊索 '+(s.name || s.pointId)+'：受力 <b>'+fmt(s.forceKg)+' kg</b> · 夹角 '+fmt(s.angleDeg,1)+'° · 利用率 '+fmt(s.utilization*100,0)+'%</div>').join('');
      const hz = (p.hazards && p.hazards.length) ? '<div class="warn">危险项：'+p.hazards.map(h => h.message).join('；')+'</div>' : '<div class="ok">无危险项</div>';
      return '<article class="card" data-risk="'+p.risk+'"><h3>'+p.id+'</h3><span class="pill">'+p.risk+'</span>' +
        '<div class="meta">'+p.shipCode+' · 吊高 '+p.hookHeight+' · '+(p.createdAt || '').slice(0,19).replace('T',' ')+'</div>' +
        '<div class="meta">重心投影 ('+fmt(p.projection.x)+', '+fmt(p.projection.y)+') · 支撑多边形内</div>'+slings+hz+'</article>';
    }
    function renderPlans() {
      const risk = riskFilter.value;
      const plans = [];
      items.forEach(i => (i.liftingPlans || []).forEach(p => plans.push({ shipCode: i.code || i.id, ...p })));
      plans.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      const visible = plans.filter(p => !risk || p.risk === risk);
      plansList.innerHTML = visible.length ? visible.map(planCard).join('') : '<span class="meta">暂无方案</span>';
    }
    liftShip.onchange = () => { checkedPoints = new Set(); lastCalc = null; confirmBtn.disabled = true; calcResult.innerHTML = ''; liftMsg.textContent = ''; fillGeoInputs(currentShip()); renderLifting(); };
    riskFilter.onchange = renderPlans;
    document.querySelector('#saveGeo').onclick = async () => {
      const ship = currentShip(); if (!ship) return;
      const payload = { massKg: Number(document.querySelector('#liftMass').value), cg: { x: Number(document.querySelector('#liftCgX').value), y: Number(document.querySelector('#liftCgY').value), z: Number(document.querySelector('#liftCgZ').value) } };
      try {
        await api('/api/items/'+shipKey(ship)+'/lifting', { method:'PUT', body: JSON.stringify(payload) });
        geoMsg.className = 'ok'; geoMsg.textContent = '吊装数据已保存';
        await load();
      } catch (err) {
        geoMsg.className = 'warn'; geoMsg.textContent = '保存失败：' + (((err.data && err.data.reasons) || []).join('；') || err.message);
      }
    };
    document.querySelector('#addPoint').onclick = async () => {
      const ship = currentShip(); if (!ship) return;
      const payload = { name: document.querySelector('#ptName').value, x: Number(document.querySelector('#ptX').value), y: Number(document.querySelector('#ptY').value), z: Number(document.querySelector('#ptZ').value), ratedKg: Number(document.querySelector('#ptRated').value) };
      try {
        await api('/api/items/'+shipKey(ship)+'/lifting/points', { method:'POST', body: JSON.stringify(payload) });
        geoMsg.className = 'ok'; geoMsg.textContent = '吊点已添加：' + payload.name;
        await load();
      } catch (err) {
        geoMsg.className = 'warn'; geoMsg.textContent = '添加失败：' + (((err.data && err.data.reasons) || []).join('；') || err.message);
      }
    };
    document.querySelector('#calcBtn').onclick = async () => {
      const ship = currentShip(); if (!ship) return;
      liftMsg.textContent = '';
      const payload = { pointIds: [...checkedPoints], hookHeight: Number(document.querySelector('#hookHeight').value) };
      const result = await api('/api/items/'+shipKey(ship)+'/lifting/calculate', { method:'POST', body: JSON.stringify(payload) });
      lastCalc = { payload, result };
      confirmBtn.disabled = !result.ok;
      calcResult.innerHTML = calcHtml(result);
    };
    confirmBtn.onclick = async () => {
      const ship = currentShip(); if (!ship || !lastCalc) return;
      try {
        const plan = await api('/api/items/'+shipKey(ship)+'/lifting/plans', { method:'POST', body: JSON.stringify(lastCalc.payload) });
        liftMsg.className = 'ok'; liftMsg.textContent = '方案已确认：' + plan.id;
        lastCalc = null; confirmBtn.disabled = true; calcResult.innerHTML = '';
        await load();
      } catch (err) {
        const d = err.data || {};
        liftMsg.className = 'warn'; liftMsg.textContent = '确认被拒绝：' + (d.message || err.message);
        if (d.reasons) calcResult.innerHTML = reasonsHtml(d.reasons) + (d.plan ? slingsTable(d.plan.slings) : '');
      }
    };
    renderForms(); load();
  </script>
</body>
</html>`;
}

async function loadDbFile(dbPath) {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function createApp(options = {}) {
  const dbPath = options.dbPath || process.env.DB_PATH || defaultDbPath;
  const db = await loadDbFile(dbPath);
  // 串行化 + 原子写：先写临时文件再 rename，失败时清理临时文件，
  // 磁盘上永远只有完整的旧版本或完整的新版本，不会留下半套数据。
  let tmpCounter = 0;
  let saveChain = Promise.resolve();
  function saveDb() {
    const snapshot = JSON.stringify(db, null, 2);
    const tmp = join(dirname(dbPath), ".tmp-" + process.pid + "-" + (tmpCounter++) + ".json");
    const run = saveChain.then(async () => {
      try {
        await writeFile(tmp, snapshot);
        await rename(tmp, dbPath);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    });
    saveChain = run.catch(() => {});
    return run;
  }
  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }
  function send(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data, null, 2));
  }
  function html(res, text) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(text);
  }
  function findItem(key) {
    return db.items.find(x => x.id === key || x.code === key);
  }
  function normalizeSelection(input) {
    const ids = Array.isArray(input.pointIds) ? input.pointIds : (input.pointIds ? [input.pointIds] : []);
    return { pointIds: ids.map(String), hookHeight: toNum(input.hookHeight) };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") return html(res, page());
      if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
      if (req.method === "POST" && url.pathname === "/api/items") {
        const input = await body(req);
        const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
        item.tasks = [];
        db.items.unshift(item);
        await saveDb();
        return send(res, 201, item);
      }
      const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
      if (patch && req.method === "PATCH") {
        const item = findItem(patch[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        Object.assign(item, await body(req));
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        await saveDb();
        return send(res, 200, item);
      }
      const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
      if (log && req.method === "POST") {
        const item = findItem(log[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        await saveDb();
        return send(res, 201, item);
      }
      const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
      if (action && req.method === "POST") {
        const item = findItem(action[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        item.logs ||= [];
        item.tasks ||= [];
        item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
        item.status = "校准中";
        item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
        await saveDb();
        return send(res, 201, item);
      }
      // ---------- 吊装配平 ----------
      const lifting = url.pathname.match(/^\/api\/items\/([^/]+)\/lifting$/);
      if (lifting && req.method === "PUT") {
        const item = findItem(lifting[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const massKg = toNum(input.massKg);
        const cg = input.cg || {};
        const reasons = [];
        if (!(massKg > 0)) reasons.push("整船质量必须为正数");
        for (const k of ["x", "y", "z"]) {
          if (!Number.isFinite(toNum(cg[k]))) reasons.push("重心坐标 " + k + " 缺失或无效");
        }
        if (reasons.length) return send(res, 400, { error: "invalid_geometry", reasons });
        const prev = item.lifting;
        item.lifting = { massKg, cg: { x: toNum(cg.x), y: toNum(cg.y), z: toNum(cg.z) }, points: (prev && prev.points) || [] };
        try {
          await saveDb();
        } catch {
          item.lifting = prev;
          return send(res, 500, { error: "save_failed", message: "写入失败，未保留任何数据" });
        }
        return send(res, 200, item.lifting);
      }
      const addPoint = url.pathname.match(/^\/api\/items\/([^/]+)\/lifting\/points$/);
      if (addPoint && req.method === "POST") {
        const item = findItem(addPoint[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const name = String(input.name ?? "").trim();
        const x = toNum(input.x), y = toNum(input.y), z = toNum(input.z), ratedKg = toNum(input.ratedKg);
        const reasons = [];
        if (!name) reasons.push("吊点名称缺失");
        if (![x, y, z].every(Number.isFinite)) reasons.push("吊点坐标缺失或无效");
        if (!(ratedKg > 0)) reasons.push("吊索额定载荷必须为正数");
        if (reasons.length) return send(res, 400, { error: "invalid_geometry", reasons });
        item.lifting ||= { points: [] };
        item.lifting.points ||= [];
        if (item.lifting.points.some(p => p.name === name)) {
          return send(res, 409, { error: "duplicate_point", reasons: ["吊点名称已存在：" + name] });
        }
        const point = { id: uid("P"), name, x, y, z, ratedKg };
        item.lifting.points.push(point);
        try {
          await saveDb();
        } catch {
          item.lifting.points = item.lifting.points.filter(p => p !== point);
          return send(res, 500, { error: "save_failed", message: "写入失败，未保留任何数据" });
        }
        return send(res, 201, point);
      }
      const calc = url.pathname.match(/^\/api\/items\/([^/]+)\/lifting\/calculate$/);
      if (calc && req.method === "POST") {
        const item = findItem(calc[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const result = computeLiftingPlan(item.lifting || {}, normalizeSelection(input));
        return send(res, 200, result);
      }
      const plans = url.pathname.match(/^\/api\/items\/([^/]+)\/lifting\/plans$/);
      if (plans && req.method === "POST") {
        const item = findItem(plans[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const result = computeLiftingPlan(item.lifting || {}, normalizeSelection(input));
        if (!result.ok) return send(res, 422, { error: "lifting_rejected", reasons: result.reasons, plan: result.plan || null });
        // 并发确认去重：相同吊点组合 + 相同吊高只能生成一个方案。
        // 以下检查与写入之间没有 await，在单线程事件循环中是原子的。
        const fingerprint = JSON.stringify([...result.plan.pointIds].sort()) + "|" + result.plan.hookHeight;
        item.liftingPlans ||= [];
        const existing = item.liftingPlans.find(p => p.fingerprint === fingerprint);
        if (existing) return send(res, 409, { error: "duplicate_confirmation", message: "相同吊点组合与吊高的方案已存在，并发确认只保留一个", plan: existing });
        const plan = { id: uid("LP"), fingerprint, createdAt: new Date().toISOString(), status: "已确认", ...result.plan };
        item.liftingPlans.push(plan);
        try {
          await saveDb();
        } catch {
          item.liftingPlans = item.liftingPlans.filter(p => p !== plan); // 失败回滚，不留半套数据
          return send(res, 500, { error: "save_failed", message: "写入失败，未保留任何数据" });
        }
        return send(res, 201, plan);
      }
      if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
      send(res, 404, { error: "not_found" });
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });
  return { server, dbPath, getDb: () => db };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT || 3038);
  const { server } = await createApp();
  server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
}
