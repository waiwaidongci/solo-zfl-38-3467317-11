// 吊装配平计算模块（纯函数，无 IO，可独立单测）
//
// 约定：
// - 坐标系：z 轴竖直向上，x/y 为水平面；重心投影即重心在水平面的 (x, y)。
// - 吊钩位于重心投影正上方，高度为 hookHeight（吊高，绝对 z 坐标）。
// - 质量、受力、额定载荷统一按公斤计（静力平衡下 kgf 与 kg 数值一致）。
// - 水平夹角 = 吊索与水平面的夹角，超过 60° 拒绝。
// - 受力求解：所有吊索汇交于吊钩，列静力平衡方程 A·T = (0,0,W)。
//   3 点为静定精确解，2 点为杠杆解（重心投影须落在两吊点连线上），
//   4 点及以上为静不定，取最小范数平衡解。

export const ANGLE_LIMIT_DEG = 60; // 水平夹角上限，超过即拒绝
export const ANGLE_WARN_DEG = 55; // 接近上限列为危险项
export const LOAD_WARN_RATIO = 0.8; // 受力达到额定载荷 80% 列为危险项

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Andrew 单调链凸包，返回逆时针序的 [x, y] 数组（共线点退化为首尾两点）
export function convexHull(points) {
  const uniq = [];
  for (const p of points) {
    if (!uniq.some(q => q[0] === p.x && q[1] === p.y)) uniq.push([p.x, p.y]);
  }
  if (uniq.length <= 2) return uniq;
  const sorted = [...uniq].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// 判断重心投影 g 是否落在凸包（支撑多边形）内，边上视为在内
export function projectionInside(hull, g, eps = 1e-9) {
  if (hull.length === 0) return false;
  if (hull.length === 1) return Math.hypot(g.x - hull[0][0], g.y - hull[0][1]) <= eps;
  if (hull.length === 2) {
    const [a, b] = hull;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : ((g.x - a[0]) * dx + (g.y - a[1]) * dy) / len2;
    if (t < -eps || t > 1 + eps) return false;
    const tc = Math.min(1, Math.max(0, t));
    return Math.hypot(g.x - (a[0] + tc * dx), g.y - (a[1] + tc * dy)) <= eps;
  }
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const c = (x2 - x1) * (g.y - y1) - (y2 - y1) * (g.x - x1);
    if (Math.abs(c) <= eps) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function det3(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function inv3(M, det) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

// 求解 A·T = (0,0,W)：A 为 3×n 矩阵，列为各吊索单位方向向量（吊点指向吊钩）
// n<3 为超定方程：用法方程 (AᵀA)T = Aᵀb 求最小二乘解，靠残差判定是否可平衡；
// n≥3 时取最小范数解 T = Aᵀ(AAᵀ)⁻¹b（n=3 即静定精确解）。
// 几何奇异（方向向量退化）时返回 { singular: true }
function solveTensions(directions, W) {
  const n = directions.length;
  const Atb = directions.map(d => d[2] * W); // Aᵀ·(0,0,W)
  let T;
  if (n < 3) {
    const G = directions.map((a, i) => directions.map((b, j) => (i <= j ? a[0] * b[0] + a[1] * b[1] + a[2] * b[2] : 0)));
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) G[i][j] = G[j][i];
    if (n === 1) {
      T = [Atb[0] / G[0][0]];
    } else {
      const det = G[0][0] * G[1][1] - G[0][1] * G[0][1];
      if (!(Math.abs(det) > 1e-12)) return { singular: true };
      T = [(Atb[0] * G[1][1] - Atb[1] * G[0][1]) / det, (Atb[1] * G[0][0] - Atb[0] * G[0][1]) / det];
    }
  } else {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const d of directions) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j];
      }
    }
    const det = det3(M);
    const scale = (M[0][0] + M[1][1] + M[2][2]) / 3;
    if (!(Math.abs(det) > 1e-12 * Math.max(1e-30, scale ** 3))) return { singular: true };
    const inv = inv3(M, det);
    const y = [inv[0][2] * W, inv[1][2] * W, inv[2][2] * W]; // M⁻¹·(0,0,W)
    T = directions.map(d => d[0] * y[0] + d[1] * y[1] + d[2] * y[2]);
  }
  const r = [0, 0, -W];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 3; i++) r[i] += T[k] * directions[k][i];
  }
  return { T, residual: Math.hypot(r[0], r[1], r[2]) };
}

