import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function startApp(dbPath) {
  const { server } = await createApp({ dbPath });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise(r => server.close(r)) };
}

async function api(base, method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

function seedDb() {
  return {
    items: [
      {
        id: "MR-OLD", code: "MR-OLD", shipType: "福船", scale: "1:48", status: "校准中",
        tasks: [{ id: "T-1", position: "前桅侧支索", tension: "偏松", status: "调整中", logs: [{ at: "2026-06-12", note: "已缩短2mm" }] }],
        logs: [{ at: "2026-06-21T03:50:29.186Z", step: "帆索", note: "后桅升帆索 · 偏紧" }],
      },
      {
        id: "MR-PLAN", code: "MR-PLAN", shipType: "沙船", status: "待检查", tasks: [], logs: [],
        lifting: {
          massKg: 60,
          cg: { x: 0, y: 0, z: 0.2 },
          points: [
            { id: "P-A", name: "艏", x: 2, y: 0, z: 0, ratedKg: 100 },
            { id: "P-B", name: "左", x: -1, y: 1.8, z: 0, ratedKg: 100 },
            { id: "P-C", name: "右", x: -1, y: -1.8, z: 0, ratedKg: 100 },
          ],
        },
        liftingPlans: [{
          id: "LP-EXISTING", fingerprint: "pre-existing", createdAt: "2026-06-01T00:00:00.000Z", status: "已确认",
          pointIds: ["P-A", "P-B", "P-C"], hookHeight: 2, massKg: 60, cg: { x: 0, y: 0, z: 0.2 },
          projection: { x: 0, y: 0, insidePolygon: true }, supportPolygon: [[2, 0], [-1, 1.8], [-1, -1.8]],
          slings: [], hazards: [], risk: "安全", maxUtilization: 0.5, maxAngleDeg: 45,
        }],
      },
    ],
  };
}

const GEO = {
  massKg: 120,
  cg: { x: 0, y: 0, z: 0.3 },
  points: [
    { name: "艏吊点", x: 2, y: 0, z: 0, ratedKg: 100 },
    { name: "左舷吊点", x: -1, y: 1.8, z: 0, ratedKg: 100 },
    { name: "右舷吊点", x: -1, y: -1.8, z: 0, ratedKg: 100 },
  ],
};

// 创建模型并登记吊装数据，返回 { code, pointIds }
async function setupShip(base, code, geo = GEO) {
  const created = await api(base, "POST", "/api/items", { code, shipType: "福船", status: "待检查" });
  assert.equal(created.status, 201);
  const put = await api(base, "PUT", `/api/items/${code}/lifting`, { massKg: geo.massKg, cg: geo.cg });
  assert.equal(put.status, 200);
  const pointIds = [];
  for (const p of geo.points) {
    const r = await api(base, "POST", `/api/items/${code}/lifting/points`, p);
    assert.equal(r.status, 201);
    pointIds.push(r.data.id);
  }
  return { code, pointIds };
}

async function plansOf(base, code) {
  const res = await api(base, "GET", "/api/items");
  const item = res.data.find(i => i.code === code);
  return (item && item.liftingPlans) || [];
}

test("安全：登记吊装数据 → 计算 → 确认 → 方案落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-safe-"));
  const dbPath = join(dir, "db.json");
  const { base, close } = await startApp(dbPath);
  try {
    const { pointIds } = await setupShip(base, "MR-SAFE");

    const calc = await api(base, "POST", "/api/items/MR-SAFE/lifting/calculate", { pointIds, hookHeight: 2 });
    assert.equal(calc.status, 200);
    assert.equal(calc.data.ok, true);
    assert.equal(calc.data.plan.slings.length, 3);
    const s0 = calc.data.plan.slings[0];
    assert.ok(Math.abs(s0.forceKg - 56.57) < 0.01, "每根吊索受力按重力平衡算出");
    assert.ok(Math.abs(s0.angleDeg - 45) < 0.01, "水平夹角 45°");
    assert.equal(calc.data.plan.projection.insidePolygon, true);
    assert.equal(calc.data.plan.risk, "安全");

    const confirm = await api(base, "POST", "/api/items/MR-SAFE/lifting/plans", { pointIds, hookHeight: 2 });
    assert.equal(confirm.status, 201);
    assert.equal(confirm.data.status, "已确认");
    assert.ok(confirm.data.id.startsWith("LP-"));

    const plans = await plansOf(base, "MR-SAFE");
    assert.equal(plans.length, 1);
    const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
    assert.equal(onDisk.items.find(i => i.code === "MR-SAFE").liftingPlans.length, 1, "方案已写入磁盘");
  } finally {
    await close();
  }
});

