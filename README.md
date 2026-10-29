# B站音频下载器

一个 Edge 浏览器扩展（Manifest V3）：把 B 站视频的音频提取出来，转码后保存成 **MP3** 文件。

---

## 功能

- 在 B 站视频页右下角注入「♪ 下载音频」悬浮按钮，点击即用
- 也可以点扩展图标，粘贴视频链接 / BV 号 / ep 号手动解析
- 支持多 P 视频（选择具体分P）与番剧（`ep` 号）
- 音质可选：64K / 132K / 192K / 杜比全景声 / Hi-Res 无损（取决于视频本身与账号权限）
- 全程显示进度：下载 → 解码 → 编码
- 保存路径：`下载目录/B站音频/《标题》- P序号.mp3`
- 记录最近 30 次下载

---

## 安装

1. 打开 Edge，地址栏输入 `edge://extensions/`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择本目录（含 `manifest.json` 的那一层）
4. 扩展图标出现在工具栏即可

> 无需 `npm install`，无需构建，代码即安装。

---

## 使用

### 方式一：页面上直接点

打开任意 B 站视频页 → 右下角出现「♪ 下载音频」→ 点开选音质 → 点「下载 MP3」。

### 方式二：扩展弹窗

点工具栏图标 → 自动识别当前标签页并解析（不在 B 站页时，手动粘贴 BV 号或链接）→ 选音质 → 下载。

---

## 音质说明

| 音轨 id | 码率 | 获取条件 | 转成 MP3 的码率 |
| --- | --- | --- | --- |
| 30216 | 64K | 免登录 | 128 kbps |
| 30232 | 132K | 免登录 | 160 kbps |
| 30280 | 192K | 需登录 | 192 kbps |
| 30250 | 杜比全景声 | 需大会员 | 192 kbps |
| 30251 | Hi-Res 无损 | 需大会员 | 320 kbps |

- **未登录时最高只有 132K**，扩展会在解析结果里明确提示。
- 扩展读取的是浏览器里你已登录的 B 站 Cookie（`SESSDATA`），不会上传到任何第三方，也不会额外申请 `cookies` 权限。
- 杜比全景声 / Hi-Res 是特殊封装，浏览器解码器可能不支持，失败时请改用 192K / 132K。

---

## 工作原理

```
页面/弹窗
   ↓ 解析 bvid / ep_id
background.js (Service Worker)
   ↓ x/web-interface/view        取标题、UP主、分P列表
   ↓ x/web-interface/nav         取 WBI 密钥（img_key / sub_key）
   ↓ x/player/wbi/playurl         WBI 签名的 DASH 取流（fnval=4048）
   ↓ 选最高带宽音频流
offscreen/offscreen.js (离屏文档)
   ↓ fetch 音频流（m4s / AAC）
   ↓ AudioContext.decodeAudioData → PCM
   ↓ lamejs 编码 → MP3
   ↓ Blob URL
background.js
   ↓ chrome.downloads.download  →  .mp3 文件
```

### 三个关键技术点

1. **WBI 签名** —— B 站 Web 端接口从 2023 年起要求 `w_rid`/`wts` 签名。实现在 `lib/wbi.js`：从 nav 接口取伪装成图片名的 `img_key`/`sub_key`，按 64 项映射表重排得 `mixin_key`，再对排序后的参数做 MD5。

2. **绕过 CDN 的 Referer 校验** —— `*.bilivideo.com` 强制校验 `Referer: https://www.bilibili.com`，缺失直接 403。而 `Referer` 是 fetch 的禁止头，JS 无法设置。解决方案：`background.js` 在启动时注册 `declarativeNetRequest` **动态规则**，只对扩展自身发起的请求改写 `Referer`/`Origin`/`User-Agent`（`initiatorDomains: [扩展ID]`），不影响你正常浏览 B 站。

