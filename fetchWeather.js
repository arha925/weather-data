// 晴天才旅行 · 每日天气数据生成脚本（方案1：GitHub + jsDelivr 免费共享缓存）
// 作用：每天由 GitHub Actions 定时运行，抓取 431 城天气 + 空气质量，
//       生成 weather.json 并提交；小程序经 jsDelivr CDN 读取。
// 本地运行：node fetchWeather.js [输出路径，默认 ./weather.json]
// 依赖：Node 18+（使用全局 fetch，无需安装 npm 包）
//
// 【数据源策略】CMA 优先 + 默认模型兜底（逐天 fallback）
//   - CMA（中国气象局模型）对国内预报更准，但免费层只给未来约 5 天，第 6 天起 weather_code 为 null
//   - 默认模型（best_match 混合）给满 16 天，且支持真实的 precipitation_probability_max
//   - 因此逐天判断：某天 CMA 有有效天气码就用 CMA，否则回退默认模型
//   这样既保住近几天的国内精度，又让出行日期条第 6-16 天有真数据（而非「未知」）
//
// 【日期口径】全程按 Asia/Shanghai 计算「今天」，避免 GitHub Actions(UTC) 与北京日期错位

const fs = require('fs');
const path = require('path');
const cities = require('./cities.js');

const WEATHER_API_CMA = 'https://api.open-meteo.com/v1/cma';
const WEATHER_API_DEFAULT = 'https://api.open-meteo.com/v1/forecast';
const AIR_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const FORECAST_DAYS = 16;
const CONCURRENCY = 4;          // 请求量翻倍（每城 2 个天气源），并发相应压低以躲限流
const RETRIES = 5;
const BATCH_INTERVAL_MS = 1200; // 每批之间留间隔，避免持续打爆免费额度

const DAILY_FIELDS_CMA = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,wind_gusts_10m_max';
// 默认模型额外支持降水概率，比 CMA 的「按降水量估算」可靠得多
const DAILY_FIELDS_DEFAULT = DAILY_FIELDS_CMA + ',precipitation_probability_max';
const CURRENT_FIELDS = 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m';

