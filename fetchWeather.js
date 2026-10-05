// 晴天才旅行 · 每日天气数据生成脚本（方案1：GitHub + jsDelivr 免费共享缓存）
// 作用：每天由 GitHub Actions 定时运行，抓取 431 城天气(Open-Meteo CMA 模型) + 空气质量，
//       生成 weather.json 并提交；小程序经 https://cdn.jsdelivr.net/gh/OWNER/REPO@main/weather.json 读取。
// 本地运行：node fetchWeather.js [输出路径，默认 ./weather.json]
// 依赖：Node 18+（使用全局 fetch，无需安装 npm 包）

const fs = require('fs');
const path = require('path');
const cities = require('./cities.js');

const WEATHER_API = 'https://api.open-meteo.com/v1/cma';
const AIR_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FORECAST_DAYS = 16;
const CONCURRENCY = 5;   // 降低并发，避免 Open-Meteo 免费层 429 限流
const RETRIES = 5;       // 提高重试次数，扛住瞬时限流

// ---- 以下纯映射与小程序的 utils/util.js、utils/api.js parseDailyForecasts 保持一致 ----
// 这样生成的 weather.json 字段与小程序的解析结果完全对齐，排行榜/详情页可直接消费。
function wmoToWeather(code) {
  const map = {
    0: '晴', 1: '晴', 2: '少云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '小雨', 53: '小雨', 55: '小雨', 56: '冻雨', 57: '冻雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '阵雨', 82: '大阵雨',
    85: '小阵雪', 86: '大阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴大冰雹'
  };
  return map[code] || '未知';
}
function getWeatherIcon(text) {
  if (!text) return '🌤️';
  if (text.indexOf('晴') !== -1) return '☀️';
  if (text.indexOf('多云') !== -1) return '⛅';
  if (text.indexOf('阴') !== -1) return '☁️';
  if (text.indexOf('小雨') !== -1 || text.indexOf('阵雨') !== -1 || text.indexOf('冻雨') !== -1) return '🌦️';
  if (text.indexOf('大雨') !== -1 || text.indexOf('暴雨') !== -1 || text.indexOf('中雨') !== -1) return '🌧️';
  if (text.indexOf('雷') !== -1) return '⛈️';
  if (text.indexOf('雪') !== -1) return '❄️';
  if (text.indexOf('雾') !== -1) return '🌫️';
  if (text.indexOf('霾') !== -1) return '😷';
  if (text.indexOf('沙') !== -1 || text.indexOf('尘') !== -1) return '🏜️';
  return '🌤️';
}
function windScaleOf(speed) {
  if (speed >= 61.9) return 8;
  if (speed >= 50.0) return 7;
  if (speed >= 38.9) return 6;
  if (speed >= 28.8) return 5;
  if (speed >= 19.8) return 4;
  if (speed >= 12.2) return 3;
  if (speed >= 5.8) return 2;
  if (speed >= 1.1) return 1;
  return 0;
}
function windDirOf(deg) {
  if (deg >= 337.5 || deg < 22.5) return '北风';
  if (deg < 67.5) return '东北风';
  if (deg < 112.5) return '东风';
  if (deg < 157.5) return '东南风';
  if (deg < 202.5) return '南风';
  if (deg < 247.5) return '西南风';
  if (deg < 292.5) return '西风';
  return '西北风';
}

