'use strict';
/**
 * 会话状态检测模块
 *
 * 两种数据源：
 * 1. Claude Code：~/.claude/projects/<编码后的工作目录>/<sessionId>.jsonl
 *    每轮对话/工具调用都会追加行，mtime 更新。正在干活时 mtime 很新；
 *    回合结束后停止写入（最后一行 type=assistant）。
 * 2. ZCode：~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl 结构化日志
 *    （turn.phase.started/completed、model.request.*、tool.call.* 等
 *    生命周期事件可精确判断"回合进行中"），
 *    以及 ~/.zcode/cli/rollout/model-io-sess_*.jsonl（模型请求时写入）。
 *
 * 状态定义（只有两种）：
 *  - working：有会话正在进行（模型生成中 / 工具执行中）
 *  - idle   ：当前没有进行中的回合
 * 「任务完成」不再是持续状态，而是 working→idle 的**瞬间事件**，由上层播报
 * （气泡 + 提示音 + 系统通知），避免完成后长时间挂着"已完成"导致永不空闲。
 *
 * 另按字节偏移增量扫描同一批日志，累计"本次任务"的 token 消耗
 * （快照带 workTokens；空闲超 60s 再开工视为新任务，清零重计）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  pollIntervalMs: 2000,          // 轮询间隔
  workingWindowMs: 30_000,       // mtime 落在该窗口内 => working（尾部解析失败时的退化路径）
  claudeStaleWorkingMs: 15 * 60 * 1000, // "tool_use 挂着"最多保持 working 的时长（防进程崩溃卡死）
  zcodeInFlightMaxAgeMs: 10 * 60 * 1000, // "回合进行中"判定的事件最大年龄
  zcodeLogTailBytes: 512 * 1024, // 每个日志文件读取的尾部字节数
  bubbleAutoCloseMs: 5 * 60 * 1000, // 完成气泡自动关闭时长（0 = 不自动关）
  sessionEndGraceMs: 3 * 60 * 1000, // 回合结束后静默多久才算"整个任务完成"（期间有新回合则取消）
  watch: { claude: true, zcode: true },
};

const SOURCE_NAMES = { claude: 'Claude Code', zcode: 'ZCode' };

// 新任务判定：空闲超过该时长再开工视为新任务，token 消耗清零重计
// （与渲染层 workTimer 的 WORK_RESET_GAP_MS 同口径）
const TASK_RESET_GAP_MS = 60 * 1000;

// token 快速轮询间隔：与状态检测（默认 2s）解耦，扫描到新增立即发 tokens 事件，
// 消耗数字近实时（纯 stat 增量检查，开销极小）
const TOKEN_POLL_MS = 400;

const ZCODE_START_EVENTS = new Set([
  'turn.phase.started',
  'model.request.started',
  'model.network.started',
  'tool.call.started',
]);
const ZCODE_END_EVENTS = new Set([
  'turn.phase.completed',
  'model.request.completed',
  'model.network.completed',
  'tool.call.completed',
  'tool.call.failed',
  'model.request.failed',
]);

function deepMerge(base, extra) {
  const out = { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig(configPath) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    /* 不存在或非法则用默认值 */
  }
  return deepMerge(DEFAULTS, fileCfg);
}

// ---------- 通用小工具 ----------

