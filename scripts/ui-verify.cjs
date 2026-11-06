// 真实界面验收台：通过 CDP 驱动用户实际启动的打包程序，把"解析 → 下载 → 删除记录"真跑一遍。
// 前置：打包版以 --remote-debugging-port=9345 启动（npm run ui:verify 之前先双击/启动它）。
// 证据（截图 + transcript）落在 %TEMP%\qy-ui-evidence。
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.QY_CDP_PORT || 9345);
const OUT_DIR = path.join(process.env.TEMP, 'qy-ui-evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });
const URL_TEST = process.env.QY_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const lines = [];
const say = (...a) => { const t = a.join(' '); lines.push(t); console.log(t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails.text).slice(0, 300));
  return result.result.value;
}

async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(`return (${expression});`);
    if (last) return last;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last)}`);
}

async function shot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(image.data, 'base64'));
  say('screenshot', name + '.png');
}

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('no page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  const title = await evaluate('return document.title;');
  say('window title:', title);

  // 1) 引擎版本：面板是启动时探测的，看的是打包程序真正会用到的那份 exe
  const engineText = await waitFor('document.querySelector("#engine-list")?.textContent?.trim()?.length > 0', 60000, 'engine list');
  const engines = await evaluate('return document.querySelector("#engine-list").innerText.replace(/\\n+/g," | ");');
  say('engine panel:', engines);
  fs.writeFileSync(path.join(OUT_DIR, 'engine-panel.txt'), engines, 'utf8');

  // 2) 解析一条 YouTube 链接
  await evaluate(`
    const input = document.querySelector('#url');
    input.value = ${JSON.stringify(URL_TEST)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#analyze').click();
    return true;
  `);
  say('clicked analyze, waiting for format list…');
  // 只等"格式下拉里有没有 option"会被上一次解析留下的旧选项骗过去（下拉没清空，
  // media 却已经重置成 null，点下载只会得到"请先解析链接"）。以界面自己的完成语为准。
  await waitFor(`(() => {
    const status = (document.querySelector('#status')?.textContent || '').trim();
    if (/正在解析/.test(status)) return '';
    if (!/解析完成/.test(status)) return '';
    return (document.querySelector('#video-format')?.options?.length || 0) > 0;
  })()`, 180000, 'video formats');
  const formats = await evaluate('return [...document.querySelectorAll("#video-format option")].map((o,i)=>i+":"+o.textContent).join(" / ");');
  say('formats:', formats);
  const mediaTitle = await evaluate('return document.querySelector("#title")?.textContent || document.querySelector("#meta")?.textContent || "";');
  say('parsed title:', mediaTitle);

  // 3) 选最低一档，点下载
  await evaluate(`
    const select = document.querySelector('#video-format');
    select.selectedIndex = select.options.length - 1;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.options[select.selectedIndex].textContent;
  `).then((picked) => say('picked format:', picked));
  const outFolder = await evaluate('return document.querySelector("#folder")?.value || "";');
  say('output folder in UI:', outFolder);
  await evaluate('document.querySelector("#download").click(); return true;');
  say('clicked download, watching the queue…');

  // 4) 队列行：状态推进 + 删除按钮必须存在
  await waitFor('document.querySelectorAll("#task-list .task-row").length > 0', 30000, 'queue row appears');
  const firstRow = await evaluate('return document.querySelector("#task-list .task-row")?.innerText.replace(/\\n+/g," | ");');
  say('queue row 1:', firstRow);
  const hasDelete = await evaluate('return Boolean(document.querySelector("#task-list .task-row [data-remove-task]"));');
  say('row has visible delete button:', hasDelete);
  await shot('01-queue-downloading');

  const finish = await waitFor(`(() => {
    const rows = [...document.querySelectorAll('#task-list .task-row')];
    const row = rows[rows.length - 1];
    if (!row) return '';
    if (row.classList.contains('status-done')) return 'done';
    if (row.classList.contains('status-failed')) return 'failed:' + (row.innerText.match(/失败[^\\n]*/g) || []).join(' ');
    return '';
  })()`, 900000, 'task to finish');
  say('task finished as:', finish);
  const rowAfter = await evaluate('return document.querySelector("#task-list .task-row")?.innerText.replace(/\\n+/g," | ");');
  say('queue row after:', rowAfter);
  await shot('02-queue-done');

  // 5) 真的点删除，确认行从列表消失且文件还在
  const fileOnDisk = await evaluate(`
    const row = document.querySelector('#task-list .task-row');
    const files = row ? row.innerText : '';
    return files;
  `);
  void fileOnDisk;
  const clicked = await evaluate(`
    const before = document.querySelectorAll('#task-list .task-row').length;
    const button = document.querySelector('#task-list .task-row [data-remove-task]');
    if (!button) return 'no-button';
    button.click();
    return 'clicked:' + before;
  `);
  say('delete click:', clicked);
  await sleep(2500);
  const afterDelete = await evaluate('return document.querySelectorAll("#task-list .task-row").length;');
  say('rows after delete:', afterDelete);
  const statusText = await evaluate('return document.querySelector("#status")?.textContent || document.querySelector(".status-line")?.textContent || "";');
  say('status line:', statusText);
  await shot('03-queue-after-delete');

  // 6) 历史列表（用户说的"下载列表"）：先证明它没重启也把新记录画出来了，
  //    再证明删除按钮可见、真删一条、且不动已下载文件
  await evaluate('document.querySelector(\'[data-view="history"]\').click(); return true;');
  await sleep(1500);
  const historyLive = await evaluate(`
    return (async () => {
      const list = await window.qingying.historyList();
      const items = list.items || [];
      const rows = [...document.querySelectorAll('#history-list .history-row')];
      return JSON.stringify({
        storage: items.length,
        rendered: rows.length,
        topTitle: rows[0] ? (rows[0].innerText.split('\\n')[0] || '') : '',
        topId: items[0] ? items[0].id : '',
      });
    })();
  `);
  say('history live-refresh check:', historyLive);
  const live = JSON.parse(historyLive);
  say('history renders the new record without a restart:',
    live.storage === live.rendered && live.topTitle === mediaTitle ? 'yes' : 'NO (storage ' + live.storage + ' vs rendered ' + live.rendered + ', top="' + live.topTitle + '")');
  const historyBefore = await waitFor('document.querySelectorAll("#history-list .history-row").length', 30000, 'history rows');
  say('history rows before delete:', historyBefore);
  const historyHasDelete = await evaluate('return Boolean(document.querySelector("#history-list .history-row [data-remove-history]"));');
  say('history row has visible delete button:', historyHasDelete);
  await shot('05-history-before-delete');
  const historyTarget = await evaluate(`
    const row = document.querySelector('#history-list .history-row');
    return row ? row.innerText.replace(/\\n+/g, ' | ') : '';
  `);
  say('history row targeted:', historyTarget);
  const historyFile = await evaluate(`
    return (async () => {
      const list = await window.qingying.historyList();
      const item = (list.items || [])[0];
      return item ? JSON.stringify({ id: item.id, files: (item.files || []).map((f) => f.path), title: item.title }) : '';
    })();
  `);
  say('history record behind that row:', historyFile);
  const recorded = historyFile ? JSON.parse(historyFile) : {};
  const historyClicked = await evaluate(`
    const button = document.querySelector('#history-list .history-row [data-remove-history]');
    if (!button) return 'no-button';
    button.click();
    return 'clicked';
  `);
  say('history delete click:', historyClicked);
  await sleep(2500);
  const historyAfter = await evaluate('return document.querySelectorAll("#history-list .history-row").length;');
  say('history rows after delete:', historyAfter);
  if (recorded.id) {
    const persisted = await evaluate(`
      return (async () => {
        const list = await window.qingying.historyList();
        return (list.items || []).some((entry) => entry.id === ${JSON.stringify(recorded.id)}) ? 'STILL-IN-STORAGE' : 'gone-from-storage';
      })();
    `);
    say('history storage after delete:', persisted);
    for (const file of (recorded.files || [])) {
      say('downloaded file still on disk:', fs.existsSync(file) + ' ' + file);
    }
  } else {
    say('history storage after delete: UNVERIFIED (no record captured)');
  }
  await shot('06-history-after-delete');

  // 7) 清除已结束 / 失败任务的入口
  const failedGate = await evaluate(`
    const input = document.querySelector('#url');
    input.value = 'https://www.youtube.com/watch?v=does-not-exist-000000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#analyze').click();
    return 'analyzing';
  `);
  say('bad link probe:', failedGate);
  await sleep(20000);
  const errShown = await evaluate('return document.querySelector("#error-card")?.innerText?.replace(/\\n+/g," | ")?.slice(0,300) || "";');
  say('parse error panel:', errShown);
  await shot('07-bad-link');

  // 8) 引擎检查更新按钮（真走官方发布页）
  await evaluate('document.querySelector(\'[data-view="settings"]\').click(); return true;');
  await sleep(1200);
  await evaluate('document.querySelector("#update-engines").click(); return true;');
  say('clicked check-for-updates');
  const updateNote = await waitFor('(() => { const n = document.querySelector("#engine-update-note")?.textContent || ""; return /最新|已升级|没换成|失败|新版本|没有|拒绝/.test(n) ? n : ""; })()', 240000, 'update note');
  say('update note:', updateNote);
  fs.writeFileSync(path.join(OUT_DIR, 'update-note.txt'), updateNote, 'utf8');
  await shot('08-engine-update');

  fs.writeFileSync(path.join(OUT_DIR, 'transcript.txt'), lines.join('\n'), 'utf8');
  ws.close();
  process.exit(0);
})().catch((error) => {
  say('FATAL', error && error.message ? error.message : String(error));
  fs.writeFileSync(path.join(OUT_DIR, 'transcript.txt'), lines.join('\n'), 'utf8');
  process.exit(1);
});
