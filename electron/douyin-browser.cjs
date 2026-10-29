'use strict';
// 抖音作品解析器（只在 Electron 主进程里用）。
//
// 为什么不能直接命令行：抖音的 aweme/detail 接口要求网页 JS 现算的签名参数（a_bogus），
// yt-dlp 复现不了，只能报 "Fresh cookies"。真正稳定拿到数据的是应用内那个已经登录的
// 浏览器会话 —— 页面自己会发这条请求。这里开一个隐藏窗口打开链接，用 CDP 把那条
// 响应原样抄下来，再交给 engine-core 映射成格式。

const { BrowserWindow } = require('electron');

const DETAIL_API = /aweme\/v1\/web\/aweme\/detail/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function browserVersion() {
  const chrome = String(process.versions.chrome || '');
  return chrome ? 'Chromium ' + chrome : 'Chromium';
}

// 图文笔记（/note/）不发 aweme/detail，数据是渲染进 DOM 的；这里只收原图列表
// 与文案，形状按 aweme_detail 拼，后面的映射仍然只有一份。
function extractNoteFromDom(wc) {
  return wc.executeJavaScript(`(() => {
    const pick = new Map();
    for (const img of document.images) {
      const src = img.currentSrc || img.src || '';
      if (!/douyinpic\\.com/.test(src)) continue;
      if (!/aweme-images|image-cut-tos|tplv-dy/.test(src)) continue;
      // 右栏推荐图（440x330）和头像（96x96）也在同一页里，按实际像素把它们剔掉。
      if ((img.naturalWidth || 0) < 600 || (img.naturalHeight || 0) < 600) continue;
      // 同一张图在页面里有多个规格（轮播缩略、详情大图、右栏推荐各一份签名）：
      // 按"~tplv-"之前的对象路径归并，只留像素面积最大的那个规格。
      const key = src.split('~tplv-')[0];
      const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      const prev = pick.get(key);
      if (!prev || area > prev.area) pick.set(key, { url: src, width: img.naturalWidth || 0, height: img.naturalHeight || 0, area });
    }
    const descEl = document.querySelector('[data-e2e="note-desc"], [data-e2e="detail-video-desc"], [data-e2e="detail-desc"]');
    const authorEl = document.querySelector('[data-e2e="user-name"], [data-e2e="user-info"] .name, a[href*="/user/"] span');
    const title = (document.title || '').replace(/\\s*[-–|]\\s*抖音\\s*$/, '');
    const hit = /\\/(?:note|share\\/note)\\/(\\d+)/.exec(location.href);
    return {
      aweme_id: hit ? hit[1] : '',
      desc: (descEl ? descEl.innerText : title || '').slice(0, 300),
      author: authorEl ? authorEl.innerText.trim().slice(0, 60) : '',
      images: [...pick.values()].slice(0, 60),
      href: location.href,
    };
  })()`);
}

// 返回 { ok:true, detail, browserVersion, ms, source }
// 或   { ok:false, kind, error, ms }（kind 会被 engine-core 的失败归因继续翻译）
async function resolveDouyinDetail(options) {
  const opts = options || {};
  const url = String(opts.url || '').trim();
  const partition = String(opts.partition || 'persist:qydouyin');
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 20000);
  const startedAt = Date.now();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, kind: 'bad_url', error: '网址无效。', ms: 0 };
  }

  let win = null;
  let attached = false;
  let detail = null;
  let noteFallback = null;
  let pageText = '';
  let originError = '';
  let userAgent = '';

  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    userAgent = wc.getUserAgent();
    wc.on('render-process-gone', (_event, info) => {
      originError = '渲染进程退出（' + String((info && info.reason) || 'unknown') + '）';
    });

    await Promise.race([
      wc.loadURL(url).catch((error) => {
        originError = String((error && error.message) || error);
      }),
      sleep(20000),
    ]);
    // 先让首屏把会话跑热，再挂调试器重载一次：目标已就绪，aweme/detail 一定从这次经过。
    await sleep(1200);
    wc.debugger.attach('1.3');
    attached = true;
    await wc.debugger.sendCommand('Network.enable');
    wc.debugger.on('message', (_event, method, params) => {
      if (method !== 'Network.responseReceived' || detail) return;
      const target = params && params.response && params.response.url;
      if (!target || !DETAIL_API.test(target)) return;
      wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then((body) => {
          const text = body.base64Encoded
            ? Buffer.from(body.body, 'base64').toString('utf8')
            : body.body;
          const parsed = JSON.parse(text);
          if (parsed && parsed.aweme_detail) detail = parsed.aweme_detail;
        })
        .catch(() => { /* 响应体可能已被回收：等下一次请求 */ });
    });
    wc.reload();

    // 图文笔记根本不发详情接口，等满超时只是白等：笔记页只等 8 秒就走 DOM 兜底。
    const detailWaitMs = /\/(?:note|share\/note)\//.test(url) ? Math.min(timeoutMs, 8000) : timeoutMs;
    const deadline = Date.now() + detailWaitMs;
    while (!detail && Date.now() < deadline) {
      if (wc.isDestroyed()) {
        originError = originError || '窗口在解析完成前被关掉了';
        break;
      }
      await sleep(250);
    }
    if (!detail && !wc.isDestroyed()) {
      pageText = await Promise.race([
        wc.executeJavaScript('(document.body && document.body.innerText || "").slice(0, 600)').catch(() => ''),
        sleep(3000).then(() => ''),
      ]);
      if (/\/(?:note|share\/note)\//.test(wc.getURL() || url)) {
        const dom = await Promise.race([
          extractNoteFromDom(wc).catch(() => null),
          sleep(5000).then(() => null),
        ]);
        if (dom && Array.isArray(dom.images) && dom.images.length) {
          noteFallback = {
            aweme_id: dom.aweme_id,
            desc: dom.desc,
            author: { nickname: dom.author },
            video: {},
            images: dom.images.map((image) => ({ url_list: [image.url], width: image.width, height: image.height })),
          };
        }
      }
    }
  } catch (error) {
    originError = originError || String((error && error.message) || error);
  } finally {
    if (win && !win.isDestroyed()) {
      try { if (attached) win.webContents.debugger.detach(); } catch {}
      try { win.destroy(); } catch {}
    }
  }

  const ms = Date.now() - startedAt;
  if (detail) return { ok: true, detail, userAgent, browserVersion: browserVersion(), ms, source: 'detail_api' };
  if (noteFallback) return { ok: true, detail: noteFallback, userAgent, browserVersion: browserVersion(), ms, source: 'dom' };
  // 页面顶栏永远有"登录"两个字，只认真正的拦截话术。
  if (/验证码|滑块|安全验证|captcha|verify|请先登录|登录后查看|登录后继续/i.test(pageText)) {
    return {
      ok: false,
      kind: 'login_required',
      error: '抖音页面停在登录或验证上，作品数据没有返回；请在“平台登录”里重新登录抖音后再解析。',
      ms,
    };
  }
  return {
    ok: false,
    kind: 'site_changed',
    error: '抖音页面没有返回作品数据' + (originError ? '（' + originError + '）' : '') + '；可能是站点改版或网络被拦，稍后重试。',
    ms,
  };
}

module.exports = { resolveDouyinDetail, browserVersion };
