// 浏览器验收：真实 Chromium 走通吊装配平全流程
// 既是 npm test 的一部分（node:test 用例），也可单独运行：npm run acceptance
// 如浏览器缺系统库，先执行 scripts/install-browser-deps.sh
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 加载项目内浏览器依赖（scripts/install-browser-deps.sh 生成）
const sysroot = join(root, ".browser-sysroot");
if (existsSync(sysroot)) {
  const arch = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  const extra = [join(sysroot, "lib", arch), join(sysroot, "usr", "lib", arch)].filter(existsSync);
  process.env.LD_LIBRARY_PATH = [...extra, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

test("浏览器验收：吊装配平全流程", async () => {
  let failures = 0;
  const check = (cond, msg) => {
    if (cond) console.log("  ✓ " + msg);
    else { failures++; console.error("  ✗ " + msg); }
  };

  const port = 4000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), "lifting-acceptance-"));
  const server = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, "db.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("服务启动超时：" + out)), 15000);
      server.stdout.on("data", d => { out += d; if (out.includes("listening")) { clearTimeout(timer); resolve(); } });
      server.on("exit", code => reject(new Error("服务进程退出 " + code + "：" + out)));
    });
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);

    async function selectShip(code) {
      const value = await page.locator("#liftShip option", { hasText: code }).first().getAttribute("value");
      await page.selectOption("#liftShip", value);
    }
    async function createModel(code, shipType) {
      await page.fill('#createForm input[name=code]', code);
      await page.fill('#createForm input[name=shipType]', shipType);
      await page.fill('#createForm input[name=scale]', "1:50");
      await page.fill('#createForm input[name=mastCount]', "2");
      await page.fill('#createForm input[name=riggingMaterial]', "棉线");
      await page.fill('#createForm input[name=owner]', "验收");
      await page.fill('#createForm input[name=dueDate]', "2026-09-30");
      await page.click("#createForm button");
      await page.waitForSelector(`#cards .card:has-text("${code}")`);
    }
    async function saveGeo(mass, x, y, z) {
      await page.fill("#liftMass", String(mass));
      await page.fill("#liftCgX", String(x));
      await page.fill("#liftCgY", String(y));
      await page.fill("#liftCgZ", String(z));
      await Promise.all([
        page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/lifting")),
        page.click("#saveGeo"),
      ]);
      // 等重新渲染完成（摘要反映新数据），避免读到旧 DOM
      await page.waitForFunction(
        ([m, x2, y2, z2]) => {
          const t = document.querySelector("#liftGeoSummary").textContent;
          return t.includes("质量 " + m + " kg") && t.includes("重心 (" + x2 + ", " + y2 + ", " + z2 + ")");
        },
        [String(mass), String(x), String(y), String(z)]
      );
    }
    async function addPoint(name, x, y, z, rated) {
      const before = await page.locator("#pointChecks input[type=checkbox]").count();
      await page.fill("#ptName", name);
      await page.fill("#ptX", String(x));
      await page.fill("#ptY", String(y));
      await page.fill("#ptZ", String(z));
      await page.fill("#ptRated", String(rated));
      await Promise.all([
        page.waitForResponse(r => r.request().method() === "POST" && r.url().includes("/lifting/points")),
        page.click("#addPoint"),
      ]);
      await page.waitForFunction(n => document.querySelectorAll("#pointChecks input[type=checkbox]").length === n, before + 1);
    }
    async function checkAllPoints() {
      const boxes = page.locator("#pointChecks input[type=checkbox]");
      const n = await boxes.count();
      for (let i = 0; i < n; i++) await boxes.nth(i).check();
      return n;
    }
    async function calculate(height) {
      await page.fill("#hookHeight", String(height));
      await page.evaluate(() => { document.querySelector("#calcResult").textContent = ""; });
      await Promise.all([
        page.waitForResponse(r => r.request().method() === "POST" && r.url().includes("/lifting/calculate")),
        page.click("#calcBtn"),
      ]);
      await page.waitForFunction(() => document.querySelector("#calcResult").textContent.trim().length > 0);
    }
    const resultText = () => page.textContent("#calcResult");
    const plansText = () => page.textContent("#plansList");
    const planCount = () => page.locator("#plansList .card").count();

    // 1. 创建模型并登记吊装数据
    await page.goto(base);
    await page.waitForSelector('#createForm input[name=code]');
    await createModel("MR-900", "沙船");
    check(true, "创建模型 MR-900");
    await selectShip("MR-900");
    await saveGeo(120, 0, 0, 0.3);
    check(await page.textContent("#liftGeoSummary").then(t => t.includes("120 kg")), "登记整船质量与重心");

    // 2. 添加三个吊点
    await addPoint("艏吊点", 2, 0, 0, 100);
    await addPoint("左舷吊点", -1, 1.8, 0, 100);
    await addPoint("右舷吊点", -1, -1.8, 0, 100);
    check(await checkAllPoints() === 3, "登记三个吊点并全部选中");

    // 3. 计算受力：每根吊索受力、夹角、重心投影
    await calculate(2);
    await page.waitForSelector("#calcResult table.slings");
    let text = await resultText();
    check((await page.locator("#calcResult table.slings tr").count()) === 4, "逐根显示 3 根吊索受力");
    check(text.includes("56.57"), "艏吊点受力 56.57 kg（重力平衡解）");
    check(text.includes("45.0°"), "水平夹角 45.0°");
    check(text.includes("重心投影 (0.00, 0.00)") && text.includes("支撑多边形内"), "重心投影落在支撑多边形内");
    check(text.includes("计算通过"), "安全方案计算通过");

    // 4. 确认方案
    await page.click("#confirmBtn");
    await page.waitForFunction(() => document.querySelector("#liftMsg").textContent.includes("方案已确认"));
    check(await planCount() === 1, "确认后生成方案记录");
    check((await plansText()).includes("安全") && (await plansText()).includes("56.57"), "方案卡片显示风险等级与每根吊索受力");

    // 5. 重复确认被拒绝（并发/重复提交只保留一个方案）
    await checkAllPoints();
    await calculate(2);
    await page.click("#confirmBtn");
    await page.waitForFunction(() => document.querySelector("#liftMsg").textContent.includes("确认被拒绝"));
    check(await planCount() === 1, "相同吊点组合与吊高的重复确认被拒绝，方案仍只有一个");

    // 6. 危险方案：额定载荷接近受力 → 危险项
    await createModel("MR-901", "福船");
    await selectShip("MR-901");
    await saveGeo(120, 0, 0, 0.3);
    await addPoint("艏吊点", 2, 0, 0, 65);
    await addPoint("左舷吊点", -1, 1.8, 0, 65);
    await addPoint("右舷吊点", -1, -1.8, 0, 65);
    await checkAllPoints();
    await calculate(2);
    check((await resultText()).includes("接近") || (await resultText()).includes("额定载荷"), "接近额定载荷时标出危险项");
    await page.click("#confirmBtn");
    await page.waitForFunction(() => document.querySelector("#liftMsg").textContent.includes("方案已确认"));
    check((await plansText()).includes("危险项"), "危险方案记录含危险项");

    // 7. 风险筛选
    await page.selectOption("#riskFilter", "安全");
    check(await planCount() === 1 && (await plansText()).includes("MR-900"), "按风险筛选：安全 1 个");
    await page.selectOption("#riskFilter", "危险");
    check(await planCount() === 1 && (await plansText()).includes("MR-901"), "按风险筛选：危险 1 个");
    await page.selectOption("#riskFilter", "");
    check(await planCount() === 2, "全部风险共 2 个方案");

    // 8. 超载拒绝
    await createModel("MR-902", "广船");
    await selectShip("MR-902");
    await saveGeo(120, 0, 0, 0.3);
    await addPoint("艏吊点", 2, 0, 0, 50);
    await addPoint("左舷吊点", -1, 1.8, 0, 50);
    await addPoint("右舷吊点", -1, -1.8, 0, 50);
    await checkAllPoints();
    await calculate(2);
    text = await resultText();
    check(text.includes("拒绝原因") && text.includes("超过额定载荷"), "超载时显示拒绝原因");
    check(await page.locator("#confirmBtn").isDisabled(), "超载时确认按钮不可用");

    // 9. 偏心拒绝
    await saveGeo(120, 5, 0, 0.3);
    await checkAllPoints();
    await calculate(2);
    check((await resultText()).includes("支撑多边形外"), "重心落在支撑多边形外时拒绝");

    // 10. 夹角超限拒绝
    await saveGeo(120, 0, 0, 0.3);
    await checkAllPoints();
    await calculate(5);
    check((await resultText()).includes("超过 60°"), "水平夹角超过 60° 时拒绝");
    check(await planCount() === 2, "所有拒绝均未生成新方案");

    // 11. 刷新页面后记录保留（数据已落盘）
    await page.reload();
    await page.waitForSelector("#plansList .card");
    check(await planCount() === 2, "刷新页面后方案记录保留");
    check((await plansText()).includes("MR-900") && (await plansText()).includes("MR-901"), "既有方案内容不变");
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
  assert.equal(failures, 0, failures + " 项验收未通过");
});