test("超载：确认被拒绝且磁盘文件不产生任何变化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-overload-"));
  const dbPath = join(dir, "db.json");
  const { base, close } = await startApp(dbPath);
  try {
    const geo = { ...GEO, points: GEO.points.map(p => ({ ...p, ratedKg: 50 })) };
    const { pointIds } = await setupShip(base, "MR-OVER", geo);
    const before = await readFile(dbPath, "utf8");

    const calc = await api(base, "POST", "/api/items/MR-OVER/lifting/calculate", { pointIds, hookHeight: 2 });
    assert.equal(calc.data.ok, false);
    assert.ok(calc.data.reasons.some(r => r.code === "overload"));

    const confirm = await api(base, "POST", "/api/items/MR-OVER/lifting/plans", { pointIds, hookHeight: 2 });
    assert.equal(confirm.status, 422);
    assert.ok(confirm.data.reasons.some(r => r.code === "overload"));
    assert.equal((await plansOf(base, "MR-OVER")).length, 0);
    assert.equal(await readFile(dbPath, "utf8"), before, "失败写入不留下半套数据");
  } finally {
    await close();
  }
});

test("偏心：重心落在支撑多边形外时拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-eccentric-"));
  const dbPath = join(dir, "db.json");
  const { base, close } = await startApp(dbPath);
  try {
    const geo = { ...GEO, cg: { x: 5, y: 0, z: 0.3 } };
    const { pointIds } = await setupShip(base, "MR-ECC", geo);
    const confirm = await api(base, "POST", "/api/items/MR-ECC/lifting/plans", { pointIds, hookHeight: 2 });
    assert.equal(confirm.status, 422);
    assert.ok(confirm.data.reasons.some(r => r.code === "cg_outside_polygon"));
    assert.equal((await plansOf(base, "MR-ECC")).length, 0);
  } finally {
    await close();
  }
});

test("拒绝分支：夹角超 60°、吊点重复、几何数据缺失", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-reject-"));
  const dbPath = join(dir, "db.json");
  const { base, close } = await startApp(dbPath);
  try {
    const { pointIds } = await setupShip(base, "MR-REJ");

    const steep = await api(base, "POST", "/api/items/MR-REJ/lifting/plans", { pointIds, hookHeight: 5 });
    assert.equal(steep.status, 422);
    assert.ok(steep.data.reasons.some(r => r.code === "angle_over_60"));

    const dup = await api(base, "POST", "/api/items/MR-REJ/lifting/plans", { pointIds: [pointIds[0], pointIds[0], pointIds[1]], hookHeight: 2 });
    assert.equal(dup.status, 422);
    assert.ok(dup.data.reasons.some(r => r.code === "duplicate_points"));

    const bare = await api(base, "POST", "/api/items", { code: "MR-BARE", shipType: "广船" });
    assert.equal(bare.status, 201);
    const missing = await api(base, "POST", "/api/items/MR-BARE/lifting/plans", { pointIds: ["P-1", "P-2"], hookHeight: 2 });
    assert.equal(missing.status, 422);
    assert.ok(missing.data.reasons.some(r => r.code === "missing_geometry"));

    const badGeo = await api(base, "PUT", "/api/items/MR-REJ/lifting", { massKg: -5, cg: { x: 0 } });
    assert.equal(badGeo.status, 400);
    const dupPoint = await api(base, "POST", "/api/items/MR-REJ/lifting/points", GEO.points[0]);
    assert.equal(dupPoint.status, 409, "吊点名称重复拒绝");

    assert.equal((await plansOf(base, "MR-REJ")).length, 0, "所有拒绝均未生成方案");
  } finally {
    await close();
  }
});

test("并发确认只生成一个方案", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-race-"));
  const dbPath = join(dir, "db.json");
  const { base, close } = await startApp(dbPath);
  try {
    const { pointIds } = await setupShip(base, "MR-RACE");
    const payload = { pointIds, hookHeight: 2 };
    const results = await Promise.all(Array.from({ length: 6 }, () => api(base, "POST", "/api/items/MR-RACE/lifting/plans", payload)));
    const created = results.filter(r => r.status === 201);
    const conflicts = results.filter(r => r.status === 409);
    assert.equal(created.length, 1, "并发确认只有一个成功");
    assert.equal(conflicts.length, 5);
    assert.equal(conflicts[0].data.error, "duplicate_confirmation");
    assert.equal((await plansOf(base, "MR-RACE")).length, 1);

    const again = await api(base, "POST", "/api/items/MR-RACE/lifting/plans", payload);
    assert.equal(again.status, 409, "重复提交同样被拒绝");

    const other = await api(base, "POST", "/api/items/MR-RACE/lifting/plans", { pointIds, hookHeight: 1.5 });
    assert.equal(other.status, 201, "不同吊高是另一个方案");
    assert.equal((await plansOf(base, "MR-RACE")).length, 2);
  } finally {
    await close();
  }
});

