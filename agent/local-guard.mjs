/**
 * local-guard.mjs —— 本机服务守卫（Agent API 的唯一边界判据，标准模板件）。
 *
 * 形状与语义同本组合已提交的参考实现（frameboost / jingjie / sucai / qingying 各自
 * 的 local-guard 是同一套判据；这里是给"独立 agent 进程"项目的纯 ESM 模板版）：
 *   1) 只绑 127.0.0.1；绑不上要如实报，绝不空 catch；
 *   2) Host 必须逐字等于 127.0.0.1:<port> / localhost:<port> / [::1]:<port>，否则拒（挡 DNS rebinding）；
 *   3) Origin / Referer 只要出现就必须落在本机回环上，不匹配回 JSON 403；
 *      ⚠ 绝不拿 Origin 去和"请求自己的 Host"比 —— 那正是 DNS rebinding 的洞
 *      （页面把域名解析到 127.0.0.1 后两者自然相等，闸门形同没有）；比较对象只有固定白名单；
 *   4) 非 GET/HEAD 必须带令牌（定长时间比较）；令牌由 token-store.mjs 自动生成并落盘 0600，
 *      合法调用方（MCP 桥、桌面壳、自检）通过 manifest 里的 token_file 自己读得到；
 *   5) 任何响应都不发 Access-Control-Allow-Origin: *（状态变更路由上发它等于欢迎任意网页来 POST）。
 *
 * 为什么必须有："只监听 127.0.0.1"不是边界 —— 回环上的服务对本机所有进程、
 * 也是对所有浏览器可达；一个任意跨源页面只要发个简单 POST 就能把 confirm:true 塞进请求体。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** 本机回环主机名（不含端口） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** 本服务允许的绑定地址（标准第 1 条：禁止 0.0.0.0） */
export const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** 拆开 "host:port"（IPv6 形如 [::1]:8796），返回 { host, port|null } */
export function splitHostPort(value) {
  const s = String(value ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return { host: s, port: null };
    const host = s.slice(0, end + 1);
    const rest = s.slice(end + 1);
    const m = /^:(\d+)$/.exec(rest);
    return { host, port: m ? Number(m[1]) : null };
  }
  const idx = s.lastIndexOf(':');
  if (idx < 0) return { host: s, port: null };
  const maybePort = Number(s.slice(idx + 1));
  if (!Number.isFinite(maybePort)) return { host: s, port: null };
  return { host: s.slice(0, idx), port: maybePort };
}

/** Host 判据：主机名在本机白名单里，并且端口就是本服务实际监听的那个端口 */
export function hostAllowed(host, port) {
  if (!host) return false;
  const { host: h, port: p } = splitHostPort(host);
  if (p !== port) return false;
  const normalized = h.replace(/^\[|\]$/g, '').toLowerCase();
  const withBrackets = normalized === '::1' ? '[::1]' : normalized;
  return LOOPBACK_HOSTS.has(normalized) || LOOPBACK_HOSTS.has(withBrackets);
}

/**
 * Origin/Referer 判据：没带 = 放行（curl、node fetch、MCP 桥都不带）；
 * 带了就必须落在本机回环上。比较对象是**固定的本机白名单**，
 * 永远不是 req.headers.host —— 后者正是 DNS rebinding 会伪造的那一半。
 */
export function originAllowed(origin) {
  if (origin === undefined || origin === null || String(origin).trim() === '') return true;
  const s = String(origin).trim();
  if (s === 'null' || s === 'file://') return false;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  const explicit = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  // 本机任意端口都算同源（比如以后从渲染层打本机接口），但端口必须是合法数字
  return Number.isFinite(explicit) && explicit > 0;
}

/** 定长时间比较：先把两侧都哈希成固定 32 字节，连长度本身都不泄露 */
export function tokenMatches(provided, expected) {
  if (!expected) return false;
  const a = createHash('sha256').update(String(provided ?? ''), 'utf8').digest();
  const b = createHash('sha256').update(String(expected), 'utf8').digest();
  return timingSafeEqual(a, b);
}

function bearer(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? '').trim());
  return m ? m[1].trim() : '';
}

function firstHeaderValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return '';
}

/**
 * 唯一的守卫入口。返回 { ok:false } 时调用方**必须**先把它回出去再 return，
 * 不许"记个日志继续跑"。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ port: number, token: string, tokenHeader?: string }} opts
 * @returns {{ ok: boolean, status?: number, code?: string, error?: string }}
 */
