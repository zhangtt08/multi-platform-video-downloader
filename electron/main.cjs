const { app, BrowserWindow, clipboard, dialog, ipcMain, net, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./engine-core.cjs');
const guard = require('./local-guard.cjs');
const { startAgentApi, DEFAULT_API_PORT } = require('./agent-api.cjs');
const { resolveDouyinDetail } = require('./douyin-browser.cjs');

const LOGIN_SITES = core.LOGIN_SITES;
const SITE_IDS = core.SITE_IDS;

let mainWindow;
let enginesCache = null;
const loginWindows = {};

// ── 本机数据目录（全部在 userData，仓库里没有）─────────────────────────────
const DATA_DIR = () => path.join(app.getPath('userData'), 'qingying');
const TEMP_DIR = () => app.getPath('temp');

// ── 应用内接口的真实状态（监听成功与否、端口、令牌）─────────────────────────
// 界面与 /api/status 读的都是这一份：以前端口被占只是 console 里没有的一句话，
// 文档却写着"接口在 8392"，谁都不知道它其实没起来。
let apiState = {
  listening: false,
  host: '127.0.0.1',
  port: DEFAULT_API_PORT,
  url: '',
  error: '',
  token_required: true,
  token_header: guard.TOKEN_HEADER,
  token_source: '',
  token_file: '',
  started_at: '',
  cookie_values_never_returned: true,
};

function publicApiState() {
  return {
    ...apiState,
    // 令牌值本身永远不出去，只报它存在与否、来自哪里。
    token_file: apiState.token_file || core.dataPaths(DATA_DIR()).apiToken,
    download_roots: core.downloadRoots(core.readSettings(DATA_DIR())),
    data_dir: DATA_DIR(),
  };
}

function reportApiState(patch) {
  apiState = { ...apiState, ...patch };
  const snapshot = publicApiState();
  sendToMain('api:status', snapshot);
  try {
    // 独立 Agent 进程（8793）与命令行工具读这份文件，把"应用内接口到底起没起来"如实转出去。
    core.writeJsonFile(core.dataPaths(DATA_DIR()).apiStatus, { ...snapshot, written_at: new Date().toISOString() });
  } catch (error) {
    console.error('[qingying-agent-api] 状态落盘失败：' + (error && error.message ? error.message : String(error)));
  }
  return apiState;
}

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// 历史的每一次落盘都要播给界面：「记录」页原本只在启动时读一次盘，于是下载完成后
// 新记录看不到、被删的行和盘上的行对不上，用户只能重启程序才发现区别。
function emitHistory() {
  let items = [];
  try {
    items = core.readHistory(DATA_DIR());
  } catch {}
  sendToMain('history:changed', { items });
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(760, Math.min(1180, workArea.width - 32));
  const height = Math.max(600, Math.min(820, workArea.height - 32));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(760, width),
    minHeight: Math.min(600, height),
    center: true,
    show: false,
    title: '清影下载器',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'app-icon.png'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  for (const ev of ['maximize', 'unmaximize']) {
    mainWindow.on(ev, () => mainWindow?.webContents.send('window:maximized', ev === 'maximize'));
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── 引擎位置 ──────────────────────────────────────────────────────────────
function isEngineFile(dir, name) {
  if (!dir) return '';
  const file = path.join(dir, name + '.exe');
  try {
    return fs.statSync(file).isFile() ? file : '';
  } catch {
    return '';
  }
}

function engineOptions() {
  const overrides = {};
  const roots = [];
  // 用户在设置里指定的引擎目录（例如安装包里的 resources/bin）。
  const configured = core.readSettings(DATA_DIR()).enginesDir;
  if (app.isPackaged) {
    const bin = path.join(process.resourcesPath, 'bin');
    for (const name of ['yt-dlp', 'gallery-dl', 'ffmpeg']) {
      // 设置目录里有这个引擎时，它优先于自带副本。原来打包版永远先用自带的，
      // 于是"升级引擎"（应用内更新或自己换 exe）在打包版里根本不生效——
      // 站点改版后只能等作者重新出包。缺哪个就退回自带的哪个，不猜。
      overrides[name] = isEngineFile(configured, name) || path.join(bin, name + '.exe');
    }
  } else {
    if (configured) roots.push(configured);
    roots.push(path.join(app.getAppPath(), 'resources', 'bin'));
    roots.push(path.join(app.getAppPath(), 'resources'));
  }
  return { overrides, extraRoots: roots };
}

function ffmpegLocation() {
  const resolved = core.resolveEnginePath('ffmpeg', engineOptions());
  if (resolved) return resolved.path;
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg) return staticFfmpeg;
  } catch {}
  return 'ffmpeg';
}

let enginesProbedAt = 0;
async function probeEngines() {
  // 探测要 fork 3 个子进程（各自超时上限 15s）：渲染层 bootstrap 一定会调它，
  // 与启动时的探测撞在一起就是白 fork 一轮。60 秒内的结果直接复用——
  // 手动"重新探测"通常在升级完引擎几分钟后，不会被这层缓存挡住。
  if (enginesCache && Date.now() - enginesProbedAt < 60 * 1000) return enginesCache;
  enginesCache = await core.probeEngines(engineOptions());
  // 如实交代"设置里的引擎目录还在不在"——用户搬过安装包时，这是唯一能解释
  // 为什么 gallery-dl / ffmpeg 报未安装的原因。
  enginesCache.engines_dir = core.enginesDirStatus(core.readSettings(DATA_DIR()).enginesDir);
  enginesProbedAt = Date.now();
  return enginesCache;
}

// ── 引擎升级（只有界面按钮能触发，不开放给本机接口）────────────────────────
// 站点改版是常态：YouTube 从 2026-10 起对旧版 yt-dlp 的播放器客户端直接回 403
// ——链接解析得出来，媒体流取不到。与其让用户去学命令行，不如给一个检查更新的入口。
// 下载来的东西一律当不可信处理：只认官方仓库的 release 资产、只走 https、限 80 MB、
// 必须与 GitHub API 公布的 sha256 完全一致，校验通过才替换本机文件。
const ENGINE_SOURCES = {
  'yt-dlp': { repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp.exe' },
  'gallery-dl': { repo: 'mikf/gallery-dl', asset: 'gallery-dl.exe' },
};
const UPDATE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const UPDATE_MAX_BYTES = 80 * 1024 * 1024;

function enginesUpdateDir() {
  const dir = path.join(DATA_DIR(), 'engines');
  core.ensureDirSync(dir);
  return dir;
}

function allowlistedDownloadUrl(raw) {
  let parsed;
  try {
    parsed = new URL(core.safeText(raw, 2048));
  } catch {
    return '';
  }
  return parsed.protocol === 'https:' && UPDATE_HOSTS.has(parsed.hostname) ? parsed.toString() : '';
}

function normalizeVersion(value) {
  return core.safeText(value, 40).trim().replace(/^v/i, '');
}

async function fetchReleaseMeta(name) {
  const source = ENGINE_SOURCES[name];
  if (!source) return { ok: false, error: `${name} 没有登记官方发布源，不在应用内升级。` };
  let meta;
  try {
    const response = await net.fetch(`https://api.github.com/repos/${source.repo}/releases/latest`, {
      headers: { 'User-Agent': 'qingying-downloader', Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return { ok: false, error: `${source.repo} 的发布信息返回 ${response.status}，稍后再试。` };
    meta = await response.json();
  } catch (error) {
    return {
      ok: false,
      error: `取不到 ${source.repo} 的发布信息：${core.safeText(error && error.message, 200)}。本机走代理时请先确认代理可用。`,
    };
  }
  const asset = (Array.isArray(meta.assets) ? meta.assets : []).find((item) => item && item.name === source.asset);
  if (!asset) return { ok: false, error: `最新发布里没有 ${source.asset} 这个文件，不动本机引擎。` };
  const downloadUrl = allowlistedDownloadUrl(asset.browser_download_url);
  if (!downloadUrl) {
    return { ok: false, error: `下载地址不在允许的官方域名内，已拒绝：${core.safeText(asset.browser_download_url, 200)}` };
  }
  const rawDigest = core.safeText(asset.digest, 80).trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(rawDigest)) {
    return { ok: false, error: `官方发布没给出 ${source.asset} 的 sha256，无法校验，已拒绝下载。` };
  }
  return {
    ok: true,
    name,
    version: normalizeVersion(meta.tag_name),
    assetName: source.asset,
    downloadUrl,
    declaredBytes: Number(asset.size) || 0,
    sha256: rawDigest.slice(7).toLowerCase(),
  };
}

// 取回来先落 .download 临时名，校验通过才改名进位：坏文件不会顶替好引擎。
async function downloadVerifiedEngine(meta, destFile) {
  let response;
  try {
    response = await net.fetch(meta.downloadUrl, {
      headers: { 'User-Agent': 'qingying-downloader' },
      redirect: 'follow',
    });
  } catch (error) {
    return { ok: false, error: `下载 ${meta.assetName} 失败：${core.safeText(error && error.message, 200)}` };
  }
  if (!response.ok || !response.body) {
    return { ok: false, error: `下载 ${meta.assetName} 返回 ${response.status}，没有写入本机。` };
  }
  const tmpFile = `${destFile}.download`;
  const reader = response.body.getReader();
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = Buffer.from(value);
    total += piece.length;
    if (total > UPDATE_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {}
      fs.rmSync(tmpFile, { force: true });
      return { ok: false, error: `下载超过 ${Math.round(UPDATE_MAX_BYTES / 1024 / 1024)} MB 上限，已中止并删除临时文件。` };
    }
    hash.update(piece);
    chunks.push(piece);
  }
  const actual = hash.digest('hex');
  if (actual !== meta.sha256) {
    fs.rmSync(tmpFile, { force: true });
    return {
      ok: false,
      error: `sha256 校验不一致（期望 ${meta.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），已删除下载的文件，没有替换本机引擎。`,
    };
  }
  if (meta.declaredBytes && Math.abs(meta.declaredBytes - total) > 1024) {
    fs.rmSync(tmpFile, { force: true });
    return { ok: false, error: `下载字节数与官方声明不符（${total} / ${meta.declaredBytes}），已删除。` };
  }
  await fs.promises.writeFile(tmpFile, Buffer.concat(chunks));
  return { ok: true, tmpFile, bytes: total };
}

function placeEngineFile(tmpFile, destFile) {
  // Windows 不允许覆盖正在运行的 exe，所以先删再改名；删不掉就是引擎正被占用。
  try {
    fs.rmSync(destFile, { force: true });
  } catch (error) {
    const code = core.safeText(error && error.code, 40);
    fs.rmSync(tmpFile, { force: true });
    return {
      ok: false,
      error: `本机 ${path.basename(destFile)} 正在被使用（${code || 'EPERM'}），替换失败。请先停掉正在下载的任务再更新引擎。`,
    };
  }
  try {
    fs.renameSync(tmpFile, destFile);
  } catch (error) {
    fs.rmSync(tmpFile, { force: true });
    return { ok: false, error: `写入 ${path.basename(destFile)} 失败：${core.safeText(error && error.message, 200)}` };
  }
  return { ok: true };
}

async function updateOneEngine(name, installedVersion) {
  const meta = await fetchReleaseMeta(name);
  if (!meta.ok) return meta;
  const destFile = path.join(enginesUpdateDir(), meta.assetName);
  if (installedVersion && normalizeVersion(installedVersion) === meta.version) {
    return { ok: true, name, version: meta.version, unchanged: true, path: destFile };
  }
  const downloaded = await downloadVerifiedEngine(meta, destFile);
  if (!downloaded.ok) return { ...downloaded, name };
  const placed = placeEngineFile(downloaded.tmpFile, destFile);
  if (!placed.ok) return { ...placed, name };
  return { ok: true, name, version: meta.version, from: installedVersion || '', bytes: downloaded.bytes, path: destFile };
}

ipcMain.handle('engines:check-update', async () => {
  const current = enginesCache || (await probeEngines());
  const records = { 'yt-dlp': current.yt_dlp, 'gallery-dl': current.gallery_dl };
  const items = [];
  for (const name of Object.keys(ENGINE_SOURCES)) {
    const meta = await fetchReleaseMeta(name);
    const installed = records[name] || {};
    if (!meta.ok) {
      items.push({ name, installed: installed.version || '', latest: '', needs_update: false, error: meta.error });
      continue;
    }
    items.push({
      name,
      installed: installed.version || '',
      latest: meta.version,
      needs_update: normalizeVersion(installed.version) !== meta.version,
      asset_bytes: meta.declaredBytes,
      error: '',
    });
  }
  return { ok: true, items };
});

ipcMain.handle('engines:update', async () => {
  const current = enginesCache || (await probeEngines());
  const records = { 'yt-dlp': current.yt_dlp, 'gallery-dl': current.gallery_dl };
  const results = [];
  for (const name of Object.keys(ENGINE_SOURCES)) {
    results.push(await updateOneEngine(name, (records[name] || {}).version));
  }
  const installedSomething = results.some((item) => item.ok && !item.unchanged);
  if (results.some((item) => item.ok)) {
    // 升级目录一旦有可用的引擎，就把它指成设置里的引擎目录：
    // 上面 engineOptions 的优先级修好了，打包版才会真的用这份新的而不是自带的旧副本。
    core.writeSettings(DATA_DIR(), { enginesDir: enginesUpdateDir() });
  }
  if (installedSomething) {
    enginesProbedAt = 0;
    enginesCache = null;
  }
  const refreshed = await probeEngines();
  return { ok: !results.some((item) => !item.ok), results, engines: refreshed };
});

// ── 登录态：Cookie 只在进程内出现，落盘的只有状态摘要 ───────────────────────
async function siteCookies(site) {
  try {
    return await session.fromPartition(site.partition).cookies.get({});
  } catch {
    return [];
  }
}

async function cookieFileForSite(site) {
  if (!site) return '';
  return core.writeTempCookieFile(site, await siteCookies(site), TEMP_DIR());
}

function releaseCookieFile(file) {
  return core.removeCookieFile(file, TEMP_DIR());
}

// 抖音的作品数据只能从登录会话里的网页拿（详见 douyin-browser.cjs）。
function browserResolve(url) {
  return resolveDouyinDetail({ url, partition: LOGIN_SITES.douyin.partition });
}

function writeInfoJsonFile(detail, url, userAgent) {
  const dir = core.ensureDirSync(path.join(DATA_DIR(), 'cache'));
  const file = path.join(dir, 'douyin-info-' + process.pid + '-' + Date.now() + '.json');
  const info = core.buildDouyinInfoJson(detail, url, userAgent || '');
  fs.writeFileSync(file, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
  return file;
}

function removeInfoJsonFile(file) {
  if (!file) return;
  if (!path.basename(file).startsWith('douyin-info-')) return;
  try { fs.rmSync(file, { force: true }); } catch {}
}

async function collectAuthSnapshot() {
  const sites = {};
  for (const siteId of SITE_IDS) {
    const site = LOGIN_SITES[siteId];
    const summary = core.summarizeLoginCookies(site, await siteCookies(site));
    // 分区目录存在 = 这个站点在这个应用里开过登录窗口（没有分区就是从没碰过）。
    let hasPartition = false;
    try {
      hasPartition = fs.existsSync(path.join(app.getPath('userData'), 'Partitions', site.partition.replace('persist:', '')));
    } catch {}
    sites[siteId] = {
      logged_in: summary.loggedIn,
      matched_cookie_names: summary.matchedCookieNames,
      cookie_count: summary.cookieCount,
      expired_detected: summary.expiredDetected,
      expires_at: summary.earliestExpiry,
      label: site.label,
      login_required: site.loginRequired,
      home_url: site.homeUrl,
      has_partition: hasPartition,
      exported: Boolean(core.exportedCookieFile(DATA_DIR(), siteId)),
      checked_at: new Date().toISOString(),
    };
  }
  const snapshot = {
    sites,
    updated_at: new Date().toISOString(),
    source: 'electron_session',
    storage: {
      data_dir: DATA_DIR(),
      session_dir: path.join(app.getPath('userData'), 'Partitions'),
      session_dir_note: '每个站点一个独立的浏览器分区（persist:qy…），由当前 Windows 账户的目录权限隔离，不与其他程序共用。',
      cookie_dir: core.dataPaths(DATA_DIR()).cookieDir,
      cookie_dir_note: '只有点了"导出给命令行"才会写出 Netscape 文件；写出时按 0600 请求，落在当前用户目录下，随时可撤销（撤销即删除该文件）。',
      exported: SITE_IDS.filter((id) => Boolean(core.exportedCookieFile(DATA_DIR(), id))),
      cookie_values_stored: false,
    },
    privacy: '这里只输出状态、Cookie 名称与过期时间；任何界面、日志、接口返回都不包含 Cookie 值。',
  };
  core.writeAuthState(DATA_DIR(), snapshot);
  return snapshot;
}

// ── 解析 ──────────────────────────────────────────────────────────────────
async function analyzeMedia(payload) {
  const url = safeUrl(payload?.url);
  if (!url) return { ok: false, error: '请输入有效的 http/https 网址。', kind: 'bad_url' };
  const engines = enginesCache || (await probeEngines());
  const settings = core.readSettings(DATA_DIR());
  // cookieProvider 交出去的临时文件由调用方负责删除（core 不猜测文件生命周期）。
  const createdCookies = [];
  let result;
  try {
    result = await core.analyzeUrl({
      url,
      engines,
      proxy: settings.proxy,
      preference: core.safeText(payload?.engine_preference, 20) || settings.enginePreference,
      cookieProvider: async (site) => {
        const file = await cookieFileForSite(site);
        if (file) createdCookies.push(file);
        return file;
      },
      browserProvider: browserResolve,
      fetchThumbnail: (target, init) => net.fetch(target, init),
    });
  } finally {
    for (const file of createdCookies) releaseCookieFile(file);
  }
  if (result.ok) emitEngines();
  return result;
}

function safeUrl(value) {
  const text = core.safeText(value, 4096).trim();
  return core.isHttpUrl(text) ? core.normalizeMediaUrl(text) : '';
}

// ── 下载队列 ──────────────────────────────────────────────────────────────
// 状态机：queued -> downloading -> (done | failed | cancelled | paused)
// retrying 是 downloading 的延迟重排，不算独立状态但会显示次数。
// 暂停 = 终止引擎进程并保留 .part 分片；继续 = 用同一批参数重跑，yt-dlp 的
// --continue 会接着已下载的分片走，不是从头再来。
const tasks = new Map();
const taskOrder = [];
let runningCount = 0;
let taskSeq = 0;

const NON_RETRYABLE = new Set(['login_required', 'engine_missing', 'bad_url', 'needs_login']);

function makeTask(input) {
  taskSeq += 1;
  const settings = core.readSettings(DATA_DIR());
  const id = 'q' + Date.now().toString(36) + '-' + taskSeq;
  const task = {
    id,
    url: safeUrl(input.url),
    title: core.safeText(input.title, 300) || '未命名内容',
    mode: core.DOWNLOAD_MODES.includes(input.mode) ? input.mode : 'combined',
    videoId: core.safeText(input.videoId, 80),
    videoExt: core.safeExt(input.videoExt),
    videoHasAudio: input.videoHasAudio === true,
    audioId: core.safeText(input.audioId, 80),
    audioExt: core.safeExt(input.audioExt),
    audioFormat: core.AUDIO_FORMATS.includes(input.audioFormat) ? input.audioFormat : settings.audioFormat,
    images: Array.isArray(input.images) ? input.images.slice(0, 500) : [],
    engine: ['yt-dlp', 'gallery-dl', 'browser'].includes(input.engine) ? input.engine : '',
    site: LOGIN_SITES[input.site] ? input.site : '',
    outputDir: core.safeText(input.outputDir, 1024).trim() || settings.outputDir,
    status: 'queued',
    progress: { percent: '', speed: '', eta: '' },
    attempts: 0,
    max_attempts: 1 + core.clampInt(settings.autoRetry, 0, 5, 2),
    error: '',
    kind: '',
    remedies: [],
    files: [],
    bytes: 0,
    log: '',
    used_engine: '',
    created_at: new Date().toISOString(),
    started_at: '',
    finished_at: '',
    runner: null,
    timer: null,
  };
  tasks.set(id, task);
  taskOrder.push(id);
  while (taskOrder.length > 200) {
    const drop = taskOrder.shift();
    if (drop !== id) tasks.delete(drop);
  }
  return task;
}

function taskView(task) {
  return {
    id: task.id,
    url: task.url,
    title: task.title,
    mode: task.mode,
    engine: task.engine || '自动',
    used_engine: task.used_engine,
    site: task.site,
    status: task.status,
    progress: task.progress,
    attempts: task.attempts,
    max_attempts: task.max_attempts,
    error: task.error,
    kind: task.kind,
    remedies: task.remedies,
    file_count: task.files.length,
    files: task.files.slice(0, 12).map((file) => ({
      path: core.safeText(file.path, 1024),
      bytes: Number(file.bytes) || 0,
      size: core.formatBytes(Number(file.bytes)) || '',
    })),
    bytes: task.bytes,
    size_text: core.formatBytes(task.bytes) || '',
    output_dir: task.outputDir,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    retrying: Boolean(task.timer),
    log_tail: core.safeText(task.log, 400),
  };
}

function queueSnapshot() {
  return {
    tasks: taskOrder.map((id) => tasks.get(id)).filter(Boolean).map(taskView),
    running: runningCount,
    limit: core.readSettings(DATA_DIR()).concurrency,
    settings: publicSettings(),
    engines: enginesCache,
    api: publicApiState(),
  };
}

let emitTimer = null;
function emitQueue(immediate = false) {
  const send = () => {
    emitTimer = null;
    sendToMain('queue:changed', queueSnapshot());
  };
  if (immediate) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    send();
    return;
  }
  if (emitTimer) return;
  emitTimer = setTimeout(send, 160);
}

function emitEngines() {
  sendToMain('engines:changed', enginesCache);
}

function publicSettings() {
  const settings = core.readSettings(DATA_DIR());
  return {
    ...settings,
    cookie_export_available: SITE_IDS.filter((id) => core.exportedCookieFile(DATA_DIR(), id)).length,
    data_dir: DATA_DIR(),
  };
}

function pumpQueue() {
  const limit = core.readSettings(DATA_DIR()).concurrency;
  while (runningCount < limit) {
    // 正在等自动重试倒计时的任务不算"可以马上开跑"，否则退避形同没有（站点限流时
    // 立刻重打等于自己把自己锤死）。
    const next = taskOrder
      .map((id) => tasks.get(id))
      .find((task) => task && task.status === 'queued' && !task.timer);
    if (!next) break;
    void runTask(next);
  }
  emitQueue();
}

function validateTaskTarget(task) {
  if (!task.url) return '网址无效。';
  if (!core.isHttpUrl(task.url)) return '网址无效。';
  const site = task.site ? LOGIN_SITES[task.site] : null;
  if (site && !core.isSiteUrl(task.url, site)) return '网址与所选站点不匹配。';
  let dirReady = false;
  try {
    dirReady = path.isAbsolute(task.outputDir) && fs.statSync(task.outputDir).isDirectory();
  } catch {
    dirReady = false;
  }
  if (!dirReady) {
    // 目录常常是"保存位置"下面一个还没建出来的子文件夹（或用户手动删过它）。
    // 原来直接判失败，报"请选择有效的下载目录"——用户看着目录框里的路径完全没错，
    // 却每条任务都失败，这就是"下载都不行了"最难自查的那一种。
    // 建目录仍走下载根判定：根外的路径照样拒绝，不会因为它就把任务写到别处。
    const created = core.resolveContainedOutputDir(
      task.outputDir,
      core.downloadRoots(core.readSettings(DATA_DIR())),
      { create: true },
    );
    if (!created.ok) return created.error || '请选择有效的下载目录。';
    task.outputDir = created.resolved || created.real || task.outputDir;
  }
  if (task.mode !== 'images' && task.mode !== 'audio' && !task.videoId) return '请选择视频画质。';
  if (task.mode === 'audio' && !task.audioId) return '请选择音频轨道。';
  if (task.mode === 'combined' && !task.videoHasAudio && !task.audioId) return '请选择用于合并的音频轨道。';
  return '';
}

async function runTask(task) {
  if (task.status !== 'queued') return;
  const problem = validateTaskTarget(task);
  if (problem) {
    task.status = 'failed';
    task.error = problem;
    task.kind = 'bad_input';
    task.finished_at = new Date().toISOString();
    recordHistory(task);
    emitQueue(true);
    return;
  }

  runningCount += 1;
  task.attempts += 1;
  task.status = 'downloading';
  task.error = '';
  task.kind = '';
  task.started_at = new Date().toISOString();
  emitQueue(true);

  const site = task.site ? LOGIN_SITES[task.site] : null;
  const cookieFile = await cookieFileForSite(site);
  const settings = core.readSettings(DATA_DIR());
  const engines = enginesCache || (await probeEngines());
  const opts = engineOptions();
  const hooks = {
    onChild: (state) => {
      task.runner = state;
    },
    onProgress: (payload) => {
      task.progress = {
        percent: core.safeText(payload.percent, 20).trim(),
        speed: core.safeText(payload.speed, 30).trim(),
        eta: core.safeText(payload.eta, 30).trim(),
      };
      emitQueue();
    },
    onLog: (line) => {
      task.log = core.appendTail(task.log, line + '\n', 4000);
    },
  };

  const commonSpec = {
    url: task.url,
    outputDir: task.outputDir,
    site,
    cookieFile,
    engineOptions: opts,
    ffmpegLocation: ffmpegLocation(),
    filenameTemplate: settings.filenameTemplate,
    subfolderByPost: settings.subfolderByPost,
    retries: 20,
    concurrentFragments: 3,
    proxy: settings.proxy,
    embedMetadata: settings.embedMetadata,
    writeSubtitles: settings.writeSubtitles,
  };

  let result;
  try {
    if (task.mode === 'images') {
      const wantGallery = (task.engine === 'gallery-dl' || settings.enginePreference === 'gallery-dl')
        && engines.gallery_dl?.available;
      if (wantGallery) {
        // engineOptions 必须传下去：gallery-dl 常常只在"引擎目录"（安装包 resources/bin）里，
        // 不在 PATH 上；漏了它就会出现"解析得到、下载却说没装"的自相矛盾。
        result = await core.runGalleryDlDownload({
          url: task.url,
          outputDir: task.outputDir,
          site,
          cookieFile,
          engineOptions: opts,
        }, hooks);
      } else {
        const cookieHeader = site ? core.buildCookieHeader(site, await siteCookies(site), task.url) : '';
        result = await core.runImageListDownload({
          url: task.url,
          outputDir: task.outputDir,
          images: task.images,
          title: task.title,
          subfolder: settings.subfolderByPost,
          cookieHeader,
          refererOrigin: safeOrigin(task.url),
        }, hooks);
      }
    } else {
      if (!engines.yt_dlp?.available) {
        result = { ok: false, kind: 'engine_missing', error: '本机找不到 yt-dlp，无法下载视频或音频。', files: [], bytes: 0 };
      } else if (task.videoId.startsWith('dj-')) {
        // 抖音画质对应的是网页现签的直链，放一会儿就会过期；下载前重新解析一次，
        // 再把新鲜直链交给 yt-dlp（--load-info-json），进度/续传/重试都走原路。
        task.progress = { percent: '', speed: '', eta: '正在用应用内浏览器取直链…' };
        emitQueue();
        const resolved = await browserResolve(task.url);
        if (!resolved.ok) {
          result = { ok: false, kind: resolved.kind || 'browser_failed', error: resolved.error, files: [], bytes: 0 };
        } else {
          const infoFile = writeInfoJsonFile(resolved.detail, task.url, resolved.userAgent);
          try {
            task.log = core.appendTail(task.log, '抖音直链已重新签名，走 --load-info-json 下载\n', 4000);
            result = await core.runEngineDownload({
              ...commonSpec,
              mode: task.mode,
              videoId: task.videoId,
              videoExt: task.videoExt,
              videoHasAudio: task.videoHasAudio,
              audioId: task.audioId,
              audioExt: task.audioExt,
              audioFormat: task.audioFormat,
              infoJsonPath: infoFile,
            }, hooks);
          } finally {
            removeInfoJsonFile(infoFile);
          }
        }
      } else {
        result = await core.runEngineDownload({
          ...commonSpec,
          mode: task.mode,
          videoId: task.videoId,
          videoExt: task.videoExt,
          videoHasAudio: task.videoHasAudio,
          audioId: task.audioId,
          audioExt: task.audioExt,
          audioFormat: task.audioFormat,
        }, hooks);
      }
    }
  } catch (error) {
    result = { ok: false, error: core.safeText(error?.message, 600), files: [], bytes: 0 };
  } finally {
    releaseCookieFile(cookieFile);
    runningCount = Math.max(0, runningCount - 1);
    task.runner = null;
  }

  task.files = result.files || [];
  task.bytes = Number(result.bytes) || 0;
  task.used_engine = result.engine || (task.mode === 'images' ? '内置取图器' : 'yt-dlp');

  if (result.ok) {
    task.status = 'done';
    // 引擎退出码 0 但什么都没落盘（最常见：同名文件已在、引擎直接跳过）。
    // 报"完成 0 B"等于说假话，这里把原因摆在进度行上。
    task.progress = task.files.length
      ? { percent: '100%', speed: '', eta: '' }
      : { percent: '', speed: '', eta: '没有新增文件：同名文件可能已存在，换个画质或清空该目录后再试' };
    if (!task.files.length) task.log = core.appendTail(task.log, '引擎没有新增文件（同名文件已存在时会直接跳过）\n', 4000);
    task.finished_at = new Date().toISOString();
    recordHistory(task);
    emitQueue(true);
    pumpQueue();
    return;
  }

  if (result.cancelled) {
    task.status = result.paused ? 'paused' : 'cancelled';
    if (task.status === 'paused') task.progress = { percent: task.progress.percent, speed: '', eta: '已暂停，分片保留在原目录' };
    task.finished_at = new Date().toISOString();
    recordHistory(task);
    emitQueue(true);
    pumpQueue();
    return;
  }

  task.error = result.error || '下载失败。';
  task.kind = result.kind || 'unknown';
  task.remedies = result.remedies || [];
  const retriable = !NON_RETRYABLE.has(task.kind) && task.attempts < task.max_attempts;
  if (retriable) {
    const delayMs = 2000 * task.attempts;
    task.status = 'queued';
    task.progress = { percent: task.progress.percent, speed: '', eta: `${delayMs / 1000} 秒后自动重试（第 ${task.attempts + 1}/${task.max_attempts} 次）` };
    task.timer = setTimeout(() => {
      task.timer = null;
      pumpQueue();
    }, delayMs);
    emitQueue(true);
    pumpQueue();
    return;
  }

  task.status = 'failed';
  task.finished_at = new Date().toISOString();
  recordHistory(task);
  emitQueue(true);
  pumpQueue();
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function recordHistory(task) {
  // 用户已经点"删除记录"的任务不要再从后台写回历史 —— 那是替用户做决定。
  if (task.removed) return;
  try {
    core.appendHistory(DATA_DIR(), {
      id: task.id,
      url: task.url,
      title: task.title,
      engine: task.used_engine || task.engine,
      mode: task.mode,
      site: task.site,
      status: task.status,
      outputDir: task.outputDir,
      files: task.files,
      bytes: task.bytes,
      error: task.error,
      attempts: task.attempts,
      finished_at: task.finished_at,
    });
    emitHistory();
  } catch {}
}

function stopTask(task, { pause }) {
  if (!task) return false;
  if (task.timer) {
    clearTimeout(task.timer);
    task.timer = null;
  }
  if (task.status === 'queued') {
    task.status = pause ? 'paused' : 'cancelled';
    task.finished_at = new Date().toISOString();
    emitQueue(true);
    pumpQueue();
    return true;
  }
  if (task.status !== 'downloading') return false;
  if (task.runner) {
    task.runner.cancelled = true;
    task.runner.paused = Boolean(pause);
    core.terminateProcessTree(task.runner.child);
  }
  return true;
}

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  data_dir: DATA_DIR(),
  packaged: app.isPackaged,
  // 命名模板的允许字段：界面提示与校验共用同一份白名单。
  template_fields: core.TEMPLATE_FIELDS,
  default_template: core.DEFAULT_FILENAME_TEMPLATE,
}));

ipcMain.handle('clipboard:read', () => core.safeText(clipboard.readText(), 4096));

ipcMain.handle('clipboard:write', (_event, payload) => {
  clipboard.writeText(core.safeText(payload?.text, 64 * 1024));
  return true;
});

ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载目录',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('folder:open', async (_event, payload) => {
  const folder = core.safeText(payload?.folder, 1024);
  try {
    if (!folder || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) return false;
  } catch {
    return false;
  }
  return (await shell.openPath(folder)) === '';
});