// ---- 以下映射与小程序的 utils/util.js 保持一致 ----
function wmoToWeather(code) {
  // 无效天气码返回 null（关键：不再伪装成「未知」，避免被当成一种真实天气参与评分）
  if (code == null) return null;
  const map = {
    0: '晴', 1: '晴', 2: '少云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '小雨', 53: '小雨', 55: '小雨', 56: '冻雨', 57: '冻雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '阵雨', 82: '大阵雨',
    85: '小阵雪', 86: '大阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴大冰雹'
  };
  return map[code] || null;
}
function getWeatherIcon(text) {
  if (!text) return '';
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
function ri(v) {
  return (typeof v === 'number' && !isNaN(v)) ? Math.round(v) : null;
}
function sleep(ms) {
  return new Promise(function (res) { setTimeout(res, ms); });
}

// 按北京时间取「今天」的 YYYY-MM-DD（避免 UTC 跑批时算成前一天）
function todayStrShanghai() {
  const parts = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).split('-');
  if (parts.length === 3) {
    const y = parts[0], m = parts[1].padStart(2, '0'), d = parts[2].padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

// 生成未来 FORECAST_DAYS 天的日期序列（以北京时间今天为起点）
// 关键：无论运行环境时区如何，都用 Asia/Shanghai 显式格式化每一天，
// 避免此前用本地时区 getDate() 回读 +08:00 构造的 Date 导致整体回偏一天。
function targetDates() {
  const base = new Date(todayStrShanghai() + 'T00:00:00+08:00');
  const out = [];
  for (let i = 0; i < FORECAST_DAYS; i++) {
    const t = base.getTime() + i * 86400000;
    const s = new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    out.push(s);
  }
  return out;
}

function httpGet(url) {
  return fetch(url, { signal: AbortSignal.timeout(20000) }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function buildUrl(base, lat, lng, dailyFields) {
  return base + '?latitude=' + lat + '&longitude=' + lng +
    '&daily=' + dailyFields +
    '&current=' + CURRENT_FIELDS +
    '&timezone=Asia/Shanghai&forecast_days=' + FORECAST_DAYS;
}

// 同时拉两个模型；任一失败不影响另一个（返回 null 由合并逻辑处理）
function fetchWeather(lat, lng) {
  return Promise.all([
    httpGet(buildUrl(WEATHER_API_CMA, lat, lng, DAILY_FIELDS_CMA)).catch(function () { return null; }),
    httpGet(buildUrl(WEATHER_API_DEFAULT, lat, lng, DAILY_FIELDS_DEFAULT)).catch(function () { return null; })
  ]).then(function (r) { return { cma: r[0], def: r[1] }; });
}
function fetchAir(lat, lng) {
  const url = AIR_API + '?latitude=' + lat + '&longitude=' + lng +
    '&current=us_aqi,pm10,pm2_5&timezone=Asia/Shanghai';
  return httpGet(url).catch(function () { return null; });
}

// 把某个模型的 daily 数组转成「日期 → 原始字段」的索引，便于逐天挑选
function indexDaily(data) {
  const map = {};
  if (!data || !data.daily || !data.daily.time) return map;
  const t = data.daily.time;
  const g = function (key, i) {
    return (data.daily[key] && data.daily[key][i] != null) ? data.daily[key][i] : null;
  };
  for (let i = 0; i < t.length; i++) {
    map[t[i]] = {
      code: g('weather_code', i),
      tempMax: g('temperature_2m_max', i),
      tempMin: g('temperature_2m_min', i),
      feelsLike: g('apparent_temperature_max', i),
      precipSum: g('precipitation_sum', i) || 0,
      precipProb: g('precipitation_probability_max', i),
      windSpeedMax: g('wind_speed_10m_max', i) || 0,
      windDirDeg: g('wind_direction_10m_dominant', i) || 0
    };
  }
  return map;
}

// 逐天 fallback 合并：CMA 有效 → 用 CMA；否则 → 用默认模型
function parseWeather(cmaData, defData) {
  const dates = targetDates();
  const cmaMap = indexDaily(cmaData);
  const defMap = indexDaily(defData);
  const cur = (cmaData && cmaData.current) ? cmaData.current
    : ((defData && defData.current) ? defData.current : null);
  const humidity = cur ? cur.relative_humidity_2m : null;

  let validDays = 0;
  let cmaDays = 0;
  const out = dates.map(function (date) {
    let pick = null, source = 'none';
    if (cmaMap[date] && cmaMap[date].code != null) { pick = cmaMap[date]; source = 'cma'; }
    else if (defMap[date] && defMap[date].code != null) { pick = defMap[date]; source = 'default'; }

    if (!pick) {
      // 两个模型都没数据：显式标记无效，绝不写成「未知」去污染评分
      return {
        date: date, valid: false, source: 'none', text: null,
        tempMax: null, tempMin: null, temp: null, feelsLike: null,
        humidity: humidity, windDir: null, windScale: '--', precipProb: null, icon: ''
      };
    }

    const text = wmoToWeather(pick.code);
    const tempMax = ri(pick.tempMax);
    const tempMin = ri(pick.tempMin);
    let precipProb = null;
    if (typeof pick.precipProb === 'number') {
      precipProb = ri(pick.precipProb);
    } else {
      // CMA 不支持降水概率字段，沿用按降水量的估算口径（与小程序 api.js 一致）
      precipProb = (pick.precipSum > 0) ? Math.min(95, Math.round(30 + pick.precipSum * 15)) : 0;
    }

    validDays++;
    if (source === 'cma') cmaDays++;
    return {
      date: date,
      valid: true,
      source: source,
      text: text,
      tempMax: tempMax,
      tempMin: tempMin,
      temp: (tempMax != null && tempMin != null) ? Math.round((tempMax + tempMin) / 2) : null,
      feelsLike: ri(pick.feelsLike),
      humidity: humidity,
      windDir: windDirOf(pick.windDirDeg),
      windScale: String(windScaleOf(pick.windSpeedMax)),
      precipProb: precipProb,
      icon: getWeatherIcon(text)
    };
  });

  return { days: out, validDays: validDays, cmaDays: cmaDays };
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
  const [sources, a] = await Promise.all([fetchWeather(city.lat, city.lng), fetchAir(city.lat, city.lng)]);
  if (!sources.cma && !sources.def) return { weather: null, air: parseAir(a) };
  return { weather: parseWeather(sources.cma, sources.def), air: parseAir(a) };
}

async function run() {
  const outPath = process.argv[2] || path.join(__dirname, 'weather.json');
  const result = { cities: {} };
  let ok = 0, fail = 0;
  let validSum = 0, cmaSum = 0, cityCount = 0;

  for (let i = 0; i < cities.length; i += CONCURRENCY) {
    const batch = cities.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async function (city) {
      let attempt = 0;
      while (true) {
        try {
          const r = await buildOne(city);
          if (!r.weather || !r.weather.days.length) return { city: city, ok: false, err: '无有效天气数据' };
          return { city: city, ok: true, weather: r.weather, air: r.air };
        } catch (e) {
          attempt++;
          if (attempt >= RETRIES) return { city: city, ok: false, err: e.message };
          // 指数退避 + 抖动，避免整批同时重试再次打爆限流
          const backoff = Math.min(20000, Math.pow(2, attempt) * 1000) * (0.5 + Math.random() * 0.5);
          await sleep(backoff);
        }
      }
    }));

    settled.forEach(function (s) {
      if (s.ok) {
        ok++;
        cityCount++;
        validSum += s.weather.validDays;
        cmaSum += s.weather.cmaDays;
        result.cities[s.city.lat + ',' + s.city.lng] = {
          name: s.city.name,
          province: s.city.province,
          lat: s.city.lat,
          lng: s.city.lng,
          validDays: s.weather.validDays,
          weather: s.weather.days,
          air: s.air
        };
      } else {
        fail++;
        console.warn('失败:', s.city.name, s.err || '空数据');
      }
    });

    console.log('进度 ' + Math.min(i + CONCURRENCY, cities.length) + '/' + cities.length + ' (成功' + ok + '/失败' + fail + ')');
    if (i + CONCURRENCY < cities.length) await sleep(BATCH_INTERVAL_MS);
  }

  const now = new Date();
  const today = todayStrShanghai();
  const payload = {
    date: today.replace(/-/g, ''),
    firstDate: today,
    updatedAt: now.toISOString(),
    source: 'open-meteo-cma+forecast',
    note: 'CMA 优先、默认模型兜底（逐天 fallback）。每天带 valid/source 字段，valid=false 表示该日无数据、不参与评分。',
    total: cities.length,
    success: ok,
    failed: fail,
    forecastDays: FORECAST_DAYS,
    avgValidDays: cityCount ? +(validSum / cityCount).toFixed(1) : 0,
    avgCmaDays: cityCount ? +(cmaSum / cityCount).toFixed(1) : 0,
    cities: result.cities
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
  console.log('已写出 ' + outPath + '：成功 ' + ok + '/' + cities.length + '，失败 ' + fail);
  console.log('平均每城有效天数 ' + payload.avgValidDays + '/' + FORECAST_DAYS +
    '（其中 CMA 占 ' + payload.avgCmaDays + ' 天）');
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});
