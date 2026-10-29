/**
 * B 站接口封装
 *
 * 说明：
 * - 所有请求都从 Service Worker 发出。因为扩展声明了 api.bilibili.com / *.bilivideo.com
 *   的 host_permissions，Chrome 会把这类跨站请求当作 same-site 处理，
 *   所以带 credentials:'include' 时能正常带上 SESSDATA（含 SameSite=Strict 的 Cookie）。
 * - Referer 属于 fetch 的禁止头，无法在 JS 里直接设置，统一由 background.js 注册的
 *   declarativeNetRequest 动态规则改写。
 */

import { encWbi, extractWbiKeys } from './wbi.js';

const API = 'https://api.bilibili.com';
const WBI_KEY_TTL = 6 * 60 * 60 * 1000; // 官方每日轮换，这里保守缓存 6 小时

/* ------------------------------------------------------------------ *
 * 音质元数据
 * ------------------------------------------------------------------ */
export const AUDIO_QUALITY = {
  30216: { label: '64K', desc: '流畅（免登录）' },
  30232: { label: '132K', desc: '标准（免登录）' },
  30280: { label: '192K', desc: '高音质（需登录）' },
  30250: { label: 'Dolby', desc: '杜比全景声（需大会员）' },
  30251: { label: 'Hi-Res', desc: '无损（需大会员）' },
};

/* ------------------------------------------------------------------ *
 * 错误处理
 * ------------------------------------------------------------------ */
const BILI_CODE_MSG = {
  '-101': '账号未登录',
  '-352': '触发 B 站风控校验，请稍后重试或先在浏览器里打开一次该视频',
  '-400': '请求参数错误',
  '-403': '没有访问权限（可能需要登录或大会员）',
  '-404': '视频不存在或已失效',
  '-10403': '该视频在当前地区不可访问',
  62002: '稿件不可见',
  62004: '稿件审核中',
};

export class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
  }
}

function explain(code, message) {
  if (code === 0) return '';
  const known = BILI_CODE_MSG[String(code)];
  if (known) return known;
  return message && message !== '0' ? message : `B 站接口返回错误码 ${code}`;
}

/* ------------------------------------------------------------------ *
 * 基础请求
 * ------------------------------------------------------------------ */
