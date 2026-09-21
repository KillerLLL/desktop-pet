'use strict';
/* 渲染进程：两态宠物、状态栏（空闲隐藏/工作显示来源 tag + 会话数）、
   完成气泡（多实例/贴猫头向上堆叠/可配置自动关/手动关）、
   完成历史面板（贴猫四角，按猫在屏幕位置选上/下与左/右，不盖猫）、
   右键功能菜单（与历史面板同款白卡片，内联图标 + 开关勾选态）、
   参数设置面板（config 参数档位步进 + 监控开关，改动实时生效）、
   点击语录 500 条（部分动态带时间/星期/时段，联网时还有天气与电量） */

const appEl = document.getElementById('app');
const bubbleEl = document.getElementById('bubble');
const stateTextEl = document.getElementById('state-text');
const timerEl = document.getElementById('work-timer');
const tokensEl = document.getElementById('work-tokens');
const toastsEl = document.getElementById('toasts');
const panelEl = document.getElementById('history-panel');
const histListEl = document.getElementById('hist-list');

const SOURCE_SHORT = { claude: 'Claude', zcode: 'ZCode' };
const MAX_TOASTS = 3;
const MAX_HISTORY = 50;

/* 取路径最后一段（项目文件夹名）：气泡只显示它，历史里保留完整路径 */
function lastSeg(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/* ---------- 简易气泡（开工/互动提示，自动消失；可选前置图标） ---------- */
let bubbleTimer = null;
function showBubble(text, holdMs = 3500, icon = '') {
  bubbleEl.innerHTML = (icon ? PetIcons.svg(icon, 12, 'bubble-ic') : '')
    + `<span>${text}</span>`;
  bubbleEl.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.add('hidden'), holdMs);
}

/* ---------- 形态：working / idle；状态栏：空闲隐藏，工作时显示来源 tag + 会话数 ---------- */
function setStateClass(state) {
  appEl.classList.remove('st-working', 'st-idle');
  appEl.classList.add(`st-${state}`);
}

/* 右上角状态角标：空闲（灰点）/ 工作中（橙点，合并各 agent 会话数） */
function renderBadge(snap) {
  const working = snap.aggregate === 'working';
  const parts = [];
  if (working) {
    for (const [source, short] of Object.entries(SOURCE_SHORT)) {
      const s = snap[source];
      if (s && s.state === 'working') {
        parts.push(`${short} ×${(s.sessions && s.sessions.count) || 1}`);
      }
    }
  }
  stateTextEl.classList.toggle('working', working);
  stateTextEl.classList.toggle('idle', !working);
  stateTextEl.innerHTML = `<i class="sdot"></i>${working ? '工作中' : '空闲'}`
    + (parts.length
      ? '<span class="sep">·</span>'
        + parts.map((p) => `<span class="src">${p}</span>`).join('<span class="sep">·</span>')
      : '');
}

function render(snap) {
  if (!snap) return;
  renderBadge(snap);
  if (typeof snap.workTokens === 'number') {
    lastWorkTokens = snap.workTokens;
    updateTokenTarget(snap.workTokens);
  }
  advanceWorkTimer(snap.aggregate === 'working');
  setStateClass(snap.aggregate === 'working' ? 'working' : 'idle');
}

/* ---------- 工作用时：聚合状态为 working 期间累积的计时器 ----------
   一个任务里来回多个回合（working↔idle），只累计"正在工作"的时间慢慢累积；
   空闲超过 WORK_RESET_GAP_MS 再开工视为新任务，用时清零从头计。 */
const WORK_RESET_GAP_MS = 60 * 1000;
let workTimer = { accMs: 0, segStart: 0 }; // segStart=当前工作段起点（0=不在工作中）
let idleSince = 0; // 当前空闲段起点（0=不在空闲段）
let lastWorkTokens = 0; // 快照里最新的本次任务 token 数（complete 时兜底取用）

