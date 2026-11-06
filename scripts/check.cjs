'use strict';
// 项目自检（npm run check）：语法、界面接线、Agent 契约、引擎核心行为。
// 不联网、不写用户数据，可在任何机器上跑。控制台按 GBK 输出，所以这里只打印 ASCII。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function report(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  // 控制台是 GBK：详情一律先转 ASCII，避免中文把输出打成乱码被误判成失败。
  const asciiDetail = detail === undefined ? '' : String(detail).replace(/[^ -~]/g, '?');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${asciiDetail ? ' :: ' + asciiDetail : ''}`);
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'resources') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter.test(entry.name)) out.push(full);
  }
  return out;
}

// 1) 语法
for (const file of walk(ROOT, /\.(cjs|mjs|js)$/)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    report('syntax ' + path.relative(ROOT, file), true);
  } catch (error) {
    report('syntax ' + path.relative(ROOT, file), false, String(error.stderr || error.message).split('\n').slice(0, 3).join(' '));
  }
}

// 2) JSON 可解析
for (const file of ['package.json', 'agent/launch.json'].map((f) => path.join(ROOT, f))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    report('json ' + path.relative(ROOT, file), true);
  } catch (error) {
    report('json ' + path.relative(ROOT, file), false, error.message);
  }
}

// 3) 界面接线：app.js 里引用的 id/class 必须在 index.html 里存在
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const referenced = [...appJs.matchAll(/querySelector\('#([a-zA-Z0-9_-]+)'\)|getElementById\('([a-zA-Z0-9_-]+)'\)/g)]
  .map((m) => m[1] || m[2]);
const missingIds = [...new Set(referenced)].filter((id) => !htmlIds.has(id));
report('renderer ids referenced exist in html', missingIds.length === 0, missingIds.join(','));

// 4) preload 暴露的方法与 app.js 调用的一致（少一边就是界面报 undefined）
const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
const exposed = new Set([...preload.matchAll(/^\s{2}([a-zA-Z]+):\s*\(/gm)].map((m) => m[1]));
const called = new Set([...appJs.matchAll(/window\.qingying\.([a-zA-Z]+)/g)].map((m) => m[1]));
const notExposed = [...called].filter((name) => !exposed.has(name) && name !== 'windowControls');
const neverUsed = [...exposed].filter((name) => !called.has(name));
report('renderer calls covered by preload', notExposed.length === 0, notExposed.join(','));
report('preload surface all used by renderer', neverUsed.length === 0, neverUsed.join(','));

// 5) IPC channel 一致性：preload invoke 的 channel 必须由主进程 handle
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
const agentTools = fs.readFileSync(path.join(ROOT, 'agent', 'tools.mjs'), 'utf8');
const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
const unhandled = [...invoked].filter((channel) => !handled.has(channel));
report('every invoked channel is handled', unhandled.length === 0, unhandled.join(','));

// 6) Agent 契约
const launch = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'launch.json'), 'utf8'));
report('agent launch.json port 8793', launch.command === 'node' && launch.ready_port === 8793
  && launch.args.join() === 'agent/server.mjs', JSON.stringify(launch));
const serverSrc = fs.readFileSync(path.join(ROOT, 'agent', 'server.mjs'), 'utf8');
report('agent server default port 8793', /PROJECT_DEFAULT_PORT = 8793/.test(serverSrc));

// 6b) 本机接口守卫：两条接口必须走同一份判据，且不许留通配 CORS / 任意输出目录。
//     （行为判据在 scripts/api-guard.test.cjs，这里守的是"接线有没有被改回去"。）
const localGuardSrc = fs.readFileSync(path.join(ROOT, 'electron', 'local-guard.cjs'), 'utf8');
const agentApiSrc = fs.readFileSync(path.join(ROOT, 'electron', 'agent-api.cjs'), 'utf8');
report('guard module exists and is required by both api surfaces',
  /require\('\.\/local-guard\.cjs'\)/.test(agentApiSrc) && /require\('\.\.\/electron\/local-guard\.cjs'\)/.test(serverSrc),
  '');
report('guard checks Host before any business route',
  /checkLocalGuard\(req/.test(agentApiSrc) && /replyGuardDenied/.test(agentApiSrc)
  && /checkLocalGuard\(req/.test(serverSrc), '');
report('Origin is never compared against the request own Host (DNS rebinding)',
  !/headers\.host[\s\S]{0,40}(===|==)\s*origin|origin[\s\S]{0,40}(===|==)\s*req\.headers\.host/i.test(localGuardSrc));
// 只在"非注释行"上判跨域头：把判据写在注释里说明边界是允许的，把 ACAO 发出去才是要挡的。
function acaoCodeLines(src) {
  return src.split(/\r?\n/).filter((line) => /access-control-allow/i.test(line))
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}
report('no wildcard CORS emitted on any local api surface',
  acaoCodeLines(agentApiSrc).length === 0 && acaoCodeLines(serverSrc).length === 0
  && /guard\.localHeaders/.test(agentApiSrc),
  acaoCodeLines(agentApiSrc).concat(acaoCodeLines(serverSrc)).join(' | ').slice(0, 120));
report('non-GET requires a token on both surfaces',
  /\{\s*port,\s*token[,}]/.test(agentApiSrc) && /token:\s*tokenInfo\.token/.test(serverSrc));
report('token file lives in per-user app-data (0600)',
  /apiToken/.test(fs.readFileSync(path.join(ROOT, 'electron', 'engine-core.cjs'), 'utf8'))
  && /mode:\s*0o600/.test(localGuardSrc) && /chmodSync\(file, 0o600\)/.test(localGuardSrc));
report('in-app api refuses outputDir outside the download root',
  /resolveOutputDir/.test(agentApiSrc) && /output_dir_refused|output_dir_outside_root|!target\.ok/.test(agentApiSrc));
report('main wires the containment helper',
  /resolveContainedOutputDir/.test(main) && /downloadRoots/.test(main));
report('agent tool output_dir goes through the same containment',
  /resolveContainedOutputDir/.test(agentTools));
report('mcp bridge sends the local token header',
  /x-qingying-token/.test(fs.readFileSync(path.join(ROOT, 'agent', 'mcp-server.mjs'), 'utf8')));
report('both api surfaces bind loopback only via listenLocal',
  /listenLocal/.test(localGuardSrc) && /listenLocal\(server/.test(fs.readFileSync(path.join(ROOT, 'electron', 'agent-api.cjs'), 'utf8')));

// 7) 引擎核心行为（无网络）
const core = require(path.join(ROOT, 'electron', 'engine-core.cjs'));

report('template accepts default', core.validateFilenameTemplate(core.DEFAULT_FILENAME_TEMPLATE).ok);
report('template rejects unknown field', !core.validateFilenameTemplate('%(hackme)s.%(ext)s').ok);
report('template rejects missing ext', !core.validateFilenameTemplate('%(title)s').ok);
report('template rejects control chars', !core.validateFilenameTemplate('a\n%(ext)s').ok);
report('preview trims by bytes', core.previewFilename('%(title).6B.%(ext)s', { title: 'abcdefghij', ext: 'mp4' }) === 'abcdef.mp4',
  core.previewFilename('%(title).6B.%(ext)s', { title: 'abcdefghij', ext: 'mp4' }));
report('filename strips illegal chars', core.sanitizeFileName('a<b>:c"d/e|f?g*h') === 'abcdefgh', core.sanitizeFileName('a<b>:c"d/e|f?g*h'));

const planImages = core.planEngine('https://www.instagram.com/p/abc/', { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'auto');
report('image site plans yt-dlp first', planImages.primary === 'yt-dlp' && planImages.chain[1].engine === 'gallery-dl');
const planVideo = core.planEngine('https://www.bilibili.com/video/BV1', { yt_dlp: { available: true }, gallery_dl: { available: false } }, 'auto');
report('video plan marks missing fallback', planVideo.chain.length === 2 && planVideo.chain[1].unavailable === true);

const diag = core.classifyParseError('ERROR: [douyin] Requested format is not available, login required', core.LOGIN_SITES.douyin, 'yt-dlp');
report('login failure has actionable remedy', diag.kind === 'login_required' && diag.remedies.some((r) => r.action === 'login'));
report('network failure suggests network', core.classifyParseError('Unable to download webpage: timed out', null, 'yt-dlp').kind === 'network');

const summary = core.summarizeLoginCookies(core.LOGIN_SITES.bilibili, [
  { name: 'SESSDATA', value: 'SECRET-VALUE', domain: '.bilibili.com', expirationDate: Math.floor(Date.now() / 1000) + 3600 },
  { name: 'junk', value: 'X', domain: '.example.com' },
]);
const serialized = JSON.stringify(summary);
report('cookie summary never leaks value', !serialized.includes('SECRET-VALUE') && !serialized.includes('"X"'), serialized);
report('cookie summary reports login', summary.loggedIn && summary.matchedCookieNames[0] === 'SESSDATA');

const args = core.buildDownloadArgs({
  url: 'https://example.com/v',
  outputDir: 'C:/tmp/out',
  mode: 'combined',
  videoId: '160',
  videoExt: 'mp4',
  videoHasAudio: false,
  audioId: '140',
  audioExt: 'm4a',
  site: null,
  cookieFile: '',
  ffmpegLocation: 'C:/ffmpeg',
  filenameTemplate: '%(title).180B [%(id)s].%(ext)s',
});
const joined = args.join(' ');
report('download args merge to mp4 when compatible', joined.includes('-f 160+140') && joined.includes('--merge-output-format mp4'));
report('download args keep continue + ffmpeg path', joined.includes('--continue') && joined.includes('C:/ffmpeg'));
report('download args use absolute -o', args[args.indexOf('-o') + 1].startsWith('C:'));

const badArgs = core.buildDownloadArgs({
  url: 'https://example.com/v', outputDir: 'C:/tmp/out', mode: 'audio', audioId: '140',
  audioFormat: 'flac', site: null, cookieFile: '', ffmpegLocation: 'x', filenameTemplate: ';rm -rf',
});
report('bad template falls back to default, not to shell', badArgs.join(' ').includes(core.DEFAULT_FILENAME_TEMPLATE));
report('unknown audio format clamps to mp3', badArgs.includes('mp3'));

const parsed = core.parseGalleryDlJson(JSON.stringify([
  [2, { url: 'https://x/1.jpg', extension: 'jpg', filename: 'a' }],
  [3, 'https://x/2.png'],
  [3, 'https://x/notimage.txt'],
]));
report('gallery-dl json parsed, non-images dropped', parsed.length === 2 && parsed[1].ext === 'png', JSON.stringify(parsed.map((p) => p.ext)));

const mapped = core.mapFormats({ formats: [
  { format_id: '160', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, tbr: 2000 },
  { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 129 },
] });
report('mapFormats splits video/audio', mapped.videos.length === 1 && mapped.audios.length === 1);

// 7h) 抖音：网页解析结果 → 格式列表 / info json / 引擎判定。
//     这一路是 issue #1 的根因修复：命令行拿不到抖音数据，只有登录会话里的网页拿得到。
const douyinDetail = {
  aweme_id: '7692418564459881721',
  desc: '测试作品 #标签',
  author: { nickname: '作者甲' },
  video: {
    duration: 8267,
    width: 1080,
    height: 1920,
    cover: { url_list: ['https://p3.douyinpic.com/a.jpeg'] },
    bit_rate: [
      { gear_name: 'normal_1080_0', bit_rate: 1788006, format: 'mp4', play_addr: { width: 1080, height: 1920, url_list: ['https://v11.douyinvod.com/hi.mp4'] } },
      { gear_name: 'normal_1080_1', bit_rate: 1163000, format: 'mp4', play_addr: { width: 1080, height: 1920, url_list: ['https://v11.douyinvod.com/lo.mp4'] } },
      { gear_name: 'normal_720_0', bit_rate: 1266671, format: 'mp4', play_addr: { width: 720, height: 1280, url_list: ['https://v11.douyinvod.com/720.mp4'] } },
    ],
  },
  images: [],
};
const douyinMedia = core.mapDouyinDetail(douyinDetail, 'https://www.douyin.com/video/7692418564459881721');
report('douyin detail keeps one format per height, highest bitrate wins',
  douyinMedia.videos.length === 2 && douyinMedia.videos[0].id === 'dj-1920p' && /1788 kbps/.test(douyinMedia.videos[0].note),
  JSON.stringify(douyinMedia.videos.map((v) => v.id)));
report('douyin formats are muxed (no separate audio pick)',
  douyinMedia.videos.every((v) => v.hasAudio === true) && douyinMedia.audios.length === 0);
report('douyin title/uploader/duration mapped',
  douyinMedia.title === '测试作品 #标签' && douyinMedia.uploader === '作者甲' && douyinMedia.duration === 8);
report('douyin renderer payload never carries CDN urls',
  !JSON.stringify(douyinMedia.videos).includes('douyinvod'));
const douyinInfo = core.buildDouyinInfoJson(douyinDetail, 'https://www.douyin.com/video/7692418564459881721', 'UA-TEST');
report('douyin info json keeps signed url + referer/UA',
  douyinInfo.formats.length === 2 && douyinInfo.formats[0].url === 'https://v11.douyinvod.com/hi.mp4'
  && douyinInfo.formats[0].http_headers.Referer === 'https://www.douyin.com/'
  && douyinInfo.formats[0].http_headers['User-Agent'] === 'UA-TEST');
const douyinNote = core.mapDouyinDetail({
  aweme_id: '1', desc: '图文', author: { nickname: 'b' }, video: {},
  images: [{ download_url_list: ['https://p3.douyinpic.com/x.webp?x=1'], width: 1440, height: 2035 }],
}, 'https://www.douyin.com/note/1');
report('douyin note maps images and no video',
  douyinNote.videos.length === 0 && douyinNote.images.length === 1 && douyinNote.images[0].ext === 'webp');
const douyinPlan = core.planEngine('https://www.douyin.com/video/1',
  { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'auto', { browserAvailable: true });
report('douyin plans browser first and drops gallery-dl',
  douyinPlan.chain.length === 2 && douyinPlan.primary === 'browser'
  && !douyinPlan.chain.some((step) => step.engine === 'gallery-dl'),
  JSON.stringify(douyinPlan.chain.map((s) => s.engine)));
report('without a browser the douyin plan stays the legacy chain',
  core.planEngine('https://www.douyin.com/video/1', { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'auto').primary === 'yt-dlp');
const douyinPref = core.planEngine('https://www.douyin.com/video/1',
  { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'gallery-dl', { browserAvailable: true });
report('preference missing from the chain is stated, not silently relabelled',
  douyinPref.primary === 'browser' && /不适用/.test(douyinPref.chain[0].reason) && !/图片链路优先/.test(douyinPref.chain[0].reason),
  douyinPref.chain[0].reason);
const infoArgs = core.buildDownloadArgs({
  url: 'https://www.douyin.com/video/1', outputDir: 'C:/tmp/out', mode: 'combined',
  videoId: 'dj-1920p', videoExt: 'mp4', videoHasAudio: true, audioId: '', audioExt: '',
  site: null, cookieFile: '', ffmpegLocation: 'ff', filenameTemplate: core.DEFAULT_FILENAME_TEMPLATE,
  infoJsonPath: 'C:/tmp/info.json',
});
report('info-json download drops the page url and falls back to best',
  infoArgs.includes('--load-info-json') && infoArgs[infoArgs.indexOf('-f') + 1] === 'dj-1920p/best'
  && !infoArgs.includes('https://www.douyin.com/video/1'), infoArgs.join(' ').slice(0, 160));

// 7g) 引擎输出行解析 —— 这一段曾经引用过一个根本没定义的常量，
//     真实下载第一行输出就把主进程整个带崩（npm run check 当时照样全绿）。
const progressLine = core.parseEngineLine('download:  45.3%| 1.20MiB/s|00:00:12');
report('progress line parsed into percent/speed/eta',
  progressLine.type === 'progress' && progressLine.percent === '45.3%' && progressLine.speed === '1.20MiB/s' && progressLine.eta === '00:00:12',
  JSON.stringify(progressLine));
const destinationCases = [
  ['[download] Destination: C:\\out\\a.f140.mp4', 'C:\\out\\a.f140.mp4'],
  ['[download] C:\\out\\a.mp4 has already been downloaded', 'C:\\out\\a.mp4'],
  ['[ExtractAudio] Destination: C:\\out\\a.mp3', 'C:\\out\\a.mp3'],
  ['[Merger] Merging formats into "C:\\out\\a.mkv"', 'C:\\out\\a.mkv'],
  ['[download] File was renamed to: C:\\out\\final.mp4', 'C:\\out\\final.mp4'],
];
for (const [line, expected] of destinationCases) {
  const parsed = core.parseEngineLine(line);
  report('destination line -> path', parsed.type === 'destination' && parsed.path === expected, parsed.type + '/' + parsed.path);
}
report('unknown engine line stays a log line', core.parseEngineLine('[debug] Command-line config: [...]').type === 'log');

// 7h) 静态兜底：大写常量必须在本文件里声明过。
// 用没定义的名字在 Node 里要等运行时才炸 —— DESTINATION_PATTERNS 那次就是下载一跑
// 就把主进程带走，而 node --check 全绿。这里做词法扫描（注释/字符串/正则字面量都不算代码）。
const AMBIENT_GLOBALS = new Set(['JSON', 'BUFFER', 'PROMISE', 'REGEXP', 'OBJECT', 'ARRAY', 'SYMBOL', 'PROXY', 'GLOBAL', 'MODULE', 'EXPORT', 'IMPORT']);

function stripCodeOnly(src) {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += "''";
      prevSignificant = "'";
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '``';
      prevSignificant = '`';
      continue;
    }
    if (ch === '/' && /[=(,:[!&|?{};\s]/.test(prevSignificant || '(')) {
      // 上一个有意义字符说明这里只能是正则字面量
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
        i += 1;
      }
      i += 1;
      while (i < n && /[gimsuy]/.test(src[i])) i += 1;
      out += '/rx/';
      prevSignificant = '/';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return out;
}

function undefinedConstants(file) {
  const code = stripCodeOnly(fs.readFileSync(file, 'utf8'));
  const declared = new Set();
  for (const m of code.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{3,})\b/g)) declared.add(m[1]);
  // 解构与对象字面量里带进来的名字也算"本文件有出处"：const { X } = require(...)
  for (const m of code.matchAll(/[,{]\s*([A-Z][A-Z0-9_]{3,})\s*[,}]/g)) declared.add(m[1]);
  const used = [];
  for (const m of code.matchAll(/(?<![.$\w])([A-Z][A-Z0-9_]{3,})\b/g)) {
    const name = m[1];
    const after = code.slice(m.index + name.length, m.index + name.length + 2);
    if (/^\s*[:=]/.test(after)) continue; // 对象键或赋值目标
    used.push(name);
  }
  return [...new Set(used)].filter((name) => !declared.has(name) && !AMBIENT_GLOBALS.has(name));
}
for (const file of ['electron/engine-core.cjs', 'electron/main.cjs', 'electron/agent-api.cjs', 'electron/local-guard.cjs', 'agent/tools.mjs', 'agent/server.mjs', 'renderer/app.js']) {
  const undeclared = undefinedConstants(path.join(ROOT, file));
  report('no undeclared CONSTANT in ' + file, undeclared.length === 0, undeclared.join(','));
}
// 反向哨兵（变异检查）：这条规则必须真的会红，否则它只是装饰。
const mutantFile = path.join(ROOT, '.check-tmp-mutant.cjs');
fs.writeFileSync(mutantFile, "const A = 1;\n// DESTINATION_PATTERNS 在注释里\nfor (const x of DESTINATION_PATTERNS) { console.log(JSON.stringify(x)); }\n");
try {
  const mutant = undefinedConstants(mutantFile);
  report('undeclared-constant guard actually bites (mutation)', mutant.join(',') === 'DESTINATION_PATTERNS', mutant.join(','));
} finally {
  fs.rmSync(mutantFile, { force: true });
}