3. **纯前端 m4s → MP3** —— MV3 的 Service Worker 没有 `AudioContext`，所以解码和编码放在**离屏文档**里做：
   - `AudioContext.decodeAudioData()` 直接解 AAC，不需要 ffmpeg
   - [lamejs](https://github.com/zhuker/lamejs)（本地打包，152 KB）编码 MP3
   - 边解码边分块喂给编码器，峰值内存约为「源文件 + 一份 PCM」

   比 ffmpeg.wasm 省掉 30 MB 的 wasm，也不用放宽 CSP。

---

## 已知限制

- **转码是 CPU 密集的**：约 1 分钟音频需要 8 秒左右（192 kbps，单核）。1 小时视频大概要 8 分钟，期间标签页可以继续用，但别关扩展的离屏文档。
- **内存**：极长的音频（3 小时以上）可能占用 1 GB 以上内存，建议用 132K 音质下载以减小体积。
- **多 P 视频**一次只能下一 P，暂不支持批量排队。
- 需要 Edge / Chrome **116 及以上**（依赖 `chrome.runtime.getContexts`）。
- 视频必须本身带音轨；纯音乐区的 MV、番剧等同样适用，但**直播间、专栏**不支持。
- 转码期间请勿在 `edge://extensions/` 里点「重新加载」或关闭扩展，会中断当前任务。

### 实现上的两个坑（供二次开发参考）

1. **离屏文档不是标签页**：`chrome.runtime.getContexts()` 返回的 `tabId` 恒为 `-1`，所以
   `chrome.tabs.sendMessage(ctx.tabId, ...)` 一定抛 `Value must be at least 0`。
   与离屏文档通信只能走 `chrome.runtime.sendMessage` + `target` 字段过滤。
2. **不能用 `AUDIO_PLAYBACK` 作为离屏文档的理由**：该理由会在 30 秒无音频播放后
   自动关闭文档，会直接打断长音频转码。本项目用 `BLOBS`（需要 `URL.createObjectURL` 交付 MP3），无生命周期限制。

---

## 目录结构

```
bili-audio-downloader/
├─ manifest.json            MV3 清单
├─ background.js            Service Worker：流程编排、DNR 规则、下载落盘
├─ lib/
│  ├─ wbi.js                WBI 签名 + 内置 MD5
│  ├─ bili-api.js           B 站接口封装（nav / view / playurl / 番剧）
│  └─ lame.min.js           MP3 编码器（lamejs 1.2.1）
├─ offscreen/
│  ├─ offscreen.html        离屏文档入口
│  ├─ offscreen.js          消息接线
│  └─ convert.js            下载 / 解码 / 编码（纯逻辑，可单测）
├─ content/
│  ├─ content.js            悬浮按钮（Shadow DOM 隔离样式）
│  └─ content.css
├─ popup/
│  ├─ popup.html            弹窗
│  ├─ popup.css
│  └─ popup.js
└─ README.md
```

---

## 常见问题

**Q：点下载没反应 / 一直转圈？**
按 F12 看 Console，再到 `edge://extensions/` 点扩展的「Service Worker」链接看后台日志。常见原因是流地址过期（120 分钟），重新点一次下载即可。

**Q：提示「音频解码失败」？**
说明选的是杜比全景声 / Hi-Res 音轨，浏览器解不了。换 192K 或 132K。

**Q：只能下到 132K？**
未登录。先在浏览器里登录 B 站，再重新打开弹窗（有缓存，重开即可刷新登录态）。

**Q：下载的 MP3 比原视频音质差？**
MP3 是有损格式，从 AAC 再转一次必然有二次损失。想要无损应保留原始 m4s 而非转 MP3。

**Q：能下视频吗？**
本扩展只处理音频轨，不下视频。

---

## 免责声明

仅供个人学习研究与离线收听使用。请遵守 B 站用户协议与相关法律法规，不要用于二次分发或商业传播。下载内容的版权归原作者所有。