ipcMain.handle('file:reveal', async (_event, payload) => {
  const file = core.safeText(payload?.file, 1024);
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) return false;
  shell.showItemInFolder(file);
  return true;
});

ipcMain.handle('external:open', (_event, payload) => {
  const target = core.safeText(payload?.url, 2048).trim();
  if (!core.isHttpUrl(target)) return false;
  void shell.openExternal(target);
  return true;
});

ipcMain.handle('engines:probe', async () => {
  await probeEngines();
  emitEngines();
  return enginesCache;
});

// 站点表只有一份：界面从这里读，不再自己抄一遍域名（抄第二遍就会和这里分叉）。
ipcMain.handle('sites:list', () => core.siteCatalog());

// 下载目录里残留的未完成分片（取消/崩溃留下的 .part / .ytdl / .temp）。
ipcMain.handle('temp:scan', (_event, payload) => {
  const folder = core.safeText(payload?.folder, 1024).trim() || core.readSettings(DATA_DIR()).outputDir;
  const scan = core.scanEngineTempFiles(folder);
  return { ...scan, files: scan.files.slice(0, 30), size_text: core.formatBytes(scan.bytes) || '0 B' };
});

ipcMain.handle('temp:clean', (_event, payload) => {
  const folder = core.safeText(payload?.folder, 1024).trim() || core.readSettings(DATA_DIR()).outputDir;
  const result = core.removeEngineTempFiles(folder);
  emitQueue(true);
  return {
    removed: result.count,
    bytes: result.bytes,
    size_text: core.formatBytes(result.bytes) || '0 B',
    failed: result.failed.slice(0, 5),
    error: result.error || '',
  };
});

