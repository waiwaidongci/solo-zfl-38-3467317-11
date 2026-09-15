import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLiftingPlan, convexHull, projectionInside } from "../lifting.js";

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// 正三角形吊点：艏(2,0,0)、左(-1,1.8,0)、右(-1,-1.8,0)，形心即原点
const TRI_POINTS = [
  { id: "P-A", name: "艏吊点", x: 2, y: 0, z: 0, ratedKg: 100 },
  { id: "P-B", name: "左舷吊点", x: -1, y: 1.8, z: 0, ratedKg: 100 },
  { id: "P-C", name: "右舷吊点", x: -1, y: -1.8, z: 0, ratedKg: 100 },
];
const TRI_GEO = { massKg: 120, cg: { x: 0, y: 0, z: 0.3 }, points: TRI_POINTS };
const TRI_IDS = ["P-A", "P-B", "P-C"];

test("安全：三点对称吊装，受力/夹角/投影符合重力平衡", () => {
  const { ok, reasons, plan } = computeLiftingPlan(TRI_GEO, { pointIds: TRI_IDS, hookHeight: 2 });
  assert.equal(ok, true);
  assert.deepEqual(reasons, []);
  assert.equal(plan.slings.length, 3);
  // 竖直分力各 40kg（对称），T = 40/sin(夹角)
  const [a, b, c] = plan.slings;
  assert.ok(approx(a.forceKg, 40 / Math.sin(Math.PI / 4), 1e-4), "艏吊点受力 56.57kg");
  assert.ok(approx(a.angleDeg, 45, 1e-6));
  const rhoB = Math.hypot(1, 1.8);
  assert.ok(approx(b.forceKg, 40 / (2 / Math.hypot(2, rhoB)), 1e-4));
  assert.ok(approx(b.forceKg, c.forceKg, 1e-9), "左右舷对称受力相等");
  // 竖直分力之和 = 总重
  const vSum = plan.slings.reduce((n, s) => n + s.forceKg * Math.sin(s.angleDeg * Math.PI / 180), 0);
  assert.ok(approx(vSum, 120, 1e-6), "竖直分力平衡总重");
  // 重心投影
  assert.deepEqual({ x: plan.projection.x, y: plan.projection.y }, { x: 0, y: 0 });
  assert.equal(plan.projection.insidePolygon, true);
  assert.equal(plan.supportPolygon.length, 3);
  assert.equal(plan.risk, "安全");
  assert.equal(plan.hazards.length, 0);
});

test("安全：四点正方形吊装（静不定取最小范数平衡解），载荷均分", () => {
  const geo = {
    massKg: 80,
    cg: { x: 0, y: 0, z: 0.2 },
    points: [
      { id: "P-1", name: "1", x: 1, y: 1, z: 0, ratedKg: 50 },
      { id: "P-2", name: "2", x: 1, y: -1, z: 0, ratedKg: 50 },
      { id: "P-3", name: "3", x: -1, y: -1, z: 0, ratedKg: 50 },
      { id: "P-4", name: "4", x: -1, y: 1, z: 0, ratedKg: 50 },
    ],
  };
  const { ok, plan } = computeLiftingPlan(geo, { pointIds: ["P-1", "P-2", "P-3", "P-4"], hookHeight: 1.5 });
  assert.equal(ok, true);
  const sinT = 1.5 / Math.hypot(1.5, Math.SQRT2);
  for (const s of plan.slings) assert.ok(approx(s.forceKg, 20 / sinT, 1e-6), "四索均分");
});

test("安全：两点吊装按杠杆分配，近重心侧受力更大", () => {
  const geo = {
    massKg: 100,
    cg: { x: 1, y: 0, z: 0.2 },
    points: [
      { id: "P-1", name: "前", x: 0, y: 0, z: 0, ratedKg: 200 },
      { id: "P-2", name: "后", x: 4, y: 0, z: 0, ratedKg: 200 },
    ],
  };
  const { ok, plan } = computeLiftingPlan(geo, { pointIds: ["P-1", "P-2"], hookHeight: 1 });
  assert.equal(ok, true);
  const [t1, t2] = plan.slings;
  assert.ok(approx(t1.forceKg, 75 / (1 / Math.SQRT2), 1e-4), "近侧承担 75kg 竖直分力");
  assert.ok(approx(t2.forceKg, 25 / (1 / Math.sqrt(10)), 1e-4));
  assert.ok(t1.forceKg > t2.forceKg);
});

test("超载：吊索受力超过额定载荷时拒绝", () => {
  const geo = { ...TRI_GEO, points: TRI_POINTS.map(p => ({ ...p, ratedKg: 50 })) };
  const { ok, reasons, plan } = computeLiftingPlan(geo, { pointIds: TRI_IDS, hookHeight: 2 });
  assert.equal(ok, false);
  assert.ok(reasons.some(r => r.code === "overload"));
  assert.ok(reasons.find(r => r.code === "overload").message.includes("超过额定载荷"));
  // 拒绝时仍给出算出的受力，便于页面展示
  assert.equal(plan.slings.length, 3);
  assert.ok(plan.slings[0].forceKg > 50);
});