test("写入失败不留半套数据：保存失败回滚，恢复后可再写", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-atomic-"));
  const dataDir = join(dir, "data");
  const dbPath = join(dataDir, "db.json");
  const { base, close } = await startApp(dbPath);
  try {
    const { pointIds } = await setupShip(base, "MR-ATOMIC");
    const ok1 = await api(base, "POST", "/api/items/MR-ATOMIC/lifting/plans", { pointIds, hookHeight: 2 });
    assert.equal(ok1.status, 201);

    // 破坏存储目录（替换成普通文件），使写入必然失败
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, "blocked");
    const failed = await api(base, "POST", "/api/items/MR-ATOMIC/lifting/plans", { pointIds, hookHeight: 1.5 });
    assert.equal(failed.status, 500);
    assert.equal(failed.data.error, "save_failed");
    assert.equal((await plansOf(base, "MR-ATOMIC")).length, 1, "内存中也不留半套数据");

    // 恢复存储后可继续写入
    await rm(dataDir, { force: true });
    await mkdir(dataDir, { recursive: true });
    const ok2 = await api(base, "POST", "/api/items/MR-ATOMIC/lifting/plans", { pointIds, hookHeight: 1.5 });
    assert.equal(ok2.status, 201);
    const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
    assert.equal(onDisk.items.find(i => i.code === "MR-ATOMIC").liftingPlans.length, 2);
  } finally {
    await close();
  }
});

test("服务重启后记录保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-restart-"));
  const dbPath = join(dir, "db.json");
  const app1 = await startApp(dbPath);
  const { pointIds } = await setupShip(app1.base, "MR-PERSIST");
  const confirm = await api(app1.base, "POST", "/api/items/MR-PERSIST/lifting/plans", { pointIds, hookHeight: 2 });
  assert.equal(confirm.status, 201);
  await app1.close();

  const app2 = await startApp(dbPath);
  try {
    const plans = await plansOf(app2.base, "MR-PERSIST");
    assert.equal(plans.length, 1, "重启后方案仍在");
    assert.equal(plans[0].id, confirm.data.id);
    assert.equal(plans[0].slings.length, 3);
  } finally {
    await app2.close();
  }
});

test("服务重启后记录保留（真实进程重启）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-proc-"));
  const dbPath = join(dir, "db.json");
  const port = 39000 + Math.floor(Math.random() * 900);
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DB_PATH: dbPath };
  const start = () => spawn(process.execPath, [join(root, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const waitUp = proc => new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("启动超时：" + out)), 15000);
    proc.stdout.on("data", d => { out += d; if (out.includes("listening")) { clearTimeout(timer); resolve(); } });
    proc.on("exit", code => reject(new Error("进程退出 " + code + "：" + out)));
  });
  const stop = proc => new Promise(resolve => { proc.on("exit", resolve); proc.kill("SIGTERM"); });

  let proc = start();
  await waitUp(proc);
  const { pointIds } = await setupShip(base, "MR-PROC");
  const confirm = await api(base, "POST", "/api/items/MR-PROC/lifting/plans", { pointIds, hookHeight: 2 });
  assert.equal(confirm.status, 201);
  await stop(proc);

  proc = start();
  await waitUp(proc);
  try {
    const plans = await plansOf(base, "MR-PROC");
    assert.equal(plans.length, 1, "进程重启后方案保留");
    assert.equal(plans[0].id, confirm.data.id);
  } finally {
    await stop(proc);
  }
});

test("已有方案和记录不变", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifting-untouched-"));
  const dbPath = join(dir, "db.json");
  const original = seedDb();
  await writeFile(dbPath, JSON.stringify(original, null, 2));
  const { base, close } = await startApp(dbPath);
  try {
    // 在 MR-OLD 上做完整吊装流程
    const put = await api(base, "PUT", "/api/items/MR-OLD/lifting", { massKg: GEO.massKg, cg: GEO.cg });
    assert.equal(put.status, 200);
    const pointIds = [];
    for (const p of GEO.points) {
      const r = await api(base, "POST", "/api/items/MR-OLD/lifting/points", p);
      pointIds.push(r.data.id);
    }
    const confirm = await api(base, "POST", "/api/items/MR-OLD/lifting/plans", { pointIds, hookHeight: 2 });
    assert.equal(confirm.status, 201);
    // 既有接口照常：改状态、加任务、加日志
    await api(base, "PATCH", "/api/items/MR-OLD", { status: "校准中" });
    await api(base, "POST", "/api/items/MR-OLD/action", { position: "主桅升帆索", tension: "偏紧", note: "回退半圈" });
    // 在 MR-PLAN 上确认一个不同吊高的新方案
    const confirm2 = await api(base, "POST", "/api/items/MR-PLAN/lifting/plans", { pointIds: ["P-A", "P-B", "P-C"], hookHeight: 1.2 });
    assert.equal(confirm2.status, 201);

    const res = await api(base, "GET", "/api/items");
    const old = res.data.find(i => i.code === "MR-OLD");
    const withPlan = res.data.find(i => i.code === "MR-PLAN");

    // 既有帆索任务与日志未被破坏
    assert.deepEqual(old.tasks[0], original.items[0].tasks[0]);
    assert.equal(old.logs[0].note, "后桅升帆索 · 偏紧");
    // MR-PLAN 的既有方案原样保留，新方案追加在后
    assert.equal(withPlan.liftingPlans.length, 2);
    assert.deepEqual(withPlan.liftingPlans[0], original.items[1].liftingPlans[0]);
    assert.equal(withPlan.liftingPlans[1].id, confirm2.data.id);
    // 磁盘上同样如此
    const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
    assert.deepEqual(onDisk.items.find(i => i.code === "MR-PLAN").liftingPlans[0], original.items[1].liftingPlans[0]);
  } finally {
    await close();
  }
});