// 把"引擎目录"指到 yt-dlp / gallery-dl / ffmpeg 所在的文件夹（安装包 resources/bin）。
ipcMain.handle('engines:choose-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择引擎所在目录',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  core.writeSettings(DATA_DIR(), { enginesDir: result.filePaths[0] });
  await probeEngines();
  emitEngines();
  emitQueue(true);
  return { dir: result.filePaths[0], engines: enginesCache };
});

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', async (_event, payload) => {
  const patch = payload && typeof payload === 'object' ? payload : {};
  const allowed = {};
  if (typeof patch.outputDir === 'string') allowed.outputDir = core.safeText(patch.outputDir, 1024);
  if (typeof patch.filenameTemplate === 'string') allowed.filenameTemplate = core.safeText(patch.filenameTemplate, 200);
  if (typeof patch.subfolderByPost === 'boolean') allowed.subfolderByPost = patch.subfolderByPost;
  if (patch.concurrency !== undefined) allowed.concurrency = patch.concurrency;
  if (patch.autoRetry !== undefined) allowed.autoRetry = patch.autoRetry;
  if (typeof patch.enginePreference === 'string') allowed.enginePreference = patch.enginePreference;
  if (typeof patch.audioFormat === 'string') allowed.audioFormat = patch.audioFormat;
  if (typeof patch.exportCookiesForCli === 'boolean') allowed.exportCookiesForCli = patch.exportCookiesForCli;
  if (typeof patch.enginesDir === 'string') allowed.enginesDir = core.safeText(patch.enginesDir, 1024);
  const saved = core.writeSettings(DATA_DIR(), allowed);
  if ('enginesDir' in allowed) {
    await probeEngines();
    emitEngines();
  }
  const merged = publicSettings();
  if (saved.filename_template_error) {
    return { ok: false, error: saved.filename_template_error, settings: merged };
  }
  emitQueue(true);
  return { ok: true, settings: merged };
});

