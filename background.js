/**
 * Service Worker：整个下载流程的编排者
 *
 * 流程：
 *   页面/弹窗 → 解析 bvid / ep_id → 取稿件信息 → WBI 签名取 playurl
 *   → 选音频流 → 离屏文档下载+解码+编码 → 拿回 Blob URL → chrome.downloads 落盘
 *
 * Referer 问题：fetch 不允许 JS 设置 Referer，bilivideo CDN 又强制校验它，
 * 所以这里在启动时注册 declarativeNetRequest 动态规则，把扩展发起的
 * bilivideo 请求统一改写 Referer / Origin / User-Agent。
 */

import {
  getVideoInfo,
  getBangumiInfo,
  getPlayUrl,
  pickAudioStreams,
  getWbiKeys,
  parseBvid,
  parseEpId,
  BiliError,
  AUDIO_QUALITY,
} from './lib/bili-api.js';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const HISTORY_LIMIT = 30;
const DEFAULT_BITRATE = 192;
const MAX_TITLE_LEN = 80;

/** 固定用真实浏览器的 UA：navigator.userAgent 在 SW 里可能带 "ServiceWorker" 之类的标识 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

/** 转码用的 MP3 码率：跟随源音质，避免无意义地放大体积 */
const BITRATE_BY_QUALITY = {
  30216: 128,
  30232: 160,
  30280: 192,
  30250: 192,
  30251: 320,
};

/* ------------------------------------------------------------------ *
 * 运行期状态
 * ------------------------------------------------------------------ */
/** 同一时刻只跑一个任务（离屏文档只有一个，串行最省内存也最稳） */
const queue = [];
let active = null;

/**
 * 已经派发给离屏文档、但还没收到 done / error 的任务 ID。
 *
 * 这个状态必不可少：离屏文档收到任务后会立刻回一个 ack，
 * 如果只看 pendingDownloads 是否为空，就会在「下载/编码进行中」时
 * 误判为空闲并把离屏文档关掉，导致转码被静默中断。
 */
let inFlightJobId = null;

/**
 * jobId -> { blobUrl, downloadId, title }
 *
 * 落盘用 storage.session：Service Worker 随时可能被浏览器回收重启，
 * 内存里的 Map 会丢，那样 Blob 就没人回收了（离屏文档会一直挂着）。
 */
const pendingDownloads = new Map();

async function persistPending() {
  try {
    await chrome.storage.session.set({
      pending: [...pendingDownloads.entries()],
    });
  } catch {
    /* storage.session 不可用时忽略，只是少了崩溃恢复能力 */
  }
}

async function restorePending() {
  try {
    const { pending = [] } = await chrome.storage.session.get('pending');
    for (const [jobId, rec] of pending) {
      if (rec?.blobUrl) pendingDownloads.set(jobId, rec);
    }
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * declarativeNetRequest：改写 bilivideo 请求头
 * ------------------------------------------------------------------ */
async function installHeaderRules() {
  const rewriteHeaders = [
    { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
    { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' },
    // UA 用真实浏览器的：B 站 CDN 对异常的 UA 会直接拒绝
    { header: 'User-Agent', operation: 'set', value: BROWSER_UA },
  ];

  const domains = ['bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'hdslb.com'];
  const rules = domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: rewriteHeaders },
    condition: {
      // 只作用于扩展自己发起的请求，避免影响用户正常浏览
      initiatorDomains: [chrome.runtime.id],
      urlFilter: `||${domain}`,
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map((r) => r.id),
      addRules: rules,
    });
  } catch (e) {
    console.error('[BiliAudio] 注册请求头改写规则失败：', e);
  }
}

/* ------------------------------------------------------------------ *
 * 离屏文档
 * ------------------------------------------------------------------ */
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;

  // 用 BLOBS：需要 URL.createObjectURL 交付 MP3。
  // 不用 AUDIO_PLAYBACK —— 那个理由会在「30 秒没有音频播放」时自动关闭文档，
  // 会直接打断长音频的转码。
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: '下载并解码 B 站音频流，编码为 MP3 后生成 Blob URL 交给下载接口。',
  });
}

