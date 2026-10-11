/**
 * token-store.mjs —— 本机 Agent API 的共享令牌：自动生成、落盘 0600、合法调用方零配置读得到。
 *
 * 为什么是"自动生成 + 落盘"而不是"环境变量里由用户设一个"：
 * 守卫要对每个非 GET 请求成立，而合法调用方（MCP 桥、桌面壳、自检）和本服务
 * 同一个用户、读得到同一份文件。要用户先设环境变量，等于要么没人设
 * （守卫只能放宽成"没有令牌也行"，边界又没了），要么每次换终端都要重设。
 *
 * 落盘位置（按这个顺序取第一个能用的）：
 *   1) AGENT_API_TOKEN 环境变量 —— 显式指定，最高优先；
 *   2) AGENT_API_DATA_DIR —— 测试与"别动用户真实 AppData"的场景用它指到临时目录；
 *   3) %APPDATA%\<项目id> —— 与项目自己的每用户目录同层（Windows）；
 *   4) 没有 APPDATA（非 Windows 或极简环境）时回落 ~/.agent-api/<项目id>。
 *
 * 权限：POSIX 上是真正的 0600（写入 mode + chmod 两道）。Windows 上 libuv 只按
 * owner-write 映射只读位，组/其他位的保证来自 %APPDATA% 这一层本来就是每用户 ACL。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const TOKEN_FILE_NAME = 'agent-api.token';
const MIN_TOKEN_LENGTH = 32;

/** 项目的每用户数据目录（唯一一份判据；server 与 MCP 桥必须传同一个 projectId） */
export function appDataDir(projectId, env = process.env) {
  const override = String(env.AGENT_API_DATA_DIR ?? '').trim();
  if (override) return override;
  const appData = String(env.APPDATA ?? env.AppData ?? '').trim();
  if (appData) return path.join(appData, projectId);
  return path.join(os.homedir(), '.agent-api', projectId);
}

export function agentTokenFile(projectId, env = process.env) {
  return path.join(appDataDir(projectId, env), TOKEN_FILE_NAME);
}

function readFileToken(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value.length >= MIN_TOKEN_LENGTH ? value : '';
  } catch {
    return '';
  }
}

/**
 * 落盘一份私有权限的令牌，返回**最终生效**的那一份。
 * 独占创建失败（EEXIST）时先看别人那份是不是有效：有效就采用它，
 * 两个进程同时启动才不会各握一个令牌、桥按文件里的令牌打服务端反而 401。
 * 只有"文件在但内容不可用"（空/截断）才被覆盖重写。
 */
function createOrAdopt(file, candidate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${candidate}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const adopted = readFileToken(file);
    if (adopted) return { token: adopted, adopted: true };
    fs.writeFileSync(file, `${candidate}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  // 二次收紧：umask 会让写入时的 mode 落不到 0600
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 只映射只读位，失败不影响边界 */ }
  return { token: candidate, adopted: false };
}

/** 只读：MCP 桥与自检用它，绝不在这里造令牌（造是服务端启动那一次的事） */
export function readAgentToken(projectId, env = process.env) {
  const fromEnv = String(env.AGENT_API_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  return readFileToken(agentTokenFile(projectId, env));
}

/**
 * 服务端启动时取令牌：有就用、没有就生成并落盘。
 * 拿不到就抛 —— 服务宁可不起，也不能"没有令牌"地把写接口开放出去。
 */
export function ensureAgentToken(projectId, env = process.env) {
  const fromEnv = String(env.AGENT_API_TOKEN ?? '').trim();
  if (fromEnv) return { token: fromEnv, file: null, source: 'env' };
  const file = agentTokenFile(projectId, env);
  const existing = readFileToken(file);
  if (existing) return { token: existing, file, source: 'file' };
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    const outcome = createOrAdopt(file, secret);
    if (outcome.adopted) return { token: outcome.token, file, source: 'file' };
  } catch (error) {
    const raced = readFileToken(file);
    if (raced) return { token: raced, file, source: 'file' };
    throw new Error(`本机令牌写不进 ${file}：${error?.message ?? error}。写接口按 fail-closed 拒绝启动；可指定 AGENT_API_TOKEN 或把 AGENT_API_DATA_DIR 指到可写目录`);
  }
  const written = readFileToken(file);
  if (!written) throw new Error(`本机令牌写完读不回（${file}）：拒绝以"没有守卫"的状态提供服务`);
  return { token: written, file, source: 'created' };
}