/** 读文件尾部若干字节 */
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 读文件头部若干字节 */
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(bytes, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 把 Claude Code 的目录编码名还原为真实路径。
 * 编码规则：`/` 和 `:` 都变成 `-`，因此 `f--work-mcp-gyyp-sass-front` 里
 * 连字符有歧义（分隔符 or 目录名里的字面量 `-`）。
 * 这里用 DFS + 实际存在性检查消歧，结果按名字缓存。
 */
const projectCache = new Map();

function resolveClaudeProject(munged, home = os.homedir()) {
  if (projectCache.has(munged)) return projectCache.get(munged);
  const drive = (munged[0] || 'c').toUpperCase();
  const rest = munged.slice(3); // 跳过 "x--"
  const parts = rest ? rest.split('-') : [];
  const base = `${drive}:\\`;
  const resolved = parts.length ? walkJoin(base, parts) || base + parts.join('-') : base;
  projectCache.set(munged, resolved);
  return resolved;
}

function walkJoin(base, parts) {
  function walk(idx, acc) {
    if (idx === parts.length) return acc;
    for (let j = idx; j < parts.length; j++) {
      const cand = path.join(acc, parts.slice(idx, j + 1).join('-'));
      if (fs.existsSync(cand)) {
        const deeper = walk(j + 1, cand);
        if (deeper) return deeper;
      }
    }
    return null;
  }
  return walk(0, base);
}

// ---------- Claude Code ----------

/**
 * 解析会话 jsonl 尾部，从内容判断回合状态（毫秒级感知完成，不依赖 mtime 窗口）。
 * 从尾部向前找最后一条主线（跳过 isSidechain 子代理记录）记录：
 *  - assistant 且 message.content 含 tool_use  => 工具执行中（哪怕已很久没写入）
 *  - assistant 纯文本                          => 回合自然结束 => waiting
 *  - user（工具结果/新输入）/ progress          => working
 *  - summary/system 等辅助行跳过
 * 返回 'working' | 'waiting' | null（无法判断，调用方退化为 mtime 启发式）
 */
function claudeTurnStateFromTail(tailText) {
  const lines = tailText.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; } // 半截行，往前找
    if (!obj || typeof obj.type !== 'string') continue;
    if (obj.isSidechain) continue; // 子代理记录不代表主回合结束
    switch (obj.type) {
      case 'assistant': {
        const content = obj.message && Array.isArray(obj.message.content)
          ? obj.message.content
          : [];
        const hasToolUse = content.some((b) => b && b.type === 'tool_use');
        return hasToolUse ? 'working' : 'waiting';
      }
      case 'user':
      case 'progress':
        return 'working';
      default:
        continue; // summary / system 等，继续往前找
    }
  }
  return null;
}

/**
 * 扫描近期活跃的 Claude Code 会话（mtime 在 claudeStaleWorkingMs 内），
 * 逐个做尾部解析，用于多会话统计（工作中会话数 / 项目名列表）。mtime 降序。
 */
function scanClaudeActiveSessions(home = os.homedir(), cfg) {
  const root = path.join(home, '.claude', 'projects');
  const out = [];
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pdir = path.join(root, d.name);
      let files;
      try { files = fs.readdirSync(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (Date.now() - st.mtimeMs > cfg.claudeStaleWorkingMs) continue;
        out.push({ file: fp, mtimeMs: st.mtimeMs, project: resolveClaudeProject(d.name, home) });
      }
    }
  } catch { /* 目录不存在 */ }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const s of out) {
    try { s.turnState = claudeTurnStateFromTail(readTail(s.file, 64 * 1024)); } catch { s.turnState = null; }
  }
  return out;
}

/**
 * 纯函数：由会话条目计算 Claude Code 状态（便于测试）
 * best: { mtimeMs, file?, project?, turnState? } | null
 * 只有 working / idle 两种状态：
 *  - turnState=working（tool_use 挂着）=> working，最多保持 claudeStaleWorkingMs（崩溃保护）
 *  - turnState=waiting（回合已结束）  => idle（完成作为事件由 change 监听者播报）
 *  - turnState=null（解析失败）       => 退化为 mtime 启发式
 */
function claudeStateFromData(best, cfg, now = Date.now()) {
  if (!best) return { source: 'claude', state: 'idle' };
  const age = now - best.mtimeMs;
  let busy;
  if (best.turnState === 'working') busy = age <= cfg.claudeStaleWorkingMs;
  else if (best.turnState === 'waiting') busy = false;
  else busy = age <= cfg.workingWindowMs;
  return {
    source: 'claude',
    state: busy ? 'working' : 'idle',
    project: best.project,
    turnState: best.turnState || undefined,
    lastActivityAgoMs: age,
  };
}

// ---------- ZCode ----------

/** 从日志尾部文本解析生命周期事件（保留 sessionId，供按会话分组判定） */
function zcodeEventsFromTail(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o.event !== 'string') continue;
    const t = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(t)) continue;
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : '';
    if (ZCODE_START_EVENTS.has(o.event)) out.push({ t, kind: 'start', event: o.event, sessionId });
    else if (ZCODE_END_EVENTS.has(o.event)) out.push({ t, kind: 'end', event: o.event, sessionId });
  }
  return out;
}