report('normalizeMediaUrl rewrites modal_id',
  core.normalizeMediaUrl('https://www.douyin.com/?modal_id=1234567890123') === 'https://www.douyin.com/video/1234567890123');
report('iesdouyin recognized as douyin', core.matchLoginSite('https://www.iesdouyin.com/share/video/1')?.id === 'douyin');
report('unknown host has no site', core.matchLoginSite('https://example.com/x') === null);

// 7b) 引擎判定诚实性：偏好引擎没装时不能说"按设置用了它"
const planForcedMissing = core.planEngine('https://www.bilibili.com/video/BV1',
  { yt_dlp: { available: false }, gallery_dl: { available: true } }, 'yt-dlp');
report('preferred-but-missing engine never becomes primary', planForcedMissing.primary === 'gallery-dl');
report('preferred-but-missing says why', /没有可用/.test(planForcedMissing.chain[0].reason)
  && /不可用/.test(planForcedMissing.executable[0].reason) && /实际改用/.test(planForcedMissing.executable[0].reason),
planForcedMissing.executable[0].reason);
report('plan keeps full chain for display', planForcedMissing.chain.length === 2 && planForcedMissing.executable.length === 1);
report('engine keys normalised (probe uses yt_dlp, plan says yt-dlp)',
  core.planEngine('https://www.bilibili.com/video/BV1', { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'auto')
    .chain.every((step) => step.available === true && !step.unavailable));
const planAllMissing = core.planEngine('https://x.com/a', { yt_dlp: { available: false }, gallery_dl: { available: false } }, 'auto');
report('plan with no engine has empty primary', planAllMissing.primary === '' && planAllMissing.executable.length === 0);

// 7c) 失败出路必须分得开（六类各有下一步）
const kindsOf = (msg, site) => core.classifyParseError(msg, site || null, 'yt-dlp').kind;
report('fail: proxy blocked', kindsOf('ERROR: unable to connect to proxy: 407 Proxy Authentication Required') === 'proxy');
report('fail: site changed', kindsOf('ERROR: [bilibili] Unable to extract json data; please report this issue on https://github.com/yt-dlp/yt-dlp') === 'unsupported_site');
report('fail: site changed (known site)', kindsOf('ERROR: Unable to extract title; please report this issue', core.LOGIN_SITES.bilibili) === 'site_changed');
report('fail: link gone', kindsOf('ERROR: [tiktok] The requested page has a HTTP Error 404') === 'link_gone');
report('fail: not a content page', kindsOf('ERROR: Unsupported URL: https://www.bilibili.com/?') === 'unsupported_url');
report('fail: engine missing', kindsOf('ERROR: 找不到引擎可执行文件：yt-dlp') === 'engine_missing');
report('fail: every kind carries remedies', ['proxy', 'site_changed', 'link_gone', 'unsupported_url', 'engine_missing']
  .every((kind) => {
    const sample = {
      proxy: 'cannot connect to proxy 407',
      site_changed: 'please report this issue',
      link_gone: 'HTTP Error 404 Not Found',
      unsupported_url: 'Unsupported URL',
      engine_missing: '找不到引擎',
    }[kind];
    const diag = core.classifyParseError(sample, kind === 'site_changed' ? core.LOGIN_SITES.bilibili : null, 'yt-dlp');
    return diag.kind === kind && diag.remedies.length >= 2 && diag.remedies.every((r) => r.label && r.action);
  }));
const networkDiag = core.classifyParseError('Unable to download webpage: timed out', null, 'yt-dlp');
report('fail: plain timeout stays network', networkDiag.kind === 'network', networkDiag.kind);

// 7d) 未完成分片：看得见、只删引擎临时文件、不碰成品
const tmpScan = path.join(ROOT, '.check-tmp-parts');
fs.rmSync(tmpScan, { recursive: true, force: true });
try {
  fs.mkdirSync(path.join(tmpScan, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpScan, 'a.mp4.part'), 'x'.repeat(120));
  fs.writeFileSync(path.join(tmpScan, 'sub', 'b.ytdl'), 'yy');
  fs.writeFileSync(path.join(tmpScan, 'keep.mp4'), 'done');
  const scan = core.scanEngineTempFiles(tmpScan);
  report('temp scan counts only engine temp files', scan.count === 2 && scan.bytes === 122, `count=${scan.count} bytes=${scan.bytes}`);
  const cleaned = core.removeEngineTempFiles(tmpScan);
  report('temp clean removes only temp files', cleaned.count === 2
    && fs.existsSync(path.join(tmpScan, 'keep.mp4'))
    && !fs.existsSync(path.join(tmpScan, 'a.mp4.part')));
  report('temp scan rejects relative path', core.scanEngineTempFiles('relative/dir').valid === false);
  report('temp scan on missing dir is honest', core.scanEngineTempFiles(path.join(tmpScan, 'nope')).count === 0);
} finally {
  fs.rmSync(tmpScan, { recursive: true, force: true });
}

const dirStatus = core.enginesDirStatus(path.join(ROOT, 'no-such-engine-dir'));
report('stale engines dir reported honestly', dirStatus.configured && !dirStatus.exists && /不存在/.test(dirStatus.note));
const dirStatusReal = core.enginesDirStatus(path.join(ROOT, 'electron'));
report('existing engines dir without tools listed', dirStatusReal.exists && dirStatusReal.engines.length === 0);

const catalog = core.siteCatalog();
report('site catalog is the single source for the UI', catalog.length === 5
  && catalog.every((s) => s.id && s.label && Array.isArray(s.domains) && s.domains.length && s.content_kind));
report('site catalog carries no cookie values', !/sessionid_ss=|SESSDATA=/.test(JSON.stringify(catalog)));

// 7e) 界面不许再抄一份站点域名（抄第二遍就会和核心分叉）
report('renderer has no duplicated site domain table', !/douyin\.com/.test(appJs) && !/xiaohongshu\.com/.test(appJs));
report('renderer reads site list from main', /window\.qingying\.sitesList\(\)/.test(appJs));
report('renderer explains part-file resume', /\.part/.test(appJs) && /接着下/.test(appJs));
report('renderer shows engine decision chain', /engine_chain/.test(appJs) && /renderChainList/.test(appJs));
report('renderer keeps invalid template visible', /没有保存：/.test(appJs));

// 7f) 队列与降级：主进程里的真实接线
const galleryCall = (main.match(/runGalleryDlDownload\(\{[\s\S]{0,400}?\}, hooks\)/g) || []).filter((block) => /engineOptions/.test(block));
report('gallery-dl download gets engine search options', galleryCall.length >= 1, `blocks=${galleryCall.length}`);
report('queue pump skips tasks waiting for retry backoff', /status === 'queued' && !task\.timer/.test(main));
report('auth snapshot declares it stores no cookie values', /cookie_values_stored: false/.test(main));
report('removed task never re-writes history', /if \(task\.removed\) return;/.test(main));
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
report('every queue status has a colour', ['done', 'failed', 'paused', 'cancelled', 'downloading', 'queued']
  .every((status) => css.includes(`.task-row.status-${status}`)));
report('status colour token exists and is reused', /--warning: #ffcb6b/.test(css) && /var\(--warning\)/.test(css));
report('no emoji used as icons', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html + appJs + css));
const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
report('gitignore covers shortcuts and installer copy', /\*\.lnk/.test(gitignore) && /\/清影下载器-安装包\//.test(gitignore));
report('agent keeps 8 tools (contract window is 4-8)', (agentTools.match(/name: 'qingying\./g) || []).length === 8,
  `count=${(agentTools.match(/name: 'qingying\./g) || []).length}`);
report('agent reports reason text for failures', /function reasonText/.test(agentTools) && /REASON_TEXT/.test(agentTools));

// 8) 设置/历史读写只落在给定目录
const tmp = path.join(ROOT, '.check-tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
try {
  const saved = core.writeSettings(tmp, { outputDir: 'C:/x', autoRetry: 99, concurrency: 0 });
  report('settings clamped', saved.autoRetry === 5 && saved.concurrency === 1);
  const { mock } = require('node:test');
  const rename = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
  let writeFailed = false;
  try { core.writeSettings(tmp, { concurrency: 3 }); } catch { writeFailed = true; } finally { rename.mock.restore(); }
  report('failed settings replacement preserves previous value', writeFailed && core.readSettings(tmp).concurrency === 1);
  report('failed settings replacement removes temporary file', !fs.existsSync(core.dataPaths(tmp).settings + '.tmp'));
  core.appendHistory(tmp, { id: 't1', url: 'https://x', title: 'A', status: 'done', bytes: 10, files: [{ path: 'C:/x/A', bytes: 10 }] });
  const history = core.readHistory(tmp);
  report('history persisted and readable', history.length === 1 && history[0].bytes === 10);
  report('history has no cookie field', !JSON.stringify(history).toLowerCase().includes('cookie'));
  core.clearHistory(tmp);
  report('history cleared', core.readHistory(tmp).length === 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 8) 从主进程源码里"举起"一个顶层函数，注入依赖后真调用它。
//    主进程整体 require 不了（要 Electron），但这些函数只依赖 core/path/fs 与一个目录，
//    照原样搬过来跑，比对着源码文本猜"应该能用"可靠。
function liftMainFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('no such function: ' + name);
  let depth = 0;
  let seen = false;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; seen = true; }
    else if (source[i] === '}') {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced function: ' + name);
}

function liftMain(names, deps) {
  const source = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  const body = names.map((name) => liftMainFunction(source, name)).join('\n');
  const keys = Object.keys(deps);
  const factory = new Function(...keys, body + '\nreturn {' + names.join(',') + '};');
  return factory(...keys.map((key) => deps[key]));
}

// 8a) 删除：列表里每一种队列状态都必须有对应的删除说法
//     （issue 原话"下载列表没有删除功能"——原来只有"已完成且有文件"的行才有删除项，
//     失败/取消/暂停的行永远删不掉）。
const statusMachineLine = (main.match(/\/\/ 状态机：([^\n]+)/) || ['', ''])[1];
const QUEUE_STATUSES = [...new Set([...statusMachineLine.matchAll(/\b([a-z_]{4,})\b/g)].map((m) => m[1]))];
report('queue status list parsed from main state machine comment', QUEUE_STATUSES.length >= 6, QUEUE_STATUSES.join(','));

const deleteLabelsBlock = (appJs.match(/const DELETE_LABELS = \{([\s\S]*?)\n\};/) || ['', ''])[1];
const deleteLabels = [...new Set([...deleteLabelsBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]))];
const unlabeledStatuses = QUEUE_STATUSES.filter((status) => !deleteLabels.includes(status));
report('every queue status has a delete label', unlabeledStatuses.length === 0, unlabeledStatuses.join(','));

const statusLabelsBlock = (appJs.match(/const STATUS_LABELS = \{([\s\S]*?)\n\};/) || ['', ''])[1];
const statusLabelKeys = [...new Set([...statusLabelsBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]))];
report('delete labels stay inside the real status set',
  deleteLabels.every((status) => statusLabelKeys.includes(status)),
  deleteLabels.filter((status) => !statusLabelKeys.includes(status)).join(','));

report('delete button is on the row, not hidden in the menu', /dataset\.removeTask = task\.id/.test(appJs));
report('history rows delete one record', /dataset\.removeHistory = item\.id/.test(appJs)
  && /window\.qingying\.removeHistoryItem\(/.test(appJs));
report('delete no longer gated on done-with-files',
  !/if \(task\.status === 'done' && task\.file_count\) \{\s*addMenuItem\('删除记录'/.test(appJs));
report('row delete says files are untouched', /已下载的文件没有改动|不动已下载的文件/.test(appJs));

const removeBlock = (main.match(/ipcMain\.handle\('queue:remove',[\s\S]*?\n\}\);/) || [''])[0];
report('queue:remove stops a running task before deleting',
  /task\.status === 'downloading'\) stopTask\(task, \{ pause: false \}/.test(removeBlock)
  && /tasks\.delete\(id\)/.test(removeBlock));
const clearBlock = (main.match(/ipcMain\.handle\('queue:clear-finished',[\s\S]*?\n\}\);/) || [''])[0];
const clearedStatuses = ((clearBlock.match(/\[([^\]]*)\]\.includes/) || ['', ''])[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ''));
report('clear finished covers failed rows too',
  ['done', 'cancelled', 'failed'].every((status) => clearedStatuses.includes(status)), clearedStatuses.join(','));
report('clear finished never sweeps active rows',
  !clearedStatuses.includes('downloading') && !clearedStatuses.includes('queued'), clearedStatuses.join(','));

// 8b) 历史单条删除：真调用核心，删掉的必须只剩另一条，删不存在的必须回 false
const tmpHistory = path.join(ROOT, '.check-history-' + process.pid);
core.ensureDirSync(tmpHistory);
try {
  core.appendHistory(tmpHistory, { id: 'keep-1', url: 'https://a', title: 'KEEP', status: 'done', bytes: 1 });
  core.appendHistory(tmpHistory, { id: 'drop-1', url: 'https://b', title: 'DROP', status: 'failed', bytes: 2 });
  const removedOne = core.removeHistoryItem(tmpHistory, 'drop-1');
  const left = core.readHistory(tmpHistory);
  report('history single delete removes exactly one row', removedOne === true && left.length === 1 && left[0].id === 'keep-1', JSON.stringify(left.map((i) => i.id)));
  report('history single delete refuses an unknown id', core.removeHistoryItem(tmpHistory, 'no-such-id') === false);
  report('history single delete ignores empty id', core.removeHistoryItem(tmpHistory, '') === false);
  report('history delete keeps the survivor file content', left[0].title === 'KEEP');
} finally {
  fs.rmSync(tmpHistory, { recursive: true, force: true });
}

// 8b2) 记录页刷新：历史一落盘就得播给界面。原来「记录」只在启动时读一次盘，
//      下载完成的新记录要等重启才出现，删掉的行和盘上的行也对不上。
const emitHistoryBlock = (main.match(/function emitHistory\(\) \{[\s\S]*?\n\}/) || [''])[0];
report('history broadcast carries the stored list, not a guess',
  /core\.readHistory\(DATA_DIR\(\)\)/.test(emitHistoryBlock)
  && /sendToMain\('history:changed'/.test(emitHistoryBlock));
const recordHistoryBlock = (main.match(/function recordHistory\(task\) \{[\s\S]*?\n\}/) || [''])[0];
report('a finished task broadcasts its new history row', /appendHistory\([\s\S]*emitHistory\(\)/.test(recordHistoryBlock));
const historyRemoveBlock = (main.match(/ipcMain\.handle\('history:remove',[\s\S]*?\n\}\);/) || [''])[0];
report('single delete broadcasts only when a row really went', /if \(removed\) emitHistory\(\)/.test(historyRemoveBlock));
const historyClearBlock = (main.match(/ipcMain\.handle\('history:clear',[\s\S]*?\n\}\);/) || [''])[0];
report('clear-all broadcasts the empty list', /clearHistory\(DATA_DIR\(\)\)[\s\S]*emitHistory\(\)/.test(historyClearBlock));
report('preload exposes the history channel',
  /onHistoryChanged: \(callback\) => listener\('history:changed'/.test(preload));
report('renderer subscribes and rerenders the record list',
  /onHistoryChanged\(\(snapshot\) => renderHistory\(snapshot\?\.items \|\| \[\]\)\)/.test(appJs));

// 8b3) 探测预算：yt-dlp 换版后第一次执行要等杀毒扫描，本机实测冷启动 34.5s。
// 预算短于冷启动 = 冷启动被判成"引擎不可用"，界面随后拒绝一切下载。
const probeEngineBlock = (fs.readFileSync(path.join(ROOT, 'electron', 'engine-core.cjs'), 'utf8')
  .match(/async function probeEngine\(name, options\) \{[\s\S]*?\n\}/) || [''])[0];
const probeBudget = Number(((probeEngineBlock.match(/probeTimeoutMs\) \|\| (\d+)/) || [0, '0'])[1]));
report('engine probe budget survives a cold start', probeBudget >= 30000, probeBudget + 'ms');

// 8c) 引擎优先级 + 下载目录自愈 + 升级取址安全：都在下面这段用真实临时目录跑
function sectionEngineDirs() {
  const tmp = path.join(ROOT, '.check-engines-' + process.pid);
  const appPath = path.join(tmp, 'app');
  const packagedBin = path.join(appPath, 'resources', 'bin');
  const userData = path.join(tmp, 'userData', 'qingying');
  const configuredDir = path.join(tmp, 'configured');
  core.ensureDirSync(packagedBin);
  core.ensureDirSync(configuredDir);
  fs.writeFileSync(path.join(packagedBin, 'yt-dlp.exe'), 'bundled-old');
  fs.writeFileSync(path.join(packagedBin, 'ffmpeg.exe'), 'bundled-ffmpeg');
  fs.writeFileSync(path.join(configuredDir, 'yt-dlp.exe'), 'upgraded-new');
  core.writeSettings(userData, { outputDir: tmp, enginesDir: configuredDir });
  try {
    const deps = {
      path, fs, core,
      // 主进程用 process.resourcesPath 定位安装包自带的引擎，这里给一个假的安装包位置。
      process: { resourcesPath: path.join(appPath, 'resources') },
      DATA_DIR: () => userData,
      app: { isPackaged: true, getAppPath: () => appPath, getPath: () => path.join(tmp, 'userData') },
    };
    const lifted = liftMain(['isEngineFile', 'engineOptions'], deps);
    const opts = lifted.engineOptions();
    report('configured engine dir beats the packaged copy',
      opts.overrides['yt-dlp'] === path.join(configuredDir, 'yt-dlp.exe'), opts.overrides['yt-dlp']);
    report('engine missing from configured dir falls back to packaged copy',
      opts.overrides.ffmpeg === path.join(packagedBin, 'ffmpeg.exe'), opts.overrides.ffmpeg);

    const stale = path.join(tmp, 'this-dir-does-not-exist');
    core.writeSettings(userData, { enginesDir: stale });
    const afterStale = liftMain(['isEngineFile', 'engineOptions'], deps).engineOptions();
    report('stale configured dir falls back instead of breaking',
      afterStale.overrides['yt-dlp'] === path.join(packagedBin, 'yt-dlp.exe'), afterStale.overrides['yt-dlp']);
    report('isEngineFile returns nothing for a missing dir', lifted.isEngineFile(stale, 'yt-dlp') === '');

    // 下载目录自愈：任务目录还没建出来时应当建好并放行，原来一律报"请选择有效的下载目录"
    const wantedDir = path.join(tmp, 'Downloads', 'new-sub');
    core.writeSettings(userData, { outputDir: path.join(tmp, 'Downloads'), enginesDir: '' });
    const guard = liftMain(['validateTaskTarget'], {
      path, fs, core,
      DATA_DIR: () => userData,
      LOGIN_SITES: core.LOGIN_SITES,
    });
    const task = {
      url: 'https://www.youtube.com/watch?v=x1',
      site: '',
      outputDir: wantedDir,
      mode: 'combined',
      videoId: '137',
      videoHasAudio: false,
      audioId: '140',
    };
    const problem = guard.validateTaskTarget(task);
    report('missing download dir is created instead of refusing the task',
      problem === '' && fs.statSync(wantedDir).isDirectory(), problem || 'created');
    report('task keeps the resolved absolute output dir',
      path.resolve(task.outputDir) === path.resolve(wantedDir), task.outputDir);

    const escapeTask = { ...task, outputDir: path.resolve(path.join(tmp, '..', '..', 'Windows', 'escape')) };
    const escapeProblem = guard.validateTaskTarget(escapeTask);
    report('output dir outside the download root is still refused',
      escapeProblem !== '' && /根目录/.test(escapeProblem), escapeProblem);

    // 根目录自己还没建出来时（用户在界面选了个子文件夹、之后手动删掉它），
    // "目标 == 根"必须放行并把目录建回来；同级目录照样拒绝。
    const missingRoot = path.join(tmp, 'Savedirs', 'gone');
    const selfCreate = core.resolveContainedOutputDir(missingRoot, [missingRoot], { create: true });
    report('output dir equal to a not-yet-created root is accepted',
      selfCreate.ok === true && fs.statSync(missingRoot).isDirectory(), selfCreate.error || '');
    const deep = path.join(missingRoot, 'a', 'b');
    const deepOk = core.resolveContainedOutputDir(deep, [missingRoot], { create: true });
    report('deep missing subdir under the root is created', deepOk.ok === true && fs.statSync(deep).isDirectory(), deepOk.error || '');
    const outside = path.join(tmp, 'elsewhere-target');
    const refused = core.resolveContainedOutputDir(outside, [missingRoot], { create: true });
    report('sibling outside the root is still refused', refused.ok === false && refused.code === 'output_dir_outside_root', String(refused.code));
    report('refused dir is not created behind the guard', !fs.existsSync(outside));

    // 引擎升级的取址安全：只认官方域名与 https。域名表从主进程源码里读，
    // 免得门和实现各写一份、改一边还是绿的。
    const hostsLiteral = (main.match(/const UPDATE_HOSTS = new Set\(\[([\s\S]*?)\]\);/) || ['', ''])[1];
    const allowedHosts = [...new Set([...hostsLiteral.matchAll(/'([^']+)'/g)].map((m) => m[1]))];
    report('update host allowlist is read from main and not empty', allowedHosts.length >= 2, allowedHosts.join(','));
    report('allowlist has no scheme-prefixed or wildcard entries',
      allowedHosts.every((host) => !/[:*/]/.test(host)), allowedHosts.join(','));
    const safety = liftMain(['allowlistedDownloadUrl', 'normalizeVersion'], { core, URL, UPDATE_HOSTS: new Set(allowedHosts) });
    report('plain http asset url is refused', safety.allowlistedDownloadUrl('http://github.com/a/b.exe') === '');
    report('off-site asset url is refused', safety.allowlistedDownloadUrl('https://evil.example.com/yt-dlp.exe') === '');
    report('https github asset url is accepted',
      safety.allowlistedDownloadUrl('https://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp.exe') !== '');
    report('relative url is refused', safety.allowlistedDownloadUrl('yt-dlp.exe') === '');
    report('version tags compare without the leading v', safety.normalizeVersion('v1.31.14') === '1.31.14');

    // 替换引擎文件：先删后改名，目标不存在时也要能装上
    const place = liftMain(['placeEngineFile'], { path, fs, core });
    const destFile = path.join(tmp, 'bin-dest', 'yt-dlp.exe');
    core.ensureDirSync(path.dirname(destFile));
    const newFile = path.join(tmp, 'staged.exe');
    fs.writeFileSync(newFile, 'fresh');
    const placed = place.placeEngineFile(newFile, destFile);
    report('engine file lands at the destination', placed.ok === true && fs.readFileSync(destFile, 'utf8') === 'fresh');
    report('staging file is consumed by the replace', !fs.existsSync(newFile));
    fs.writeFileSync(newFile, 'second');
    fs.writeFileSync(destFile + '.locked', 'x');
    const replaceExisting = place.placeEngineFile(newFile, destFile);
    report('replace over an existing engine works', replaceExisting.ok === true && fs.readFileSync(destFile, 'utf8') === 'second');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
sectionEngineDirs();

// 8e) 取流 403 的归因：能解析、取不到流，不该指用户去登录一个公开视频
const forbidden = core.classifyParseError('ERROR: unable to download video data: HTTP Error 403: Forbidden', null, 'yt-dlp');
report('media 403 is not blamed on login', forbidden.kind === 'blocked_403', forbidden.kind);
const forbiddenActions = (forbidden.remedies || []).map((item) => item.action);
report('media 403 offers engine upgrade and a lower bitrate',
  forbiddenActions.includes('update_engine') && forbiddenActions.includes('lower_quality'), forbiddenActions.join(','));
const realLogin = core.classifyParseError('This video is private. Login required.', core.LOGIN_SITES.douyin, 'yt-dlp');
report('a genuine login wall still says login', realLogin.kind === 'login_required', realLogin.kind);
const proxyStillWins = core.classifyParseError('unable to connect to proxy: 407 tunnel failed', null, 'yt-dlp');
report('proxy failure keeps its own class ahead of 403', proxyStillWins.kind === 'proxy', proxyStillWins.kind);
report('403 class is printed the same way on every surface',
  /blocked_403/.test(appJs) && /blocked_403/.test(agentTools));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