/** 毫秒 => mm:ss（满一小时 h:mm:ss） */
function fmtDur(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** token 数 => 紧凑显示：<1万 原样，≥1万 一位小数 + 万 */
function fmtTokens(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

/** 完成时刻：今天只显示时分，跨天记录带月-日 */
function fmtClock(ts) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function workElapsedMs(now = Date.now()) {
  return workTimer.accMs + (workTimer.segStart ? now - workTimer.segStart : 0);
}

/** 走表：对齐到用时的整数秒边界刷新。唯一刷新源、每次按真实时钟重算下一次
    延迟 => 数字每秒准时跳一格，不会忽快忽慢（也不受定时器漂移/节流影响）。 */
let tickTimer = null;
function scheduleTick() {
  clearTimeout(tickTimer);
  if (!workTimer.segStart) return;
  const delay = 1000 - (workElapsedMs() % 1000) + 5;
  tickTimer = setTimeout(() => {
    if (!workTimer.segStart) return;
    timerEl.querySelector('.wt-val').textContent = fmtDur(workElapsedMs());
    scheduleTick();
  }, delay);
}

/** 每次快照推进计时：进入 working 开段计时，退出则把本段并入累计 */
function advanceWorkTimer(working) {
  const now = Date.now();
  if (working) {
    if (!workTimer.segStart) {
      // 新工作段：距上一段空闲超过阈值 => 新任务，清零重计
      if (idleSince && now - idleSince >= WORK_RESET_GAP_MS) resetTokenAnim(); // token 同口径清零
      workTimer.segStart = now;
      idleSince = 0;
      timerEl.classList.add('show');
      tokensEl.classList.add('show');
      timerEl.querySelector('.wt-val').textContent = fmtDur(workElapsedMs(now));
      scheduleTick();
      startTokenAnim();
    }
  } else {
    if (workTimer.segStart) {
      workTimer.accMs += now - workTimer.segStart;
      workTimer.segStart = 0;
      timerEl.classList.remove('show');
      tokensEl.classList.remove('show');
      stopTokenAnim();
    }
    if (!idleSince) idleSince = now;
  }
}

/* ---------- 消耗数字动画：真实值由 400ms 快速通道推送，仍有请求间隔 ----------
   rAF 平滑逼近目标值；目标间隙按最近增速小幅外推，数字保持向前走。
   两条铁律：显示值**只涨不跌**（外推冲过头时原地暂停，等真实值追上来再走，
   决不回退）；外推窗口 1.2s（超出即视为停滞，停帧省电，新目标到达再唤醒）。 */
const tokAnim = { shown: 0, target: 0, targetAt: 0, rate: 0, raf: 0, lastFrame: 0, lastText: '0' };
const tokValEl = tokensEl.querySelector('.wk-val');
const TOKEN_EXTRAP_MS = 1200; // 外推窗口：真实值到达间隔（400ms 轮询 + 写盘延迟）再放宽些

function startTokenAnim() {
  if (tokAnim.raf) return;
  tokAnim.lastFrame = 0;
  tokAnim.raf = requestAnimationFrame(stepTokenAnim);
}

function stopTokenAnim() {
  if (tokAnim.raf) cancelAnimationFrame(tokAnim.raf);
  tokAnim.raf = 0;
}

/** 新任务清零：状态归零并立即写 0，不走缓动（这是唯一的回落时刻） */
function resetTokenAnim() {
  stopTokenAnim();
  tokAnim.shown = 0;
  tokAnim.target = 0;
  tokAnim.rate = 0;
  tokAnim.lastText = '0';
  tokValEl.textContent = '0';
}

/** 快照到达：更新目标值与最近增速（只增不减；清零走 resetTokenAnim） */
function updateTokenTarget(v) {
  if (v === tokAnim.target) { startTokenAnim(); return; } // 无新信息：不打断现有外推
  if (v > tokAnim.target) {
    const now = performance.now();
    const dt = now - tokAnim.targetAt;
    tokAnim.rate = dt > 0 ? (v - tokAnim.target) / dt : 0;
    tokAnim.target = v;
    tokAnim.targetAt = now;
  }
  startTokenAnim();
}

function stepTokenAnim(ts) {
  const dt = Math.min(100, ts - (tokAnim.lastFrame || ts));
  tokAnim.lastFrame = ts;
  const age = ts - tokAnim.targetAt;
  const est = age <= TOKEN_EXTRAP_MS ? tokAnim.target + tokAnim.rate * age : tokAnim.target;
  let next = tokAnim.shown + (est - tokAnim.shown) * (1 - Math.pow(0.88, dt / 16.7)); // 指数缓动
  if (next < tokAnim.shown) next = tokAnim.shown; // 外推过头 => 原地暂停，等真实值追上
  tokAnim.shown = next;
  const text = fmtTokens(Math.round(tokAnim.shown));
  if (text !== tokAnim.lastText) {
    tokAnim.lastText = text;
    tokValEl.textContent = text;
  }
  tokAnim.raf = (age > TOKEN_EXTRAP_MS && tokAnim.shown >= est - 0.5)
    ? 0 // 过了外推窗口且已追平（或暂停等真实值）=> 停帧，新目标到达再唤醒
    : requestAnimationFrame(stepTokenAnim);
}

/* ---------- 完成历史（localStorage 持久化，面板查看） ---------- */
let history = [];
try {
  history = JSON.parse(localStorage.getItem('pet-history') || '[]');
  if (!Array.isArray(history)) history = [];
} catch { history = []; }

function pushHistory(entry) {
  history.unshift(entry);
  history = history.slice(0, MAX_HISTORY);
  try { localStorage.setItem('pet-history', JSON.stringify(history)); } catch { /* ignore */ }
}

function renderHistory() {
  histListEl.innerHTML = '';
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    empty.textContent = '还没有完成记录';
    histListEl.appendChild(empty);
    return;
  }
  for (const h of history) {
    const item = document.createElement('div');
    item.className = 'hist-item';
    const timeText = h.ts ? fmtClock(h.ts) : h.time; // 兼容旧记录（只有 time 字符串）
    item.innerHTML = `<span class="h-time">${PetIcons.svg('clock', 10)}${timeText}</span><span class="h-name">${h.name}</span> 任务已完成`
      + ((h.project || h.durationMs || h.tokens) ? `<div class="h-meta">`
        + (h.project ? `<span class="h-proj">${PetIcons.svg('folder', 10)} ${h.project}</span>` : '')
        + (h.durationMs ? `<span class="h-dur">${PetIcons.svg('timer', 10)} ${fmtDur(h.durationMs)}</span>` : '')
        + (h.tokens ? `<span class="h-tok" title="本次任务 Token 消耗">${PetIcons.svg('chart', 10)} ${fmtTokens(h.tokens)}</span>` : '')
        + `</div>` : '');
    histListEl.appendChild(item);
  }
}

/* ---------- 完成历史面板：贴在猫四角之一的小卡片，不盖猫 ----------
   猫在屏幕下半 => 面板在猫上方（左上/右上）；上半 => 猫下方（左下/右下）；
   左右贴边朝屏幕中间那一侧靠。窗口内空间不足时主进程临时扩窗，猫位置不动。 */
let panelSide = 'right';

function panelCorner() {
  const cx = window.screenX + window.outerWidth / 2; // 窗口即猫的包围盒
  const cy = window.screenY + window.outerHeight / 2;
  // avail* 是全局坐标：用所在显示器工作区中心判断半区（兼容副屏负坐标）
  const midX = window.screen.availLeft + window.screen.availWidth / 2;
  const midY = window.screen.availTop + window.screen.availHeight / 2;
  return {
    dir: cy > midY ? 'up' : 'down',
    side: cx < midX ? 'right' : 'left',
  };
}

function applyPanelClasses(dir) {
  appEl.classList.toggle('panel-up', dir === 'up');
  appEl.classList.toggle('panel-down', dir === 'down');
  appEl.classList.toggle('anchor-top', dir === 'down');
  appEl.classList.toggle('side-left', dir !== 'off' && panelSide === 'left');
  appEl.classList.toggle('side-right', dir !== 'off' && panelSide === 'right');
  appEl.classList.toggle('panel-open', dir === 'up' || dir === 'down');
}

function toggleHistory(force) {
  const show = force !== undefined ? force : panelEl.classList.contains('hidden');
  if (show) {
    closeSettingsPanel(); // 与参数/用量面板互斥
    closeUsagePanel();
    renderHistory();
    const { dir, side } = panelCorner();
    panelSide = side;
    applyPanelClasses(dir);
    panelEl.style.maxHeight = ''; // 等主进程回报实际扩出的高度
    window.petApi.setPanelSpace({ dir, px: 240 });
  } else {
    applyPanelClasses('off');
    window.petApi.setPanelSpace({ dir: 'off' });
  }
  panelEl.classList.toggle('hidden', !show);
}

// 主进程回报实际扩窗结果：菜单打开时只同步方向；面板打开时限高；空间不足换向时同步类名
window.petApi.onPanelSpace(({ dir, px }) => {
  if (ctxOpen) { applyCtxClasses(dir); return; }
  const histOpen = !panelEl.classList.contains('hidden');
  const setOpen = !settingsEl.classList.contains('hidden');
  const usageOpen = !usageEl.classList.contains('hidden');
  if (!histOpen && !setOpen && !usageOpen) return;
  if (dir) applyPanelClasses(dir);
  if (histOpen) panelEl.style.maxHeight = `${Math.max(60, px - 12)}px`;
  if (setOpen) settingsEl.style.maxHeight = `${Math.max(60, px - 12)}px`;
  if (usageOpen) usageEl.style.maxHeight = `${Math.max(60, px - 12)}px`;
});

document.getElementById('hist-close').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleHistory(false);
});
document.getElementById('hist-clear').addEventListener('click', (e) => {
  e.stopPropagation();
  history = [];
  try { localStorage.removeItem('pet-history'); } catch { /* ignore */ }
  renderHistory();
});
// 面板内点击不触发宠物拖拽/互动
panelEl.addEventListener('mousedown', (e) => e.stopPropagation());

