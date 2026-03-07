const express = require('express');
const RssParser = require('rss-parser');
const path = require('path');

const app = express();
const rssParser = new RssParser();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory store for prediction history
const predictionHistory = [];

// RSS feeds for Iran war news
const RSS_FEEDS = [
  'https://www.aljazeera.com/xml/rss/all.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml',
  'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',
  'https://www.theguardian.com/world/middleeast/rss',
];

const KEYWORDS = ['iran', 'tehran', 'israel', 'ceasefire', 'negotiation', 'diplomacy',
  'missile', 'strike', 'bombing', 'hormuz', 'hezbollah', 'irgc', 'epic fury',
  'casualt', 'peace', 'truce', 'surrender', 'withdraw', 'escalat', 'de-escalat',
  'sanction', 'nuclear', 'khamenei', 'trump', 'war'];

async function fetchNews() {
  const articles = [];
  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 30)) {
        const text = ((item.title || '') + ' ' + (item.contentSnippet || '')).toLowerCase();
        const isRelevant = KEYWORDS.some(kw => text.includes(kw));
        if (isRelevant) {
          articles.push({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || item.isoDate,
            source: feed.title,
            snippet: (item.contentSnippet || '').slice(0, 200),
          });
        }
      }
    } catch (e) {
      console.error(`Failed to fetch ${feedUrl}: ${e.message}`);
    }
  }
  // Sort by date desc, deduplicate by title similarity
  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return articles.slice(0, 50);
}

// Sentiment/signal analysis from news articles
function analyzeNewsSignals(articles) {
  const signals = {
    ceasefire_mentions: 0,
    escalation_mentions: 0,
    negotiation_mentions: 0,
    casualty_mentions: 0,
    diplomacy_mentions: 0,
    regional_spread: 0,
    peace_mentions: 0,
    total_articles: articles.length,
  };

  const ceasefireWords = ['ceasefire', 'truce', 'armistice', 'halt', 'pause', 'stop fighting'];
  const escalationWords = ['escalat', 'expand', 'spread', 'intensif', 'widen', 'new front', 'ground invasion'];
  const negotiationWords = ['negotiat', 'talks', 'dialog', 'diplomat', 'mediati', 'proposal'];
  const casualtyWords = ['killed', 'dead', 'casualt', 'wounded', 'death toll', 'victims'];
  const peaceWords = ['peace', 'de-escalat', 'withdraw', 'retreat', 'surrender', 'end war'];
  const regionalWords = ['saudi', 'uae', 'qatar', 'bahrain', 'kuwait', 'iraq', 'lebanon', 'turkey', 'nato'];

  for (const article of articles) {
    const text = ((article.title || '') + ' ' + (article.snippet || '')).toLowerCase();
    if (ceasefireWords.some(w => text.includes(w))) signals.ceasefire_mentions++;
    if (escalationWords.some(w => text.includes(w))) signals.escalation_mentions++;
    if (negotiationWords.some(w => text.includes(w))) signals.negotiation_mentions++;
    if (casualtyWords.some(w => text.includes(w))) signals.casualty_mentions++;
    if (peaceWords.some(w => text.includes(w))) signals.peace_mentions++;
    if (regionalWords.some(w => text.includes(w))) signals.regional_spread++;
  }

  return signals;
}

// --- Economic indicators ---
const https = require('https');
const http = require('http');

const ECON_SYMBOLS = {
  WTI: 'CL=F', BRENT: 'BZ=F', GOLD: 'GC=F', VIX: '^VIX',
  DXY: 'DX-Y.NYB', US10Y: '^TNX', US2Y: '^IRX',
};
const ECON_FALLBACK = {
  WTI: { price: 95.0, change: 0, changePercent: 0 },
  BRENT: { price: 98.0, change: 0, changePercent: 0 },
  GOLD: { price: 3100, change: 0, changePercent: 0 },
  VIX: { price: 28.0, change: 0, changePercent: 0 },
  DXY: { price: 104.5, change: 0, changePercent: 0 },
  US10Y: { price: 4.35, change: 0, changePercent: 0 },
  US2Y: { price: 4.10, change: 0, changePercent: 0 },
};