async function closeOffscreenIfIdle() {
  if (active || queue.length > 0) return;
  if (inFlightJobId) return; // 离屏文档正在干活，绝不能关
  if (pendingDownloads.size > 0) return;
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (existing.length > 0) await chrome.offscreen.closeDocument();
  } catch {
    /* 已经关掉了，忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function sanitizeFileName(name) {
  let out = String(name || 'audio')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (out.length > MAX_TITLE_LEN) out = out.slice(0, MAX_TITLE_LEN).trim();
  return out || 'audio';
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 广播给 popup 和所有 B 站标签页 */
async function broadcast(payload) {
  const msg = { target: 'ui', ...payload };
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    /* 没有接收者时忽略 */
  }
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.bilibili.com/video/*', 'https://www.bilibili.com/bangumi/play/*'],
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
    }
  } catch {
    /* 忽略 */
  }
}

function emitProgress(jobId, phase, percent, extra = {}) {
  broadcast({ type: 'progress', jobId, phase, percent, ...extra });
}

/**
 * 发消息给离屏文档。
 *
 * 唯一的可靠方式是 chrome.runtime.sendMessage + target 字段过滤：
 * 离屏文档不是普通标签页，getContexts() 返回的 tabId 恒为 -1，
 * 所以 chrome.tabs.sendMessage(ctx.tabId, ...) 必然抛
 * 「Value must be at least 0」，这条路根本走不通。
 *
 * background 自己的 onMessage 会用 target 过滤掉这些消息
 * （见下方 REQUEST_TYPES 白名单），不会自我吞掉。
 */
async function sendToOffscreen(payload, { recreate = true } = {}) {
  const message = { target: 'offscreen', ...payload };

  // 离屏文档刚创建时可能还没挂上监听器，给几次重试机会
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (contexts.length === 0) {
      lastError = new Error('离屏文档不存在');
      // 清理类消息（release）不该反过来把文档创建出来
      if (!recreate) throw lastError;
      await ensureOffscreen();
    } else {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (e) {
        lastError = e;
      }
    }
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  throw lastError || new Error('无法与离屏文档通信');
}

/* ------------------------------------------------------------------ *
 * 目标解析：把页面 URL / BV 号 / ep 号统一成可用的稿件信息
 * ------------------------------------------------------------------ */
async function resolveTarget({ bvid, epId, input }) {
  const raw = input || bvid || epId;
  const ep = epId || parseEpId(raw);
  const bv = bvid || parseBvid(raw);

  if (ep) {
    const info = await getBangumiInfo(ep);
    return { info, epId: ep };
  }
  if (bv) {
    const info = await getVideoInfo(bv);
    return { info, bvid: bv };
  }
  throw new BiliError('没有识别到有效的视频地址，请打开 B 站视频页或粘贴 BV 号 / 视频链接', 'input');
}

/** 探测：返回稿件信息 + 可选音质列表 */
async function probe({ bvid, epId, input, cid }) {
  const { info, bvid: bv, epId: ep } = await resolveTarget({ bvid, epId, input });

  // 选中的分P
  let page = info.pages[0];
  if (cid) {
    page = info.pages.find((p) => String(p.cid) === String(cid)) || page;
  }
  if (!page) throw new BiliError('这个视频没有可用的分P信息', 'pages');

  const playData = await getPlayUrl({
    bvid: bv,
    cid: page.cid,
    epId: ep,
  });

  const streams = pickAudioStreams(playData?.dash);
  if (streams.length === 0) {
    throw new BiliError(
      '没有取到音频流。可能是该视频为纯视频/无声稿件，或需要登录后才有权限。',
      'no-audio'
    );
  }

  const keys = await getWbiKeys().catch(() => ({}));

  // 给用户一句人话提示，说明当前为什么只能拿到这个音质
  const notices = [];
  const best = streams[0];
  if (!keys.isLogin) {
    notices.push('当前未登录 B 站，最高只能取到 132K 音质；登录后可获取 192K / 无损。');
  }
  if (best.id === 30216) {
    notices.push('该视频本身只有 64K 音轨，转成 MP3 也不会更好，建议直接听。');
  }

  const result = {
    kind: info.kind,
    bvid: bv || '',
    epId: ep || '',
    aid: info.aid,
    title: info.title,
    owner: info.owner,
    cover: info.cover,
    duration: page.duration || info.duration,
    pages: info.pages,
    selectedCid: page.cid,
    selectedIndex: page.index,
    selectedTitle: page.title,
    isLogin: Boolean(keys.isLogin),
    uname: keys.uname || '',
    vip: Boolean(keys.vip),
    notice: notices.join(' '),
    streams: streams.map((s) => ({
      id: s.id,
      label: s.label,
      desc: s.desc,
      bandwidth: s.bandwidth,
      kbps: Math.round(s.bandwidth / 1000),
      codecs: s.codecs,
      source: s.source,
      mimeType: s.mimeType,
    })),
    probedAt: Date.now(),
  };

  return result;
}