/* ---------- 右键功能菜单：与历史面板同款白卡片，条目带内联图标 ----------
   开关项（提示音/置顶）右侧橙色对勾表示开启态；与历史面板互斥共用「临时扩窗」：
   打开菜单前先收起历史面板，关闭时归还扩窗空间。 */
const ctxEl = document.getElementById('context-menu');
let ctxOpen = false;

const CTX_ITEMS = [
  { action: 'toggle-sound', icon: 'bell', label: '完成提示音', toggle: true },
  { action: 'toggle-top', icon: 'pin', label: '窗口置顶', toggle: true },
  { sep: true },
  { action: 'history', icon: 'clock', label: '完成历史' },
  { action: 'settings', icon: 'gear', label: '参数设置' },
  { action: 'usage', icon: 'chart', label: 'Token 厂家列表' },
  { action: 'open-dir', icon: 'folder', label: '打开程序目录' },
  { action: 'debug', icon: 'eye', label: '查看当前检测状态' },
  { sep: true },
  { action: 'quit', icon: 'power', label: '退出', danger: true },
];

for (const def of CTX_ITEMS) {
  if (def.sep) {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    ctxEl.appendChild(sep);
    continue;
  }
  const item = document.createElement('div');
  item.className = 'ctx-item' + (def.danger ? ' danger' : '');
  item.dataset.action = def.action;
  item.innerHTML = `<span class="ci-ic">${PetIcons.svg(def.icon, 13)}</span>`
    + `<span class="ci-label">${def.label}</span>`
    + (def.toggle ? `<span class="ci-check">${PetIcons.svg('tick', 11)}</span>` : '');
  ctxEl.appendChild(item);
}

/** 打开前拉一次开关态：勾选标记跟着主进程的真实状态走 */
async function refreshCtxChecks() {
  let st = { sound: false, top: false };
  try { st = await window.petApi.menuState(); } catch { /* 主进程未就绪则不勾选 */ }
  const itemSound = ctxEl.querySelector('[data-action="toggle-sound"]');
  const itemTop = ctxEl.querySelector('[data-action="toggle-top"]');
  if (itemSound) itemSound.classList.toggle('on', !!st.sound);
  if (itemTop) itemTop.classList.toggle('on', !!st.top);
}

function applyCtxClasses(dir) {
  appEl.classList.toggle('panel-up', dir === 'up');
  appEl.classList.toggle('panel-down', dir === 'down');
  appEl.classList.toggle('anchor-top', dir === 'down');
  appEl.classList.toggle('side-left', panelSide === 'left');
  appEl.classList.toggle('side-right', panelSide === 'right');
  appEl.classList.add('panel-open'); // 复用历史面板的「打开时隐藏气泡流」
}

function closeCtx() {
  if (!ctxOpen) return;
  ctxOpen = false;
  ctxEl.classList.add('hidden');
  appEl.classList.remove('panel-up', 'panel-down', 'anchor-top', 'side-left', 'side-right', 'panel-open');
  window.petApi.setPanelSpace({ dir: 'off' }); // 归还扩窗空间
}

async function openCtx() {
  if (ctxOpen) { closeCtx(); return; } // 再按一次右键 = 收起（与系统菜单一致）
  closeHistoryPanel(); // 与历史/参数/用量面板互斥，共用扩窗空间
  closeSettingsPanel();
  closeUsagePanel();
  ctxOpen = true;
  await refreshCtxChecks();
  if (!ctxOpen) return; // 等待状态期间被关掉（如窗口失焦）
  const { dir, side } = panelCorner();
  panelSide = side;
  applyCtxClasses(dir);
  ctxEl.classList.remove('hidden');
  window.petApi.setPanelSpace({ dir, px: 240 });
}

ctxEl.addEventListener('mousedown', (e) => e.stopPropagation()); // 菜单内点击不触发拖拽/互动
ctxEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation(); // 菜单上右键不再触发开合
});
ctxEl.addEventListener('click', (e) => {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  const action = item.dataset.action;
  closeCtx();
  if (action === 'history') toggleHistory(true); // 面板在渲染层，直接开
  else if (action === 'settings') toggleSettings(true); // 参数面板同理
  else if (action === 'usage') toggleUsage(true, 'list'); // 右键菜单直达厂家列表
  else if (action === 'debug') showDebugStatus();
  else window.petApi.menuAction(action);
});
// 点菜单外任意处 / 窗口失焦 / Esc 都收起菜单
document.addEventListener('mousedown', (e) => {
  if (ctxOpen && !ctxEl.contains(e.target)) closeCtx();
}, true);
window.addEventListener('blur', () => closeCtx());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCtx(); closeSettingsPanel(); closeUsagePanel(); }
});

/** 查看当前检测状态：气泡里各来源一行实时状态 */
async function showDebugStatus() {
  let snap = null;
  try { snap = await window.petApi.getSnapshot(); } catch { /* ignore */ }
  if (!snap) return;
  const parts = [];
  for (const [src, short] of Object.entries(SOURCE_SHORT)) {
    const s = snap[src];
    if (!s) continue;
    const n = (s.sessions && s.sessions.count) || 0;
    parts.push(`${short} ${s.state === 'working' ? `工作中${n > 1 ? ` ×${n}` : ''}` : '空闲'}`);
  }
  showBubble(parts.join(' · ') || '暂无检测数据', 6000);
}

