'use strict';
/**
 * Token 用量/余额查询：按 provider 抽象的注册表，详情页展示各厂家数据。
 * 内置厂家：
 *   glm         智谱 Coding Plan —— 配额窗口(5h/周) + 今日/近30天用量
 *   deepseek    余额（官方 balance 接口）
 *   moonshot    Kimi · 月之暗面 —— 余额
 *   siliconflow 硅基流动 —— 余额
 *   openai      用量（组织管理员 Key，普通 Key 无用量权限）
 *   anthropic   用量（组织管理员 Key）
 * 接入新厂家：在 PROVIDERS 里加一段 fields（表单字段定义）+ fetchStats（拉数）即可。
 *
 * 凭据来源：环境变量（GLM_API_KEY / DEEPSEEK_API_KEY / …，优先）或
 * userData/usage-config.json —— 由用户在面板里自己填；源码/示例/日志不落真实 key，
 * 回显给渲染层的只有掩码（••••abcd）。查询地址内置默认，仅环境变量（GLM_BASE_URL 等）可覆盖。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_NAME = 'usage-config.json';
const CACHE_TTL_MS = 60 * 1000; // 打开面板/连续刷新不重复打接口
const TIMEOUT_MS = 8000;

/** 腾讯云 API 3.0 请求（TC3-HMAC-SHA256 签名，Node crypto 实现，无需 SDK） */
function tc3Request(secretId, secretKey, { service, version, action, payload = '{}' }) {
  const host = `${service}.tencentcloudapi.com`;
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonical = 'POST\n/\n\n'
    + `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\n`
    + `content-type;host;x-tc-action\n${hashedPayload}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${date}/${service}/tc3_request\n`
    + crypto.createHash('sha256').update(canonical).digest('hex');
  const kDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    url: `https://${host}/`,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp),
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${date}/${service}/tc3_request, `
        + `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    },
    body: payload,
  };
}

