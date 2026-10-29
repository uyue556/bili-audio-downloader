/**
 * 离屏文档：下载音频流 → 解码 AAC → 用 lamejs 编码成 MP3
 *
 * 设计要点：
 * 1. 音频流由本文件自己 fetch。这样既省掉「把几十 MB 二进制通过消息传递」的开销，
 *    又能直接复用 background 注册的 declarativeNetRequest 规则（改写 Referer）。
 * 2. 编码结果用 Blob URL 交给 background 调 chrome.downloads 落盘
 *    —— 离屏文档没有 downloads 权限，而且大二进制不适合走消息传递。
 * 3. 纯逻辑都放在 convert.js，本文件只做消息接线。
 */

import { fetchWithProgress, decodeAudio, encodeToMp3 } from './convert.js';

/** jobId -> { blobUrl } */
const jobs = new Map();

function post(msg) {
  chrome.runtime.sendMessage({ target: 'background', ...msg });
}

function reportProgress(jobId, phase, percent, extra = {}) {
  post({ type: 'progress', jobId, phase, percent, ...extra });
}

function releaseJob(jobId) {
  const job = jobs.get(jobId);
  if (job?.blobUrl) URL.revokeObjectURL(job.blobUrl);
  jobs.delete(jobId);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.cmd === 'convert') {
    runConvert(msg).catch((err) => {
      post({ type: 'error', jobId: msg.jobId, message: err?.message || String(err) });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.cmd === 'release') {
    releaseJob(msg.jobId);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function runConvert({ jobId, urls, bitrate, title }) {
  const startAt = Date.now();
  jobs.set(jobId, { blobUrl: null });

  // 1) 下载
  reportProgress(jobId, 'download', 0, { message: '正在获取音频流…' });
  const raw = await fetchWithProgress(urls, (received, total) => {
    reportProgress(jobId, 'download', total ? Math.min(100, (received / total) * 100) : 0, {
      message: total
        ? `下载中 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
        : `下载中 ${(received / 1048576).toFixed(1)} MB`,
      indeterminate: !total,
    });
  });

  // 2) 解码
  reportProgress(jobId, 'decode', 0, { message: '正在解码音频…', indeterminate: true });
  const audioBuffer = await decodeAudio(raw, 44100);

  // 3) 编码
  reportProgress(jobId, 'encode', 0, {
    message: '正在编码 MP3…',
    channels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
  });

  const result = await encodeToMp3(audioBuffer, bitrate, (percent) => {
    reportProgress(jobId, 'encode', percent, { message: `编码中 ${Math.round(percent)}%` });
  });

  // 4) 产出 Blob URL
  const blob = new Blob(result.parts, { type: 'audio/mpeg' });
  const blobUrl = URL.createObjectURL(blob);
  jobs.set(jobId, { blobUrl });

  post({
    type: 'done',
    jobId,
    blobUrl,
    size: blob.size,
    title,
    durationSec: result.durationSec,
    channels: result.channels,
    sampleRate: result.sampleRate,
    elapsedMs: Date.now() - startAt,
  });
}