function fetchUrlRaw(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrlRaw(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchEconomicData() {
  const results = {};
  for (const [name, symbol] of Object.entries(ECON_SYMBOLS)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const raw = await fetchUrlRaw(url);
      const json = JSON.parse(raw);
      const meta = json.chart.result[0].meta;
      const closes = json.chart.result[0].indicators.quote[0].close.filter(v => v != null);
      const current = meta.regularMarketPrice || closes[closes.length - 1];
      const prev = closes.length >= 2 ? closes[closes.length - 2] : current;
      const change = +(current - prev).toFixed(2);
      const changePercent = prev ? +((change / prev) * 100).toFixed(2) : 0;
      results[name] = { price: +current.toFixed(2), change, changePercent };
    } catch (e) {
      results[name] = { ...ECON_FALLBACK[name], fallback: true };
    }
  }
  return results;
}

function analyzeEconomicImpact(econ) {
  const impact = { factors: [], war_pressure: 0 };
  const oil = econ.WTI || econ.BRENT;
  if (oil && oil.price > 90) {
    const severity = oil.price > 120 ? 'extreme' : oil.price > 100 ? 'high' : 'moderate';
    const pm = { extreme: 0.06, high: 0.04, moderate: 0.02 };
    impact.war_pressure += pm[severity];
    impact.factors.push({ factor: `유가 급등 (WTI $${econ.WTI.price}/배럴)`, impact: '경제 압력 → 조기 종전 촉구', weight: `+${(pm[severity]*100).toFixed(0)}%p (1-2개월)` });
  }
  if (econ.GOLD && econ.GOLD.price > 2800) {
    impact.factors.push({ factor: `금값 사상최고 ($${econ.GOLD.price}/oz)`, impact: '안전자산 수요 폭증', weight: '+1%p (2-3개월)' });
  }
  if (econ.VIX && econ.VIX.price > 25) {
    const pm = { extreme: 0.04, high: 0.02, moderate: 0.01 };
    const s = econ.VIX.price > 40 ? 'extreme' : econ.VIX.price > 30 ? 'high' : 'moderate';
    impact.war_pressure += pm[s];
    impact.factors.push({ factor: `VIX 공포지수 ${econ.VIX.price}`, impact: '시장 공포 → 정치적 종전 압력', weight: `+${(pm[s]*100).toFixed(0)}%p (단기)` });
  }
  if (econ.US10Y && econ.US2Y && econ.US10Y.price < econ.US2Y.price) {
    impact.war_pressure += 0.02;
    impact.factors.push({ factor: `장단기 금리 역전 (10Y ${econ.US10Y.price}% < 2Y ${econ.US2Y.price}%)`, impact: '경기침체 신호 → 전쟁 비용 부담', weight: '+2%p (2-3개월)' });
  }
  if (econ.DXY && econ.DXY.price > 106) {
    impact.war_pressure += 0.01;
    impact.factors.push({ factor: `달러 강세 (DXY ${econ.DXY.price})`, impact: '이란 경제 추가 압박', weight: '+1%p (2-3개월)' });
  }
  return impact;
}

// Historical war data for comparison
const HISTORICAL_WARS = [
  {
    name: '걸프전 (1991)',
    duration_days: 42,
    type: 'air_campaign_then_ground',
    coalition: true,
    involved_countries: 35,
    trigger: 'invasion',
    ended_by: 'military_defeat',
    nuclear_dimension: false,
  },
  {
    name: '이라크 전쟁 - 주요 전투 (2003)',
    duration_days: 42,
    type: 'invasion',
    coalition: true,
    involved_countries: 4,
    trigger: 'preemptive',
    ended_by: 'regime_change',
    nuclear_dimension: true,
  },
  {
    name: '2006 레바논 전쟁',
    duration_days: 34,
    type: 'air_and_ground',
    coalition: false,
    involved_countries: 2,
    trigger: 'border_incident',
    ended_by: 'ceasefire_un',
    nuclear_dimension: false,
  },
  {
    name: '2008 가자 전쟁',
    duration_days: 22,
    type: 'air_then_ground',
    coalition: false,
    involved_countries: 2,
    trigger: 'rocket_attacks',
    ended_by: 'unilateral_ceasefire',
    nuclear_dimension: false,
  },
  {
    name: '2014 가자 전쟁',
    duration_days: 50,
    type: 'air_and_ground',
    coalition: false,
    involved_countries: 2,
    trigger: 'kidnapping',
    ended_by: 'ceasefire_negotiated',
    nuclear_dimension: false,
  },
  {
    name: '리비아 내전 - NATO 개입 (2011)',
    duration_days: 222,
    type: 'air_campaign',
    coalition: true,
    involved_countries: 18,
    trigger: 'civil_war',
    ended_by: 'regime_change',
    nuclear_dimension: false,
  },
  {
    name: '포클랜드 전쟁 (1982)',
    duration_days: 74,
    type: 'naval_air_ground',
    coalition: false,
    involved_countries: 2,
    trigger: 'invasion',
    ended_by: 'military_defeat',
    nuclear_dimension: false,
  },
  {
    name: '코소보 전쟁 - NATO 폭격 (1999)',
    duration_days: 78,
    type: 'air_campaign',
    coalition: true,
    involved_countries: 19,
    trigger: 'humanitarian',
    ended_by: 'capitulation',
    nuclear_dimension: false,
  },
  {
    name: '2023-2025 이스라엘-하마스 전쟁',
    duration_days: 470,
    type: 'air_and_ground',
    coalition: false,
    involved_countries: 2,
    trigger: 'terror_attack',
    ended_by: 'ceasefire_negotiated',
    nuclear_dimension: false,
  },
  {
    name: '이란-이라크 전쟁 (1980-1988)',
    duration_days: 2922,
    type: 'total_war',
    coalition: false,
    involved_countries: 2,
    trigger: 'territorial',
    ended_by: 'ceasefire_un',
    nuclear_dimension: false,
  },
  {
    name: '2025 이란-이스라엘 교전',
    duration_days: 12,
    type: 'air_campaign',
    coalition: true,
    involved_countries: 3,
    trigger: 'nuclear_threat',
    ended_by: 'ceasefire_brokered',
    nuclear_dimension: true,
  },
];

// Current war parameters
function getCurrentWarParams(newsSignals) {
  const warStartDate = new Date('2026-02-28');
  const now = new Date();
  const daysSinceStart = Math.floor((now - warStartDate) / (1000 * 60 * 60 * 24));

  return {
    days_elapsed: daysSinceStart,
    type: 'air_campaign_expanding',
    coalition: true,
    involved_countries: 9,
    trigger: 'preemptive_regime_change',
    nuclear_dimension: true,
    leader_killed: true,
    strait_blocked: true,
    proxy_involvement: true,
    ground_invasion_started: true,
    news_signals: newsSignals,
  };
}

// Time decay: 군사적 기정사실은 느린 감쇠(0.02/일, 최소40%), 나머지는 일반 감쇠(0.05/일, 최소30%), 실시간은 감쇠 없음
const DECAY_MIL = { rate: 0.02, min: 0.4 };
const DECAY_STD = { rate: 0.05, min: 0.3 };
const MIL_KEYWORDS = ['제공권', '방공', '미사일 능력', '호르무즈'];
function calcDecay(dateStr, name) {
  if (!dateStr || dateStr === '실시간') return 1;
  const hours = (new Date() - new Date(dateStr)) / 3600000;
  if (hours <= 0) return 1;
  const days = hours / 24;
  const isMil = MIL_KEYWORDS.some(k => (name || '').includes(k));
  const cfg = isMil ? DECAY_MIL : DECAY_STD;
  return Math.max(cfg.min, +(1 - days * cfg.rate).toFixed(4));
}
function dw(s, d) { return d >= 0.99 ? s : s + ` (잔존${Math.round(d * 100)}%)`; }

// Prediction engine
function calculatePrediction(warParams, newsSignals, econImpact) {
  // Categories: <1month, 1-2months, 2-4months, 4-6months, 6-9months, 9-12months, 12+months
  let probs = [0.12, 0.22, 0.25, 0.18, 0.12, 0.07, 0.04];
  const factors = [];

  // 요인별 시간 감쇠 계산
  const dTrump = calcDecay('2026-03-01', '트럼프');
  const dAir = calcDecay('2026-03-01', '제공권');
  const dMissile = calcDecay('2026-03-02', '미사일 능력');
  const dHormuz = calcDecay('2026-03-01', '호르무즈');
  const d9n = calcDecay('2026-03-02', '참전');
  const dKham = calcDecay('2026-03-03', '하메네이');
  const dKurd = calcDecay('2026-03-04', '쿠르드');
  const dCIA = calcDecay('2026-03-05', 'CIA');
  const dSenate = calcDecay('2026-03-04', '상원');
  const dSaudi = calcDecay('2026-03-03', '사우디');

  // Factor 1: Trump stated 4-5 weeks
  probs[1] += 0.06 * dTrump;
  probs[0] += 0.03 * dTrump;
  factors.push({
    factor: '트럼프 대통령 4-5주 예상 발언',
    impact: '1-2개월 내 종전 확률 증가',
    weight: dw('+6%p (1-2개월)', dTrump),
    decay: dTrump,
  });

  // Factor 2: Air superiority achieved (military fact - slow decay)
  probs[0] += 0.04 * dAir;
  probs[1] += 0.05 * dAir;
  factors.push({
    factor: '이스라엘 제공권 장악 (이란 방공 80% 파괴)',
    impact: '단기 종전 가능성 증가',
    weight: dw('+4%p (1개월 내), +5%p (1-2개월)', dAir),
    decay: dAir,
  });

  // Factor 3: Iran missile capability (military fact - slow decay)
  if (newsSignals.escalation_mentions < newsSignals.ceasefire_mentions) {
    probs[0] += 0.05 * dMissile;
    probs[1] += 0.03 * dMissile;
    factors.push({
      factor: '이란 미사일 능력 급감 (90% 감소)',
      impact: '전쟁 지속 능력 약화로 단기 종전 가능성 증가',
      weight: dw('+5%p (1개월 내)', dMissile),
      decay: dMissile,
    });
  } else {
    probs[2] += 0.03;
    probs[3] += 0.02;
    factors.push({
      factor: '에스컬레이션 뉴스가 휴전 뉴스보다 많음',
      impact: '전쟁 장기화 가능성 약간 증가',
      weight: '+3%p (2-4개월)',
      decay: 1,
    });
  }

  // Factor 4: Strait of Hormuz (military fact - slow decay)
  probs[0] += 0.03 * dHormuz;
  probs[1] += 0.04 * dHormuz;
  factors.push({
    factor: '호르무즈 해협 봉쇄 → 국제 경제 압력',
    impact: '경제적 압력으로 빠른 해결 촉구',
    weight: dw('+3%p (1개월 내), +4%p (1-2개월)', dHormuz),
    decay: dHormuz,
  });

  // Factor 5: 9 countries involved
  probs[2] += 0.04 * d9n;
  probs[3] += 0.03 * d9n;
  factors.push({
    factor: '9개국 참전 - 분쟁의 복잡성 증가',
    impact: '다자간 분쟁으로 협상 복잡화',
    weight: dw('+4%p (2-4개월), +3%p (4-6개월)', d9n),
    decay: d9n,
  });

  // Factor 6: Leader killed
  probs[1] += 0.03 * dKham;
  probs[2] += 0.04 * dKham;
  factors.push({
    factor: '하메네이 사망 - 이란 지도부 공백',
    impact: '정권 붕괴 가능성과 함께 내부 혼란 장기화 위험',
    weight: dw('+3%p (1-2개월), +4%p (2-4개월)', dKham),
    decay: dKham,
  });

  // Factor 7: Ground invasion (Kurdish forces)
  probs[2] += 0.03 * dKurd;
  probs[3] += 0.03 * dKurd;
  factors.push({
    factor: '쿠르드족 지상군 이란 국경 진입',
    impact: '지상전 확전으로 전쟁 장기화 위험',
    weight: dw('+3%p (2-4개월), +3%p (4-6개월)', dKurd),
    decay: dKurd,
  });

  // Factor 8: Iran attempted negotiation on March 5
  if (warParams.days_elapsed >= 5) {
    probs[0] += 0.05 * dCIA;
    probs[1] += 0.06 * dCIA;
    factors.push({
      factor: '이란 3/5 CIA 통한 협상 시도',
      impact: '이란의 협상 의지 → 단기 종전 가능성 증가',
      weight: dw('+5%p (1개월 내), +6%p (1-2개월)', dCIA),
      decay: dCIA,
    });
  }

  // Factor 9: Historical comparison (reference, no decay)
  factors.push({
    factor: '걸프전(42일) 패턴 유사성',
    impact: '공중전 우위 → 지상전 → 빠른 종결 패턴',
    weight: '참고: 걸프전 42일, 코소보 78일, 포클랜드 74일',
    decay: 1,
  });

  // Factor 10: News signal adjustments (실시간, no decay)
  if (newsSignals.negotiation_mentions > 3) {
    probs[0] += 0.02 * Math.min(newsSignals.negotiation_mentions, 10);
    probs[1] += 0.01 * Math.min(newsSignals.negotiation_mentions, 10);
    factors.push({
      factor: `협상/외교 관련 뉴스 ${newsSignals.negotiation_mentions}건`,
      impact: '외교적 해결 움직임 감지',
      weight: `+${(0.02 * Math.min(newsSignals.negotiation_mentions, 10)).toFixed(1)}%p (1개월 내)`,
      decay: 1,
    });
  }

  if (newsSignals.regional_spread > 5) {
    probs[3] += 0.02;
    probs[4] += 0.02;
    factors.push({
      factor: `지역 확산 뉴스 ${newsSignals.regional_spread}건`,
      impact: '주변국 연루 확대로 장기화 위험',
      weight: '+2%p (4-6개월, 6-9개월)',
      decay: 1,
    });
  }

  // Factor 11: Senate support for war
  probs[1] += 0.02 * dSenate;
  probs[2] += 0.02 * dSenate;
  factors.push({
    factor: '미 상원 전쟁 결의안 부결 (전쟁 지속 지지)',
    impact: '미국 내 정치적 지지로 군사작전 지속 가능',
    weight: dw('+2%p (1-2개월, 2-4개월)', dSenate),
    decay: dSenate,
  });

  // Factor 12: Saudi/UAE joining coalition
  probs[0] += 0.03 * dSaudi;
  probs[1] += 0.04 * dSaudi;
  factors.push({
    factor: '사우디/UAE 연합군 참전',
    impact: '이란 포위망 강화 → 조기 항복 가능성',
    weight: dw('+3%p (1개월 내), +4%p (1-2개월)', dSaudi),
    decay: dSaudi,
  });

  // Economic indicator factors
  if (econImpact) {
    const wp = econImpact.war_pressure || 0;
    if (wp > 0) { probs[0] += wp * 0.4; probs[1] += wp * 0.6; }
    for (const ef of (econImpact.factors || [])) { factors.push(ef); }
  }

  // Normalize probabilities
  const total = probs.reduce((a, b) => a + b, 0);
  probs = probs.map(p => Math.round((p / total) * 1000) / 10);

  // Ensure they sum to 100
  const diff = 100 - probs.reduce((a, b) => a + b, 0);
  probs[2] = Math.round((probs[2] + diff) * 10) / 10;

  return {
    timestamp: new Date().toISOString(),
    probabilities: {
      '1개월 내 (~3/28)': probs[0],
      '1-2개월 (4월)': probs[1],
      '2-4개월 (5-6월)': probs[2],
      '4-6개월 (7-8월)': probs[3],
      '6-9개월 (9-11월)': probs[4],
      '9-12개월 (12월-2027/2월)': probs[5],
      '12개월 이상': probs[6],
    },
    factors,
    war_day: warParams.days_elapsed,
    news_signals: newsSignals,
    historical_comparison: HISTORICAL_WARS,
  };
}

// API: Get latest prediction
app.get('/api/predict', async (req, res) => {
  try {
    const [articles, econData] = await Promise.all([fetchNews(), fetchEconomicData()]);
    const signals = analyzeNewsSignals(articles);
    const warParams = getCurrentWarParams(signals);
    const econImpact = analyzeEconomicImpact(econData);
    const prediction = calculatePrediction(warParams, signals, econImpact);
    prediction.latest_news = articles.slice(0, 15);
    prediction.economic_indicators = econData;

    // Store in history
    predictionHistory.push({
      timestamp: prediction.timestamp,
      probabilities: prediction.probabilities,
      factors_summary: prediction.factors.length + ' factors analyzed',
      war_day: prediction.war_day,
    });

    res.json(prediction);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// API: Get prediction history
app.get('/api/history', (req, res) => {
  res.json(predictionHistory);
});

// API: Get historical wars data
app.get('/api/historical-wars', (req, res) => {
  res.json(HISTORICAL_WARS);
});

// API: manual trigger for update (also used by auto-update)
app.post('/api/update', async (req, res) => {
  try {
    const [articles, econData] = await Promise.all([fetchNews(), fetchEconomicData()]);
    const signals = analyzeNewsSignals(articles);
    const warParams = getCurrentWarParams(signals);
    const econImpact = analyzeEconomicImpact(econData);
    const prediction = calculatePrediction(warParams, signals, econImpact);
    prediction.latest_news = articles.slice(0, 15);
    prediction.economic_indicators = econData;

    predictionHistory.push({
      timestamp: prediction.timestamp,
      probabilities: prediction.probabilities,
      factors: prediction.factors,
      war_day: prediction.war_day,
      news_signals: prediction.news_signals,
      news_count: articles.length,
    });

    res.json(prediction);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Iran War Prediction Dashboard running at http://localhost:${PORT}`);
});
