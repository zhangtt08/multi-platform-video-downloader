// 抖音回归：用界面真实链路（浏览器取数 → 签名直链 → yt-dlp）跑一条历史里出现过的链接。
// 跑完把自己造出来的队列行/历史行删掉，不留垃圾。
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(process.env.TEMP, 'qy-ui-evidence');
const lines = [];
const say = (...a) => { const t = a.join(' '); lines.push(t); console.log(t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let nextId = 1; const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
}
async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(`return (${expr});`);
    if (last) return last;
    await sleep(1000);
  }
  throw new Error('timeout waiting for ' + label + ': last=' + JSON.stringify(last));
}
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9345/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  await send('Runtime.enable');

  const url = process.env.QY_DOUYIN_URL || await evaluate(`
    const list = await window.qingying.historyList();
    const item = (list.items || []).find((i) => /douyin\\.com/.test(i.url || ''));
    return item ? item.url : '';
  `);
  if (!url) { say('no douyin url available — cannot regress'); fs.writeFileSync(path.join(OUT, 'douyin-regression.txt'), lines.join('\n'), 'utf8'); process.exit(1); }
  say('douyin url:', url);

  await evaluate(`
    document.querySelector('[data-view="home"]').click();
    const input = document.querySelector('#url');
    input.value = ${JSON.stringify(url)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#analyze').click();
    return true;
  `);
  const outcome = await waitFor(`(() => {
    const status = (document.querySelector('#status')?.textContent || '').trim();
    if (/正在解析/.test(status)) return '';
    if (/解析完成/.test(status)) return (document.querySelector('#video-format')?.options?.length || 0) > 0 ? 'formats' : '';
    const err = document.querySelector('#error-card');
    if (err && (err.innerText || '').trim()) return 'error';
    return '';
  })()`, 180000, 'douyin analyze');
  say('analyze outcome:', outcome);
  if (outcome !== 'formats') {
    say('error panel:', await evaluate('return (document.querySelector("#error-card")?.innerText || "").replace(/\\n+/g," | ").slice(0,300);'));
    fs.writeFileSync(path.join(OUT, 'douyin-regression.txt'), lines.join('\n'), 'utf8');
    process.exit(1);
  }
  say('formats:', await evaluate('return [...document.querySelectorAll("#video-format option")].map(o=>o.textContent).join(" / ").slice(0,300);'));
  await evaluate(`
    const s = document.querySelector('#video-format');
    s.selectedIndex = s.options.length - 1;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#download').click();
    return true;
  `);
  say('clicked download');
  const finish = await waitFor(`(() => {
    const rows = [...document.querySelectorAll('#task-list .task-row')];
    const row = rows[rows.length - 1];
    if (!row) return '';
    if (row.classList.contains('status-done')) return 'done';
    if (row.classList.contains('status-failed')) return 'failed:' + (row.innerText.match(/失败[^\\n]*/g) || []).join(' ');
    return '';
  })()`, 600000, 'douyin task to finish');
  say('douyin task finished as:', finish);
  say('row:', await evaluate('return (document.querySelector("#task-list .task-row")?.innerText || "").replace(/\\n+/g," | ").slice(0,300);'));

  // 清理：删掉这条队列行和历史行（按 url 精确匹配，不碰别的记录）
  await evaluate(`
    const b = document.querySelector('#task-list .task-row [data-remove-task]');
    if (b) b.click();
    return true;
  `);
  await sleep(1500);
  const cleaned = await evaluate(`
    const list = await window.qingying.historyList();
    const mine = (list.items || []).filter((i) => (i.url || '') === ${JSON.stringify(url)});
    const removed = [];
    for (const item of mine) { if (await window.qingying.removeHistoryItem(item.id)) removed.push(item.id); }
    return removed.length ? 'removed:' + removed.join(',') : 'nothing-to-remove';
  `);
  say('cleanup:', cleaned);

  fs.writeFileSync(path.join(OUT, 'douyin-regression.txt'), lines.join('\n'), 'utf8');
  ws.close();
  process.exit(finish === 'done' ? 0 : 1);
})().catch((e) => { say('FATAL', e.message); fs.writeFileSync(path.join(OUT, 'douyin-regression.txt'), lines.join('\n'), 'utf8'); process.exit(1); });
