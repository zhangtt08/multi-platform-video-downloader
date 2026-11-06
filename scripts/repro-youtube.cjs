// 引擎级复现脚本：走应用真实链路（probeEngines → analyzeUrl → runEngineDownload），
// 不经过界面。站点风控变化时用它先分辨"引擎解析坏了"还是"下载被 403"。
const path = require('path');
const fs = require('fs');
const os = require('os');
const core = require('../electron/engine-core.cjs');

const URL = process.argv[2] || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'qy-repro-dl');
const LOG = path.join(os.tmpdir(), 'qy-repro-result.txt');
const lines = [];
const say = (...a) => { lines.push(a.join(' ')); console.log(a.join(' ')); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 默认清空目标目录：残留的 .part 会让下一轮走续传，测的就不是同一条链路了。
  if (!process.env.QY_KEEP) for (const n of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, n), { recursive: true, force: true });
  const engineOptions = { extraRoots: [path.join(__dirname, '..', 'resources', 'bin')] };
  const engines = await core.probeEngines(engineOptions);
  say('yt-dlp', JSON.stringify(engines.yt_dlp));

  const an = await core.analyzeUrl({
    url: URL,
    engines,
    proxy: '',
    preference: 'auto',
    cookieProvider: async () => '',
    fetchThumbnail: async () => { throw new Error('repro: no thumbnail fetch'); },
  });
  say('analyze.ok', an.ok, 'kind', an.kind, 'engine', an.engine);
  if (!an.ok) { say('analyze.error', an.error); fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); process.exit(1); }
  const d = an.data;
  const vi = Number.parseInt(process.env.QY_VIDEO_INDEX || '0', 10);
  const video = d.videos[vi] || d.videos[0] || null;
  const audio = d.audios[0] || null;
  say('picked video index', vi, 'of', d.videos.length, 'videos:', d.videos.map((v) => v.id).join(','));
  say('title', d.title, 'videos', d.videos.length, 'audios', d.audios.length, 'videoId', video && video.id);

  const MODE = process.env.QY_MODE || (video && video.hasAudio ? 'video' : 'combined');
  const spec = {
    url: d.webpageUrl || URL,
    outputDir: OUT,
    site: null,
    cookieFile: '',
    engineOptions,
    ffmpegLocation: path.join(__dirname, '..', 'resources', 'bin', 'ffmpeg.exe'),
    filenameTemplate: '%(title).120B [%(id)s].%(ext)s',
    subfolderByPost: false,
    retries: 3,
    concurrentFragments: 2,
    proxy: '',
    mode: MODE,
    videoId: video ? video.id : '',
    videoExt: video ? video.ext : '',
    videoHasAudio: Boolean(video && video.hasAudio),
    audioId: audio ? audio.id : '',
    audioExt: audio ? audio.ext : '',
    audioFormat: 'mp3',
  };
  say('spec.mode', spec.mode, 'videoId', spec.videoId, 'audioId', spec.audioId);

  const res = await core.runEngineDownload(spec, {
    onProgress: (p) => say('progress', JSON.stringify(p)),
    onLog: (l) => { if (lines.length < 400) say('log', l); },
  });
  say('download.ok', res.ok, 'kind', res.kind, 'code', res.code, 'bytes', res.bytes, 'exit', res.exit_code);
  if (!res.ok) say('download.error', res.error);
  say('download.files', JSON.stringify((res.files || []).map((f) => [path.basename(f.path), f.bytes])));
  fs.writeFileSync(LOG, lines.join('\n'), 'utf8');
})().catch((error) => {
  say('FATAL', error && error.stack ? error.stack : String(error));
  fs.writeFileSync(LOG, lines.join('\n'), 'utf8');
  process.exit(1);
});