/* ---------- 参数设置面板：config.json 的可视化入口 ----------
   数值参数按预设档位 ‹ › 步进（档位见 SET_PARAMS），监控开关为迷你拨动；
   改动即时生效并写回 config.json（主进程热应用：轮询重启计时器、
   宽限期同步进完成判定门）。面板贴猫四角，与历史面板互斥。 */
const settingsEl = document.getElementById('settings-panel');
const setListEl = document.getElementById('settings-list');

const SET_PARAMS = [
  { key: 'pollIntervalMs', label: '轮询间隔', def: 2000,
    presets: [1000, 2000, 5000, 10000], tip: '多久扫描一次会话日志' },
  { key: 'sessionEndGraceMs', label: '完成宽限', def: 180000,
    presets: [10000, 30000, 60000, 180000, 300000, 600000],
    tip: '回合结束后静默多久判定「整个任务完成」；点击数值可自定义' },
  { key: 'bubbleAutoCloseMs', label: '气泡自动关', def: 300000, allowZero: true,
    presets: [10000, 30000, 60000, 300000, 600000, 0],
    tip: '完成气泡自动关闭时长；点击数值可自定义' },
  { key: 'workingWindowMs', label: '兜底窗口', def: 30000,
    presets: [15000, 30000, 60000, 120000], tip: '日志尾部解析失败时按文件修改时间判活的时间窗' },
  { key: 'claudeStaleWorkingMs', label: 'Claude 挂起上限', def: 900000,
    presets: [300000, 900000, 1800000, 3600000], tip: 'tool_use 挂起最久保持工作中的时长（防进程崩溃卡死）' },
  { key: 'zcodeInFlightMaxAgeMs', label: 'ZCode 挂起上限', def: 600000,
    presets: [300000, 600000, 1800000, 3600000], tip: '回合进行中判定的事件最大年龄' },
];
const SET_WATCH = [
  { key: 'claude', label: '监控 Claude Code' },
  { key: 'zcode', label: '监控 ZCode' },
];
let settingsVals = null; // 面板当前展示的配置快照（打开时从主进程拉取）

function closeHistoryPanel() { if (!panelEl.classList.contains('hidden')) toggleHistory(false); }
function closeSettingsPanel() { if (!settingsEl.classList.contains('hidden')) toggleSettings(false); }

/** 毫秒 => 人类可读（0 只会出现在「气泡自动关」=> 不自动关；
    非整分钟/整小时直接用秒表示，如 90 秒，避免 1.5 分钟被显示成 2 分钟） */
function fmtMs(ms) {
  ms = Number(ms) || 0;
  if (ms === 0) return '不自动关';
  if (ms >= 3600000) {
    const h = ms / 3600000;
    return Number.isInteger(h) ? `${h} 小时` : `${Math.round(ms / 60000)} 分钟`;
  }
  if (ms >= 60000) {
    const m = ms / 60000;
    return Number.isInteger(m) ? `${m} 分钟` : `${Math.round(ms / 1000)} 秒`;
  }
  return `${Math.round(ms / 1000)} 秒`;
}

/** 文本 => 毫秒：默认按秒，也认「3分」「90秒」「2m」「1min」；非法返回 NaN */
function parseDur(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(分|分钟|秒|s|sec|m|min)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const u = (m[2] || '').toLowerCase();
  return Math.round(n * ((u.startsWith('分') || u === 'm' || u === 'min') ? 60000 : 1000));
}

// 行结构只建一次，值随 settingsVals 刷新
for (const def of SET_WATCH) {
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `<span class="set-label">${def.label}</span><span class="set-toggle" data-watch="${def.key}"></span>`;
  row.querySelector('.set-toggle').addEventListener('click', async (e) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next); // 先乐观更新，失败回滚
    try { await window.petApi.setSettings({ watch: { [def.key]: next } }); } catch { el.classList.toggle('on', !next); }
  });
  setListEl.appendChild(row);
}
for (const def of SET_PARAMS) {
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `<span class="set-label" title="${def.tip}">${def.label}</span>`
    + `<span class="set-step" data-key="${def.key}">`
    + `<button class="st-btn" title="上一档">‹</button>`
    + `<input class="st-val" title="点击输入自定义值：单位秒，也可写 3分 / 90秒" />`
    + `<button class="st-btn" title="下一档">›</button></span>`;
  const [prev, next] = row.querySelectorAll('.st-btn');
  const input = row.querySelector('.st-val');
  prev.addEventListener('click', (e) => { e.stopPropagation(); stepSetting(def, -1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); stepSetting(def, 1); });
  input.addEventListener('focus', () => { // 编辑态以秒为单位，方便精细调整
    input.value = String(Math.round((settingsVals ? settingsVals[def.key] : 0) / 1000));
    input.select();
  });
  input.addEventListener('blur', () => commitSetting(def, input));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 输入框里的按键（含 Esc）不触发面板快捷键
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = settingsVals ? fmtMs(settingsVals[def.key]) : '';
      input.blur();
    }
  });
  setListEl.appendChild(row);
}

/** 提交输入框里的自定义时长：范围校验（气泡可为 0，其余最小 5 秒），非法则还原 */
function commitSetting(def, input) {
  const cur = settingsVals ? settingsVals[def.key] : null;
  const ms = parseDur(input.value);
  const min = def.allowZero ? 0 : 5000;
  if (cur == null || !Number.isFinite(ms) || ms < min || ms > 24 * 3600 * 1000) {
    input.value = cur != null ? fmtMs(cur) : '';
    return;
  }
  input.value = fmtMs(ms);
  if (ms === cur) return; // 取消或未变：不落盘
  settingsVals[def.key] = ms;
  window.petApi.setSettings({ [def.key]: ms }).catch(() => {});
}

/** 当前值吸附到最近档位后步进（config.json 里手改过的值也能无缝接上） */
function stepSetting(def, delta) {
  if (!settingsVals) return;
  let idx = 0;
  let bd = Infinity;
  def.presets.forEach((p, i) => {
    const d = Math.abs(p - settingsVals[def.key]);
    if (d < bd) { bd = d; idx = i; }
  });
  idx = (idx + delta + def.presets.length) % def.presets.length;
  const value = def.presets[idx];
  settingsVals[def.key] = value;
  updateSettingsRows();
  window.petApi.setSettings({ [def.key]: value }).catch(() => {});
}

