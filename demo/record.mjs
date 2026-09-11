// demo/record.mjs — records the page while scenes.sh runs; overlays the caption and agent logs.
// Seller-side lines never show the pair (a, b, answers, truth, pair) so nothing leaks before reveal.
import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_URL = process.argv[2] ?? "https://leavesj.github.io/black-box-bazaar/";
const here = new URL(".", import.meta.url).pathname;
const OUT = join(here, "out"); mkdirSync(OUT, { recursive: true });
const MAX_LINES = 24;
const SELLER_ROLES = new Set(["seller", "rogue", "newcomer"]);
const HIDDEN_FOR_SELLERS = new Set(["a", "b", "answers", "truth"]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
await page.goto(PAGE_URL, { waitUntil: "networkidle" });
// cut.sh aligns caption timestamps to the video with this.
writeFileSync(join(OUT, "record-start.json"), JSON.stringify({ t: Math.floor(Date.now() / 1000) }) + "\n");
await page.addStyleTag({ content: `
  #cap { position:fixed; left:0; right:0; bottom:0; padding:14px 28px; background:rgba(8,10,13,.94); color:#fff; font:600 18px/1.4 ui-sans-serif,system-ui; border-top:1px solid #333; z-index:99999 }
  #logs { position:fixed; right:0; top:0; width:520px; height:calc(100% - 70px); overflow:hidden; background:rgba(8,10,13,.92); color:#cfd6dd; font:12px/1.35 ui-monospace,Menlo,monospace; padding:10px 12px; border-left:1px solid #333; z-index:99998; white-space:pre-wrap }
  #logs b { color:#7ab8ff } main { padding-right:540px !important }` });
await page.evaluate(() => { for (const id of ["cap", "logs"]) { const d = document.createElement("div"); d.id = id; document.body.appendChild(d); } });

const tail = (file, n) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").slice(-n) : [];
const hidden = (role, key) => SELLER_ROLES.has(role) && (HIDDEN_FOR_SELLERS.has(key) || /pair/i.test(key));
function fmt(line) {
  try { const o = JSON.parse(line); const { t, role, event, ...rest } = o;
    const short = Object.entries(rest).filter(([k]) => !hidden(role, k)).map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("http") ? v.split("/").pop().slice(0, 10) + "…" : String(v).slice(0, 40)}`).join(" ");
    return `<b>${role}</b> ${event}  ${short}`; } catch { return line; }
}
let last = "";
while (true) {
  const cap = existsSync(join(here, "scene.txt")) ? readFileSync(join(here, "scene.txt"), "utf8").trim() : "";
  if (cap === "END") break;
  const dir = join(here, "logs");
  const lines = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".log")).flatMap(f => tail(join(dir, f), 40)) : [];
  lines.sort();
  const html = lines.slice(-MAX_LINES).map(fmt).join("\n");
  if (cap + html !== last) { await page.evaluate(([c, h]) => { document.getElementById("cap").textContent = c; document.getElementById("logs").innerHTML = h; }, [cap, html]); last = cap + html; }
  await page.waitForTimeout(700);
}
await page.waitForTimeout(2500);
await ctx.close(); await browser.close();
const webm = readdirSync(OUT).find(f => f.endsWith(".webm"));
renameSync(join(OUT, webm), join(OUT, "raw.webm"));
console.log("recorded demo/out/raw.webm");