// 主入口：按重力平衡计算吊装方案
// geometry: { massKg, cg: {x,y,z}, points: [{id, name, x, y, z, ratedKg}] }
// selection: { pointIds: [...], hookHeight }
// 返回 { ok, reasons: [{code, message}], plan }；ok=false 时 plan 仍尽量给出已算出的数据
export function computeLiftingPlan(geometry, selection = {}) {
  const reasons = [];
  const geo = geometry || {};
  const points = Array.isArray(geo.points) ? geo.points : [];
  const cg = geo.cg || {};
  const hookHeight = selection.hookHeight;
  const ids = Array.isArray(selection.pointIds) ? selection.pointIds : [];

  // 1. 几何数据缺失
  if (!isNum(geo.massKg) || geo.massKg <= 0) reasons.push({ code: "missing_geometry", message: "整船质量缺失或无效" });
  if (!isNum(cg.x) || !isNum(cg.y) || !isNum(cg.z)) reasons.push({ code: "missing_geometry", message: "重心坐标缺失或无效" });
  if (!isNum(hookHeight)) reasons.push({ code: "missing_geometry", message: "吊高缺失或无效" });
  if (ids.length === 0) reasons.push({ code: "missing_geometry", message: "未选择吊点" });
  if (reasons.length) return { ok: false, reasons, plan: null };

  // 2. 吊点重复
  const seen = new Set();
  const dupIds = [];
  for (const id of ids) {
    if (seen.has(id)) dupIds.push(id);
    else seen.add(id);
  }
  if (dupIds.length) reasons.push({ code: "duplicate_points", message: "吊点重复：" + dupIds.join("、") });

  // 3. 解析吊点并校验其几何数据
  const chosen = [];
  for (const id of seen) {
    const p = points.find(pt => pt.id === id);
    if (!p) {
      reasons.push({ code: "missing_geometry", message: "吊点不存在：" + id });
      continue;
    }
    if (!isNum(p.x) || !isNum(p.y) || !isNum(p.z) || !isNum(p.ratedKg) || p.ratedKg <= 0) {
      reasons.push({ code: "missing_geometry", message: "吊点" + (p.name || id) + "的坐标或吊索额定载荷缺失" });
      continue;
    }
    chosen.push(p);
  }
  if (chosen.length < 2) reasons.push({ code: "not_enough_points", message: "吊点组合至少需要两个有效吊点" });
  if (reasons.length) return { ok: false, reasons, plan: null };

  // 4. 吊钩必须高于所有吊点
  const g = { x: cg.x, y: cg.y };
  const W = geo.massKg;
  const legs = chosen.map(p => ({
    p,
    rho: Math.hypot(g.x - p.x, g.y - p.y), // 吊点到重心投影的水平距离
    dz: hookHeight - p.z, // 吊钩相对吊点的竖直高差
  }));
  for (const leg of legs) {
    if (!(leg.dz > 0)) {
      reasons.push({ code: "hook_below_point", message: "吊高必须高于吊点" + (leg.p.name || leg.p.id) + "的 z 坐标（" + leg.p.z + "）" });
    }
  }
  if (reasons.length) return { ok: false, reasons, plan: null };

  // 5. 重心投影必须落在吊点组成的支撑多边形内
  const hull = convexHull(chosen);
  const inside = projectionInside(hull, g);
  if (!inside) reasons.push({ code: "cg_outside_polygon", message: "重心投影落在吊点组成的支撑多边形外" });

  // 6. 重力平衡求解每根吊索受力
  const directions = legs.map(leg => {
    const L = Math.hypot(leg.rho, leg.dz);
    return [(g.x - leg.p.x) / L, (g.y - leg.p.y) / L, leg.dz / L];
  });
  const solved = solveTensions(directions, W);
  const tol = 1e-6 * Math.max(1, W);
  let tensions = null;
  if (solved.singular) {
    reasons.push({ code: "unbalanced_geometry", message: "吊点几何无法形成稳定的重力平衡" });
  } else if (solved.residual > tol) {
    reasons.push({ code: "unbalanced_geometry", message: "吊点几何无法满足重力平衡方程" });
  } else {
    tensions = solved.T.map(t => (Math.abs(t) < 1e-9 * Math.max(1, W) ? 0 : t));
    if (tensions.some(t => t < 0)) {
      reasons.push({ code: "cg_outside_polygon", message: "存在吊索受压，重心投影超出有效支撑范围" });
      tensions = null;
    }
  }

  // 7. 水平夹角与载荷校验；同时汇总危险项
  let slings = [];
  if (tensions) {
    slings = legs.map((leg, i) => {
      const angleDeg = Math.atan2(leg.dz, leg.rho) * 180 / Math.PI;
      const forceKg = tensions[i];
      const utilization = forceKg / leg.p.ratedKg;
      const hazards = [];
      if (angleDeg > ANGLE_LIMIT_DEG + 1e-9) {
        reasons.push({ code: "angle_over_60", pointId: leg.p.id, message: "吊索" + (leg.p.name || leg.p.id) + "与水平面夹角 " + angleDeg.toFixed(1) + "° 超过 60°" });
      }
      if (forceKg > leg.p.ratedKg + 1e-9) {
        reasons.push({ code: "overload", pointId: leg.p.id, message: "吊索" + (leg.p.name || leg.p.id) + "受力 " + forceKg.toFixed(2) + " kg 超过额定载荷 " + leg.p.ratedKg + " kg" });
      }
      if (utilization >= LOAD_WARN_RATIO && forceKg <= leg.p.ratedKg + 1e-9) {
        hazards.push({ code: "near_overload", message: "受力达额定载荷 " + (utilization * 100).toFixed(0) + "%" });
      }
      if (angleDeg >= ANGLE_WARN_DEG && angleDeg <= ANGLE_LIMIT_DEG + 1e-9) {
        hazards.push({ code: "steep_angle", message: "夹角 " + angleDeg.toFixed(1) + "° 接近 60° 上限" });
      }
      return { pointId: leg.p.id, name: leg.p.name, forceKg, angleDeg, ratedKg: leg.p.ratedKg, utilization, hazards };
    });
  }

  const hazards = slings.flatMap(s => s.hazards.map(h => ({ ...h, pointId: s.pointId, name: s.name })));
  const plan = {
    pointIds: chosen.map(p => p.id),
    hookHeight,
    massKg: W,
    cg: { x: cg.x, y: cg.y, z: cg.z },
    projection: { x: g.x, y: g.y, insidePolygon: inside },
    supportPolygon: hull,
    slings,
    hazards,
    risk: hazards.length ? "危险" : "安全",
    maxUtilization: slings.length ? Math.max(...slings.map(s => s.utilization)) : null,
    maxAngleDeg: slings.length ? Math.max(...slings.map(s => s.angleDeg)) : null,
  };
  return reasons.length ? { ok: false, reasons, plan } : { ok: true, reasons: [], plan };
}