function updateSettingsRows() {
  if (!settingsVals) return;
  for (const def of SET_PARAMS) {
    const stepEl = setListEl.querySelector(`[data-key="${def.key}"]`);
    if (!stepEl) continue;
    const inp = stepEl.querySelector('.st-val');
    if (document.activeElement !== inp) inp.value = fmtMs(settingsVals[def.key]); // 正在编辑的不覆盖
  }
  for (const def of SET_WATCH) {
    const el = setListEl.querySelector(`[data-watch="${def.key}"]`);
    if (el) el.classList.toggle('on', !!(settingsVals.watch && settingsVals.watch[def.key]));
  }
}

function toggleSettings(force) {
  const show = force !== undefined ? force : settingsEl.classList.contains('hidden');
  if (show) {
    closeHistoryPanel(); // 与历史/用量面板互斥
    closeUsagePanel();
    settingsEl.classList.remove('hidden');
    const { dir, side } = panelCorner();
    panelSide = side;
    applyPanelClasses(dir);
    settingsEl.style.maxHeight = ''; // 等主进程回报实际扩出的高度
    window.petApi.setPanelSpace({ dir, px: 240 });
    window.petApi.getSettings()
      .then((c) => { settingsVals = c; updateSettingsRows(); })
      .catch(() => { settingsVals = null; });
  } else {
    settingsEl.classList.add('hidden');
    applyPanelClasses('off');
    window.petApi.setPanelSpace({ dir: 'off' });
  }
}

document.getElementById('settings-close').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSettings(false);
});
document.getElementById('settings-reset').addEventListener('click', (e) => {
  e.stopPropagation();
  const patch = { watch: {} };
  for (const def of SET_PARAMS) patch[def.key] = def.def;
  for (const def of SET_WATCH) patch.watch[def.key] = true;
  settingsVals = settingsVals ? { ...settingsVals, ...patch, watch: { ...patch.watch } } : patch;
  updateSettingsRows();
  window.petApi.setSettings(patch).catch(() => {});
});
// 面板内点击不触发宠物拖拽/互动，右键不弹菜单
settingsEl.addEventListener('mousedown', (e) => e.stopPropagation());
settingsEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

/* ---------- Token 用量面板：聚合详情页 + 厂家列表开关 + 配置表单 ----------
   usage.js 按 provider 抽象（glm=用量+配额；deepseek/moonshot/硅基流动=余额；
   openai/anthropic=用量，需管理员 Key）。详情页堆叠各「已启用+已配置」厂家；
   厂家列表里的开关控制详情页显示哪些；未配置点行进表单。
   Key 只存本机 userData/usage-config.json，界面只回显掩码；60s 缓存。 */
const usageEl = document.getElementById('usage-panel');
const usageBodyEl = document.getElementById('usage-body');
const usageSetBtn = document.getElementById('usage-set');
let usageState = null;   // { providers: [{id,name,kind,configured,show,fields}] }
let usageResults = null; // { id: { ok, data | error, needConfig } }
let usageView = 'detail'; // 'detail' 聚合详情 | 'list' 厂家列表 | 'form:<id>' 配置表单
let usageBusy = false;
let usagePending = false;

/** token 数 => 紧凑中文（123456 => 12.3 万） */
function fmtTokens(n) {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(Math.round(n));
}

function closeUsagePanel() { if (!usageEl.classList.contains('hidden')) toggleUsage(false); }

function toggleUsage(force, startView) {
  const show = force !== undefined ? force : usageEl.classList.contains('hidden');
  if (show) {
    closeHistoryPanel(); // 与历史/参数面板互斥
    closeSettingsPanel();
    usageEl.classList.remove('hidden');
    const { dir, side } = panelCorner();
    panelSide = side;
    applyPanelClasses(dir);
    usageEl.style.maxHeight = ''; // 等主进程回报实际扩出的高度
    window.petApi.setPanelSpace({ dir, px: 240 });
    openUsageView(startView);
  } else {
    usageEl.classList.add('hidden');
    applyPanelClasses('off');
    window.petApi.setPanelSpace({ dir: 'off' });
  }
}

async function openUsageView(startView) {
  usageBusy = false;
  usagePending = false;
  try { usageState = await window.petApi.getUsageState(); } catch { usageState = null; }
  if (usageEl.classList.contains('hidden')) return; // 期间已被关掉
  if (!usageState) { usageView = startView || 'detail'; renderUsageError('主进程未就绪'); return; }
  const anyConfigured = usageState.providers.some((p) => p.configured);
  // 左上角角标点进来默认看详情；右键菜单「Token 厂家列表」带 startView='list'；首次使用直接进配置
  usageView = startView || (anyConfigured ? 'detail' : 'form:glm');
  renderUsage();
  if (anyConfigured) await queryUsage(false); // 打开面板走缓存，点刷新才强制
}

async function queryUsage(force) {
  if (usageBusy) { usagePending = true; return; } // 正在查：结束后补一轮
  usageBusy = true;
  renderUsage(); // 先把旧数据/查询中状态画出来
  const r = await window.petApi.fetchUsage(force).catch(() => null);
  usageBusy = false;
  // 面板关着也照常更新结果：左上角角标靠它刷新
  usageResults = (r && r.providers) || {};
  renderUsage();
  if (usagePending) { usagePending = false; await queryUsage(false); }
}

function renderUsage() {
  refreshUsageBadge(); // 角标与数据同步
  if (usageView === 'list') renderUsageList();
  else if (usageView.startsWith('form:')) renderUsageForm(usageView.slice(5));
  else renderUsageDetail();
}

/* 左上角用量角标：显示「最接近上限的配额百分比」（≥80% 变红）；
   没有配额型数据时显示「用量」二字。点击打开详情面板。 */
const usageBadgeEl = document.getElementById('usage-badge');
usageBadgeEl.querySelector('.ub-ic').innerHTML = PetIcons.svg('chart', 10);
usageBadgeEl.addEventListener('mousedown', (e) => e.stopPropagation()); // 不触发拖拽/点击语录
usageBadgeEl.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleUsage(true);
});