/** 扫描 ZCode 日志与 rollout，返回 {events, rolloutMtime, project, busyCount, latestSessionId} */
function scanZcodeData(home = os.homedir(), cfg, now = Date.now()) {
  const logDir = path.join(home, '.zcode', 'cli', 'log');
  const rolloutDir = path.join(home, '.zcode', 'cli', 'rollout');
  const events = [];
  try {
    const logs = fs.readdirSync(logDir)
      .filter((f) => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-2); // 今天 + 昨天，防止跨零点
    for (const f of logs) {
      try {
        events.push(...zcodeEventsFromTail(readTail(path.join(logDir, f), cfg.zcodeLogTailBytes)));
      } catch { /* ignore */ }
    }
  } catch { /* log 目录不存在 */ }

  let rolloutMtime = 0;
  let busyCount = 0;
  let latestSessionId = null;
  let latestRolloutMtime = 0;
  try {
    for (const f of fs.readdirSync(rolloutDir)) {
      if (!f.startsWith('model-io-sess_') || !f.endsWith('.jsonl')) continue;
      const st = fs.statSync(path.join(rolloutDir, f));
      if (st.mtimeMs > rolloutMtime) rolloutMtime = st.mtimeMs;
      if (now - st.mtimeMs <= cfg.workingWindowMs) busyCount++; // 近期仍在写 => 会话活跃
      const m = f.match(/^model-io-(sess_[0-9a-f-]+)\.jsonl$/i);
      if (st.mtimeMs > latestRolloutMtime && m) {
        latestRolloutMtime = st.mtimeMs;
        latestSessionId = m[1];
      }
    }
  } catch { /* ignore */ }

  // 工作区优先取「最新会话自己」的（rollout 首行 system prompt 里有），
  // bot-state.v3.json 只是全局最近 bot，多项目时会指错，仅作回退
  const project = zcodeSessionWorkspace(rolloutDir, latestSessionId) || scanZcodeWorkspace(home);
  return { events, rolloutMtime, project, busyCount, latestSessionId };
}

/**
 * 从会话自己的 rollout 文件头部提取工作区路径：
 * 首行是 model 请求记录，其 system prompt 里有
 * `Primary working directory: <路径>`（JSON 转义形式）。
 */
function zcodeWorkspaceFromRolloutHead(file) {
  try {
    const head = readHead(file, 64 * 1024);
    const m = head.match(/Primary working directory: (.*?)(?:\\n|")/);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\\\/g, '\\');
    }
  } catch {
    return null;
  }
}

// 每会话只解析一次（rollout 头部内容固定，没必要每轮重读）
const zcodeWsCache = { id: null, path: null };

function zcodeSessionWorkspace(rolloutDir, sessionId) {
  if (!sessionId) return null;
  if (zcodeWsCache.id === sessionId) return zcodeWsCache.path;
  const ws = zcodeWorkspaceFromRolloutHead(path.join(rolloutDir, `model-io-${sessionId}.jsonl`));
  if (ws) {
    zcodeWsCache.id = sessionId;
    zcodeWsCache.path = ws;
  }
  return ws;
}

/**
 * 读最近活跃 bot 的工作区路径（~/.zcode/v2/bot-state.v3.json），
 * 用于完成消息里说明"什么任务"。
 */
function scanZcodeWorkspace(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'v2', 'bot-state.v3.json'), 'utf8'));
    let best = null;
    for (const bot of Object.values(raw.bots || {})) {
      if (!bot.workspacePath) continue;
      if (!best || (bot.updatedAt || 0) > (best.updatedAt || 0)) best = bot;
    }
    return best ? best.workspacePath : null;
  } catch {
    return null;
  }
}

/**
 * 纯函数：由事件列表 + rollout mtime 计算 ZCode 状态（便于测试）
 * 事件按 sessionId 分组，各会话独立判定"回合进行中"（该会话最新 start 晚于最新 end
 * 且未超时）；任一会话进行中 => working，workingSessions 即进行中的会话清单
 * （其数量 = 真实并行会话数）。不能用全局最后一条 start/end 比较：多会话并行时
 * 其它会话刚写入的 end 会把整体误判成空闲。
 */
