#!/usr/bin/env node
// Agent API server — 标准实现（本机守卫版），项目只需提供同目录下的 tools.mjs。
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md。
// 守卫判据见 ./local-guard.mjs；令牌来源见 ./token-store.mjs。复制时本文件逻辑不必改动；
// 项目在 tools.mjs 里 export const project = { id, name, version, summary, port? } 即可：
// 令牌请求头按 x-<id>-token 自动推导（id 缺省 'agent'），默认端口按 project.port（缺省 8790）。
import { createServer } from 'node:http';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const fs = { readFileSync };
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureAgentToken } from './token-store.mjs';

const require = createRequire(import.meta.url);
// 守卫判据只有一份：electron/local-guard.cjs（Electron 主进程的 8392 接口用的也是它）。
const guard = require('../electron/local-guard.cjs');
// 本机统一注册表里清影占 8793（README / launch.json / scripts/check.cjs 都以它为准）。
export const PROJECT_DEFAULT_PORT = 8793;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START = Date.now();

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadTools() {
  const p = path.join(__dirname, 'tools.mjs');
  if (!existsSync(p)) throw new Error(`missing ${p}: 项目必须实现 agent/tools.mjs`);
  return import(`file:///${p.replace(/\\/g, '/')}`);
}

function json(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, guard.localHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    ...extra,
  }));
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new AgentError('too_large', '请求体超过 8MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AgentError('bad_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 只校验 required 与未知键；类型宽松处理，交给业务 handler 自己收窄。
function validate(schema, input) {
  if (!schema || schema.type !== 'object') return;
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const missing = (schema.required || []).filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
  if (missing.length) throw new AgentError('bad_input', `缺少必填参数：${missing.join(', ')}`);
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(data).filter((k) => !(k in (schema.properties || {})));
    if (unknown.length) throw new AgentError('bad_input', `未知参数：${unknown.join(', ')}；可用：${Object.keys(schema.properties || {}).join(', ') || '无'}`);
  }
}