function refreshUsageBadge() {
  const val = usageBadgeEl.querySelector('.ub-val');
  const providers = (usageState && usageState.providers || []).filter((p) => p.configured && p.show);
  if (!providers.length) {
    val.textContent = '用量';
    usageBadgeEl.classList.remove('hot');
    usageBadgeEl.title = 'Token 用量（尚未配置厂家，点击去配置）';
    return;
  }
  let maxPct = -1;
  const tips = [];
  for (const p of providers) {
    const r = usageResults && usageResults[p.id];
    if (!r || !r.ok) continue;
    const d = r.data || {};
    if ((d.quotas || []).length) {
      const mx = Math.max(...d.quotas.map((q) => Number(q.percent) || 0));
      tips.push(`${p.name} 峰值 ${mx}%`);
      if (mx > maxPct) maxPct = mx;
    } else if (d.usage && d.usage.today && d.usage.today.totalTokens) {
      tips.push(`${p.name} 今日 ${fmtTokens(d.usage.today.totalTokens)} tok`);
    } else if ((d.lines || []).length) {
      tips.push(`${p.name} ${d.lines.map((l) => `${l.label} ${l.value}`).join('，')}`);
    }
  }
  if (maxPct >= 0) {
    val.textContent = `${Math.round(maxPct)}%`;
    usageBadgeEl.classList.toggle('hot', maxPct >= 80);
  } else {
    val.textContent = '用量';
    usageBadgeEl.classList.remove('hot');
  }
  usageBadgeEl.title = tips.length ? `Token 用量：${tips.join('；')}` : 'Token 用量';
}

// 角标后台数据：启动拉一次（走主进程 60s 缓存），之后每 5 分钟刷新
async function initUsageBadge() {
  try { usageState = await window.petApi.getUsageState(); } catch { return; }
  refreshUsageBadge();
  if (usageState && usageState.providers.some((p) => p.configured && p.show)) {
    await queryUsage(false);
  }
}
initUsageBadge();
setInterval(() => { if (usageState && !usageBusy) queryUsage(false); }, 5 * 60 * 1000);

function renderUsageError(msg) {
  usageBodyEl.innerHTML = `<div class="u-err">${msg}</div>`
    + '<div class="u-tip">可点右上「设置」检查 API Key。</div>';
}

function uDiv(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function uLink(text, onClick) {
  const el = uDiv('u-link', text);
  el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return el;
}

/** 厂家数据 => 面板一块：配额进度条（≥80% 红）+ 今日/近30天用量 + 余额行 + 更新时间 */
function appendProviderData(sec, d) {
  for (const q of d.quotas || []) {
    const pct = Number(q.percent) || 0;
    const hot = pct >= 80;
    let sub = '';
    if (q.used != null && q.total) sub = `已用 ${q.used}/${q.total}`;
    if (q.resetAt) sub = `${sub ? `${sub} · ` : ''}重置 ${fmtClock(q.resetAt)}`;
    const row = document.createElement('div');
    row.className = 'u-quota';
    row.innerHTML = `<div class="u-qrow"><span class="u-qlabel">${q.label}</span>`
      + `<span class="u-qval${hot ? ' hot' : ''}">${pct.toFixed(1)}%</span></div>`
      + (sub ? `<div class="u-qsub">${sub}</div>` : '');
    // 宽度用 CSSOM 赋值：CSP 的 style-src 'self' 会拦内联 style 属性
    const bar = document.createElement('div');
    bar.className = 'u-bar';
    const fill = document.createElement('i');
    if (hot) fill.className = 'hot';
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    sec.appendChild(row);
  }
  for (const line of d.lines || []) {
    const row = document.createElement('div');
    row.className = 'u-model';
    row.innerHTML = `<span class="m-name">${line.label}</span>`
      + `<span class="m-tok">${line.value}</span>`;
    sec.appendChild(row);
  }
  for (const [title, u] of [['今日', d.usage && d.usage.today], ['近 30 天', d.usage && d.usage.d30]]) {
    if (!u || (!u.totalTokens && !(u.models || []).length)) continue;
    const sub = uDiv('u-subtitle', `${title} · 共 ${fmtTokens(u.totalTokens)} tok`
      + (u.totalCalls ? ` · ${u.totalCalls} 次` : ''));
    sec.appendChild(sub);
    for (const m of u.models || []) {
      const row = document.createElement('div');
      row.className = 'u-model';
      row.innerHTML = `<span class="m-name">${m.name}</span>`
        + `<span class="m-tok">${fmtTokens(m.tokens)} tok</span>`;
      sec.appendChild(row);
    }
  }
  if (d.at) sec.appendChild(uDiv('u-note', `更新于 ${fmtClock(d.at)}`));
}

/** 详情页：已启用+已配置的厂家各一块，纵向堆叠（可滚动） */
function renderUsageDetail() {
  usageSetBtn.textContent = '设置';
  usageBodyEl.innerHTML = '';
  const wrap = document.createElement('div');
  const shown = (usageState.providers || []).filter((p) => p.show && p.configured);
  if (!shown.length) {
    wrap.appendChild(uDiv('u-hint', '还没有启用的厂家'));
    wrap.appendChild(uLink('打开厂家列表 ›', () => { usageView = 'list'; renderUsage(); }));
    usageBodyEl.appendChild(wrap);
    return;
  }
  for (const p of shown) {
    const sec = document.createElement('div');
    sec.className = 'u-sec';
    sec.appendChild(uDiv('u-sec-title', p.name));
    const r = usageResults && usageResults[p.id];
    if (!r) sec.appendChild(uDiv('u-hint', '查询中…'));
    else if (!r.ok) {
      sec.appendChild(uDiv('u-err', r.error || '查询失败'));
      if (r.needConfig) sec.appendChild(uLink('去配置 Key ›', () => { usageView = `form:${p.id}`; renderUsage(); }));
    } else {
      appendProviderData(sec, r.data);
    }
    wrap.appendChild(sec);
  }
  wrap.appendChild(uLink('厂家列表 ›', () => { usageView = 'list'; renderUsage(); }));
  usageBodyEl.appendChild(wrap);
}

/** 厂家列表：每行 名称 + 状态/摘要 + 显示开关；点行（未配置）进表单 */
function renderUsageList() {
  usageSetBtn.textContent = '设置';
  usageBodyEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.appendChild(uLink('‹ 返回详情', () => { usageView = 'detail'; renderUsage(); }));
  for (const p of usageState.providers || []) {
    const r = usageResults && usageResults[p.id];
    let mini = '';
    if (!p.configured) mini = '未配置 Key';
    else if (!p.show) mini = '已隐藏';
    else if (r && r.ok) {
      const d = r.data || {};
      if ((d.quotas || []).length) mini = d.quotas.map((q) => `${q.percent}%`).join(' / ');
      else if (d.usage && d.usage.today && d.usage.today.totalTokens) mini = `今日 ${fmtTokens(d.usage.today.totalTokens)} tok`;
      else if ((d.lines || []).length) mini = d.lines[0].value;
      else mini = '已连接';
    } else if (r && !r.ok && !r.needConfig) mini = r.error;

    const row = document.createElement('div');
    row.className = 'u-row';
    row.innerHTML = `<span class="u-name">${p.name}</span>`
      + `<span class="u-mini">${mini}</span>`
      + `<span class="set-toggle${p.show ? ' on' : ''}" title="在详情页显示/隐藏该厂家"></span>`;
    row.querySelector('.set-toggle').addEventListener('click', async (e) => {
      e.stopPropagation();
      const el = e.currentTarget;
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      try {
        usageState = await window.petApi.setUsageConfig({ show: { [p.id]: next } });
        renderUsage();
        if (next && p.configured) await queryUsage(false); // 新启用：拉一次数据
      } catch { el.classList.toggle('on', !next); }
    });
    row.addEventListener('click', () => {
      usageView = p.configured ? 'detail' : `form:${p.id}`;
      renderUsage();
    });
    wrap.appendChild(row);
  }
  wrap.appendChild(uDiv('u-tip', '开关控制该厂家是否显示在详情页；点厂家名配置 Key'));
  usageBodyEl.appendChild(wrap);
}

/** 配置表单：带厂家下拉；secret 字段留空 = 保持已存值；保存后自动查询 */
function renderUsageForm(pid) {
  const providers = usageState.providers || [];
  const p = providers.find((x) => x.id === pid) || providers.find((x) => x.id === 'glm') || providers[0];
  if (!p) { renderUsageError('主进程未就绪'); return; }
  usageView = `form:${p.id}`;
  usageSetBtn.textContent = '返回';
  usageBodyEl.innerHTML = '';
  const form = document.createElement('div');
  form.appendChild(uLink('‹ 返回', () => { usageView = 'detail'; renderUsage(); }));
  if (providers.length > 1) {
    const sel = document.createElement('select');
    sel.className = 'u-select';
    for (const cand of providers) {
      const opt = document.createElement('option');
      opt.value = cand.id;
      opt.textContent = `${cand.name}${cand.configured ? '' : '（未配置）'}`;
      if (cand.id === p.id) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => renderUsageForm(sel.value));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    form.appendChild(sel);
  }
  const hint = uDiv('u-hint', p.configured ? '修改配置（Key 留空表示不变）：' : '填入 API Key 后查询：');
  form.appendChild(hint);
  for (const f of p.fields || []) {
    const field = document.createElement('label');
    field.className = 'u-field';
    field.innerHTML = `<span>${f.label}</span>`;
    const input = document.createElement('input');
    input.className = 'u-input';
    input.type = f.secret ? 'password' : 'text';
    input.dataset.field = f.key;
    input.placeholder = f.secret && f.value ? `已保存 ${f.value}` : (f.value || f.placeholder || '');
    input.value = f.secret ? '' : (f.value || '');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 输入框按键（含 Esc/Enter）不触发面板快捷键
      if (e.key === 'Enter') saveUsageForm(p.id);
    });
    field.appendChild(input);
    form.appendChild(field);
  }
  const err = uDiv('u-err hidden');
  form.appendChild(err);
  const save = document.createElement('button');
  save.className = 'u-btn';
  save.textContent = '保存并查询';
  save.addEventListener('click', (e) => { e.stopPropagation(); saveUsageForm(p.id); });
  form.appendChild(save);
  form.appendChild(uDiv('u-tip', 'Key 只保存在本机（userData/usage-config.json），日志与界面只显示掩码'));
  usageBodyEl.appendChild(form);
}

