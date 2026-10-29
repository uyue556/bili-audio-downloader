/**
 * Popup 逻辑
 * 只负责「拿数据 → 渲染 → 发指令」，所有网络与转码都在 background / offscreen 里做。
 */

const $ = (id) => document.getElementById(id);

const el = {
  account: $('account'),
  btnFolder: $('btnFolder'),
  inputUrl: $('inputUrl'),
  btnProbe: $('btnProbe'),
  infoCard: $('infoCard'),
  cover: $('cover'),
  vTitle: $('vTitle'),
  vOwner: $('vOwner'),
  vDuration: $('vDuration'),
  pageField: $('pageField'),
  selPage: $('selPage'),
  selQuality: $('selQuality'),
  btnStart: $('btnStart'),
  progressCard: $('progressCard'),
  pPhase: $('pPhase'),
  pPercent: $('pPercent'),
  pBar: $('pBar'),
  pMsg: $('pMsg'),
  alert: $('alert'),
  historyList: $('historyList'),
  btnClearHistory: $('btnClearHistory'),
};

const state = {
  info: null,
  probing: false,
  busy: false,
  currentJobId: null,
};

/* ------------------------------------------------------------------ *
 * 与 background 通信
 * ------------------------------------------------------------------ */
function send(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'background', ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: '没有收到响应' });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 界面工具
 * ------------------------------------------------------------------ */
function showAlert(message, kind = 'error') {
  el.alert.textContent = message;
  el.alert.className = `alert ${kind}`;
}

function hideAlert() {
  el.alert.className = 'alert hidden';
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */
function renderAccount(data) {
  if (!data) {
    el.account.textContent = '未登录（最高 132K 音质）';
    return;
  }
  el.account.textContent = data.isLogin
    ? `${data.uname || '已登录'}${data.vip ? ' · 大会员' : ''}`
    : '未登录（最高 132K 音质）';
}

function renderInfo(info) {
  state.info = info;

  el.vTitle.textContent = info.title || '未知标题';
  el.vOwner.textContent = info.owner ? `UP主：${info.owner}` : '';
  el.vDuration.textContent = info.duration ? `时长：${formatDuration(info.duration)}` : '';
  if (info.cover) {
    el.cover.src = info.cover;
    el.cover.style.display = '';
  } else {
    el.cover.removeAttribute('src');
    el.cover.style.display = 'none';
  }

  // 分P
  if (info.pages.length > 1) {
    el.pageField.classList.remove('hidden');
    el.selPage.innerHTML = '';
    for (const p of info.pages) {
      const opt = document.createElement('option');
      opt.value = String(p.cid);
      opt.textContent = `P${p.index} ${p.title}`;
      if (String(p.cid) === String(info.selectedCid)) opt.selected = true;
      el.selPage.appendChild(opt);
    }
  } else {
    el.pageField.classList.add('hidden');
    el.selPage.innerHTML = '';
  }

  // 音质
  el.selQuality.innerHTML = '';
  for (const s of info.streams) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = `${s.label} · 约 ${s.kbps} kbps${s.desc ? ` · ${s.desc}` : ''}`;
    el.selQuality.appendChild(opt);
  }
  // 默认最高（streams 已按带宽降序）
  if (info.streams.length > 0) el.selQuality.value = String(info.streams[0].id);

  el.infoCard.classList.remove('hidden');
}

function renderProgress(phase, percent, message, indeterminate) {
  const phaseText = {
    prepare: '准备中',
    download: '下载音频',
    decode: '解码',
    encode: '编码 MP3',
    error: '失败',
    done: '完成',
  };

  el.progressCard.classList.remove('hidden');
  el.pPhase.textContent = phaseText[phase] || phase;
  el.pMsg.textContent = message || '';

  if (indeterminate || percent == null) {
    el.pPercent.textContent = '';
    el.pBar.classList.add('indeterminate');
  } else {
    const p = Math.max(0, Math.min(100, percent));
    el.pPercent.textContent = `${Math.round(p)}%`;
    el.pBar.classList.remove('indeterminate');
    el.pBar.style.width = `${p}%`;
  }
}

function hideProgress() {
  el.progressCard.classList.add('hidden');
  el.pBar.style.width = '0';
  el.pBar.classList.remove('indeterminate');
}