export async function start({ port: wantPort, host = '127.0.0.1', label = 'agent' } = {}) {
  // 标准第 1 条：绑非回环直接拒绝启动，不是提醒一句（判据在 local-guard 里，只有一份）。
  // 标准第 1 条：绑非回环直接拒绝启动（判据与绑定入口都走 electron/local-guard.cjs，只有一份）。
  // 非回环地址由 listenLocal 返回 ok:false 并拒绝，这里不用第二套规则重复判断。
  const mod = await loadTools();
  const meta = mod.project || { name: label, version: '0.0.0' };
  const projectId = String(mod.projectId || meta.id || 'qingying');
  const tokenHeader = `x-${projectId}-token`;
  // 令牌在服务起来之前就取定：拿不到就抛，绝不以"写接口没有守卫"的状态监听
  const secret = ensureAgentToken(projectId);  // { token, file, source }
  // source 取值：env（环境变量给定）/ file（复用已有）/ created（本次生成）。
  // 绑定/守卫/响应头全部走 local-guard：与 8392 那份是同一套判据。
  const tokenInfo = secret;
  const tools = mod.tools || [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptor = (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk || 'read' });

  const server = createServer(async (req, res) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : Number(wantPort) || 8790;
    // 守卫在最前：Host / Origin / Referer / 令牌，任何一条不过都不进业务分支
    const verdict = guard.checkLocalGuard(req, { port, token: tokenInfo.token, tokenHeader });
    if (!verdict.ok) { guard.replyGuardDenied(res, verdict); return; }
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') {
        // 预检也是非 GET：能走到这里说明它带了合法令牌且来源是本机回环。
        // 回 405 并且**不发任何 Access-Control-* —— 本服务不做跨源放行，
        // 跨源页面连预检都过不了，也就不可能对 /api/agent/tool 发出真请求。
        json(res, 405, { ok: false, error: { code: 'no_cors', message: '本机服务不做跨源放行；请从本机回环地址带令牌直接调用' } }, { allow: 'GET, POST, OPTIONS' });
        return;
      }
      if (route === '/api/health') {
        // 如实回执本服务自己的守卫：令牌来源、监听地址白名单、桌面 8392 接口的真实状态。
        const statusFile = path.join(path.dirname(tokenInfo.file || ''), 'agent-api-status.json');
        let desktopApi = { listening: false, note: '桌面界面没有运行（无 agent-api-status.json）' };
        try { desktopApi = { ...JSON.parse(fs.readFileSync(statusFile, 'utf8')), status_file: statusFile }; } catch { /* 桌面没开就如实说没开 */ }
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, agent_api: 1, tools: tools.length, uptime_ms: Date.now() - START, token_required: true, token_header: tokenHeader, token_file: tokenInfo.file ?? null, desktop_api: desktopApi, guard: { host: `127.0.0.1:${port} / localhost:${port} / [::1]:${port}`, host_allowlist: `127.0.0.1:${port} / localhost:${port} / [::1]:${port}`, origin: 'loopback only', token_required: true, token_required_for: '非 GET/HEAD', token_available: true, token_source: tokenInfo.source || 'file', token_file: tokenInfo.file ?? 'env', wildcard_cors: false, token_required_for: '非 GET/HEAD' } } });
      } else if (route === '/api/agent/tools') {
        json(res, 200, { ok: true, data: tools.map(descriptor) });
      } else if (route === '/api/agent/manifest') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, description: meta.summary || '', base_url: `http://${host}:${port}`, tools: tools.map(descriptor), api: { token_header: tokenHeader, token_env: 'AGENT_API_TOKEN', token_file: secret.file ?? null } } });
      } else if (route === '/api/agent/tool' && req.method === 'POST') {
        const body = await readBody(req);
        const tool = byName.get(body.tool);
        // 未注册的工具必须在这里就回完并 return：落进下面的 try 会在已结束的响应上二次发送，
        // 把 keep-alive 连接打坏，后续请求全部 ECONNRESET。
        if (!tool) { json(res, 400, { ok: false, error: { code: 'unknown_tool', message: `未注册的工具：${body.tool}`, available: [...byName.keys()] } }); return; }
        try {
          const t0 = Date.now();
          validate(tool.input_schema, body.input);
          const data = await tool.handler(body.input || {}, { meta, host, port });
          json(res, 200, { ok: true, tool: tool.name, ms: Date.now() - t0, data });
        } catch (e) {
          const code = e instanceof AgentError ? e.code : 'handler_failed';
          // 调用方修得了的（参数不存在/越界/缺确认/令牌之类）一律 400，只有真正的内部异常才是 500。
          const callerFixable = e instanceof AgentError && ['bad_input', 'unknown_tool', 'not_found', 'output_dir_outside_root', 'output_dir_not_absolute', 'output_dir_refused', 'no_download_root', 'confirm_required'].includes(e.code);
          json(res, callerFixable ? 400 : 500, { ok: false, tool: tool.name, error: { code, message: e.message } });
        }
      } else {
        json(res, 404, { ok: false, error: { code: 'not_found', message: `未知路径 ${route}`, endpoints: ['/api/health', '/api/agent/tools', '/api/agent/manifest', 'POST /api/agent/tool'] } });
      }
    } catch (e) {
      // 调用方修得了的问题不能报 500：坏 JSON、超大 body、缺必填都是调用方的错，
      // 回 5xx 会让 Agent 以为"服务坏了"而反复重试，永远学不会改那行 body。
      const code = e instanceof AgentError ? e.code : 'internal';
      const callerFixable = e instanceof AgentError && ['bad_json', 'too_large', 'bad_input', 'unknown_tool', 'not_found'].includes(e.code);
      json(res, callerFixable ? 400 : 500, { ok: false, error: { code, message: e.message } });
    }
  });

  const endpointFile = path.join(__dirname, '.endpoint');
  // 绑定：走 local-guard 的 listenLocal（只准回环 + 失败说出原因）；端口被占按契约 +1，最多试 12 个。
  let outcome = null;
  // 显式传入 port（含 0 = 系统分配临时端口）时，严格按它执行，不往上换端口：
  // 否则调用方按自己给的端口去连，会永远连不上（自检/test 都踩过这个坑）。
  const explicitPort = wantPort !== undefined && wantPort !== null && wantPort !== '' && Number.isFinite(Number(wantPort));
  for (let p = explicitPort ? Number(wantPort) : (Number(process.env.AGENT_PORT || process.env.PORT) || Number(meta.port) || PROJECT_DEFAULT_PORT), tries = explicitPort ? 0 : 12; tries >= 0; p += 1, tries -= 1) {
    outcome = await guard.listenLocal(server, p, { host, token: tokenInfo.token });
    if (outcome.ok) break;
    // 只有"端口被占"才往上换；非回环、权限这类绑定错误直接如实抛，不换端口蒙混过去。
    if (!/已被别的程序占用/.test(outcome.error || '')) throw new Error(outcome.error);
  }
  if (!outcome || !outcome.ok) throw new Error((outcome && outcome.error) || '接口未能监听');
  const port = outcome.port;
  writeFileSync(endpointFile, `http://${host}:${port}\n`);
  console.log(`[agent] ${meta.name} v${meta.version} → http://${host}:${port} (${tools.length} tools)`);
  console.log(`[agent] 本机守卫：Host 只认 127.0.0.1/localhost/[::1]:${port}，非 GET 需 ${tokenHeader}${secret.file ? `（令牌文件 ${secret.file}，0600）` : '（令牌来自环境变量）'}`);
  return { server, port, url: `http://${host}:${port}`, token: secret.token, tokenHeader, tools: tools.map(descriptor) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPort = Number(process.env.AGENT_PORT || process.env.PORT || 0) || undefined;
  start({ port: envPort }).catch((e) => { console.error('[agent] 启动失败：', e.message); process.exit(1); });
}