async function saveUsageForm(pid) {
  const btn = usageBodyEl.querySelector('.u-btn');
  const errEl = usageBodyEl.querySelector('.u-err');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const p = (usageState.providers || []).find((x) => x.id === pid);
  const values = {};
  for (const f of (p && p.fields) || []) {
    const input = usageBodyEl.querySelector(`input[data-field="${f.key}"]`);
    if (input) values[f.key] = input.value.trim();
  }
  try {
    usageState = await window.petApi.setUsageConfig({ provider: pid, values });
  } catch (e) {
    if (errEl) { errEl.classList.remove('hidden'); errEl.textContent = '保存失败，请重试'; }
    if (btn) { btn.disabled = false; btn.textContent = '保存并查询'; }
    return;
  }
  usageView = 'detail';
  renderUsage();
  await queryUsage(true);
}

usageSetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (usageView.startsWith('form:')) { usageView = 'detail'; renderUsage(); }
  else renderUsageForm();
});
document.getElementById('usage-refresh').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!usageView.startsWith('form:')) queryUsage(true);
});
document.getElementById('usage-close').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleUsage(false);
});
// 面板内点击不触发宠物拖拽/互动，右键不弹菜单
usageEl.addEventListener('mousedown', (e) => e.stopPropagation());
usageEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

/* ---------- 完成气泡：可多个、默认 5 分钟自动关（可配置）、可手动关 ---------- */
function makeToast(entry, autoCloseMs) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  const short = lastSeg(entry.project);
  toast.innerHTML = `
    <div class="t-icon">${PetIcons.svg('check', 16)}</div>
    <div class="t-body">
      <div class="t-title">${entry.name} 任务已完成</div>
      <div class="t-sub">${short ? `${PetIcons.svg('folder', 11)}<span>${short}</span>` : ''}`
      + (entry.durationMs ? `<span>${PetIcons.svg('timer', 11)} ${fmtDur(entry.durationMs)}</span>` : '')
      + (entry.tokens ? `<span title="本次任务 Token 消耗">${PetIcons.svg('chart', 11)} ${fmtTokens(entry.tokens)}</span>` : '')
      + `<span>${fmtClock(entry.ts)}</span></div>
    </div>
    <button class="t-close" title="关闭">${PetIcons.svg('close', 9)}</button>`;

  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 300);
  };
  toast.querySelector('.t-close').addEventListener('click', (e) => {
    e.stopPropagation();
    remove();
  });
  toast.addEventListener('mousedown', (e) => e.stopPropagation());
  if (autoCloseMs > 0) toast._timer = setTimeout(remove, autoCloseMs);
  return toast;
}

function showToast(entry, autoCloseMs) {
  const toast = makeToast(entry, autoCloseMs);
  bubbleEl.after(toast); // 插在气泡之后：气泡永远贴猫，完成气泡依次往外排
  while (toastsEl.children.length > MAX_TOASTS + 1) { // +1 是常驻的气泡
    toastsEl.lastElementChild.remove(); // 超出上限移除最旧的
  }
}