function renderHistory(list) {
  el.historyList.innerHTML = '';
  if (!list || list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有下载记录';
    el.historyList.appendChild(li);
    return;
  }

  for (const item of list) {
    const li = document.createElement('li');

    const title = document.createElement('span');
    title.className = 'h-title';
    title.textContent = item.title || '未命名';
    title.title = item.title || '';

    const meta = document.createElement('span');
    meta.className = 'h-meta';
    meta.textContent = [formatSize(item.size), timeAgo(item.at)].filter(Boolean).join(' · ');

    li.append(title, meta);
    el.historyList.appendChild(li);
  }
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */
async function loadAccount() {
  const res = await send({ type: 'account' });
  if (res.ok) renderAccount(res.data);
  else renderAccount(null);
}

async function loadHistory() {
  const res = await send({ type: 'history' });
  renderHistory(res.ok ? res.data : []);
}

async function doProbe(input) {
  const value = (input ?? el.inputUrl.value ?? '').trim();
  if (!value) {
    showAlert('请先填入视频地址或 BV 号');
    return;
  }

  if (state.probing) return;
  state.probing = true;
  el.btnProbe.disabled = true;
  el.btnProbe.textContent = '解析中…';
  hideAlert();
  hideProgress();

  try {
    const res = await send({ type: 'probe', input: value });
    if (!res.ok) {
      showAlert(res.error || '解析失败');
      el.infoCard.classList.add('hidden');
      return;
    }
    renderInfo(res.data);
    if (res.data.notice) showAlert(res.data.notice, 'ok');
  } finally {
    state.probing = false;
    el.btnProbe.disabled = false;
    el.btnProbe.textContent = '解析';
  }
}

async function doStart() {
  if (!state.info || state.busy) return;

  const cid = el.selPage.value || state.info.selectedCid;
  const qualityId = el.selQuality.value;

  state.busy = true;
  el.btnStart.disabled = true;
  el.btnStart.textContent = '处理中…';
  hideAlert();
  renderProgress('prepare', 0, '正在创建任务…', true);

  const res = await send({
    type: 'start',
    bvid: state.info.bvid,
    epId: state.info.epId,
    cid,
    qualityId,
  });

  if (!res.ok) {
    state.busy = false;
    el.btnStart.disabled = false;
    el.btnStart.textContent = '下载 MP3';
    hideProgress();
    showAlert(res.error || '任务创建失败');
    return;
  }

  state.currentJobId = res.data.jobId;
}

/** 切换分P后重新探测（不同分P的时长/音轨可能不同） */
async function onPageChange() {
  if (!state.info) return;
  const cid = el.selPage.value;
  const target = state.info.bvid || state.info.epId;
  const res = await send({ type: 'probe', input: target, bvid: state.info.bvid, epId: state.info.epId, cid });
  if (res.ok) renderInfo(res.data);
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */
el.btnProbe.addEventListener('click', () => doProbe());
el.inputUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doProbe();
});
el.btnStart.addEventListener('click', doStart);
el.selPage.addEventListener('change', onPageChange);

el.btnFolder.addEventListener('click', () => send({ type: 'openDownloadFolder' }));

el.btnClearHistory.addEventListener('click', async () => {
  await send({ type: 'clearHistory' });
  renderHistory([]);
});

/* background / offscreen 的广播 */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'ui') return;

  if (msg.type === 'progress') {
    renderProgress(msg.phase, msg.percent, msg.message, msg.indeterminate);
  } else if (msg.type === 'done') {
    state.busy = false;
    state.currentJobId = null;
    el.btnStart.disabled = false;
    el.btnStart.textContent = '下载 MP3';
    renderProgress('done', 100, `已保存：${msg.title}`);
    showAlert(`已保存为 MP3：${msg.title}（${formatSize(msg.size)}）`, 'ok');
    loadHistory();
  } else if (msg.type === 'error') {
    state.busy = false;
    state.currentJobId = null;
    el.btnStart.disabled = false;
    el.btnStart.textContent = '下载 MP3';
    hideProgress();
    showAlert(msg.message || '处理失败');
  } else if (msg.type === 'queued') {
    renderProgress('prepare', 0, `已加入队列，前面还有 ${msg.position} 个任务`, true);
  } else if (msg.type === 'cancelled') {
    state.busy = false;
    el.btnStart.disabled = false;
    el.btnStart.textContent = '下载 MP3';
    hideProgress();
  }
});

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
(async function init() {
  await Promise.all([loadAccount(), loadHistory()]);

  // 如果当前标签页就是 B 站视频页，自动填入并解析
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (/bilibili\.com\/(video|bangumi\/play)\//.test(url)) {
      el.inputUrl.value = url;
      doProbe(url);
    }
  } catch {
    /* 忽略 */
  }
})();
