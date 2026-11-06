// 变异台：把修复逐个退回原样，确认新增的门真的会红（不是只对着新代码点头）。
// 每次只改一处，跑完立刻按快照字节原样还原。不留机器路径：仓库根由本文件位置推出。
// 用法：node scripts/mutation-bench.cjs [M1 M2 ...]（不传则全跑）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIVE = path.resolve(__dirname, '..');
const SCRATCH = path.join(process.env.TEMP || process.env.TMPDIR || '.', 'qy-mutation-bench');
const COPY_DIRS = ['electron', 'renderer', 'agent', 'scripts'];

function freshScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const dir of COPY_DIRS) fs.cpSync(path.join(LIVE, dir), path.join(SCRATCH, dir), { recursive: true });
  // check.cjs 会读仓库根的 .gitignore / package.json / README，少一个文件它就整个崩掉，
  // 而崩溃在统计里读起来像"没有 FAIL"——必须把根目录的文件一并带上。
  for (const entry of fs.readdirSync(LIVE, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(LIVE, entry.name), path.join(SCRATCH, entry.name));
  }
}

function read(file) { return fs.readFileSync(path.join(SCRATCH, file), 'utf8'); }
function write(file, text) { fs.writeFileSync(path.join(SCRATCH, file), text, 'utf8'); }

function runCheck() {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(SCRATCH, 'scripts', 'check.cjs')], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : -1;
    out = String(error.stdout || '') + String(error.stderr || '');
  }
  const lines = out.split(/\r?\n/);
  const summary = lines.find((line) => /checks passed/.test(line)) || '';
  return {
    failedGates: lines.filter((line) => line.startsWith('FAIL')).map((line) => line.replace(/^FAIL\s+/, '').split(' ::')[0]),
    summary,
    crashed: !summary,
  };
}

function reindent(block) {
  // 还原成"旧代码"的多行形状时按当前文件的换行符写，避免锚点匹配不上。
  return block;
}

const MUTATIONS = [
  {
    name: 'M1 队列删除退回"只有已完成且有文件才显示"',
    file: 'renderer/app.js',
    apply(text) {
      let next = text.replace(
        "    addMenuItem(DELETE_LABELS[task.status] || '从列表删除', 'trash', () => void removeTaskRow(task));",
        reindent("    if (task.status === 'done' && task.file_count) {\n      addMenuItem('删除记录', 'trash', () => window.qingying.removeTask(task.id));\n    }"),
      );
      if (next === text) throw new Error('anchor: menu delete item');
      text = next;
      next = next.replace('dataset.removeTask = task.id;', 'dataset.noopTask = task.id;');
      if (next === text) throw new Error('anchor: visible row button');
      text = next;
      next = next.replace('dataset.removeHistory = item.id;', 'dataset.noopHistory = item.id;');
      if (next === text) throw new Error('anchor: history button');
      return next;
    },
    expect: [
      'delete button is on the row, not hidden in the menu',
      'history rows delete one record',
    ],
  },
  {
    name: 'M2 打包版引擎优先级退回"自带的永远赢"',
    file: 'electron/main.cjs',
    apply(text) {
      const next = text.replace(
        /      overrides\[name\] = isEngineFile\(configured, name\) \|\| path\.join\(bin, name \+ '\.exe'\);/,
        "      overrides[name] = path.join(bin, name + '.exe');",
      );
      if (next === text) throw new Error('anchor: overrides');
      return next;
    },
    expect: ['configured engine dir beats the packaged copy'],
  },
  {
    name: 'M3 下载目录退回"不存在就直接判失败"',
    file: 'electron/main.cjs',
    apply(text) {
      const next = text.replace(
        /  let dirReady = false;[\s\S]*?task\.outputDir = created\.resolved \|\| created\.real \|\| task\.outputDir;[\s\S]*?\n  \}/,
        "  try {\n    if (!path.isAbsolute(task.outputDir) || !fs.statSync(task.outputDir).isDirectory()) {\n      return '请选择有效的下载目录。';\n    }\n  } catch {\n    return '请选择有效的下载目录。';\n  }",
      );
      if (next === text) throw new Error('anchor: dirReady block');
      return next;
    },
    expect: ['missing download dir is created instead of refusing the task', 'output dir outside the download root is still refused'],
  },
  {
    name: 'M4 清除已结束退回不含 failed',
    file: 'electron/main.cjs',
    apply(text) {
      const next = text.replace(
        /\['done', 'cancelled', 'failed'\]\.includes\(tasks\.get\(id\)\?\.status\)/,
        "['done', 'cancelled'].includes(tasks.get(id)?.status)",
      );
      if (next === text) throw new Error('anchor: clear-finished');
      return next;
    },
    expect: ['clear finished covers failed rows too'],
  },
  {
    name: 'M5 取流 403 退回"归成需要登录"',
    file: 'electron/engine-core.cjs',
    apply(text) {
      const next = text.replace(/  \} else if \(MEDIA_403_PATTERNS\.test\(lowered\)\) \{[\s\S]*?\n  \} else if \(LOGIN_PATTERNS/, '  } else if (LOGIN_PATTERNS');
      if (next === text) throw new Error('anchor: blocked_403 branch');
      return next;
    },
    expect: ['media 403 is not blamed on login', 'media 403 offers engine upgrade and a lower bitrate'],
  },
  {
    name: 'M6 历史单条删除不再真的删',
    file: 'electron/engine-core.cjs',
    apply(text) {
      const next = text.replace(
        '  const next = items.filter((item) => safeText(item && item.id, 40) !== want);',
        '  const next = items.slice();',
      );
      if (next === text) throw new Error('anchor: removeHistoryItem filter');
      return next;
    },
    expect: ['history single delete removes exactly one row'],
  },
  {
    name: 'M7 引擎升级允许 http 或非官方域名',
    file: 'electron/main.cjs',
    apply(text) {
      const next = text.replace(
        "  return parsed.protocol === 'https:' && UPDATE_HOSTS.has(parsed.hostname) ? parsed.toString() : '';",
        '  return parsed.toString();',
      );
      if (next === text) throw new Error('anchor: allowlist guard');
      return next;
    },
    expect: ['plain http asset url is refused', 'off-site asset url is refused'],
  },
  {
    name: 'M8 目录归属退回"按上级投影"（根自己没建出来就判越界）',
    file: 'electron/engine-core.cjs',
    apply(text) {
      const next = text.replace(
        '  const hit = realRoots.find((entry) => pathIsInside(entry.real, projected));',
        '  const containmentTarget = opts.create && !fs.existsSync(target) ? (projectRealPath(path.dirname(target), impl) || projected) : projected;\n  const hit = realRoots.find((entry) => pathIsInside(entry.real, containmentTarget));',
      );
      if (next === text) throw new Error('anchor: containment projection');
      return next;
    },
    // 只该击中"目标恰好等于尚未建出来的根"这一条：老的"按上级投影"对
    // "根下面还没建的子目录"本来就是放行的，那条由 M3 管，不在这里冒充。
    expect: ['output dir equal to a not-yet-created root is accepted'],
  },
  {
    name: 'M9 下载完成后不再播历史（记录页退回只有重启才更新）',
    file: 'electron/main.cjs',
    apply(text) {
      const next = text.replace(
        '      finished_at: task.finished_at,\n    });\n    emitHistory();\n  } catch {}',
        '      finished_at: task.finished_at,\n    });\n  } catch {}',
      );
      if (next === text) throw new Error('anchor: recordHistory emit');
      return next;
    },
    expect: ['a finished task broadcasts its new history row'],
  },
  {
    name: 'M10 渲染端不再订阅 history:changed',
    file: 'renderer/app.js',
    apply(text) {
      const next = text.replace(
        'window.qingying.onHistoryChanged((snapshot) => renderHistory(snapshot?.items || []));',
        '// history channel unsubscribed',
      );
      if (next === text) throw new Error('anchor: onHistoryChanged subscription');
      return next;
    },
    expect: ['renderer subscribes and rerenders the record list'],
  },
  {
    name: 'M11 引擎探测预算退回 15s（冷启动被判成不可用）',
    file: 'electron/engine-core.cjs',
    apply(text) {
      const next = text.replace(
        '      timeoutMs: (options && options.probeTimeoutMs) || 40000,',
        '      timeoutMs: (options && options.probeTimeoutMs) || 15000,',
      );
      if (next === text) throw new Error('anchor: probe timeout');
      return next;
    },
    expect: ['engine probe budget survives a cold start'],
  },
];