export function checkLocalGuard(req, opts) {
  const port = Number(opts.port);
  if (!hostAllowed(req.headers.host, port)) {
    return {
      ok: false,
      status: 403,
      code: 'HOST_NOT_ALLOWED',
      error: `Host 头不被允许：本机服务只接受 127.0.0.1:${port} / localhost:${port} / [::1]:${port}（挡 DNS rebinding）。请把请求指到这些地址`
    };
  }
  const origin = firstHeaderValue(req.headers.origin);
  if (!originAllowed(origin)) {
    return {
      ok: false,
      status: 403,
      code: 'ORIGIN_NOT_ALLOWED',
      error: `Origin 不是本机来源：${origin.slice(0, 160)}。本接口只服务本机回环请求，不从网页里直接调用`
    };
  }
  const referer = firstHeaderValue(req.headers.referer ?? req.headers.referrer);
  if (referer && !originAllowed(referer)) {
    return {
      ok: false,
      status: 403,
      code: 'REFERER_NOT_ALLOWED',
      error: `Referer 不是本机来源：${referer.slice(0, 160)}`
    };
  }
  const token = String(opts.token ?? '').trim();
  const method = String(req.method ?? '').toUpperCase();
  if (!token) {
    // 令牌读不出来就是边界塌了：非 GET 一律拒，绝不退化成"没有守卫也行"
    if (method !== 'GET' && method !== 'HEAD') {
      return {
        ok: false,
        status: 500,
        code: 'TOKEN_UNAVAILABLE',
        error: '服务端没能取到本机令牌，写接口按 fail-closed 拒绝。请检查 token-store.mjs 的落盘目录是否可写'
      };
    }
  } else if (method !== 'GET' && method !== 'HEAD') {
    const headerName = String(opts.tokenHeader ?? 'x-agent-token').toLowerCase();
    let provided = firstHeaderValue(req.headers[headerName]);
    if (!provided) provided = bearer(req.headers.authorization);
    if (!tokenMatches(provided, token)) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_REQUIRED',
        error: `缺少或错误的本机令牌：请带请求头 ${headerName}: <令牌>（令牌见 manifest api.token_file 落盘的文件，MCP 桥会自动读取）`
      };
    }
  }
  return { ok: true };
}

/**
 * 把拒绝理由回成 JSON。刻意不带任何 Access-Control-Allow-* 头：
 * 状态变更路由上发 ACAO:* 等于告诉浏览器"任意站点都可以来 POST 我"。
 */
export function replyGuardDenied(res, verdict, tokenHeader) {
  const headerName = String(tokenHeader ?? 'x-agent-token').toLowerCase();
  const body = JSON.stringify({
    ok: false,
    error: { code: verdict.code ?? 'FORBIDDEN', message: verdict.error ?? '请求被本机守卫拒绝' },
    guard: { host: '127.0.0.1 only', origin: 'loopback only', tokenHeader, mutatingMethodsNeedToken: true }
  });
  res.writeHead(verdict.status ?? 403, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

/** 统一的本机响应头：任何 access-control-allow-origin 通配值都被剥掉 */
export function localHeaders(extra = {}) {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
  for (const key of Object.keys(headers)) {
    if (/^access-control-allow-origin$/i.test(key) && String(headers[key]).trim() === '*') delete headers[key];
  }
  return headers;
}

/** 绑定地址判据：非本机回环直接拒绝执行（不是提醒一句） */
export function assertLoopbackBindHost(host) {
  const h = String(host ?? '').trim();
  if (!LOOPBACK_BIND_HOSTS.has(h)) {
    return { ok: false, error: `只允许监听本机回环（127.0.0.1），拒绝绑定到 ${h || '(空)'}` };
  }
  return { ok: true };
}

/** 把 listen 失败翻译成一句能照着做的话（调用方原样显示，不许吞） */
export function describeBindError(err, port) {
  const code = String(err?.code ?? '');
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 已被别的程序占用，接口没有起来。用 AGENT_PORT 换一个端口，或先关掉占用 ${port} 的程序（netstat -ano | findstr :${port}）`;
  }
  if (code === 'EACCES') {
    return `端口 ${port} 在本机被系统占用或需要管理员权限，接口没有起来。换一个 1024 以上的端口（AGENT_PORT）`;
  }
  return `接口未能监听 127.0.0.1:${port}：${err?.message ?? String(err)}`;
}
