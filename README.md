# 晴天才旅行 · 免费天气数据仓库（方案1）

把"每天抓一次 431 城天气 + 空气质量"这件事，放到一个**长期免费、不会被掐**的地方：
GitHub 公开仓库 + jsDelivr CDN + GitHub Actions 定时生成。小程序只读这份共享 JSON，不再各自打天气源。

## 工作原理

1. GitHub Actions 每天 **北京时间 06:00**（UTC 22:00）运行 `fetchWeather.js`；
2. 脚本用 Open-Meteo（CMA 模型，免费、无需 key）抓取 431 城天气 + 空气质量，生成 `weather.json`；
3. Actions 把 `weather.json` 提交回仓库；
4. 小程序通过 `https://cdn.jsdelivr.net/gh/arha925/weather-data@main/weather.json` 读取共享数据。

- Open-Meteo 免费额度充足（日抓 ~862 次，远低于上限）；
- jsDelivr 免费、全球 CDN、无带宽焦虑；
- 数据 100% 是你的，随时可下载 / 克隆 / 备份。

## 部署步骤（一次性）

1. 在 GitHub 新建一个**公开**仓库（例如 `weather-cache`）；
2. 把本目录内容（不含 `.git` 的脚手架）推上去：
   - `fetchWeather.js`
   - `cities.js`
   - `weather.json`（首次可本地生成，见下）
   - `.github/workflows/daily-weather.yml`
3. 仓库 **Settings → Actions → General → Workflow permissions** 设为 `Read and write permissions`（让 Actions 能提交）；
4. 在微信公众平台 → 开发 → 开发管理 → **服务器域名 → request 合法域名** 添加：
   `https://cdn.jsdelivr.net`

## 小程序端对接

改 `miniprogram/utils/cache.js` 顶部的常量：

```js
var SHARED_JSON_URL = 'https://cdn.jsdelivr.net/gh/arha925/weather-data@main/weather.json';
```

`getWeather(..., 'hybrid')` 会优先读这份共享 JSON（首次拉全量、之后内存命中），读不到再回落本地 / 直连源头。

## 本地生成 / 验证

```bash
node fetchWeather.js weather.json
```

生成的 `weather.json` 结构：

```json
{
  "date": "20260909",
  "updatedAt": "2026-09-09T06:00:00.000Z",
  "source": "open-meteo-cma",
  "total": 431,
  "success": 431,
  "failed": 0,
  "cities": {
    "39.9042,116.4074": {
      "name": "北京", "province": "北京", "lat": 39.9042, "lng": 116.4074,
      "weather": [ { "date": "...", "text": "晴", "tempMax": 26, "tempMin": 15, "temp": 20, "feelsLike": 25, "humidity": 40, "windDir": "北风", "windScale": "3", "precipProb": 0, "icon": "☀️" } ],
      "air": { "aqi": 42, "pm2p5": 12, "pm10": 30 }
    }
  }
}
```

## 手动触发

仓库 **Actions → daily-weather → Run workflow** 可立即跑一次，不用等定时。