function zcodeStateFromData(events, rolloutMtime, cfg, now = Date.now()) {
  const perSession = new Map();
  let lastEvent = null;
  let latest = 0;
  for (const e of events) {
    if (!e.t) continue;
    if (e.t > latest) { latest = e.t; lastEvent = e.event; }
    const id = e.sessionId || '';
    const s = perSession.get(id) || { lastStart: 0, lastEnd: 0 };
    if (e.kind === 'start' && e.t > s.lastStart) s.lastStart = e.t;
    if (e.kind === 'end' && e.t > s.lastEnd) s.lastEnd = e.t;
    perSession.set(id, s);
  }

  const workingSessions = [];
  for (const [sessionId, s] of perSession) {
    if (s.lastStart > 0 && s.lastStart > s.lastEnd
      && (now - s.lastStart) <= cfg.zcodeInFlightMaxAgeMs) {
      workingSessions.push({ sessionId: sessionId || '(unknown)', startedAt: s.lastStart });
    }
  }
  workingSessions.sort((a, b) => b.startedAt - a.startedAt);

  if (workingSessions.length) {
    return {
      source: 'zcode',
      state: 'working',
      lastEvent,
      lastActivityAgoMs: now - workingSessions[0].startedAt,
      workingSessions,
    };
  }

  // 日志里解析不到任何事件时，用 rollout mtime 短窗口兜底
  if (!latest && rolloutMtime && (now - rolloutMtime) <= cfg.workingWindowMs) {
    return {
      source: 'zcode',
      state: 'working',
      lastEvent: null,
      lastActivityAgoMs: now - rolloutMtime,
      workingSessions: [],
    };
  }

  const lastActivity = Math.max(latest, rolloutMtime);
  return {
    source: 'zcode',
    state: 'idle',
    lastEvent,
    lastActivityAgoMs: lastActivity ? now - lastActivity : undefined,
    workingSessions: [],
  };
}

// ---------- Token 消耗扫描（本次任务，增量读日志） ----------
// 口径：输入+输出总消耗（含缓存读，与套餐额度扣减口径一致）。两来源：
//  - ZCode：rollout 每行一次模型请求，response.usage.totalTokens 已含缓存读
//  - Claude：会话 jsonl 的 assistant 行 message.usage（子代理行也是真实消耗，一并计）