/** 阿里云 RPC 签名 GET 地址（HMAC-SHA256，BSS 费用中心等老版 OpenAPI 用） */
function aliyunSignedUrl(accessKeyId, accessKeySecret, params) {
  const enc = (s) => encodeURIComponent(String(s))
    .replace(/\!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
  const full = {
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA256',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    AccessKeyId: accessKeyId,
    ...params,
  };
  const canonical = Object.keys(full).sort()
    .map((k) => `${enc(k)}=${enc(full[k])}`).join('&');
  const signature = crypto.createHmac('sha256', `${accessKeySecret}&`)
    .update(`GET&${enc('/')}&${enc(canonical)}`).digest('base64');
  return `https://business.aliyuncs.com/?${canonical}&Signature=${enc(signature)}`;
}

/** 配置文件路径：CONFIG_NAME 为固定字面量，边界校验确保不越出传入的根目录 */
function configFileFor(userDataDir) {
  const root = path.resolve(userDataDir);
  const file = path.resolve(root, CONFIG_NAME);
  if (!file.startsWith(root + path.sep)) throw new Error('配置目录非法');
  return file;
}

// 配额单位代码 => 中文（实测：unit 3 + number 5 = 5 小时窗口、unit 6 = 周、unit 5 = 月）
const UNIT_ZH = { 2: '分钟', 3: '小时', 4: '天', 5: '个月', 6: '周', 7: '年' };

function p2(n) { return String(n).padStart(2, '0'); }
function fmtDT(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    + ` ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
/** 本地时间 => RFC3339（带时区偏移，Anthropic 接口用） */
function fmtIsoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${fmtDT(d).replace(' ', 'T')}${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}
/** 人民币/美元符号（按平台币种习惯，接口未给币种时用） */
function curSym(base) {
  return /\.cn$|bigmodel|moonshot\.cn|deepseek\.com|siliconflow/.test(base) ? '¥' : '$';
}

function auth(key) { return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }; }

/** 统一的超时壳：8s 无响应放弃 */
async function withTimeout(run) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** 统一的 GET：非 2xx 或业务码非 0/200 抛带 status 的 Error；解析失败抛格式错误 */
async function callJson(fetchImpl, url, headers, signal) {
  const res = await fetchImpl(url, { headers, signal });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error('响应不是 JSON');
    err.status = res.status;
    throw err;
  }
  // 部分平台（智谱等）的业务错误也走 HTTP 200（如 code:401 + msg）
  const bizCode = Number(json && json.code);
  const bizBad = Number.isFinite(bizCode) && bizCode !== 0 && bizCode !== 200;
  if ((json && json.success === false) || bizBad) {
    const err = new Error((json && json.msg) || `业务错误 ${json.code}`);
    err.status = bizBad ? bizCode : res.status;
    throw err;
  }
  return json;
}

/** 智谱配额行 => 面板一行：标签 + 百分比 + 重置时间/已用量（结构化，文案由渲染层拼） */
function parseQuota(limits) {
  const out = [];
  for (const item of Array.isArray(limits) ? limits : []) {
    const pct = Number(item && item.percentage);
    if (!item || !Number.isFinite(pct)) continue;
    const unitZh = UNIT_ZH[item.unit] || '期';
    const n = Number(item.number) || 1;
    let label;
    if (item.type === 'TOKENS_LIMIT') label = `Token 额度 · ${n} ${unitZh}窗口`;
    else if (item.type === 'TIME_LIMIT') label = `工具提示 · ${n} ${unitZh}额度`;
    else label = String(item.type || '配额');
    out.push({
      label,
      percent: pct,
      resetAt: Number(item.nextResetTime) || 0,
      used: Number.isFinite(Number(item.currentValue)) ? Number(item.currentValue) : null,
      total: Number(item.usage) || 0,
    });
  }
  return out;
}

/** 智谱 model-usage => 今日/30天 汇总（实测结构：totalUsage.totalTokensUsage + modelSummaryList） */
function parseModelUsage(d) {
  const empty = { totalTokens: 0, totalCalls: 0, models: [] };
  if (!d || typeof d !== 'object') return empty;
  const tu = d.totalUsage && typeof d.totalUsage === 'object' ? d.totalUsage : {};
  const models = (Array.isArray(tu.modelSummaryList) ? tu.modelSummaryList : Array.isArray(d.modelSummaryList) ? d.modelSummaryList : [])
    .filter((m) => m && m.modelName && Number.isFinite(Number(m.totalTokens)))
    .map((m) => ({ name: String(m.modelName), tokens: Number(m.totalTokens) }))
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = Number(tu.totalTokensUsage) || models.reduce((s, m) => s + m.tokens, 0);
  return { totalTokens, totalCalls: Number(tu.totalModelCallCount) || 0, models };
}

function emptyUsage() { return { today: { totalTokens: 0, totalCalls: 0, models: [] }, d30: { totalTokens: 0, totalCalls: 0, models: [] } }; }

const PROVIDERS = {
  glm: {
    name: 'GLM · 智谱',
    kind: 'usage',
    // 查询地址内置默认，不让用户填（填错会 404/500）；海外版用环境变量 GLM_BASE_URL 覆盖
    defaultBase: 'https://open.bigmodel.cn',
    envBase: 'GLM_BASE_URL',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, env: 'GLM_API_KEY',
        placeholder: '粘贴智谱 API Key（bigmodel.cn 控制台获取）' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://open.bigmodel.cn').trim()
        .replace(/\/+$/, '');
      const headers = {
        Authorization: creds.apiKey, // 智谱监控接口：裸 key，不带 Bearer
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      };
      return withTimeout(async (signal) => {
        // 两个用量窗口：今日（00:00 → 当日末）、近 30 天；服务端自动切粒度
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const d30Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        const modelUsage = (s) => callJson(fetchImpl,
          `${base}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmtDT(s))}&endTime=${encodeURIComponent(fmtDT(dayEnd))}`,
          headers, signal).catch(() => null);
        const [quota, today, d30] = await Promise.all([
          callJson(fetchImpl, `${base}/api/monitor/usage/quota/limit`, headers, signal),
          modelUsage(todayStart),
          modelUsage(d30Start),
        ]);
        const unwrap = (r) => (r && (r.data || r)) || null;
        return {
          quotas: parseQuota(quota && quota.data && quota.data.limits),
          usage: { today: parseModelUsage(unwrap(today)), d30: parseModelUsage(unwrap(d30)) },
          at: Date.now(),
        };
      });
    },
  },

  deepseek: {
    name: 'DeepSeek',
    kind: 'balance',
    defaultBase: 'https://api.deepseek.com',
    envBase: 'DEEPSEEK_BASE_URL',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, env: 'DEEPSEEK_API_KEY',
        placeholder: 'DeepSeek 平台 API Key' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
      const sym = curSym(base);
      return withTimeout(async (signal) => {
        const j = await callJson(fetchImpl, `${base}/user/balance`, auth(creds.apiKey), signal);
        const info = j && Array.isArray(j.balance_infos) ? j.balance_infos[0] : null;
        const lines = [];
        if (info) {
          const cur = info.currency === 'CNY' ? '¥' : info.currency === 'USD' ? '$' : `${info.currency} `;
          lines.push({ label: '余额', value: `${cur}${info.total_balance}` });
          if (Number(info.granted_balance)) lines.push({ label: '赠送余额', value: `${cur}${info.granted_balance}` });
          if (Number(info.topped_up_balance)) lines.push({ label: '充值余额', value: `${cur}${info.topped_up_balance}` });
        }
        return { lines, at: Date.now() };
      });
    },
  },

  moonshot: {
    name: 'Kimi · 月之暗面',
    kind: 'balance',
    defaultBase: 'https://api.moonshot.cn',
    envBase: 'MOONSHOT_BASE_URL',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, env: 'MOONSHOT_API_KEY',
        placeholder: '月之暗面平台 API Key' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://api.moonshot.cn').trim().replace(/\/+$/, '');
      const sym = curSym(base);
      return withTimeout(async (signal) => {
        const j = await callJson(fetchImpl, `${base}/v1/users/me/balance`, auth(creds.apiKey), signal);
        const d = (j && j.data && typeof j.data === 'object' ? j.data : j) || {};
        const lines = [];
        const v = d.available_balance != null ? d.available_balance : d.balance;
        if (v != null) lines.push({ label: '可用余额', value: `${sym}${v}` });
        if (Number(d.voucher_balance)) lines.push({ label: '代金券', value: `${sym}${d.voucher_balance}` });
        return { lines, at: Date.now() };
      });
    },
  },

  minimax: {
    name: 'MiniMax',
    kind: 'balance',
    defaultBase: 'https://api.minimax.chat',
    envBase: 'MINIMAX_BASE_URL',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, env: 'MINIMAX_API_KEY',
        placeholder: 'MiniMax 开放平台 API Key' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://api.minimax.chat').trim().replace(/\/+$/, '');
      return withTimeout(async (signal) => {
        const j = await callJson(fetchImpl, `${base}/v1/get_balance`, auth(creds.apiKey), signal);
        const br = j && j.base_resp;
        if (br && Number(br.status_code) !== 0) {
          const err = new Error(br.status_msg || '接口错误');
          err.status = 401;
          throw err;
        }
        const lines = [];
        if (j && j.total_balance != null) {
          // balance_type: TICKET（票数）或 CNY（单位为分）
          const v = j.balance_type === 'CNY' ? `¥${(Number(j.total_balance) / 100).toFixed(2)}` : `${j.total_balance} tickets`;
          lines.push({ label: '余额', value: v });
        }
        return { lines, at: Date.now() };
      });
    },
  },

  siliconflow: {
    name: '硅基流动',
    kind: 'balance',
    defaultBase: 'https://api.siliconflow.cn',
    envBase: 'SILICONFLOW_BASE_URL',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, env: 'SILICONFLOW_API_KEY',
        placeholder: '硅基流动平台 API Key' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://api.siliconflow.cn').trim().replace(/\/+$/, '');
      const sym = curSym(base);
      return withTimeout(async (signal) => {
        const j = await callJson(fetchImpl, `${base}/v1/user/info`, auth(creds.apiKey), signal);
        const d = (j && j.data && typeof j.data === 'object' ? j.data : j) || {};
        const lines = [];
        const v = d.totalBalance != null ? d.totalBalance : d.balance;
        if (v != null) lines.push({ label: '余额', value: `${sym}${v}` });
        if (Number(d.chargeBalance)) lines.push({ label: '充值余额', value: `${sym}${d.chargeBalance}` });
        return { lines, at: Date.now() };
      });
    },
  },

  aliyun: {
    name: '阿里云（百炼）',
    kind: 'balance',
    // 百炼的模型 api-key 查不了账，走 BSS 费用中心账户余额（RPC 签名）
    fields: [
      { key: 'akId', label: 'AccessKey ID', secret: true, env: 'ALIYUN_ACCESS_KEY_ID',
        placeholder: '建议用只读「费用中心」权限的子账号 AK' },
      { key: 'akSecret', label: 'AccessKey Secret', secret: true, env: 'ALIYUN_ACCESS_KEY_SECRET',
        placeholder: '与上面 AccessKey ID 配对的 Secret' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      return withTimeout(async (signal) => {
        const url = aliyunSignedUrl(creds.akId, creds.akSecret, {
          Action: 'QueryAccountBalance',
          Version: '2017-12-14',
        });
        const j = await callJson(fetchImpl, url, {}, signal);
        if (j && j.Code && j.Code !== 'Success') {
          const err = new Error(j.Message || j.Code);
          err.status = 403;
          throw err;
        }
        const d = (j && j.Data) || {};
        const lines = [];
        const cur = d.Currency === 'CNY' ? '¥' : d.Currency === 'USD' ? '$' : `${d.Currency || ''} `;
        if (d.AvailableBalance != null) lines.push({ label: '可用余额', value: `${cur}${d.AvailableBalance}` });
        else if (d.AvailableAmount != null) lines.push({ label: '可用余额', value: `${cur}${d.AvailableAmount}` });
        if (Number(d.CreditAmount)) lines.push({ label: '授信余额', value: `${cur}${d.CreditAmount}` });
        return { lines, at: Date.now() };
      });
    },
  },

  qcloud: {
    name: '腾讯云（混元）',
    kind: 'balance',
    // 混元无聚合用量接口，走费用中心账户余额（TC3 签名）
    fields: [
      { key: 'secretId', label: 'SecretId', secret: true, env: 'TENCENT_SECRET_ID',
        placeholder: '建议用「只读」权限子账号的 SecretId' },
      { key: 'secretKey', label: 'SecretKey', secret: true, env: 'TENCENT_SECRET_KEY',
        placeholder: '与上面 SecretId 配对的 SecretKey' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      return withTimeout(async (signal) => {
        const req = tc3Request(creds.secretId, creds.secretKey, {
          service: 'billing',
          version: '2020-07-01',
          action: 'QueryAccountBalance',
        });
        const res = await fetchImpl(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          signal,
        });
        const text = await res.text();
        let j;
        try {
          j = JSON.parse(text);
        } catch {
          const err = new Error('响应不是 JSON');
          err.status = res.status;
          throw err;
        }
        const r = j && j.Response;
        if (r && r.Error) {
          const err = new Error(r.Error.Message || r.Error.Code);
          err.status = 403;
          throw err;
        }
        const lines = [];
        if (r && r.Balance != null) lines.push({ label: '可用余额', value: `¥${r.Balance}` });
        return { lines, at: Date.now() };
      });
    },
  },

  openai: {
    name: 'OpenAI',
    kind: 'usage',
    defaultBase: 'https://api.openai.com',
    envBase: 'OPENAI_BASE_URL',
    fields: [
      { key: 'apiKey', label: '管理员 Key', secret: true, env: 'OPENAI_API_KEY',
        placeholder: 'sk-admin-… 组织管理员 Key（普通 Key 无用量权限）' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://api.openai.com').trim().replace(/\/+$/, '');
      return withTimeout(async (signal) => {
        const now = new Date();
        const sec = (d) => Math.floor(d.getTime() / 1000);
        const todayStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        const d30Start = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
        const dayEnd = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59));
        // 管理员用量接口：输入/输出 token 分两个端点，各取窗口总和
        const sumTokens = async (from, to) => {
          const eps = ['input_tokens', 'completion_tokens'];
          const parts = await Promise.all(eps.map((ep) => callJson(fetchImpl,
            `${base}/v1/organization/usage/${ep}?start_time=${from}&end_time=${to}&bucket_width=1d`,
            auth(creds.apiKey), signal)));
          let t = 0;
          for (const j of parts) {
            for (const bucket of (j && j.data) || []) {
              for (const r of (bucket && bucket.results) || []) t += Number(r && r.amount && r.amount.value) || 0;
            }
          }
          return Math.round(t);
        };
        const [today, d30] = await Promise.all([sumTokens(todayStart, dayEnd), sumTokens(d30Start, dayEnd)]);
        return { usage: { today: { totalTokens: today, totalCalls: 0, models: [] }, d30: { totalTokens: d30, totalCalls: 0, models: [] } }, at: Date.now() };
      });
    },
  },

  anthropic: {
    name: 'Anthropic',
    kind: 'usage',
    defaultBase: 'https://api.anthropic.com',
    envBase: 'ANTHROPIC_BASE_URL',
    fields: [
      { key: 'apiKey', label: '管理员 Key', secret: true, env: 'ANTHROPIC_API_KEY',
        placeholder: 'sk-ant-admin-… 组织管理员 Key（普通 Key 无用量权限）' },
    ],
    async fetchStats(creds, fetchImpl = fetch) {
      const base = String(creds.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
      const headers = { 'x-api-key': creds.apiKey, 'anthropic-version': '2023-06-01' };
      return withTimeout(async (signal) => {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const d30Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        const sumTokens = async (from, to) => {
          const j = await callJson(fetchImpl,
            `${base}/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(fmtIsoLocal(from))}&ending_at=${encodeURIComponent(fmtIsoLocal(to))}&bucket_width=1d`,
            headers, signal);
          let t = 0;
          for (const bucket of (j && j.data) || []) {
            for (const r of (bucket && bucket.results) || []) {
              t += (Number(r && r.input_tokens) || 0) + (Number(r && r.output_tokens) || 0);
            }
          }
          return t;
        };
        const [today, d30] = await Promise.all([sumTokens(todayStart, dayEnd), sumTokens(d30Start, dayEnd)]);
        return { usage: { today: { totalTokens: today, totalCalls: 0, models: [] }, d30: { totalTokens: d30, totalCalls: 0, models: [] } }, at: Date.now() };
      });
    },
  },
};

function maskKey(k) {
  return k.length > 8 ? `••••${k.slice(-4)}` : '••••';
}

/** 该厂家的所有 secret 字段是否都已配置（阿里/腾讯的 ID+Secret 对要求两个字段齐全） */
function credsReady(d, creds) {
  return d.fields.filter((f) => f.secret).every((f) => creds[f.key]);
}

/**
 * @param {string} userDataDir Electron app.getPath('userData')；node 冒烟测试可传临时目录
 * @param {object} env 环境变量源，默认 process.env
 */
function createUsageManager(userDataDir, env = process.env) {
  const file = configFileFor(userDataDir);
  let store = { show: {}, creds: {} };
  const cache = {}; // id => { at, data }
  let lastResults = null;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      store = { show: (raw.show && typeof raw.show === 'object') ? raw.show : {}, creds: (raw.creds && typeof raw.creds === 'object') ? raw.creds : {} };
    }
  } catch { /* 首次运行/损坏则用默认 */ }

  function save() {
    try {
      fs.writeFileSync(file, JSON.stringify(store, null, 2));
    } catch { /* 写不进去不致命：本次会话内仍可用 */ }
  }

  // 一次性清理：早期版本把「接口地址」暴露给用户填写，容易误填成 /api/anthropic
  // 兼容地址导致查询 404/500；现在地址已内置默认（仅各 *_BASE_URL 环境变量可覆盖），旧值直接删
  try {
    let dirty = false;
    for (const [pid, c] of Object.entries(store.creds || {})) {
      if (PROVIDERS[pid] && c && typeof c === 'object' && 'baseUrl' in c) {
        delete c.baseUrl;
        dirty = true;
      }
    }
    if (dirty) save();
  } catch { /* ignore */ }

  /** 环境变量优先于配置文件；查询地址只认环境变量，不认用户输入 */
  function resolveCreds(id) {
    const d = PROVIDERS[id];
    if (!d) return {};
    const saved = (store.creds && store.creds[id]) || {};
    const merged = {};
    for (const f of d.fields) {
      merged[f.key] = String((f.env && env[f.env]) || saved[f.key] || '');
    }
    merged.baseUrl = d.envBase && env[d.envBase] ? String(env[d.envBase]) : '';
    return merged;
  }

  function state() {
    return {
      providers: Object.keys(PROVIDERS).map((id) => {
        const d = PROVIDERS[id];
        const creds = resolveCreds(id);
        return {
          id,
          name: d.name,
          kind: d.kind,
          configured: credsReady(d, creds),
          show: store.show[id] !== false,
          fields: d.fields.map((f) => ({
            key: f.key,
            label: f.label,
            secret: !!f.secret,
            value: creds[f.key] ? (f.secret ? maskKey(creds[f.key]) : creds[f.key]) : '',
            placeholder: f.placeholder || '',
          })),
        };
      }),
    };
  }

  function setConfig(patch) {
    if (patch && typeof patch === 'object') {
      if (patch.provider && PROVIDERS[patch.provider] && patch.values && typeof patch.values === 'object') {
        const d = PROVIDERS[patch.provider];
        const saved = { ...(store.creds[patch.provider] || {}) };
        for (const f of d.fields) {
          if (!(f.key in patch.values)) continue;
          const v = String(patch.values[f.key] || '').trim();
          // secret 留空 = 保持旧值；非 secret 清空 = 清除
          if (!v && f.secret) continue;
          saved[f.key] = v;
        }
        store.creds = { ...(store.creds || {}), [patch.provider]: saved };
        cache[patch.provider] = null; // 配置变了该厂家缓存作废
      }
      if (patch.show && typeof patch.show === 'object') {
        for (const [k, v] of Object.entries(patch.show)) {
          if (PROVIDERS[k]) store.show[k] = !!v;
        }
      }
    }
    save();
    return state();
  }

  function classifyError(e) {
    if (e && e.name === 'AbortError') return `查询超时（${TIMEOUT_MS / 1000}s），稍后再试`;
    if (e && e.status === 401) return 'API Key 无效（HTTP 401），去设置里检查';
    if (e && e.status === 403) return '该 Key 无权限或套餐不支持（HTTP 403）';
    if (e && e.status === 429) return '请求太频繁，稍后再试（HTTP 429）';
    if (e && e.status === 404) return '接口不存在（HTTP 404），检查 Key 类型或平台公告';
    if (e && e.status) return `接口异常（HTTP ${e.status}）`;
    return `网络错误：${(e && e.message) || '未知原因'}`;
  }

  /** 并行拉所有「已启用」厂家的数据；未配置的返回 needConfig，单家失败不影响别家 */
  async function refresh(force = false) {
    const ids = Object.keys(PROVIDERS).filter((id) => store.show[id] !== false);
    const results = {};
    await Promise.all(ids.map(async (id) => {
      const d = PROVIDERS[id];
      const cached = cache[id];
      if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
        results[id] = { ok: true, data: cached.data };
        return;
      }
      const creds = resolveCreds(id);
      if (!credsReady(d, creds)) {
        results[id] = { ok: false, needConfig: true, error: '未配置 Key' };
        return;
      }
      try {
        const data = await d.fetchStats(creds);
        cache[id] = { at: Date.now(), data };
        results[id] = { ok: true, data };
      } catch (e) {
        results[id] = { ok: false, error: classifyError(e) };
      }
    }));
    lastResults = results;
    return { ok: true, providers: results };
  }

  return { state, setConfig, refresh };
}

module.exports = { createUsageManager, PROVIDERS };
