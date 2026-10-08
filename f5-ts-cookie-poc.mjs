#!/usr/bin/env node
/**
 * POC: obtener la cookie TS (WAF F5 BIG-IP) de pjud.cl
 * corriendo Chrome headless=new en container-friendly mode,
 * con override de User-Agent para que el WAF no vea "HeadlessChrome".
 *
 * CDP puro sobre WebSocket — sin puppeteer, sin deps externas.
 * Requiere Node >= 22 (WebSocket global).
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------- config ----------
const CHROME_BIN = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const DEBUG_PORT = 9222;
const TARGET_URL = "https://www.pjud.cl";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const CHROME_MAJOR = 128;
const COOKIE_TIMEOUT_MS = 15_000; // máx espera del challenge F5
const POLL_MS = 250;
// ------------------------------

function launchChrome() {
  const proc = spawn(CHROME_BIN, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-sandbox",              // necesario como root en container
    "--disable-gpu",
    "--disable-dev-shm-usage",   // /dev/shm chico en docker -> crashes random
    "--disable-background-timer-throttling",
    "--no-first-run",
    "--user-data-dir=/tmp/opencode/chrome-profile",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  proc.stderr.on("data", () => {}); // silencia logs de chrome
  return proc;
}

async function waitForDebugger() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* aún no está listo */ }
    await sleep(200);
  }
  throw new Error("Chrome no expuso el debugger a tiempo");
}

/** Cliente CDP mínimo: send + espera de eventos */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { ok, err } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? err(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      } else if (msg.method) {
        cdp.listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
      }
    };
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }
}

async function getOrCreatePage(browser) {
  const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  return page.webSocketDebuggerUrl;
}

async function main() {
  console.log(`[poc] lanzando ${CHROME_BIN} headless=new...`);
  const chrome = launchChrome();

  try {
    const browserWsUrl = await waitForDebugger();
    const browser = await Cdp.connect(browserWsUrl);

    // arrancamos en about:blank, creamos un target limpio
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const pageWs = `ws://127.0.0.1:${DEBUG_PORT}/devtools/page/${targetId}`;
    const page = await Cdp.connect(pageWs);

    await page.send("Page.enable");
    await page.send("Network.enable");

    // ---- clave del POC: override del UA con metadata completa ----
    // el string del UA ya no dice "HeadlessChrome", y userAgentData
    // (Navigator.userAgentData, brands/fullVersionList) queda consistente.
    await page.send("Emulation.setUserAgentOverride", {
      userAgent: UA,
      platform: "Linux x86_64",
      userAgentMetadata: {
        brands: [
          { brand: "Chromium", version: String(CHROME_MAJOR) },
          { brand: "Google Chrome", version: String(CHROME_MAJOR) },
          { brand: "Not=A?Brand", version: "8" },
        ],
        fullVersionList: [
          { brand: "Chromium", version: `${CHROME_MAJOR}.0.0.0` },
          { brand: "Google Chrome", version: `${CHROME_MAJOR}.0.0.0` },
          { brand: "Not=A?Brand", version: "8" },
        ],
        fullVersion: `${CHROME_MAJOR}.0.0.0`,
        platform: "Linux",
        platformVersion: "6.1.0",
        architecture: "x86",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
      },
    });

    // sanity check: qué ve el navegador
    const ua = await page.send("Runtime.evaluate", {
      expression: "navigator.userAgent + ' | headless=' + navigator.userAgentData",
      returnByValue: true,
    });
    console.log(`[poc] navigator dice: ${ua.result.value}`);

    console.log(`[poc] navegando a ${TARGET_URL} (el challenge F5 puede recargar la página)...`);
    await page.send("Page.navigate", { url: TARGET_URL });

    // ---- loop de espera: el challenge F5 setea document.cookie=TS... y recarga ----
    const cookies = {};
    const isTsCookie = (name) => /^TS[\w-]*$/.test(name) || name.startsWith("TS");

    const pollCookies = async () => {
      const { cookies: cs } = await page.send("Network.getCookies", { urls: [TARGET_URL] });
      for (const c of cs) cookies[c.name] = c.value;
    };

    const deadline = Date.now() + COOKIE_TIMEOUT_MS;
    let found = null;
    while (Date.now() < deadline && !found) {
      await sleep(POLL_MS);
      await pollCookies();
      found = Object.keys(cookies).find(isTsCookie);
    }

    await pollCookies(); // captura final completa

    if (found) {
      console.log(`\n[poc] OK — cookie TS obtenida: ${found}=${cookies[found].slice(0, 40)}...`);
    } else {
      console.log("\n[poc] timeout esperando la cookie TS");
    }
    console.log("[poc] cookies finales:");
    for (const [name, value] of Object.entries(cookies)) {
      console.log(`  ${name} = ${value.slice(0, 60)}${value.length > 60 ? "..." : ""}`);
    }
  } finally {
    chrome.kill("SIGTERM");
    await sleep(300);
    process.exit(0);
  }
}

main().catch((e) => { console.error("[poc] fatal:", e); process.exit(1); });