/** 单条 ZCode rollout 记录 => 该请求消耗的 token 数（无 usage 返回 0） */
function zcodeLineTokens(o) {
  const t = Number(o && o.response && o.response.usage && o.response.usage.totalTokens);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** 单条 Claude 会话记录 => 该条消耗（四类 token 求和；无 usage 返回 0） */
function claudeLineTokens(o) {
  const u = o && o.message && o.message.usage;
  if (!u) return 0;
  let sum = 0;
  for (const k of ['input_tokens', 'cache_creation_input_tokens',
    'cache_read_input_tokens', 'output_tokens']) {
    const v = Number(u[k]);
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

/**
 * 按字节偏移增量消费日志文件：每个文件只读上次之后的新增完整行，
 * 半截行留到写全后的下一轮。首见文件从当前末尾起算（只算观察期内的消耗）。
 */
class TokenScanner {
  constructor() {
    this.offsets = new Map(); // file => 已消费到的字节偏移
  }

  /** 读取 file 新增部分并按 parseLine 累加，返回本次新增的 token 数 */
  readDeltas(file, parseLine) {
    let st;
    try { st = fs.statSync(file); } catch { return 0; }
    let from = this.offsets.get(file);
    if (from === undefined) { this.offsets.set(file, st.size); return 0; }
    if (st.size <= from) return 0; // 无新增（文件被截断重建时按新末尾重新起算）
    if (from > st.size) { this.offsets.set(file, st.size); return 0; }

    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString('utf8');
      const cut = text.lastIndexOf('\n'); // 只消费完整行
      let consumed = from;
      let tokens = 0;
      if (cut >= 0) {
        consumed = from + cut + 1;
        for (const line of text.slice(0, cut).split('\n')) {
          if (!line) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          tokens += parseLine(o);
        }
      }
      this.offsets.set(file, consumed);
      return tokens;
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /** 扫描两来源日志目录的增量，返回本次新增 token 总数（顺带清理已消失文件的偏移） */
  scan(home = os.homedir()) {
    let delta = 0;
    const seen = new Set();
    try {
      const dir = path.join(home, '.zcode', 'cli', 'rollout');
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('model-io-sess_') || !f.endsWith('.jsonl')) continue;
        const fp = path.join(dir, f);
        seen.add(fp);
        delta += this.readDeltas(fp, zcodeLineTokens);
      }
    } catch { /* rollout 目录不存在 */ }
    try {
      const root = path.join(home, '.claude', 'projects');
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const pdir = path.join(root, d.name);
        let files;
        try { files = fs.readdirSync(pdir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(pdir, f);
          seen.add(fp);
          delta += this.readDeltas(fp, claudeLineTokens);
        }
      }
    } catch { /* projects 目录不存在 */ }
    for (const fp of this.offsets.keys()) {
      if (!seen.has(fp)) this.offsets.delete(fp);
    }
    return delta;
  }
}

// ---------- 汇总 ----------

/** 聚合多个来源的状态：任一 working => working，否则 idle */
function aggregateOf(states) {
  return states.some((s) => s && s.state === 'working') ? 'working' : 'idle';
}

/**
 * "整个任务完成"判定门。
 * 回合结束（working→idle）只是单轮完成；静默 sessionEndGraceMs 内没有新回合
 * 才算整个任务完成。期间有新回合（idle→working）则撤销判定。
 * 时间由调用方注入（便于测试）。
 */
class CompletionGate {
  constructor(graceMs) {
    this.graceMs = graceMs;
    this.idleSince = {}; // source -> 转入 idle 的时刻
  }

  /** 来源发生状态转换时调用；to: 'working' | 'idle' */
  onTransition(source, to, now = Date.now()) {
    if (to === 'working') {
      delete this.idleSince[source]; // 又开工了，撤销待判定的完成
    } else if (to === 'idle') {
      this.idleSince[source] = now;
    }
  }

  /** 每次轮询调用；宽限期满返回 'complete'（只返回一次） */
  poll(source, now = Date.now()) {
    const t0 = this.idleSince[source];
    if (t0 === undefined) return null;
    if (now - t0 >= this.graceMs) {
      delete this.idleSince[source];
      return 'complete';
    }
    return null;
  }
}

class SessionMonitor extends EventEmitter {
  constructor(cfg = DEFAULTS, home = os.homedir()) {
    super();
    this.cfg = cfg;
    this.home = home;
    this.prev = {};
    this.gate = new CompletionGate(cfg.sessionEndGraceMs);
    this.scanner = new TokenScanner();
    this.workTokens = 0;    // 本次任务累计 token 消耗
    this.lastWorkingAt = 0; // 最近一次 working 的时刻（算空闲时长、判新任务）
    this.lastAggregate = 'idle'; // 最近一次快照的聚合状态（token 快速轮询复用）
    this.timer = null;
    this.tokenTimer = null;
  }

  /** 单次探测（不发事件） */
  snapshot(now = Date.now()) {
    const snap = { now, claude: null, zcode: null, aggregate: 'idle' };
    if (this.cfg.watch.claude) {
      try {
        const sessions = scanClaudeActiveSessions(this.home, this.cfg);
        const best = sessions[0] || null;
        // 工作中的会话（scan 已按 mtime ≤ claudeStaleWorkingMs 预过滤）。
        // 不能只看最新一个文件定状态：最新会话空闲时，其它正在跑工具的会话会被漏掉
        const working = sessions.filter((s) => s.turnState === 'working');
        if (working.length) {
          const w = working[0]; // mtime 降序 => 最近活动的工作中会话
          snap.claude = {
            source: 'claude',
            state: 'working',
            project: w.project,
            turnState: 'working',
            lastActivityAgoMs: now - w.mtimeMs,
          };
        } else {
          snap.claude = claudeStateFromData(best, this.cfg, now);
        }
        let count = working.length;
        let names = working.map((s) => s.project);
        if (snap.claude.state === 'working' && count === 0) {
          // 尾部解析不可用的回退路径：至少算 1 个
          count = 1;
          names = best ? [best.project] : [];
        }
        snap.claude.sessions = { count, names };
      } catch (e) {
        snap.claude = { source: 'claude', state: 'unknown', error: String(e.message || e) };
      }
    }
    if (this.cfg.watch.zcode) {
      try {
        const { events, rolloutMtime, project, busyCount, latestSessionId } =
          scanZcodeData(this.home, this.cfg, now);
        const state = zcodeStateFromData(events, rolloutMtime, this.cfg, now);
        snap.zcode = {
          ...state,
          project,
          latestSessionId,
          // 工作中会话数：按 sessionId 分组的"回合进行中"会话数（真实并行数）。
          // 不能用近期写过的 rollout 文件数：会话刚结束的 30s 内文件仍新 => 虚高，
          // 长工具执行超 30s 不写模型日志 => 虚低。无事件兜底时才退回旧近似，至少算 1
          sessions: {
            count: state.state === 'working'
              ? (state.workingSessions.length || Math.max(1, busyCount))
              : 0,
          },
        };
      } catch (e) {
        snap.zcode = { source: 'zcode', state: 'unknown', error: String(e.message || e) };
      }
    }
    snap.aggregate = aggregateOf([snap.claude, snap.zcode]);
    this.lastAggregate = snap.aggregate;

    // token 消耗走独立的快速轮询（tokenTick，默认 400ms）；快照顺带带上当前总数
    if (this.cfg.watch.claude || this.cfg.watch.zcode) {
      snap.workTokens = this.tokenTick(now);
    }
    return snap;
  }

  /**
   * token 快速轮询（与状态检测解耦，默认 400ms 一次）：
   * 增量扫日志 + 新任务重置（口径与渲染层 workTimer 一致：空闲超
   * TASK_RESET_GAP_MS 再开工 => 清零重计）。回合刚结束的宽限期内继续扫，
   * 兜住最后一条响应落在 idle 判定之后的情况。
   * 发 'tokens' 事件：有新增时携带最新总数；新任务清零即使无新增也发
   * （第二参数 reset=true），渲染层据此同步归零，避免旧数值残留。
   */
  tokenTick(now = Date.now()) {
    if (!(this.cfg.watch.claude || this.cfg.watch.zcode)) return this.workTokens;
    const working = this.lastAggregate === 'working';
    const idleFor = this.lastWorkingAt ? now - this.lastWorkingAt : Infinity;
    if (!working && idleFor > this.cfg.sessionEndGraceMs) return this.workTokens;
    let reset = false;
    if (working && this.lastWorkingAt && idleFor >= TASK_RESET_GAP_MS) {
      this.workTokens = 0;
      reset = true;
    }
    const delta = this.scanner.scan(this.home);
    if (working) this.lastWorkingAt = now;
    if (delta > 0 || reset) {
      this.workTokens += delta;
      this.emit('tokens', this.workTokens, reset);
    }
    return this.workTokens;
  }

  tick() {
    const snap = this.snapshot();
    const now = snap.now;
    for (const src of ['claude', 'zcode']) {
      const cur = snap[src] && snap[src].state;
      const prev = this.prev[src];
      if (prev && cur && prev !== cur) {
        this.gate.onTransition(src, cur, now);
        this.emit('change', { source: src, from: prev, to: cur, snapshot: snap });
      }
      if (cur) this.prev[src] = cur;
      // 宽限期满 => 整个任务完成
      if (this.gate.poll(src, now) === 'complete') {
        this.emit('complete', { source: src, snapshot: snap });
      }
    }
    this.emit('snapshot', snap);
    return snap;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.cfg.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
    this.tokenTimer = setInterval(() => this.tokenTick(), TOKEN_POLL_MS);
    if (this.tokenTimer.unref) this.tokenTimer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.timer = this.tokenTimer = null;
  }
}

// ---------- CLI：node monitor.js --once ----------
if (require.main === module) {
  const cfg = loadConfig(path.join(__dirname, 'config.json'));
  if (process.argv.includes('--once')) {
    const snap = new SessionMonitor(cfg).snapshot();
    for (const src of ['claude', 'zcode']) {
      const s = snap[src];
      if (!s) { console.log(`${SOURCE_NAMES[src]}: (未启用)`); continue; }
      const ago = s.lastActivityAgoMs != null ? `（${Math.round(s.lastActivityAgoMs / 1000)}s 前）` : '';
      const proj = s.project ? ` · ${s.project}` : '';
      const n = s.sessions && s.sessions.count;
      const cnt = s.state === 'working' && n ? ` ×${n}` : '';
      console.log(`${SOURCE_NAMES[src]}: ${s.state}${cnt}${ago}${proj}${s.error ? ` · ${s.error}` : ''}`);
    }
    console.log(`总体: ${snap.aggregate}`
      + (snap.workTokens != null ? ` · 本次任务 token: ${snap.workTokens}` : ''));
  } else {
    console.log('用法: node monitor.js --once   # 打印一次检测结果');
  }
}

module.exports = {
  DEFAULTS,
  SOURCE_NAMES,
  loadConfig,
  deepMerge,
  readTail,
  claudeTurnStateFromTail,
  resolveClaudeProject,
  scanClaudeActiveSessions,
  claudeStateFromData,
  scanZcodeData,
  scanZcodeWorkspace,
  zcodeWorkspaceFromRolloutHead,
  zcodeSessionWorkspace,
  zcodeEventsFromTail,
  zcodeStateFromData,
  zcodeLineTokens,
  claudeLineTokens,
  TokenScanner,
  TASK_RESET_GAP_MS,
  aggregateOf,
  CompletionGate,
  SessionMonitor,
};