function httpGet(url) {
  return fetch(url, { signal: AbortSignal.timeout(15000) }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function fetchWeather(lat, lng) {
  const url = WEATHER_API + '?latitude=' + lat + '&longitude=' + lng +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,wind_gusts_10m_max' +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m' +
    '&timezone=Asia/Shanghai&forecast_days=' + FORECAST_DAYS;
  return httpGet(url);
}
function fetchAir(lat, lng) {
  const url = AIR_API + '?latitude=' + lat + '&longitude=' + lng +
    '&current=us_aqi,pm10,pm2_5&timezone=Asia/Shanghai';
  return httpGet(url).catch(function () { return null; });
}

function parseWeather(data) {
  if (!data.daily || !data.daily.time) return null;
  const today = new Date();
  const startDateStr = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');
  let startIdx = data.daily.time.indexOf(startDateStr);
  if (startIdx < 0) startIdx = 0;
  const out = [];
  for (let dOff = 0; dOff < FORECAST_DAYS; dOff++) {
    const i = startIdx + dOff;
    if (i >= data.daily.time.length) break;
    const code = data.daily.weather_code[i];
    const text = wmoToWeather(code);
    const tempMax = Math.round(data.daily.temperature_2m_max[i]);
    const tempMin = Math.round(data.daily.temperature_2m_min[i]);
    const feelsLike = Math.round(data.daily.apparent_temperature_max[i]);
    const precipSum = data.daily.precipitation_sum[i] || 0;
    // CMA 不支持 precipitation_probability_max，用降水量估算（与小程序 api.js 一致）
    const precipProb = (precipSum > 0) ? Math.min(95, Math.round(30 + precipSum * 15)) : 0;
    const windSpeedMax = data.daily.wind_speed_10m_max[i] || 0;
    const windDirDeg = data.daily.wind_direction_10m_dominant[i] || 0;
    out.push({
      date: data.daily.time[i],
      text: text,
      tempMax: tempMax,
      tempMin: tempMin,
      temp: Math.round((tempMax + tempMin) / 2),
      feelsLike: feelsLike,
      humidity: data.current ? data.current.relative_humidity_2m : null,
      windDir: windDirOf(windDirDeg),
      windScale: String(windScaleOf(windSpeedMax)),
      precipProb: precipProb,
      icon: getWeatherIcon(text)
    });
  }
  return out.length ? out : null;
}

function parseAir(data) {
  if (!data || !data.current) return null;
  return {
    aqi: data.current.us_aqi != null ? Math.round(data.current.us_aqi) : null,
    pm2p5: data.current.pm2_5 != null ? Math.round(data.current.pm2_5) : null,
    pm10: data.current.pm10 != null ? Math.round(data.current.pm10) : null
  };
}

async function buildOne(city) {
  const [w, a] = await Promise.all([fetchWeather(city.lat, city.lng), fetchAir(city.lat, city.lng)]);
  return { weather: parseWeather(w), air: parseAir(a) };
}

async function run() {
  const outPath = process.argv[2] || path.join(__dirname, 'weather.json');
  const result = { cities: {} };
  let ok = 0, fail = 0;
  for (let i = 0; i < cities.length; i += CONCURRENCY) {
    const batch = cities.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async function (city) {
      let attempt = 0;
      while (true) {
        try {
          const r = await buildOne(city);
          if (!r.weather) return { city: city, ok: false };
          return { city: city, ok: true, weather: r.weather, air: r.air };
        } catch (e) {
          attempt++;
          if (attempt >= RETRIES) return { city: city, ok: false, err: e.message };
          await new Promise(function (res) { setTimeout(res, 500 * attempt); });
        }
      }
    }));
    settled.forEach(function (s) {
      if (s.ok) {
        ok++;
        result.cities[s.city.lat + ',' + s.city.lng] = {
          name: s.city.name,
          province: s.city.province,
          lat: s.city.lat,
          lng: s.city.lng,
          weather: s.weather,
          air: s.air
        };
      } else {
        fail++;
        console.warn('失败:', s.city.name, s.err || '空数据');
      }
    });
    console.log('进度 ' + Math.min(i + CONCURRENCY, cities.length) + '/' + cities.length + ' (成功' + ok + '/失败' + fail + ')');
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const payload = {
    date: '' + y + m + d,
    updatedAt: now.toISOString(),
    source: 'open-meteo-cma',
    total: cities.length,
    success: ok,
    failed: fail,
    note: '每日北京06:00由GitHub Actions生成，小程序经jsDelivr读取。字段与utils/api.js parseDailyForecasts一致。',
    cities: result.cities
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
  console.log('已写出 ' + outPath + '：成功 ' + ok + '/' + cities.length + '，失败 ' + fail);
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