ipcMain.handle('template:preview', (_event, payload) => {
  const template = core.safeText(payload?.template, 200);
  const check = core.validateFilenameTemplate(template);
  if (!check.ok) return { ok: false, error: check.error };
  const sample = payload?.sample && typeof payload.sample === 'object' ? payload.sample : {};
  return { ok: true, preview: core.previewFilename(template, { title: '示例标题', id: 'BV1xx4y1A', ext: 'mp4', ...sample }) };
});

ipcMain.handle('history:list', () => ({ items: core.readHistory(DATA_DIR()) }));
ipcMain.handle('history:remove', (_event, payload) => {
  const removed = core.removeHistoryItem(DATA_DIR(), core.safeText(payload?.id, 40));
  if (removed) emitHistory();
  return removed;
});
ipcMain.handle('history:clear', () => {
  core.clearHistory(DATA_DIR());
  emitHistory();
  return { items: [] };
});

ipcMain.handle('media:analyze', (_event, payload) => analyzeMedia(payload));

ipcMain.handle('queue:submit', (_event, payload) => {
  const items = Array.isArray(payload?.items) ? payload.items.slice(0, 50) : [payload || {}];
  const created = [];
  for (const item of items) {
    const task = makeTask(item);
    created.push(taskView(task));
  }
  pumpQueue();
  return { ok: true, tasks: created };
});

