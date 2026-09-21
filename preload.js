'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petApi', {
  onState: (cb) => ipcRenderer.on('pet-state', (_e, snap) => cb(snap)),
  // token 快速通道：主进程 400ms 增量扫描，扫到新增立即推送（不等状态快照）
  onTokens: (cb) => ipcRenderer.on('pet-tokens', (_e, tokens) => cb(tokens)),
  onEvent: (cb) => ipcRenderer.on('pet-event', (_e, ev) => cb(ev)),
  dragStart: () => ipcRenderer.send('pet-drag-start'),
  dragEnd: () => ipcRenderer.send('pet-drag-end'),
  // 历史面板临时扩窗：dir = up(猫上方)/down(猫下方)/off(还原)
  setPanelSpace: (opts) => ipcRenderer.send('pet-panel-space', opts),
  onPanelSpace: (cb) => ipcRenderer.on('pet-panel-space', (_e, v) => cb(v)),
  // 右键功能菜单：查开关态 / 下发动作 / 取检测快照（菜单本体由渲染层绘制）
  menuState: () => ipcRenderer.invoke('pet-menu-state'),
  menuAction: (action) => ipcRenderer.send('pet-menu-action', action),
  getSnapshot: () => ipcRenderer.invoke('pet-debug-snapshot'),
  // 参数设置面板：读/写 config.json（写会热应用并返回最新配置）
  getSettings: () => ipcRenderer.invoke('pet-settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('pet-settings-set', patch),
  // 点击语录的天气（主进程缓存，取不到返回 null => 语录自动跳过天气类）
  getWeather: () => ipcRenderer.invoke('pet-weather'),
  // Token 用量：配置态 / 保存配置（key 回显掩码）/ 拉取用量（force=强制刷新）
  getUsageState: () => ipcRenderer.invoke('pet-usage-state'),
  setUsageConfig: (delta) => ipcRenderer.invoke('pet-usage-set', delta),
  fetchUsage: (force) => ipcRenderer.invoke('pet-usage-fetch', force),
});
