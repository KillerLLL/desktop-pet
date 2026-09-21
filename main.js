'use strict';
/**
 * Electron 主进程：透明置顶宠物窗口 + 会话监控 + 托盘 + 右键菜单（状态/动作桥）
 * + Token 用量查询桥（usage.js：provider 抽象，当前 glm=智谱 Coding Plan）
 */
const {
  app, BrowserWindow, ipcMain, Tray, Menu, screen, Notification, shell, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { SessionMonitor, loadConfig, SOURCE_NAMES } = require('./monitor');
const { createUsageManager } = require('./usage');
const { buildPngIcon } = require('./icon');

const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, 'config.json');

let win = null;
let tray = null;
let monitor = null;
let dragTimer = null;
let dragOffset = { dx: 0, dy: 0 };
let lastCelebrateAt = 0;
let soundOn = true;
let cfg = null;

// ---------- 窗口位置持久化 ----------
function positionFile() {
  return path.join(app.getPath('userData'), 'window-position.json');
}

function restorePosition() {
  try {
    const { x, y } = JSON.parse(fs.readFileSync(positionFile(), 'utf8'));
    if (typeof x === 'number' && typeof y === 'number') {
      const display = screen.getDisplayNearestPoint({ x, y }) || screen.getPrimaryDisplay();
      const { workArea } = display;
      const [w, h] = win.getSize();
      // 窗口高度变过/拖到边缘时防止出屏
      const cx = Math.min(Math.max(x, workArea.x - w + 80), workArea.x + workArea.width - 80);
      const cy = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - 80);
      win.setPosition(cx, cy);
      return;
    }
  } catch { /* 首次运行 */ }
  // 默认放到鼠标所在显示器的工作区右下角（避免"主显示器"与实际使用屏不一致）
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  console.log('默认位置，显示器 workArea:', JSON.stringify(workArea));
  win.setPosition(workArea.x + workArea.width - 280, workArea.y + workArea.height - 460);
}

function savePosition() {
  try {
    const [x, y] = win.getPosition();
    fs.writeFileSync(positionFile(), JSON.stringify({ x, y }));
  } catch { /* ignore */ }
}

// ---------- 通知 ----------
/** 任务完成（任一来源 working→idle 的瞬间）：统一播报「XX 任务已完成」。
    4s 防抖只压制庆典（系统通知/气泡/音效），complete 事件本身始终送达渲染进程
    —— 计时清零、历史记录依赖它，不能被防抖吞掉。 */
function notifyComplete(source, snap) {
  const now = Date.now();
  const celebrate = now - lastCelebrateAt >= 4_000;
  if (celebrate) lastCelebrateAt = now;
  const name = SOURCE_NAMES[source] || source;
  const project = snap && snap[source] && snap[source].project;
  if (celebrate && Notification.isSupported()) {
    const n = new Notification({
      title: `${name} 任务已完成`,
      body: project ? `项目：${project}（用时见宠物角标）` : '快回来看看结果～',
      silent: true,
    });
    n.show();
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet-event', {
      type: 'complete',
      source,
      name,
      project,
      tokens: snap && snap.workTokens, // 本次任务累计 token 消耗（记入完成历史）
      celebrate,
      sound: soundOn,
      autoCloseMs: cfg.bubbleAutoCloseMs,
    });
  }
}
// ---------- 右键功能菜单（菜单本体由渲染层绘制成与历史面板同款白卡片；主进程只管状态与动作） ----------
ipcMain.handle('pet-menu-state', () => ({
  sound: soundOn,
  top: !!(win && !win.isDestroyed() && win.isAlwaysOnTop()),
}));

ipcMain.on('pet-menu-action', (_e, action) => {
  if (action === 'toggle-sound') {
    soundOn = !soundOn;
    persistRuntime();
  } else if (action === 'toggle-top') {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(!win.isAlwaysOnTop(), 'screen-saver');
  } else if (action === 'open-dir') {
    shell.openPath(APP_DIR);
  } else if (action === 'quit') {
    app.quit();
  }
});

ipcMain.handle('pet-debug-snapshot', () => (monitor ? monitor.snapshot() : null));

// ---------- 参数设置（渲染层参数面板的可视化配置入口；改动实时生效并写回 config.json） ----------
const SETTABLE_KEYS = ['pollIntervalMs', 'workingWindowMs', 'claudeStaleWorkingMs',
  'zcodeInFlightMaxAgeMs', 'bubbleAutoCloseMs', 'sessionEndGraceMs'];