/* ------------------------------------------------------------------ *
 * 构建文件名
 * ------------------------------------------------------------------ */
function buildFileName(info, page) {
  const parts = [sanitizeFileName(info.title)];

  if (info.pages.length > 1) {
    parts.push(`P${page.index}`);
    if (page.title && page.title !== `P${page.index}`) {
      parts.push(sanitizeFileName(page.title));
    }
  } else if (info.kind === 'bangumi' && info.episodeName) {
    parts.push(sanitizeFileName(info.episodeName));
  }

  return `${parts.join(' - ')}.mp3`;
}

/* ------------------------------------------------------------------ *
 * 任务执行
 * ------------------------------------------------------------------ */
async function runJob(job) {
  const { jobId, bvid, epId, cid, qualityId, bitrate } = job;

  try {
    emitProgress(jobId, 'prepare', 0, { message: '正在获取视频信息…' });

    const { info, bvid: bv, epId: ep } = await resolveTarget({ bvid, epId });

    let page = info.pages[0];
    if (cid) page = info.pages.find((p) => String(p.cid) === String(cid)) || page;
    if (!page) throw new BiliError('找不到对应的分P', 'pages');

    emitProgress(jobId, 'prepare', 30, { message: '正在获取音频流地址…' });

    const playData = await getPlayUrl({ bvid: bv, cid: page.cid, epId: ep });
    const streams = pickAudioStreams(playData?.dash);
    if (streams.length === 0) {
      throw new BiliError('没有取到音频流，可能该稿件无音轨或需要更高权限。', 'no-audio');
    }

    // 选流：优先用户指定的 id，其次最高带宽
    let stream = qualityId ? streams.find((s) => String(s.id) === String(qualityId)) : null;
    if (!stream) stream = streams[0];

    const urls = [stream.url, ...(stream.backupUrls || [])].filter(Boolean);
    const chosenBitrate = bitrate || BITRATE_BY_QUALITY[stream.id] || DEFAULT_BITRATE;
    const fileName = buildFileName(info, page);

    emitProgress(jobId, 'prepare', 100, {
      message: `已选音质 ${stream.label}（约 ${Math.round(stream.bandwidth / 1000)} kbps）`,
      quality: stream.label,
    });

    await ensureOffscreen();

    // 离屏文档负责 下载 → 解码 → 编码，最后回传 Blob URL。
    // 先登记 inFlight，保证任务执行期间不会有人把离屏文档关掉。
    inFlightJobId = jobId;
    await sendToOffscreen({
      cmd: 'convert',
      jobId,
      urls,
      bitrate: chosenBitrate,
      title: fileName,
    });

    return { jobId, fileName, quality: stream.label, bitrate: chosenBitrate };
  } catch (err) {
    inFlightJobId = null;
    emitProgress(jobId, 'error', 0, {
      message: err?.message || String(err),
      code: err?.code ?? null,
    });
    throw err;
  }
}

/** 串行消费队列 */
async function drainQueue() {
  if (active) return;
  while (queue.length > 0) {
    active = queue.shift();
    try {
      await runJob(active);
    } catch {
      /* runJob 内部已经广播错误 */
    } finally {
      active = null;
      closeOffscreenIfIdle();
    }
  }
}

function enqueue(job) {
  queue.push(job);
  broadcast({ type: 'queued', jobId: job.jobId, position: queue.length });
  drainQueue();
}

/* ------------------------------------------------------------------ *
 * 保存与历史
 * ------------------------------------------------------------------ */
async function saveHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
}

async function handleOffscreenDone(msg) {
  const { jobId, blobUrl, size, title, durationSec, channels, sampleRate, elapsedMs } = msg;
  inFlightJobId = null;

  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `B站音频/${title}`,
      saveAs: false,
    });
  } catch (e) {
    // 落盘失败就立刻释放 Blob，否则会一直占着内存
    sendToOffscreen({ cmd: 'release', jobId }, { recreate: false }).catch(() => {});
    emitProgress(jobId, 'error', 0, { message: `保存文件失败：${e.message}` });
    return;
  }

  pendingDownloads.set(jobId, { blobUrl, downloadId, title });
  await persistPending();

  const entry = {
    jobId,
    title,
    size,
    durationSec,
    channels,
    sampleRate,
    elapsedMs,
    at: Date.now(),
  };
  await saveHistory(entry);

  broadcast({ type: 'done', jobId, downloadId, ...entry });
  // 注意：这里不能关离屏文档 —— chrome.downloads 对 blob: URL 的读取是异步的，
  // 文档一旦关闭，Blob URL 立即失效，文件会下载失败。等 onChanged 里再回收。
}

