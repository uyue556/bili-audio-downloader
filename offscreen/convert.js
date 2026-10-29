/**
 * 纯转码逻辑（不依赖任何 chrome.* API，便于单独测试）
 *
 * 依赖全局 `lamejs`（由 offscreen.html 以传统 <script> 方式引入 lib/lame.min.js）。
 */

export const SAMPLE_BLOCK = 1152; // MP3 每帧 1152 个采样
const YIELD_EVERY = 400; // 每编码多少块让出一次事件循环

/* ------------------------------------------------------------------ *
 * 下载（带进度，主地址失败自动切备用地址）
 * ------------------------------------------------------------------ */
export async function fetchWithProgress(urls, onProgress) {
  let lastError = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new Error(`音频流返回 HTTP ${res.status}`);

      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received, total);
      }

      if (received === 0) throw new Error('音频流内容为空');

      const merged = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return merged.buffer;
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(
    `下载音频流失败：${lastError?.message || '未知错误'}（可能是流地址已过期或网络被拦截）`
  );
}

/* ------------------------------------------------------------------ *
 * 采样格式转换
 * ------------------------------------------------------------------ */
/** Float32(-1~1) → Int16，就地写入 dst，省一份内存 */
export function floatToInt16(src, dst) {
  for (let i = 0; i < src.length; i++) {
    const s = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
    dst[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return dst;
}

/** 把任意声道数整理成 lamejs 需要的左右声道 */
export function pickChannels(audioBuffer) {
  const count = audioBuffer.numberOfChannels;

  if (count === 1) {
    return { channels: 1, left: audioBuffer.getChannelData(0), right: null };
  }

  if (count === 2) {
    return {
      channels: 2,
      left: audioBuffer.getChannelData(0),
      right: audioBuffer.getChannelData(1),
    };
  }

  // 多声道：前两声道作为左右，其余按 0.5 增益混入
  const len = audioBuffer.length;
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  left.set(audioBuffer.getChannelData(0));
  right.set(audioBuffer.getChannelData(1));
  for (let c = 2; c < count; c++) {
    const src = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const v = src[i] * 0.5;
      left[i] += v;
      right[i] += v;
    }
  }
  return { channels: 2, left, right };
}

/* ------------------------------------------------------------------ *
 * 编码
 * ------------------------------------------------------------------ */
/**
 * 把 AudioBuffer 编码为 MP3 数据块
 * @param {AudioBuffer} audioBuffer
 * @param {number} bitrate 目标码率 kbps
 * @param {(percent:number)=>void} [onProgress] 0~100
 * @returns {Promise<{parts: Int8Array[], totalBytes: number, channels:number, sampleRate:number, durationSec:number}>}
 */
export async function encodeToMp3(audioBuffer, bitrate, onProgress) {
  const lame = globalThis.lamejs;
  if (!lame) throw new Error('lamejs 未加载，无法编码 MP3');

  const { channels, left, right } = pickChannels(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const totalSamples = left.length;

  const encoder = new lame.Mp3Encoder(channels, sampleRate, bitrate);
  const parts = [];
  let totalBytes = 0;

  // 复用固定大小的缓冲，避免每个 block 都新建 Int16Array
  const leftBlock = new Int16Array(SAMPLE_BLOCK);
  const rightBlock = channels === 2 ? new Int16Array(SAMPLE_BLOCK) : null;

  let blockIndex = 0;
  for (let offset = 0; offset < totalSamples; offset += SAMPLE_BLOCK) {
    const size = Math.min(SAMPLE_BLOCK, totalSamples - offset);
    const l = size === SAMPLE_BLOCK ? leftBlock : leftBlock.subarray(0, size);
    const r =
      channels === 2
        ? size === SAMPLE_BLOCK
          ? rightBlock
          : rightBlock.subarray(0, size)
        : null;

    floatToInt16(left.subarray(offset, offset + size), l);
    if (channels === 2) floatToInt16(right.subarray(offset, offset + size), r);

    const buf = channels === 2 ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (buf.length > 0) {
      parts.push(buf);
      totalBytes += buf.length;
    }

    blockIndex++;
    if (blockIndex % YIELD_EVERY === 0) {
      if (onProgress) onProgress((offset / totalSamples) * 100);
      // 让出事件循环：离屏文档还要处理消息，不能长时间独占
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    parts.push(tail);
    totalBytes += tail.length;
  }

  if (totalBytes === 0) throw new Error('编码结果为空，音频可能没有有效数据');

  return {
    parts,
    totalBytes,
    channels,
    sampleRate,
    durationSec: totalSamples / sampleRate,
  };
}

/** 解码音频（Web Audio 会重采样到 context 的采样率） */
export async function decodeAudio(raw, sampleRate = 44100) {
  const audioCtx = new AudioContext({ sampleRate, latencyHint: 'playback' });
  try {
    return await audioCtx.decodeAudioData(raw);
  } catch (e) {
    throw new Error(
      `音频解码失败：${e?.message || '该音轨的编码格式浏览器无法解码'}。` +
        '请改用 192K 或 132K 音质重试（杜比全景声 / Hi-Res 无损可能不被支持）。'
    );
  } finally {
    audioCtx.close().catch(() => {});
  }
}