// 各参数下限：气泡可为 0（不自动关），轮询最短 0.5 秒，其余最短 5 秒
const SET_MIN_MS = { pollIntervalMs: 500, bubbleAutoCloseMs: 0 };

function saveConfigPatch(patch) {
  try {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* ignore */ }
    if (patch.watch) c.watch = { ...(c.watch || {}), ...patch.watch };
    for (const k of SETTABLE_KEYS) if (patch[k] !== undefined) c[k] = patch[k];
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  } catch { /* ignore */ }
}

/** 校验并应用一次参数补丁：写回文件 + 热应用到运行中的监控（不重启应用） */
function applySettingsPatch(patch) {
  if (!cfg) return null;
  if (!patch || typeof patch !== 'object') return { ...cfg, watch: { ...cfg.watch } };
  const clean = {};
  for (const k of SETTABLE_KEYS) {
    const v = Number(patch[k]);
    const min = SET_MIN_MS[k] !== undefined ? SET_MIN_MS[k] : 5000;
    if (patch[k] !== undefined && Number.isFinite(v) && v >= min && v <= 24 * 60 * 60 * 1000) {
      clean[k] = v;
    }
  }
  if (patch.watch && typeof patch.watch === 'object') {
    clean.watch = {};
    for (const k of ['claude', 'zcode']) {
      if (typeof patch.watch[k] === 'boolean') clean.watch[k] = patch.watch[k];
    }
    if (!Object.keys(clean.watch).length) delete clean.watch;
  }
  if (Object.keys(clean).length) {
    for (const [k, v] of Object.entries(clean)) {
      if (k !== 'watch') cfg[k] = v; // monitor.cfg 与 cfg 同引用，扫描参数即改即生效
    }
    if (clean.watch) cfg.watch = { ...cfg.watch, ...clean.watch };
    saveConfigPatch(clean);
    if (monitor) {
      // 宽限期被判定门在构造时捕获，需同步进 gate；轮询间隔在定时器里，需重启轮询
      if (clean.sessionEndGraceMs !== undefined && monitor.gate) monitor.gate.graceMs = clean.sessionEndGraceMs;
      if (clean.pollIntervalMs !== undefined) { monitor.stop(); monitor.start(); }
      else if (clean.watch) monitor.tick(); // 监控开关变了立即刷一次快照
    }
  }
  return { ...cfg, watch: { ...cfg.watch } };
}

ipcMain.handle('pet-settings-get', () => (cfg ? { ...cfg, watch: { ...cfg.watch } } : null));
ipcMain.handle('pet-settings-set', (_e, patch) => applySettingsPatch(patch));

// ---------- 天气（增强项：给点击语录提供 {weather}，联网失败静默跳过） ----------
// wttr.in 的 lang_zh 只翻译了部分码，自带 WWO weatherCode 对照表更稳
const CODE_ZH = {
  0: '晴', 1: '晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '零星阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷雨夹雹', 99: '雷雨夹雹',
};

let weather = null; // { text, at }，如 { text: "小雨 21℃" }
async function fetchWeather() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch('https://wttr.in/?format=j1', { signal: ctl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const cur = data && data.current_condition && data.current_condition[0];
    if (!cur) return;
    const zh = cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value;
    const desc = CODE_ZH[cur.weatherCode]
      || String(zh || (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '').trim();
    if (!desc) return;
    weather = { text: `${desc} ${cur.temp_C}℃`, at: Date.now() };
  } catch { /* 无网/超时：语录自动跳过天气类 */ }
}
ipcMain.handle('pet-weather', () => weather);

// ---------- Token 用量（usage.js：凭据只存本机 userData，回显仅掩码） ----------
let usage = null; // whenReady 时创建
ipcMain.handle('pet-usage-state', () => (usage ? usage.state() : null));
ipcMain.handle('pet-usage-set', (_e, delta) => {
  if (!usage) return null;
  return usage.setConfig(delta);
});
ipcMain.handle('pet-usage-fetch', (_e, force) => {
  if (!usage) return Promise.resolve({ ok: false, error: '主进程未就绪' });
  return usage.refresh(Boolean(force));
});

function persistRuntime() {
  try {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* ignore */ }
    c.sound = soundOn;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  } catch { /* ignore */ }
}