async function apiFetch(url, { params, signed = false } = {}) {
  let target = url;
  if (params) {
    target = `${url}${url.includes('?') ? '&' : '?'}${params}`;
  }

  let res;
  try {
    res = await fetch(target, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
  } catch (e) {
    throw new BiliError(`网络请求失败：${e.message}`, 'network');
  }

  if (!res.ok) {
    throw new BiliError(`接口返回 HTTP ${res.status}`, res.status);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new BiliError('接口返回内容不是合法 JSON（可能被风控拦截）', 'parse');
  }

  if (json.code !== 0) {
    const err = new BiliError(explain(json.code, json.message), json.code);
    // 带 WBI 的接口在签名过期时也会返回 v_voucher，交给调用方重试
    if (json.data && json.data.v_voucher) err.wbiExpired = true;
    throw err;
  }

  return json.data;
}

/* ------------------------------------------------------------------ *
 * WBI keys
 * ------------------------------------------------------------------ */
let wbiKeyCache = null; // { imgKey, subKey, at }

export async function getWbiKeys(force = false) {
  if (!force && wbiKeyCache && Date.now() - wbiKeyCache.at < WBI_KEY_TTL) {
    return wbiKeyCache;
  }

  // nav 未登录时 code 为 -101，但 data.wbi_img 依然存在，所以这里不走 apiFetch
  const res = await fetch(`${API}/x/web-interface/nav`, {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new BiliError(`获取 WBI 密钥失败：HTTP ${res.status}`, res.status);

  const json = await res.json();
  const img = json?.data?.wbi_img?.img_url;
  const sub = json?.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new BiliError('获取 WBI 密钥失败：响应结构异常', 'wbi');

  const { imgKey, subKey } = extractWbiKeys(img, sub);
  wbiKeyCache = {
    imgKey,
    subKey,
    at: Date.now(),
    isLogin: Boolean(json?.data?.isLogin),
    uname: json?.data?.uname || '',
    vip: Boolean(json?.data?.vipStatus),
  };
  return wbiKeyCache;
}

/** 调用需要 WBI 签名的接口，签名失效自动刷新密钥重试一次 */
async function signedFetch(path, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const keys = await getWbiKeys(attempt > 0);
    const query = encWbi(params, keys.imgKey, keys.subKey);
    try {
      return await apiFetch(`${API}${path}`, { params: query });
    } catch (e) {
      if (attempt === 0 && (e.wbiExpired || e.code === -403)) continue;
      throw e;
    }
  }
  throw new BiliError('WBI 签名失败', 'wbi');
}

/* ------------------------------------------------------------------ *
 * 稿件信息
 * ------------------------------------------------------------------ */
export function parseBvid(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

export function parseEpId(input) {
  if (!input) return null;
  const m = String(input).match(/ep(\d+)/i);
  return m ? m[1] : null;
}

/** 普通投稿：拿到 aid / 标题 / UP主 / 分P 列表 */
export async function getVideoInfo(bvid) {
  const data = await apiFetch(`${API}/x/web-interface/view`, { params: `bvid=${bvid}` });
  return {
    kind: 'video',
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    owner: data.owner?.name || '',
    cover: data.pic || '',
    duration: data.duration,
    pages: (data.pages || []).map((p) => ({
      cid: p.cid,
      index: p.page,
      title: p.part || `P${p.page}`,
      duration: p.duration,
    })),
  };
}

/** 番剧/影视：用 ep_id 拿剧集信息 */
export async function getBangumiInfo(epId) {
  const data = await apiFetch(`${API}/pgc/view/web/season`, { params: `ep_id=${epId}` });
  const ep = (data.episodes || []).find((e) => String(e.ep_id) === String(epId));
  return {
    kind: 'bangumi',
    epId: String(epId),
    seasonId: data.season_id,
    title: data.title,
    owner: data.up_info?.uname || '',
    cover: data.cover || '',
    duration: ep?.duration ? Math.round(ep.duration / 1000) : data.episodes?.[0]?.duration || 0,
    pages: ep
      ? [{ cid: ep.cid, index: ep.ep_index || 1, title: ep.show_title || ep.title, duration: Math.round((ep.duration || 0) / 1000) }]
      : [],
    episodeName: ep?.show_title || ep?.title || '',
  };
}

/* ------------------------------------------------------------------ *
 * 取流
 * ------------------------------------------------------------------ */
const FNVAL_DASH_ALL = 4048; // 16|64|128|256|512|1024|2048

/**
 * 获取 DASH 取流信息
 * @param {{bvid?: string, cid: number|string, epId?: string}} opts
 */
export async function getPlayUrl({ bvid, cid, epId }) {
  const params = {
    cid: String(cid),
    qn: '127',
    fnver: '0',
    fnval: String(FNVAL_DASH_ALL),
    fourk: '1',
  };

  if (epId) {
    // 番剧走 pgc 接口，同样需要 WBI 签名
    params.ep_id = String(epId);
    const data = await signedFetch('/pgc/player/web/playurl', params);
    return data;
  }

  params.bvid = bvid;
  const data = await signedFetch('/x/player/wbi/playurl', params);
  return data;
}

/**
 * 从 DASH 数据里挑出所有可用音频流，按带宽降序
 */
export function pickAudioStreams(dash) {
  if (!dash) return [];

  const collect = (item, source) => {
    if (!item) return null;
    const url = item.baseUrl || item.base_url;
    if (!url) return null;
    return {
      id: item.id,
      bandwidth: item.bandwidth || 0,
      mimeType: item.mimeType || item.mime_type || '',
      codecs: item.codecs || '',
      url,
      backupUrls: item.backupUrl || item.backup_url || [],
      source,
      label: AUDIO_QUALITY[item.id]?.label || String(item.id),
      desc: AUDIO_QUALITY[item.id]?.desc || '',
    };
  };

  const list = [];
  for (const a of dash.audio || []) {
    const s = collect(a, 'normal');
    if (s) list.push(s);
  }
  for (const a of dash.dolby?.audio || []) {
    const s = collect(a, 'dolby');
    if (s) list.push(s);
  }
  const flac = collect(dash.flac?.audio, 'flac');
  if (flac) list.push(flac);

  // 同一 id 可能有多个镜像，去重后按带宽降序
  const seen = new Set();
  return list
    .filter((s) => {
      const key = `${s.id}-${s.bandwidth}-${s.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.bandwidth - a.bandwidth);
}

export { apiFetch, signedFetch };