const rows = [];
// 控制腿：未改动的 scratch 必须先全绿，否则后面每个"变红"都可能是台子自己坏了。
freshScratch();
const control = runCheck();
rows.push({ name: 'CONTROL 未改动', status: control.crashed ? 'BENCH-BROKEN' : (control.failedGates.length ? 'BASELINE-NOT-GREEN' : 'green'), failedCount: control.failedGates.length, detail: control.crashed ? 'no summary line' : control.failedGates.slice(0, 4).join(' | ') });

// 可选过滤：`node tmp-mutation-bench.cjs M8 M9` 只跑指定行（每条变异各自 freshScratch，
// 互不共享状态，所以分批跑不改变结论）。不传就全跑。
const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.name.split(' ')[0].toUpperCase())) : MUTATIONS;
if (wanted.length) {
  const missing = wanted.filter((tag) => !MUTATIONS.some((m) => m.name.split(' ')[0].toUpperCase() === tag));
  if (missing.length) {
    console.log('NO-SUCH-MUTATION  ' + missing.join(','));
    process.exit(2);
  }
}

for (const mutation of selected) {
  freshScratch();
  const pristine = read(mutation.file);
  let mutated;
  try {
    mutated = mutation.apply(pristine);
  } catch (error) {
    rows.push({ name: mutation.name, status: 'ANCHOR-BROKEN', failedCount: 0, detail: error.message });
    continue;
  }
  if (mutated === pristine) { rows.push({ name: mutation.name, status: 'NO-OP', failedCount: 0, detail: 'bytes unchanged' }); continue; }
  write(mutation.file, mutated);
  const result = runCheck();
  write(mutation.file, pristine);
  if (read(mutation.file) !== pristine) throw new Error('restore failed for ' + mutation.file);
  if (result.crashed) { rows.push({ name: mutation.name, status: 'BENCH-BROKEN', failedCount: result.failedGates.length, detail: 'check.cjs died' }); continue; }
  const missed = mutation.expect.filter((gate) => !result.failedGates.includes(gate));
  rows.push({
    name: mutation.name,
    status: missed.length ? 'GATE-STAYED-GREEN' : 'CAUGHT',
    failedCount: result.failedGates.length,
    detail: missed.length ? 'missed=' + JSON.stringify(missed) : '',
  });
}

const text = rows.map((row) => `${row.status}  ${row.name}  failed=${row.failedCount}${row.detail ? '  ' + row.detail : ''}`).join('\n');
fs.writeFileSync(path.join(process.env.TEMP, 'qy-mutation-bench-report.txt'), text, 'utf8');
console.log(text);