test("偏心：重心投影落在支撑多边形外时拒绝", () => {
  const geo = { ...TRI_GEO, cg: { x: 5, y: 0, z: 0.3 } };
  const { ok, reasons } = computeLiftingPlan(geo, { pointIds: TRI_IDS, hookHeight: 2 });
  assert.equal(ok, false);
  assert.ok(reasons.some(r => r.code === "cg_outside_polygon"));
});

test("偏心：两点吊装重心偏离连线时拒绝", () => {
  const geo = {
    massKg: 100,
    cg: { x: 1, y: 0.5, z: 0.2 }, // 偏离两吊点连线
    points: [
      { id: "P-1", name: "前", x: 0, y: 0, z: 0, ratedKg: 200 },
      { id: "P-2", name: "后", x: 4, y: 0, z: 0, ratedKg: 200 },
    ],
  };
  const { ok, reasons } = computeLiftingPlan(geo, { pointIds: ["P-1", "P-2"], hookHeight: 1 });
  assert.equal(ok, false);
  assert.ok(reasons.some(r => r.code === "cg_outside_polygon"));
});

test("夹角：水平夹角超过 60° 时拒绝", () => {
  const { ok, reasons, plan } = computeLiftingPlan(TRI_GEO, { pointIds: TRI_IDS, hookHeight: 5 });
  assert.equal(ok, false);
  assert.ok(reasons.some(r => r.code === "angle_over_60"));
  assert.ok(plan.maxAngleDeg > 60);
});

test("吊点重复时拒绝", () => {
  const { ok, reasons } = computeLiftingPlan(TRI_GEO, { pointIds: ["P-A", "P-A", "P-B"], hookHeight: 2 });
  assert.equal(ok, false);
  assert.ok(reasons.some(r => r.code === "duplicate_points"));
});

test("几何数据缺失时拒绝：未登记质量/重心/吊高/吊点", () => {
  const r1 = computeLiftingPlan({}, { pointIds: ["P-A"], hookHeight: 2 });
  assert.equal(r1.ok, false);
  assert.ok(r1.reasons.some(r => r.code === "missing_geometry"));
  const r2 = computeLiftingPlan(TRI_GEO, { pointIds: ["P-A", "P-X"], hookHeight: 2 });
  assert.equal(r2.ok, false);
  assert.ok(r2.reasons.some(r => r.code === "missing_geometry" && r.message.includes("P-X")));
  const r3 = computeLiftingPlan(TRI_GEO, { pointIds: TRI_IDS, hookHeight: NaN });
  assert.equal(r3.ok, false);
  assert.ok(r3.reasons.some(r => r.code === "missing_geometry"));
  const r4 = computeLiftingPlan({ ...TRI_GEO, points: [{ id: "P-A", name: "缺", x: 1, y: 0, z: 0 }] }, { pointIds: ["P-A", "P-B"], hookHeight: 2 });
  assert.equal(r4.ok, false);
  assert.ok(r4.reasons.some(r => r.code === "missing_geometry"));
});

test("吊点不足两个、吊高不高于吊点时拒绝", () => {
  const r1 = computeLiftingPlan(TRI_GEO, { pointIds: ["P-A"], hookHeight: 2 });
  assert.equal(r1.ok, false);
  assert.ok(r1.reasons.some(r => r.code === "not_enough_points"));
  const geo = { ...TRI_GEO, points: TRI_POINTS.map(p => ({ ...p, z: 3 })) };
  const r2 = computeLiftingPlan(geo, { pointIds: TRI_IDS, hookHeight: 2 });
  assert.equal(r2.ok, false);
  assert.ok(r2.reasons.some(r => r.code === "hook_below_point"));
});

test("危险项：接近额定载荷或接近 60° 夹角时标记为危险但可通过", () => {
  const geoLoad = { ...TRI_GEO, points: TRI_POINTS.map(p => ({ ...p, ratedKg: 65 })) };
  const r1 = computeLiftingPlan(geoLoad, { pointIds: TRI_IDS, hookHeight: 2 });
  assert.equal(r1.ok, true);
  assert.equal(r1.plan.risk, "危险");
  assert.ok(r1.plan.hazards.some(h => h.code === "near_overload"));

  const h = 2 * Math.tan(57 * Math.PI / 180); // 夹角 57°，未超 60° 但超过预警线
  const r2 = computeLiftingPlan(TRI_GEO, { pointIds: TRI_IDS, hookHeight: h });
  assert.equal(r2.ok, true);
  assert.equal(r2.plan.risk, "危险");
  assert.ok(r2.plan.hazards.some(h2 => h2.code === "steep_angle"));
});

test("凸包与投影包含：边上/顶点视为在内，共线退化为线段", () => {
  const hull = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 2, y: 2 }]);
  assert.equal(hull.length, 4);
  assert.equal(projectionInside(hull, { x: 2, y: 2 }), true);
  assert.equal(projectionInside(hull, { x: 4, y: 2 }), true, "边上在内");
  assert.equal(projectionInside(hull, { x: 4.1, y: 2 }), false);
  const seg = convexHull([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }]);
  assert.equal(seg.length, 2);
  assert.equal(projectionInside(seg, { x: 2, y: 0 }), true);
  assert.equal(projectionInside(seg, { x: 2, y: 0.1 }), false);
});
