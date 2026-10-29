/**
 * 内容脚本：在 B 站视频页右下角注入一个「下载音频」悬浮按钮。
 *
 * 用 Shadow DOM 隔离样式，避免和 B 站页面互相污染。
 * 所有网络请求都转交给 background，内容脚本本身不发请求。
 */

(function () {
  if (window.__biliAudioInjected) return;
  window.__biliAudioInjected = true;

  const HOST_ID = 'bili-audio-downloader-root';

  /* ---------------------------------------------------------------- *
   * 与 background 通信
   * ---------------------------------------------------------------- */
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

  /* ---------------------------------------------------------------- *
   * 样式
   * ---------------------------------------------------------------- */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .root {
      position: fixed;
      right: 20px;
      bottom: 88px;
      z-index: 2147483000;
      font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #18191c;
    }

    .fab {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 9px 15px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(135deg, #00aeec, #4fc9f5);
      color: #fff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 174, 236, 0.4);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .fab:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,174,236,.5); }
    .fab:active { transform: translateY(0); }
    .fab[disabled] { opacity: .6; cursor: not-allowed; transform: none; }
    .fab .ico { font-size: 15px; }

    .panel {
      position: absolute;
      right: 0;
      bottom: 52px;
      width: 300px;
      padding: 14px;
      border: 1px solid #e3e5e7;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16);
    }
    .panel[hidden] { display: none; }

    .p-title {
      margin: 0 0 3px;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .p-sub { margin: 0 0 10px; font-size: 11px; color: #6d7278; }

    .p-field { display: block; margin-bottom: 9px; }
    .p-label { display: block; margin-bottom: 4px; font-size: 11px; color: #6d7278; }
    select {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid #e3e5e7;
      border-radius: 7px;
      background: #fff;
      color: inherit;
      font: inherit;
    }
    select:focus { outline: none; border-color: #00aeec; }

    .p-actions { display: flex; gap: 6px; margin-top: 10px; }
    .btn {
      flex: 1;
      padding: 7px 12px;
      border: 1px solid #e3e5e7;
      border-radius: 7px;
      background: #fff;
      color: inherit;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .btn.primary { border-color: transparent; background: #00aeec; color: #fff; }
    .btn.primary:hover:not([disabled]) { background: #0095c8; }
    .btn[disabled] { opacity: .55; cursor: not-allowed; }

    .bar { height: 5px; margin-top: 10px; border-radius: 3px; background: #eef0f2; overflow: hidden; }
    .bar-fill { height: 100%; width: 0; background: linear-gradient(90deg,#00aeec,#5cd6ff); transition: width .2s ease; }
    .bar-fill.indet { width: 40%; animation: slide 1.1s ease-in-out infinite; }
    @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }

    .msg { margin: 7px 0 0; font-size: 11px; color: #6d7278; min-height: 14px; word-break: break-word; }
    .msg.error { color: #b3204f; }
    .msg.ok { color: #1a7a44; }

    .p-close {
      position: absolute; top: 8px; right: 8px;
      width: 20px; height: 20px;
      border: none; border-radius: 5px;
      background: none; color: #6d7278;
      font-size: 14px; line-height: 1; cursor: pointer;
    }
    .p-close:hover { background: #f1f2f3; }
  `;

  /* ---------------------------------------------------------------- *
   * 构建 UI
   * ---------------------------------------------------------------- */
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;

  const root = document.createElement('div');
  root.className = 'root';
  root.innerHTML = `
    <div class="panel" hidden>
      <button class="p-close" title="关闭">✕</button>
      <p class="p-title"></p>
      <p class="p-sub"></p>
      <label class="p-field">
        <span class="p-label">音质</span>
        <select class="p-quality"></select>
      </label>
      <div class="p-actions">
        <button class="btn primary p-download">下载 MP3</button>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
      <p class="msg"></p>
    </div>
    <button class="fab"><span class="ico">♪</span><span>下载音频</span></button>
  `;

  shadow.append(style, root);
  document.documentElement.appendChild(host);

  const ui = {
    fab: shadow.querySelector('.fab'),
    panel: shadow.querySelector('.panel'),
    close: shadow.querySelector('.p-close'),
    title: shadow.querySelector('.p-title'),
    sub: shadow.querySelector('.p-sub'),
    quality: shadow.querySelector('.p-quality'),
    download: shadow.querySelector('.p-download'),
    bar: shadow.querySelector('.bar-fill'),
    msg: shadow.querySelector('.msg'),
  };

  let info = null;
  let busy = false;
  let jobId = null;

  function setMsg(text, kind = '') {
    ui.msg.textContent = text || '';
    ui.msg.className = `msg ${kind}`.trim();
  }

  function setBar(percent, indeterminate) {
    if (indeterminate || percent == null) {
      ui.bar.classList.add('indet');
      return;
    }
    ui.bar.classList.remove('indet');
    ui.bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  function setBusy(next, label) {
    busy = next;
    ui.download.disabled = next;
    ui.download.textContent = label || (next ? '处理中…' : '下载 MP3');
    ui.fab.disabled = next;
  }

  function fillQuality(streams) {
    ui.quality.innerHTML = '';
    for (const s of streams) {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = `${s.label} · 约 ${s.kbps} kbps${s.desc ? ` · ${s.desc}` : ''}`;
      ui.quality.appendChild(opt);
    }
    if (streams.length > 0) ui.quality.value = String(streams[0].id);
  }

  function showPanel(data) {
    info = data;
    ui.title.textContent = data.title || '未知标题';
    const bits = [];
    if (data.owner) bits.push(data.owner);
    if (data.pages.length > 1) bits.push(`共 ${data.pages.length} P`);
    ui.sub.textContent = bits.join(' · ');
    fillQuality(data.streams);
    ui.panel.hidden = false;
    setMsg(data.notice || '', data.notice ? 'ok' : '');
    setBar(0);
  }

  /* ---------------------------------------------------------------- *
   * 行为
   * ---------------------------------------------------------------- */
  async function onFabClick() {
    if (busy) return;

    if (info) {
      ui.panel.hidden = !ui.panel.hidden;
      return;
    }

    ui.panel.hidden = false;
    ui.title.textContent = '正在解析…';
    ui.sub.textContent = '';
    ui.quality.innerHTML = '';
    setMsg('正在读取视频信息…');
    setBar(0, true);
    ui.fab.disabled = true;

    const res = await send({ type: 'probe', input: location.href });
    ui.fab.disabled = false;

    if (!res.ok) {
      ui.title.textContent = '解析失败';
      setMsg(res.error || '无法解析当前页面', 'error');
      setBar(0);
      return;
    }
    showPanel(res.data);
  }

  async function onDownloadClick() {
    if (!info || busy) return;

    setBusy(true);
    setMsg('正在创建任务…');
    setBar(0, true);

    const res = await send({
      type: 'start',
      bvid: info.bvid,
      epId: info.epId,
      cid: info.selectedCid,
      qualityId: ui.quality.value,
    });

    if (!res.ok) {
      setBusy(false);
      setMsg(res.error || '任务创建失败', 'error');
      setBar(0);
      return;
    }
    jobId = res.data.jobId;
  }

  ui.fab.addEventListener('click', onFabClick);
  ui.download.addEventListener('click', onDownloadClick);
  ui.close.addEventListener('click', () => {
    ui.panel.hidden = true;
  });

  /* ---------------------------------------------------------------- *
   * 接收进度广播
   * ---------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'ui') return;
    if (jobId && msg.jobId && msg.jobId !== jobId) return;

    if (msg.type === 'progress') {
      setBar(msg.percent, msg.indeterminate);
      setMsg(msg.message || '');
    } else if (msg.type === 'done') {
      setBusy(false);
      jobId = null;
      setBar(100);
      setMsg(`已保存：${msg.title}`, 'ok');
    } else if (msg.type === 'error') {
      setBusy(false);
      jobId = null;
      setBar(0);
      setMsg(msg.message || '处理失败', 'error');
    }
  });

  /* SPA 换页时把旧的解析结果作废，避免下错视频 */
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (busy) return;
    info = null;
    jobId = null;
    ui.panel.hidden = true;
    setMsg('');
    setBar(0);
  }, 1500);
})();