// ---------- 托盘 ----------
function createTray() {
  try {
    // 图标用黑猫一帧（cat.png，与快捷方式 cat.ico 同源）；缺文件时回退红点
    let img = nativeImage.createFromPath(path.join(APP_DIR, 'cat.png')).resize({ width: 32, height: 32 });
    if (img.isEmpty()) img = nativeImage.createFromBuffer(buildPngIcon(32, [222, 83, 71]));
    tray = new Tray(img);
    tray.setToolTip('桌面宠物 · 监控 Claude Code / ZCode');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示宠物', click: () => win && win.show() },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('click', () => (win.isVisible() ? win.hide() : win.show()));
  } catch (e) {
    console.error('托盘创建失败:', e);
  }
}

// ---------- 主流程 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 240,
    height: 360, // 气泡贴猫头堆叠（向上/向下自适应），无气泡时全透明不挡操作
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 透明置顶窗易被判定"被遮挡"而节流定时器，导致走表忽快忽慢
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  restorePosition();
  win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error('页面加载失败:', code, desc, url));
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('渲染进程退出:', JSON.stringify(details)));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    cfg = loadConfig(CONFIG_FILE);
    soundOn = cfg.sound !== false;
    usage = createUsageManager(app.getPath('userData'));

    createWindow();
    createTray();

    monitor = new SessionMonitor(cfg);
    monitor.on('snapshot', (snap) => {
      if (win && !win.isDestroyed()) win.webContents.send('pet-state', snap);
    });
    monitor.on('tokens', (tokens, reset) => {
      // token 快速通道（400ms 增量扫描），不等 2s 的状态快照；
      // reset=新任务清零，渲染层据此同步归零
      if (win && !win.isDestroyed()) win.webContents.send('pet-tokens', { tokens, reset: !!reset });
    });
    monitor.on('change', (e) => {
      // working→idle 只是单回合结束；"整个任务完成"由宽限期后的 complete 事件播报
      if (win && !win.isDestroyed()) {
        win.webContents.send('pet-event', {
          type: e.to === 'working' ? 'start' : 'turn-end',
          source: e.source,
          from: e.from,
          to: e.to,
          name: SOURCE_NAMES[e.source],
        });
      }
    });
    monitor.on('complete', (e) => {
      notifyComplete(e.source, e.snapshot);
    });
    monitor.start();

    // 点击语录用的天气缓存：启动取一次，之后每 2h 刷新
    fetchWeather();
    setInterval(fetchWeather, 2 * 60 * 60 * 1000);

    // 渲染进程 → 主进程
    ipcMain.on('pet-drag-start', () => {
      const cursor = screen.getCursorScreenPoint();
      const [x, y] = win.getPosition();
      dragOffset = { dx: x - cursor.x, dy: y - cursor.y };
      if (dragTimer) clearInterval(dragTimer);
      dragTimer = setInterval(() => {
        const c = screen.getCursorScreenPoint();
        win.setPosition(c.x + dragOffset.dx, c.y + dragOffset.dy);
      }, 16);
    });
    ipcMain.on('pet-drag-end', () => {
      if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
      savePosition();
    });

    // ---------- 历史面板临时扩窗：向上/向下扩出面板空间，猫的位置保持不动 ----------
    let panelRestore = null; // { dir, px } 打开面板前的窗口状态
    ipcMain.on('pet-panel-space', (_e, opts = {}) => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      if (!opts.dir || opts.dir === 'off') {
        if (panelRestore) {
          const [, cy] = win.getPosition(); // 拖动过则从当前位置收回扩出部分
          win.setBounds({
            x,
            y: panelRestore.dir === 'up' ? cy + panelRestore.px : cy,
            width: w,
            height: 360,
          });
          panelRestore = null;
        }
        return;
      }
      const want = Math.max(80, Math.min(240, opts.px || 240));
      const { workArea } = screen.getDisplayNearestPoint({ x, y });
      const upAvail = y - workArea.y;
      const downAvail = workArea.y + workArea.height - (y + h);
      let dir = opts.dir;
      // 请求方向空间不足时自动换到更宽裕的一侧
      if ((dir === 'up' ? upAvail : downAvail) < want) {
        dir = upAvail >= downAvail ? 'up' : 'down';
      }
      const px = Math.min(want, dir === 'up' ? upAvail : downAvail);
      panelRestore = { dir, px };
      win.setBounds({ x, y: dir === 'up' ? y - px : y, width: w, height: h + px });
      win.webContents.send('pet-panel-space', { dir, px });
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不退出，由菜单/托盘控制
    if (process.platform !== 'win32') app.quit();
  });
}
