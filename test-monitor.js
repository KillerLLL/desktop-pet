'use strict';
/* 检测逻辑单元测试：node test-monitor.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  claudeStateFromData,
  claudeTurnStateFromTail,
  zcodeStateFromData,
  zcodeEventsFromTail,
  aggregateOf,
  resolveClaudeProject,
  scanZcodeWorkspace,
  deepMerge,
  CompletionGate,
  SessionMonitor,
  DEFAULTS,
  zcodeLineTokens,
  claudeLineTokens,
  TokenScanner,
  TASK_RESET_GAP_MS,
} = require('./monitor');

const NOW = 1_800_000_000_000;
const cfg = DEFAULTS;
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---------- Claude Code ----------
console.log('Claude Code 状态:');

test('无会话文件 => idle', () => {
  assert.strictEqual(claudeStateFromData(null, cfg, NOW).state, 'idle');
});

test('回合刚结束（末行纯文本 assistant，mtime 才 3s）=> 立即 idle，不等 mtime 冷却', () => {
  const s = claudeStateFromData(
    { mtimeMs: NOW - 3_000, turnState: 'waiting', project: 'demo' }, cfg, NOW,
  );
  assert.strictEqual(s.state, 'idle');
});

test('长命令执行中（mtime 5 分钟前，末行 assistant 带 tool_use）=> working', () => {
  const s = claudeStateFromData(
    { mtimeMs: NOW - 5 * 60_000, turnState: 'working', project: 'demo' }, cfg, NOW,
  );
  assert.strictEqual(s.state, 'working');
});

test('tool_use 挂起超过 claudeStaleWorkingMs（进程崩溃保护）=> idle', () => {
  const s = claudeStateFromData(
    { mtimeMs: NOW - 20 * 60_000, turnState: 'working', project: 'demo' }, cfg, NOW,
  );
  assert.strictEqual(s.state, 'idle');
});

test('尾部解析失败（turnState=null）退化为 mtime 启发式', () => {
  assert.strictEqual(
    claudeStateFromData({ mtimeMs: NOW - 5_000, turnState: null }, cfg, NOW).state, 'working');
  assert.strictEqual(
    claudeStateFromData({ mtimeMs: NOW - 5 * 60_000, turnState: null }, cfg, NOW).state, 'idle');
});

test('3 小时前结束 => idle', () => {
  const s = claudeStateFromData({ mtimeMs: NOW - 3 * 3600_000, turnState: 'waiting' }, cfg, NOW);
  assert.strictEqual(s.state, 'idle');
});

test('尾部解析：tool_use=working / 纯文本=waiting / user=working / sidechain 跳过', () => {
  const asst = (blocks, sidechain) => JSON.stringify({
    type: 'assistant', isSidechain: sidechain, message: { content: blocks },
  });
  // 末行带 tool_use => working
  assert.strictEqual(claudeTurnStateFromTail(asst([{ type: 'tool_use', id: 't1' }])), 'working');
  // 末行纯文本 => waiting
  assert.strictEqual(claudeTurnStateFromTail(asst([{ type: 'text', text: 'done' }])), 'waiting');
  // 子代理的"完成"行不算数，往前找到主线程 tool_use => working
  const tail = [
    asst([{ type: 'tool_use', id: 'task1' }]),
    asst([{ type: 'text', text: 'subagent done' }], true),
  ].join('\n');
  assert.strictEqual(claudeTurnStateFromTail(tail), 'working');
  // 半截 JSON 行跳过
  assert.strictEqual(claudeTurnStateFromTail(`${asst([{ type: 'text' }])}\n{"type":"assi`), 'waiting');
  // 末行 user（工具结果/新输入）=> working
  assert.strictEqual(
    claudeTurnStateFromTail(JSON.stringify({ type: 'user', message: { content: [] } })), 'working');
});

// ---------- ZCode ----------
console.log('ZCode 状态:');

test('回合进行中（start 晚于 end）=> working', () => {
  const events = [
    { t: NOW - 60_000, kind: 'start', event: 'turn.phase.started' },
    { t: NOW - 50_000, kind: 'end', event: 'model.request.completed' },
    { t: NOW - 5_000, kind: 'start', event: 'tool.call.started' },
  ];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'working');
});

test('回合刚完成（end 最新）=> idle（完成作为事件由 change 播报）', () => {
  const events = [
    { t: NOW - 60_000, kind: 'start', event: 'turn.phase.started' },
    { t: NOW - 10_000, kind: 'end', event: 'turn.phase.completed' },
  ];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'idle');
});

test('inFlight 超时（卡死保护）=> idle', () => {
  const events = [{ t: NOW - 20 * 60_000, kind: 'start', event: 'tool.call.started' }];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'idle');
});

test('无日志事件、rollout 刚写入 => working（降级路径）', () => {
  const s = zcodeStateFromData([], NOW - 10_000, cfg, NOW);
  assert.strictEqual(s.state, 'working');
});

test('2 小时前 => idle', () => {
  const events = [
    { t: NOW - 3 * 3600_000, kind: 'start', event: 'turn.phase.started' },
    { t: NOW - 3 * 3600_000 + 1000, kind: 'end', event: 'turn.phase.completed' },
  ];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'idle');
});

test('多会话并行：A 进行中 + B 刚结束 => 仍 working（按会话分组，不被 B 的 end 误判成空闲）', () => {
  const events = [
    { t: NOW - 120_000, kind: 'start', event: 'turn.phase.started', sessionId: 'A' },
    { t: NOW - 60_000, kind: 'start', event: 'tool.call.started', sessionId: 'B' },
    { t: NOW - 5_000, kind: 'end', event: 'turn.phase.completed', sessionId: 'B' },
  ];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.workingSessions.length, 1);
  assert.strictEqual(s.workingSessions[0].sessionId, 'A');
});

test('会话数：两个会话同时进行中 => workingSessions 为 2', () => {
  const events = [
    { t: NOW - 100_000, kind: 'start', event: 'tool.call.started', sessionId: 'A' },
    { t: NOW - 50_000, kind: 'start', event: 'tool.call.started', sessionId: 'B' },
  ];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.workingSessions.length, 2);
});

test('刚结束的会话不再计入会话数（无 30s 幽灵计数）', () => {
  const events = [
    { t: NOW - 10_000, kind: 'start', event: 'turn.phase.started', sessionId: 'A' },
    { t: NOW - 2_000, kind: 'end', event: 'turn.phase.completed', sessionId: 'A' },
  ];
  const s = zcodeStateFromData(events, 0, cfg, NOW);
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.workingSessions.length, 0);
});

test('日志尾解析：只收生命周期事件', () => {
  const tail = [
    JSON.stringify({ timestamp: new Date(NOW - 1000).toISOString(), event: 'zcode_protocol.process.memory_sample' }),
    JSON.stringify({ timestamp: new Date(NOW - 2000).toISOString(), event: 'tool.call.started' }),
    'not json',
    JSON.stringify({ timestamp: new Date(NOW - 3000).toISOString(), event: 'turn.phase.completed' }),
  ].join('\n');
  const events = zcodeEventsFromTail(tail);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.kind), ['start', 'end']);
});

// ---------- 汇总与工具 ----------
console.log('汇总与工具:');

test('aggregate: 任一 working => working，否则 idle', () => {
  assert.strictEqual(aggregateOf([{ state: 'idle' }, { state: 'working' }]), 'working');
  assert.strictEqual(aggregateOf([{ state: 'working' }, { state: 'idle' }]), 'working');
  assert.strictEqual(aggregateOf([{ state: 'idle' }, { state: 'idle' }]), 'idle');
  assert.strictEqual(aggregateOf([]), 'idle');
});

test('项目名解码（真实路径存在性消歧）', () => {
  assert.strictEqual(resolveClaudeProject('f--work-desktop-pet'), 'F:\\work\\desktop-pet');
  assert.strictEqual(resolveClaudeProject('f--work'), 'F:\\work');
});

test('配置合并', () => {
  const merged = deepMerge(DEFAULTS, { workingWindowMs: 1000, watch: { claude: false } });
  assert.strictEqual(merged.workingWindowMs, 1000);
  assert.strictEqual(merged.watch.claude, false);
  assert.strictEqual(merged.watch.zcode, true);
  assert.strictEqual(merged.bubbleAutoCloseMs, DEFAULTS.bubbleAutoCloseMs);
});

test('ZCode 工作区解析：取最近更新的 bot', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-test-'));
  const v2 = path.join(home, '.zcode', 'v2');
  fs.mkdirSync(v2, { recursive: true });
  fs.writeFileSync(path.join(v2, 'bot-state.v3.json'), JSON.stringify({
    bots: {
      a: { workspacePath: 'F:\\work\\old-project', updatedAt: 100 },
      b: { workspacePath: 'F:\\work\\desktop-pet', updatedAt: 200 },
    },
  }));
  assert.strictEqual(scanZcodeWorkspace(home), 'F:\\work\\desktop-pet');
  // 文件缺失 => null
  assert.strictEqual(scanZcodeWorkspace(path.join(os.tmpdir(), 'pet-not-exist')), null);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- 整个任务完成判定（宽限门） ----------
console.log('整个任务完成判定:');

test('回合结束 => 宽限期内不判定；静默满宽限期 => complete（只触发一次）', () => {
  const gate = new CompletionGate(60_000);
  gate.onTransition('claude', 'working', NOW - 120_000);
  gate.onTransition('claude', 'idle', NOW - 30_000); // 回合结束
  assert.strictEqual(gate.poll('claude', NOW - 20_000), null);   // 才静默 10s
  assert.strictEqual(gate.poll('claude', NOW), null);            // 静默 30s < 60s
  assert.strictEqual(gate.poll('claude', NOW + 31_000), 'complete'); // 满 60s
  assert.strictEqual(gate.poll('claude', NOW + 40_000), null);   // 只触发一次
});

test('宽限期内有新回合 => 撤销完成判定', () => {
  const gate = new CompletionGate(60_000);
  gate.onTransition('zcode', 'idle', NOW - 50_000);
  gate.onTransition('zcode', 'working', NOW - 10_000); // 用户又开工了
  assert.strictEqual(gate.poll('zcode', NOW + 120_000), null);
});

test('启动时就处于空闲（从未 working）=> 不触发完成', () => {
  const gate = new CompletionGate(60_000);
  assert.strictEqual(gate.poll('claude', NOW + 999_999), null);
});

// ---------- 端到端：真实文件扫描 + 状态机转换 ----------
console.log('端到端（伪造 HOME）:');

test('SessionMonitor 完整链路：working -> idle（完成事件）触发 change', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-test-'));
  const logDir = path.join(home, '.zcode', 'cli', 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(logDir, `zcode-${today}.jsonl`);
  const line = (event, offsetMs) => JSON.stringify({
    timestamp: new Date(Date.now() + offsetMs).toISOString(), event,
  });
  fs.writeFileSync(logFile, `${line('turn.phase.started', -5000)}\n${line('tool.call.started', -1000)}\n`);

  const monitor = new SessionMonitor({ ...DEFAULTS, pollIntervalMs: 10 }, home);
  const snap1 = monitor.tick();
  assert.strictEqual(snap1.zcode.state, 'working');
  assert.strictEqual(snap1.aggregate, 'working');

  const changes = [];
  const completions = [];
  monitor.on('change', (e) => changes.push(e));
  monitor.on('complete', (e) => completions.push(e));
  // 模拟回合结束
  fs.appendFileSync(logFile, `${line('tool.call.completed', 0)}\n${line('turn.phase.completed', 0)}\n`);
  const snap2 = monitor.tick();
  assert.strictEqual(snap2.zcode.state, 'idle');
  assert.strictEqual(snap2.aggregate, 'idle');
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].source, 'zcode');
  assert.strictEqual(changes[0].from, 'working');
  assert.strictEqual(changes[0].to, 'idle');
  assert.strictEqual(completions.length, 0); // 回合结束 ≠ 任务完成，须过宽限期
  monitor.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude 会话文件扫描链路：tool_use => working，回合结束 => 立即 idle + change 事件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-test-'));
  const projDir = path.join(home, '.claude', 'projects', 'f--work-desktop-pet');
  fs.mkdirSync(projDir, { recursive: true });
  const jsonl = path.join(projDir, 'sess1.jsonl');
  const asst = (blocks) => JSON.stringify({
    type: 'assistant', message: { content: blocks },
  });
  fs.writeFileSync(jsonl, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    asst([{ type: 'tool_use', id: 't1', name: 'Bash' }]),
  ].join('\n'));

  const monitor = new SessionMonitor({ ...DEFAULTS }, home);
  const snap1 = monitor.snapshot();
  assert.strictEqual(snap1.claude.state, 'working');
  assert.strictEqual(snap1.claude.project, 'F:\\work\\desktop-pet');
  monitor.tick(); // 记录 prev 状态

  const changes = [];
  monitor.on('change', (e) => changes.push(e));
  // 回合结束：追加一条纯文本 assistant，空闲状态立即翻转（mtime 还很新）
  fs.appendFileSync(jsonl, `\n${asst([{ type: 'text', text: '搞定' }])}\n`);
  const snap2 = monitor.snapshot();
  assert.strictEqual(snap2.claude.state, 'idle');
  monitor.tick(); // 触发 change 事件
  assert.ok(changes.some((c) => c.source === 'claude' && c.from === 'working' && c.to === 'idle'));
  monitor.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- Token 消耗扫描 ----------
console.log('Token 消耗扫描:');

test('zcodeLineTokens：取 response.usage.totalTokens，无 usage 返回 0', () => {
  assert.strictEqual(
    zcodeLineTokens({ response: { usage: { totalTokens: 372467 } } }), 372467);
  assert.strictEqual(zcodeLineTokens({ response: {} }), 0);
  assert.strictEqual(zcodeLineTokens({}), 0);
  assert.strictEqual(zcodeLineTokens(null), 0);
});

test('claudeLineTokens：四类 token 求和，无 usage 返回 0', () => {
  assert.strictEqual(claudeLineTokens({
    type: 'assistant',
    message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30, output_tokens: 20 } },
  }), 150);
  assert.strictEqual(claudeLineTokens({ type: 'assistant', message: {} }), 0);
  assert.strictEqual(claudeLineTokens({ type: 'user' }), 0);
});

test('TokenScanner：首见文件从当前末尾起算，半截行推迟到写全后计', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tok-'));
  const roll = path.join(home, '.zcode', 'cli', 'rollout');
  fs.mkdirSync(roll, { recursive: true });
  const f = path.join(roll, 'model-io-sess_abc.jsonl');
  const req = (n) => JSON.stringify({ response: { usage: { totalTokens: n } } });

  fs.writeFileSync(f, `${req(999)}\n`); // 首见前已存在的内容不计（只算观察期内）
  const sc = new TokenScanner();
  assert.strictEqual(sc.scan(home), 0);

  fs.appendFileSync(f, `${req(10)}\n${req(20)}\n`);
  assert.strictEqual(sc.scan(home), 30);

  fs.appendFileSync(f, `${req(5)}\n${req(7).slice(0, 20)}`); // 末尾半截行（无换行）
  assert.strictEqual(sc.scan(home), 5); // 半截行不计
  fs.appendFileSync(f, `${req(7).slice(20)}\n`); // 写全
  assert.strictEqual(sc.scan(home), 7);
  assert.strictEqual(sc.scan(home), 0); // 无新增 => 0，不重复计

  fs.rmSync(home, { recursive: true, force: true });
});

test('TokenScanner：Claude 会话行求和，且清理已消失文件的偏移', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tok-'));
  const pdir = path.join(home, '.claude', 'projects', 'f--work-desktop-pet');
  fs.mkdirSync(pdir, { recursive: true });
  const f = path.join(pdir, 'sess1.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: {
    usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 10 } },
  })}\n`);

  const sc = new TokenScanner();
  assert.strictEqual(sc.scan(home), 0); // 首见只记账
  fs.appendFileSync(f, `${JSON.stringify({ type: 'assistant', isSidechain: true, message: {
    usage: { input_tokens: 3, output_tokens: 2 } },
  })}\n`);
  assert.strictEqual(sc.scan(home), 5); // 子代理行也是真实消耗

  fs.rmSync(f);
  sc.scan(home);
  assert.ok(!sc.offsets.has(f), '已删除文件的偏移应被清理');
  fs.rmSync(home, { recursive: true, force: true });
});

test('任务窗口：同一任务内累积，空闲超阈值再开工则清零重计', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-task-'));
  const logDir = path.join(home, '.zcode', 'cli', 'log');
  const roll = path.join(home, '.zcode', 'cli', 'rollout');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(roll, { recursive: true });
  const logFile = path.join(logDir, `zcode-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const tokFile = path.join(roll, 'model-io-sess_t1.jsonl');
  fs.writeFileSync(tokFile, ''); // 先建空文件：首见从 EOF 起算
  const line = (event, at) => JSON.stringify({ timestamp: new Date(at).toISOString(), event, sessionId: 's1' });
  const req = (n) => `${JSON.stringify({ response: { usage: { totalTokens: n } } })}\n`;

  const t0 = Date.now();
  fs.writeFileSync(logFile, `${line('turn.phase.started', t0 - 5000)}\n${line('tool.call.started', t0 - 1000)}\n`);
  const monitor = new SessionMonitor({ ...DEFAULTS }, home);

  const s1 = monitor.snapshot(t0);
  assert.strictEqual(s1.aggregate, 'working');
  assert.strictEqual(s1.workTokens, 0);

  fs.appendFileSync(tokFile, req(100));
  assert.strictEqual(monitor.snapshot(t0 + 2000).workTokens, 100);
  fs.appendFileSync(tokFile, req(50));
  assert.strictEqual(monitor.snapshot(t0 + 4000).workTokens, 150);

  // 回合结束 => idle；宽限期内落地的最后一笔计入旧任务，不触发清零
  fs.appendFileSync(logFile, `${line('tool.call.completed', t0 + 10000)}\n${line('turn.phase.completed', t0 + 10000)}\n`);
  fs.appendFileSync(tokFile, req(7));
  const s4 = monitor.snapshot(t0 + 70_000);
  assert.strictEqual(s4.aggregate, 'idle');
  assert.strictEqual(s4.workTokens, 157);

  // 空闲已超 TASK_RESET_GAP_MS 再开工 => 新任务，只算新消耗
  fs.appendFileSync(logFile, `${line('turn.phase.started', t0 + 71_000)}\n`);
  fs.appendFileSync(tokFile, req(200));
  const s5 = monitor.snapshot(t0 + 72_000);
  assert.strictEqual(s5.aggregate, 'working');
  assert.ok(TASK_RESET_GAP_MS === 60 * 1000);
  assert.strictEqual(s5.workTokens, 200);
  monitor.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test('tokenTick：扫描到新增发 tokens 事件；新任务清零显式发 reset', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-emit-'));
  const roll = path.join(home, '.zcode', 'cli', 'rollout');
  fs.mkdirSync(roll, { recursive: true });
  const tokFile = path.join(roll, 'model-io-sess_e1.jsonl');
  fs.writeFileSync(tokFile, '');

  const monitor = new SessionMonitor({ ...DEFAULTS }, home);
  const events = [];
  monitor.on('tokens', (v, r) => events.push([v, r]));
  monitor.lastAggregate = 'working';
  monitor.tokenTick(); // 首见记账，无新增
  fs.appendFileSync(tokFile, `${JSON.stringify({ response: { usage: { totalTokens: 250 } } })}\n`);
  monitor.tokenTick();
  assert.deepStrictEqual(events, [[250, false]]);
  monitor.tokenTick(); // 无新增不发
  assert.deepStrictEqual(events, [[250, false]]);

  // 空闲超阈值再开工：即使本轮无新增也发清零事件（渲染层据此同步归零）
  monitor.lastWorkingAt = Date.now() - TASK_RESET_GAP_MS - 1000;
  monitor.tokenTick();
  assert.deepStrictEqual(events, [[250, false], [0, true]]);
  assert.strictEqual(monitor.workTokens, 0);
  monitor.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

console.log(`\n全部 ${passed} 项测试通过 ✅`);