/* ---------- 完成音效（WebAudio 双音提示，无需音频文件） ---------- */
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    [[880, 0, 0.16], [1174.66, 0.14, 0.3]].forEach(([freq, off, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.linearRampToValueAtTime(0.22, t0 + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + dur + 0.05);
    });
  } catch { /* 音频不可用则忽略 */ }
}

/** 完成庆祝：星星 + 开心跳几秒（叠加在当前形态上） */
let partyTimer = null;
function party() {
  appEl.classList.add('party');
  clearTimeout(partyTimer);
  partyTimer = setTimeout(() => appEl.classList.remove('party'), 4500);
}

/* ---------- 主进程事件 ---------- */
// 历史面板/参数面板标题与关闭按钮的内联图标
document.getElementById('panel-title').innerHTML =
  `${PetIcons.svg('clock', 12)}<span>完成历史</span>`;
document.getElementById('hist-close').innerHTML = PetIcons.svg('close', 8);
document.getElementById('settings-title').innerHTML =
  `${PetIcons.svg('gear', 12)}<span>参数设置</span>`;
document.getElementById('settings-close').innerHTML = PetIcons.svg('close', 8);
document.getElementById('usage-title').innerHTML =
  `${PetIcons.svg('chart', 12)}<span>Token 用量</span>`;
document.getElementById('usage-close').innerHTML = PetIcons.svg('close', 8);
// 工作用时角标是纯 CSS 的 AI thinking 三点、消耗角标是纯 CSS 均衡柱，均无需注入 SVG

window.petApi.onState(render);

// token 快速通道：主进程 400ms 增量扫描，扫到新增立即推送（不等 2s 状态快照）；
// reset=主进程判定新任务清零，这里同步归零（两边的 60s 判定有轮询粒度差，不能各清各的）
window.petApi.onTokens(({ tokens, reset }) => {
  if (typeof tokens !== 'number') return;
  if (reset) resetTokenAnim();
  lastWorkTokens = tokens;
  updateTokenTarget(tokens);
});

window.petApi.onEvent((ev) => {
  if (ev.type === 'start') {
    showBubble(`${ev.name} 开工啦`, 2600, 'rocket');
  }
  if (ev.type === 'complete') {
    const entry = {
      name: ev.name,
      project: ev.project || '',
      ts: Date.now(), // 完整时间戳：跨天记录显示带日期
      durationMs: workElapsedMs(), // 本次任务累计工作时长（清零由空闲阈值规则负责）
      tokens: typeof ev.tokens === 'number' ? ev.tokens : lastWorkTokens,
    };
    pushHistory(entry);
    if (ev.celebrate !== false) { // 防抖只压庆典，历史与计时不受影响
      showToast(entry, ev.autoCloseMs !== undefined ? ev.autoCloseMs : 5 * 60 * 1000);
      party();
      if (ev.sound !== false) chime();
    }
    if (!panelEl.classList.contains('hidden')) renderHistory(); // 面板开着时同步新记录
  }
  if (ev.type === 'show-history') {
    toggleHistory();
  }
});

/* ---------- 点击语录（词库在 click-lines.js，共 500 条） ----------
   一部分是模板：{time}{h}{date}{week}{period} 本地就能填；
   {weather} 需主进程联网取到天气才启用；{battery} 需浏览器电量接口才启用，
   取不到就自动跳过那一类，退回固定语录。 */
const WEEK_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function periodName(h) {
  if (h < 5) return '深夜';
  if (h < 8) return '清晨';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 17) return '午后';
  if (h < 19) return '傍晚';
  return '晚上';
}

function fillDynamic(tpl) {
  const d = new Date();
  return tpl
    .replace(/\{time\}/g, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
    .replace(/\{h\}/g, String(d.getHours()))
    .replace(/\{date\}/g, `${d.getMonth() + 1}月${d.getDate()}日`)
    .replace(/\{week\}/g, WEEK_NAMES[d.getDay()])
    .replace(/\{period\}/g, periodName(d.getHours()))
    .replace(/\{weather\}/g, weatherText)
    .replace(/\{battery\}/g, batteryText);
}

let weatherText = ''; // 如 "晴 26℃"；主进程取不到则保持空 => 跳过天气类
function refreshWeather() {
  window.petApi.getWeather()
    .then((w) => { weatherText = (w && w.text) || ''; })
    .catch(() => { weatherText = ''; });
}
refreshWeather();
setTimeout(refreshWeather, 30 * 1000); // 启动时主进程可能还没取到，稍后补一次
setInterval(refreshWeather, 10 * 60 * 1000); // 主进程每 2h 刷新缓存，这里只是同步过来

let batteryText = '';
function refreshBattery() {
  try {
    if (!navigator.getBattery) return;
    navigator.getBattery().then((b) => {
      batteryText = `${Math.round(b.level * 100)}%`;
    }).catch(() => { batteryText = ''; });
  } catch { batteryText = ''; }
}
refreshBattery();
setInterval(refreshBattery, 60 * 1000);

function pickFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// 概率分布：天气 8%、电量 3%（可用时），时间 12%，其余固定语录
function pickLineOnce() {
  const r = Math.random();
  if (weatherText && r < 0.08) return fillDynamic(pickFrom(PetLines.weather));
  if (batteryText && r < 0.11) return fillDynamic(pickFrom(PetLines.battery));
  if (r < 0.23) return fillDynamic(pickFrom(PetLines.time));
  return pickFrom(PetLines.static);
}

let lastLine = '';
function pickLine() {
  for (let i = 0; i < 3; i++) { // 连着两下说同一句会很尬，重抽两次
    const line = pickLineOnce();
    if (line !== lastLine) { lastLine = line; return line; }
  }
  return lastLine;
}

/* ---------- 拖拽 / 点击 / 右键 ---------- */
let dragStart = null;

appEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragStart = { x: e.screenX, y: e.screenY, moved: false };
  window.petApi.dragStart();
});

window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  if (Math.abs(e.screenX - dragStart.x) > 4 || Math.abs(e.screenY - dragStart.y) > 4) {
    dragStart.moved = true;
  }
});

window.addEventListener('mouseup', () => {
  if (!dragStart) return;
  window.petApi.dragEnd();
  if (!dragStart.moved) {
    appEl.classList.remove('boing');
    void appEl.offsetWidth; // 重新触发动画
    appEl.classList.add('boing');
    showBubble(pickLine(), 2400);
  }
  dragStart = null;
});

appEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openCtx();
});