ipcMain.handle('queue:pause', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  return stopTask(task, { pause: true });
});

ipcMain.handle('queue:resume', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  if (!task || (task.status !== 'paused' && task.status !== 'cancelled' && task.status !== 'failed')) return false;
  task.status = 'queued';
  task.error = '';
  task.kind = '';
  task.remedies = [];
  task.progress = { percent: '', speed: '', eta: '' };
  pumpQueue();
  return true;
});

ipcMain.handle('queue:retry', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) return false;
  task.status = 'queued';
  task.attempts = 0;
  task.error = '';
  task.kind = '';
  task.remedies = [];
  task.log = '';
  task.progress = { percent: '', speed: '', eta: '重新排队：引擎会带着 --continue 接着已下载的分片走' };
  pumpQueue();
  return true;
});

ipcMain.handle('queue:cancel', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  return stopTask(task, { pause: false });
});

ipcMain.handle('queue:remove', (_event, payload) => {
  const id = core.safeText(payload?.id, 40);
  const task = tasks.get(id);
  if (!task) return false;
  task.removed = true;
  if (task.status === 'downloading') stopTask(task, { pause: false });
  if (task.timer) clearTimeout(task.timer);
  tasks.delete(id);
  const index = taskOrder.indexOf(id);
  if (index >= 0) taskOrder.splice(index, 1);
  emitQueue(true);
  return true;
});

