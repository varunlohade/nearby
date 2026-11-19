// node cdp.mjs shot <url> <out.png> <w> <h> [waitMs] [js]
// node cdp.mjs rec  <url> <outDir> <w> <h> <warmMs> <recMs> [js]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [mode, url, out, w = '1440', h = '900', a = '4000', b = '', c = ''] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--allow-file-access-from-files', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--enable-webgl', '--ignore-gpu-blocklist', '--mute-audio', `--window-size=${w},${h}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) { await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
if (!target) { chrome.kill(); throw new Error('no chrome target'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const handlers = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) handlers.forEach((f) => f(m)); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const logs = [];
handlers.push((m) => { if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((x) => x.value ?? x.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400)); });
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: mode === 'rec' ? 1 : 1, mobile: +w < 600 });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await send('Page.enable');
await send('Page.navigate', { url });
if (mode === 'shot') {
  await sleep(+a);
  if (b) { const r = await send('Runtime.evaluate', { expression: b, awaitPromise: true, returnByValue: true }); console.log('EVAL', JSON.stringify(r.result?.result?.value ?? r.result)); await sleep(+(c || 800)); }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  const info = await send('Runtime.evaluate', { expression: 'JSON.stringify({iw: innerWidth, ih: innerHeight})', returnByValue: true });
  console.log(out, info.result.result.value);
} else {
  mkdirSync(out, { recursive: true });
  await sleep(+a);
  if (c) await send('Runtime.evaluate', { expression: c });
  let n = 0; const times = [];
  handlers.push(async (m) => { if (m.method !== 'Page.screencastFrame') return;
    const f = m.params; writeFileSync(join(out, `f${String(n).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    times.push(f.metadata.timestamp); n++; send('Page.screencastFrameAck', { sessionId: f.sessionId }); });
  await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: +w, maxHeight: +h, everyNthFrame: 1 });
  await sleep(+b);
  await send('Page.stopScreencast');
  writeFileSync(join(out, 'times.json'), JSON.stringify(times));
  console.log('frames', n, 'span', times.length ? (times.at(-1) - times[0]).toFixed(2) : 0);
}
if (logs.length) console.log('LOGS:\n' + logs.slice(0, 15).join('\n'));
ws.close(); chrome.kill();