/** 下载结束后释放 Blob，避免离屏文档里一直挂着内存 */
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  for (const [jobId, rec] of pendingDownloads) {
    if (rec.downloadId !== delta.id) continue;

    pendingDownloads.delete(jobId);
    await persistPending();

    try {
      await sendToOffscreen({ cmd: 'release', jobId }, { recreate: false });
    } catch {
      /* 离屏文档可能已经关闭 */
    }

    if (state === 'interrupted') {
      broadcast({ type: 'error', jobId, message: '下载被中断或取消，文件可能不完整' });
    }
    closeOffscreenIfIdle();
    break;
  }
});

/* 浏览器重启后，之前没等到 onChanged 的记录已经无意义，直接清掉 */
chrome.runtime.onStartup.addListener(() => {
  pendingDownloads.clear();
  chrome.storage.session.remove('pending').catch(() => {});
});

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */
/** 需要 background 主动响应的请求类型；离屏文档的 progress/done/error 不在此列 */
const REQUEST_TYPES = new Set([
  'ping',
  'probe',
  'start',
  'cancel',
  'history',
  'clearHistory',
  'account',
  'openDownloadFolder',
  'revealDownload',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;
  if (!REQUEST_TYPES.has(msg.type)) return false; // 交给下面那个监听器处理

  (async () => {
    try {
      switch (msg.type) {
        case 'ping':
          sendResponse({ ok: true });
          break;

        case 'probe': {
          const data = await probe(msg);
          sendResponse({ ok: true, data });
          break;
        }

        case 'start': {
          const jobId = msg.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          enqueue({
            jobId,
            bvid: msg.bvid,
            epId: msg.epId,
            cid: msg.cid,
            qualityId: msg.qualityId,
            bitrate: msg.bitrate,
          });
          sendResponse({ ok: true, data: { jobId } });
          break;
        }

        case 'cancel': {
          const idx = queue.findIndex((j) => j.jobId === msg.jobId);
          if (idx >= 0) {
            queue.splice(idx, 1);
            broadcast({ type: 'cancelled', jobId: msg.jobId });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: '任务已开始执行，无法取消' });
          }
          break;
        }

        case 'history': {
          const { history = [] } = await chrome.storage.local.get('history');
          sendResponse({ ok: true, data: history });
          break;
        }

        case 'clearHistory': {
          await chrome.storage.local.set({ history: [] });
          sendResponse({ ok: true });
          break;
        }

        case 'account': {
          const keys = await getWbiKeys();
          sendResponse({
            ok: true,
            data: { isLogin: Boolean(keys.isLogin), uname: keys.uname, vip: Boolean(keys.vip) },
          });
          break;
        }

        case 'openDownloadFolder':
          chrome.downloads.showDefaultFolder();
          sendResponse({ ok: true });
          break;

        case 'revealDownload':
          if (msg.downloadId != null) chrome.downloads.show(msg.downloadId);
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `未知消息类型：${msg.type}` });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err?.message || String(err),
        code: err?.code ?? null,
      });
    }
  })();

  return true; // 异步响应
});

/* 离屏文档过来的进度 / 完成 / 错误 */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'background') return false;

  if (msg.type === 'progress') {
    emitProgress(msg.jobId, msg.phase, msg.percent, {
      message: msg.message,
      indeterminate: msg.indeterminate,
    });
  } else if (msg.type === 'done') {
    handleOffscreenDone(msg);
  } else if (msg.type === 'error') {
    inFlightJobId = null;
    emitProgress(msg.jobId, 'error', 0, { message: msg.message });
    closeOffscreenIfIdle();
  }
  return false;
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(() => {
  installHeaderRules();
  restorePending();
});

// Service Worker 可能被回收后重启，动态规则存在浏览器里不会丢，
// 但为了保险，每次启动都检查一次。
installHeaderRules();
restorePending();

export { AUDIO_QUALITY, formatDuration };