ipcMain.handle('queue:clear-finished', () => {
  // failed 也算"已结束"：一键清除原来只收 done/cancelled，失败的行删不掉，
  // 只能一条条留在列表里（用户说的"没有删除功能"多半就落在这里）。
  const finished = taskOrder.filter((id) => ['done', 'cancelled', 'failed'].includes(tasks.get(id)?.status));
  for (const id of finished) {
    tasks.delete(id);
    const index = taskOrder.indexOf(id);
    if (index >= 0) taskOrder.splice(index, 1);
  }
  emitQueue(true);
  return { removed: finished.length };
});

ipcMain.handle('queue:list', () => queueSnapshot());

// 接口的真实状态：界面用它显示"本机接口在不在"，端口被占时不再是一片安静。
ipcMain.handle('api:status', () => publicApiState());

// ── 登录窗口与登录态开关 ──────────────────────────────────────────────────
function openLogin(site) {
  const existing = loginWindows[site.id];
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const loginWindow = new BrowserWindow({
    parent: mainWindow,
    width: 1050,
    height: 760,
    title: site.title,
    autoHideMenuBar: true,
    webPreferences: {
      partition: site.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  loginWindows[site.id] = loginWindow;

  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (core.isSiteUrl(targetUrl, site)) return;
    event.preventDefault();
  });
  // 站点登录成功常表现为 session cookie 出现；这里不轮询页面，只在窗口关闭时确认一次。
  loginWindow.loadURL(site.homeUrl);
  loginWindow.on('closed', async () => {
    delete loginWindows[site.id];
    await refreshSiteStatus(site.id);
  });
}

async function refreshSiteStatus(siteId) {
  const site = LOGIN_SITES[siteId];
  if (!site) return null;
  const snapshot = await collectAuthSnapshot();
  sendToMain('auth:changed', snapshot);
  return snapshot.sites[siteId] || null;
}

ipcMain.handle('auth:status', async () => collectAuthSnapshot());

ipcMain.handle('auth:login', (_event, payload) => {
  const site = LOGIN_SITES[core.safeText(payload?.site, 24)];
  if (!site) return { ok: false, error: '未知站点。' };
  openLogin(site);
  return { ok: true, title: site.title };
});

ipcMain.handle('auth:logout', async (_event, payload) => {
  const siteId = core.safeText(payload?.site, 24);
  const site = LOGIN_SITES[siteId];
  if (!site) return { ok: false, error: '未知站点。' };
  try {
    const cookies = await siteCookies(site);
    await Promise.all(cookies.filter((c) => core.isSiteCookie(c, site)).map((cookie) => {
      const scheme = cookie.secure ? 'https://' : 'http://';
      const domain = String(cookie.domain || '').replace(/^\./, '');
      return session.fromPartition(site.partition).cookies.remove(
        scheme + domain,
        cookie.name,
      ).catch(() => {});
    }));
  } catch {}
  core.removeExportedCookies(DATA_DIR(), siteId);
  const snapshot = await collectAuthSnapshot();
  sendToMain('auth:changed', snapshot);
  return { ok: true, snapshot };
});

// 导出登录态给命令行用（agent 走这条路读同一份会话）。开关只影响导出文件。
ipcMain.handle('auth:export', async (_event, payload) => {
  const siteId = core.safeText(payload?.site, 24);
  const site = LOGIN_SITES[siteId];
  if (!site) return { ok: false, error: '未知站点。' };
  const enabled = payload?.enabled === true;
  if (!enabled) {
    core.removeExportedCookies(DATA_DIR(), siteId);
    const snapshot = await collectAuthSnapshot();
    sendToMain('auth:changed', snapshot);
    return { ok: true, exported: false };
  }
  const result = core.exportSiteCookies(DATA_DIR(), site, await siteCookies(site));
  if (!result.ok) return result;
  const snapshot = await collectAuthSnapshot();
  sendToMain('auth:changed', snapshot);
  return { ok: true, exported: true, path: result.path, cookie_count: result.cookie_count };
});

// ── 供应用内 HTTP 接口（127.0.0.1:8392）复用：提交队列并等它跑完 ────────────
const FINISHED_STATUSES = new Set(['done', 'failed', 'cancelled', 'paused']);

// 接口传来的 outputDir 只能落在用户指定的下载根目录之内（设置「保存位置」+ allowedOutputRoots）。
// 判据只有一份：engine-core 的 resolveContainedOutputDir；界面自己选目录不受影响，
// 因为人在界面里选目录这个动作本身就是"指定下载根目录"。
function resolveDownloadOutputDir(candidate) {
  const settings = core.readSettings(DATA_DIR());
  const roots = core.downloadRoots(settings);
  const result = core.resolveContainedOutputDir(candidate, roots);
  return { ...result, roots };
}

function downloadThroughQueue(payload) {
  const task = makeTask(payload || {});
  pumpQueue();
  return new Promise((resolve) => {
    // 只在这个任务真的有变化时才广播快照：等重试倒计时/长时间无进展时，
    // 之前每 400ms 都全量序列化整个队列推一遍，纯空转。
    let lastSignature = '';
    const poll = setInterval(() => {
      const signature = JSON.stringify(taskView(task));
      if (signature !== lastSignature) {
        lastSignature = signature;
        emitQueue();
      }
      if (!FINISHED_STATUSES.has(task.status)) return;
      clearInterval(poll);
      resolve({
        ok: task.status === 'done',
        cancelled: task.status === 'cancelled' || task.status === 'paused',
        error: task.error,
        task_id: task.id,
        data: { files: task.files, bytes: task.bytes, engine: task.used_engine },
      });
    }, 400);
    poll.unref?.();
  });
}

// ── 窗口控制（自绘标题栏）───────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.isMaximized()));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.qingying.downloader');
    core.ensureDirSync(DATA_DIR());
    // 默认下载目录在首帧前就落盘，避免第一次打开时目录框是空的。
    try {
      if (!core.readSettings(DATA_DIR()).outputDir) {
        core.writeSettings(DATA_DIR(), { outputDir: app.getPath('downloads') });
      }
    } catch (error) {
      console.error('[qingying] 默认下载目录写入失败：' + (error && error.message ? error.message : String(error)));
    }
    createWindow();
    await probeEngines();
    const snapshot = await collectAuthSnapshot();
    sendToMain('auth:changed', snapshot);
    emitEngines();
    // 应用内接口的启动结果必须如实交出去：端口被占时以前是 on('error',()=>{}) + 空 catch，
    // 表现是"文档说接口在 8392，实际什么都没有"，界面与接口都不报错。
    const apiPort = Number(process.env.QINGYING_API_PORT) || DEFAULT_API_PORT;
    const tokenInfo = guard.resolveApiToken({ tokenFile: core.dataPaths(DATA_DIR()).apiToken });
    reportApiState({
      port: apiPort,
      token_required: true,
      token_source: tokenInfo.source,
      token_file: tokenInfo.file || core.dataPaths(DATA_DIR()).apiToken,
      started_at: new Date().toISOString(),
      error: tokenInfo.error || '',
    });
    const outcome = await startAgentApi({
      port: apiPort,
      host: '127.0.0.1',
      token: tokenInfo.token,
      tokenFile: tokenInfo.file || core.dataPaths(DATA_DIR()).apiToken,
      version: app.getVersion(),
      analyzeMedia,
      downloadMedia: downloadThroughQueue,
      queueSnapshot,
      resolveOutputDir: resolveDownloadOutputDir,
      statusSnapshot: publicApiState,
    });
    if (outcome.ok) {
      reportApiState({ listening: true, host: outcome.host, port: outcome.port, url: outcome.url, error: '' });
      console.log('[qingying-agent-api] listening on ' + outcome.url + '（非 GET 需本机令牌）');
    } else {
      reportApiState({ listening: false, host: outcome.host, port: apiPort, url: '', error: outcome.error });
      console.error('[qingying-agent-api] ' + outcome.error);
    }
  });
}

app.on('before-quit', () => {
  for (const id of taskOrder) {
    const task = tasks.get(id);
    if (task && task.status === 'downloading') stopTask(task, { pause: false });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
