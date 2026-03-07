const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { DOMParser } = require('@xmldom/xmldom');

const DATA_DIR = path.join(__dirname, '..', 'docs', 'data');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SEEN_FILE = path.join(DATA_DIR, 'seen_keys.json');

const KEYWORDS = ['iran','tehran','israel','ceasefire','negotiation','diplomacy','missile','strike','bombing','hormuz','hezbollah','irgc','casualt','peace','truce','surrender','withdraw','escalat','de-escalat','sanction','nuclear','khamenei','trump','war'];

const RSS_FEEDS = [
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'aljazeera' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml', name: 'nytimes' },
  { url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', name: 'bbc' },
  { url: 'https://www.theguardian.com/world/middleeast/rss', name: 'guardian' },
];

const PROB_KEYS = ['1개월 내 (~3월)','2~3개월 (4~5월)','4~6개월 (6~8월)','7~12개월 (9월~27/2월)','1년 초과'];

// --- Economic indicators ---
const ECON_SYMBOLS = {
  'WTI': 'CL=F',
  'BRENT': 'BZ=F',
  'GOLD': 'GC=F',
  'VIX': '^VIX',
  'DXY': 'DX-Y.NYB',
  'US10Y': '^TNX',
  'US2Y': '^IRX',
};

// Fallback values (approximate recent values as of early March 2026)
const ECON_FALLBACK = {
  WTI: { price: 95.0, change: 0, changePercent: 0 },
  BRENT: { price: 98.0, change: 0, changePercent: 0 },
  GOLD: { price: 3100, change: 0, changePercent: 0 },
  VIX: { price: 28.0, change: 0, changePercent: 0 },
  DXY: { price: 104.5, change: 0, changePercent: 0 },
  US10Y: { price: 4.35, change: 0, changePercent: 0 },
  US2Y: { price: 4.10, change: 0, changePercent: 0 },
};

async function fetchEconomicData() {
  const results = {};
  const entries = Object.entries(ECON_SYMBOLS);
  const fetches = entries.map(async ([name, symbol]) => {
    for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
      try {
        const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
        const raw = await fetchUrl(url, 8000);
        const json = JSON.parse(raw);
        const meta = json.chart.result[0].meta;
        const closes = json.chart.result[0].indicators.quote[0].close.filter(v => v != null);
        const current = meta.regularMarketPrice || closes[closes.length - 1];
        const prev = closes.length >= 2 ? closes[closes.length - 2] : current;
        const change = +(current - prev).toFixed(2);
        const changePercent = prev ? +((change / prev) * 100).toFixed(2) : 0;
        results[name] = { price: +current.toFixed(2), change, changePercent, prev: +prev.toFixed(2) };
        console.log(`  [ECON] ${name}: ${current.toFixed(2)} (${change >= 0 ? '+' : ''}${change})`);
        return;
      } catch (e) { /* try next host */ }
    }
    console.log(`  [ECON FAIL] ${name}`);
    results[name] = { ...ECON_FALLBACK[name], fallback: true };
  });
  await Promise.all(fetches);

  // Try to get US 10Y from Treasury.gov as backup if Yahoo failed
  if (results.US10Y.fallback) {
    try {
      const year = new Date().getFullYear();
      const month = String(new Date().getMonth() + 1).padStart(2, '0');
      const tUrl = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/${year}${month}?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
      const csv = await fetchUrl(tUrl, 10000);
      const lines = csv.trim().split('\n');
      if (lines.length >= 2) {
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const lastLine = lines[lines.length - 1].split(',').map(v => v.trim().replace(/"/g, ''));
        const i10y = headers.findIndex(h => h.includes('10 Yr'));
        const i2y = headers.findIndex(h => h.includes('2 Yr'));
        if (i10y >= 0 && lastLine[i10y]) {
          results.US10Y = { price: +parseFloat(lastLine[i10y]).toFixed(2), change: 0, changePercent: 0, source: 'treasury.gov' };
          console.log(`  [ECON] US10Y (Treasury.gov): ${results.US10Y.price}`);
        }
        if (i2y >= 0 && lastLine[i2y]) {
          results.US2Y = { price: +parseFloat(lastLine[i2y]).toFixed(2), change: 0, changePercent: 0, source: 'treasury.gov' };
          console.log(`  [ECON] US2Y (Treasury.gov): ${results.US2Y.price}`);
        }
      }
    } catch (e) {
      console.log(`  [ECON FAIL] Treasury.gov: ${e.message}`);
    }
  }

  return results;
}

function analyzeEconomicImpact(econ) {
  const impact = { factors: [], war_pressure: 0 };

  // Oil price impact - high oil = more international pressure for quick resolution
  const oil = econ.WTI || econ.BRENT;
  if (oil && oil.price > 90) {
    const severity = oil.price > 120 ? 'extreme' : oil.price > 100 ? 'high' : 'moderate';
    const pressureMap = { extreme: 0.06, high: 0.04, moderate: 0.02 };
    impact.war_pressure += pressureMap[severity];
    impact.factors.push({
      factor: `유가 급등 (WTI $${econ.WTI.price}/배럴)`,
      impact: severity === 'extreme' ? '극심한 경제 압력 → 조기 종전 강력 촉구' : severity === 'high' ? '높은 경제 압력 → 빠른 해결 요구 증가' : '중간 수준 경제 압력',
      weight: `+${(pressureMap[severity] * 100).toFixed(0)}%p (1-2개월)`,
      direction: 'shorten',
      detail: `WTI 유가가 $${econ.WTI.price}/배럴로 ${severity === 'extreme' ? '120달러 돌파' : severity === 'high' ? '100달러 돌파' : '90달러 이상'}입니다. 호르무즈 해협 봉쇄와 맞물려 글로벌 에너지 시장에 큰 충격을 주고 있으며, 주요국들의 조기 종전 압력이 강화되고 있습니다.`,
      keywords: ['oil', 'crude', 'wti', 'brent', 'energy', 'gas price'],
      applied: '실시간',
      active: true,
    });
  }

  // Gold price impact - high gold = safe haven demand = market stress
  if (econ.GOLD && econ.GOLD.price > 2800) {
    const severity = econ.GOLD.price > 3200 ? 'extreme' : econ.GOLD.price > 3000 ? 'high' : 'moderate';
    impact.factors.push({
      factor: `금값 사상최고 ($${econ.GOLD.price}/oz)`,
      impact: '안전자산 수요 폭증 → 글로벌 불안 심화',
      weight: severity === 'extreme' ? '+2%p (4-6개월)' : '+1%p (2-3개월)',
      direction: severity === 'extreme' ? 'lengthen' : 'mixed',
      detail: `금 가격이 온스당 $${econ.GOLD.price}로 사상 최고 수준입니다. 투자자들이 안전자산으로 대거 이동하고 있으며, 이는 전쟁 장기화에 대한 시장의 우려를 반영합니다.`,
      keywords: ['gold', 'safe haven', 'precious metal', 'investor'],
      applied: '실시간',
      active: true,
    });
  }

  // VIX impact - high VIX = market fear = political pressure
  if (econ.VIX && econ.VIX.price > 25) {
    const severity = econ.VIX.price > 40 ? 'extreme' : econ.VIX.price > 30 ? 'high' : 'moderate';
    const pressureMap = { extreme: 0.04, high: 0.02, moderate: 0.01 };
    impact.war_pressure += pressureMap[severity];
    impact.factors.push({
      factor: `VIX 공포지수 ${econ.VIX.price} (${severity === 'extreme' ? '극도 공포' : severity === 'high' ? '공포' : '불안'})`,
      impact: '시장 공포 심화 → 정치적 종전 압력 증가',
      weight: `+${(pressureMap[severity] * 100).toFixed(0)}%p (단기)`,
      direction: 'shorten',
      detail: `VIX 지수가 ${econ.VIX.price}로 ${severity === 'extreme' ? '40을 넘어 극도의 시장 공포 상태' : severity === 'high' ? '30 이상의 높은 공포 수준' : '25 이상의 불안 수준'}입니다. 금융시장 불안이 커지면서 각국 정부에 전쟁 종결 압력이 가해지고 있습니다.`,
      keywords: ['vix', 'volatility', 'fear', 'market', 'stock'],
      applied: '실시간',
      active: true,
    });
  }

  // US Treasury yield impact
  if (econ.US10Y) {
    const yield10 = econ.US10Y.price;
    const yield2 = econ.US2Y ? econ.US2Y.price : null;
    const inverted = yield2 && yield10 < yield2;

    if (inverted) {
      impact.factors.push({
        factor: `미국 국채 장단기 금리 역전 (10Y ${yield10}% < 2Y ${yield2}%)`,
        impact: '경기침체 신호 → 전쟁 비용 부담 가중',
        weight: '+2%p (2-3개월)',
        direction: 'shorten',
        detail: `미국 10년물 국채금리(${yield10}%)가 2년물(${yield2}%)보다 낮은 금리 역전 현상이 발생했습니다. 이는 경기침체 신호로, 전쟁 장기화 시 미국 경제에 미치는 부담이 커져 조기 종전 압력이 됩니다.`,
        keywords: ['treasury', 'yield', 'bond', 'recession', 'invert'],
        applied: '실시간',
        active: true,
      });
      impact.war_pressure += 0.02;
    } else if (yield10 > 4.5) {
      impact.factors.push({
        factor: `미국 10년 국채금리 ${yield10}% (고금리 지속)`,
        impact: '전쟁 자금 조달 비용 증가',
        weight: '+1%p (4-6개월)',
        direction: 'mixed',
        detail: `미국 10년물 국채금리가 ${yield10}%로 높은 수준을 유지하고 있습니다. 전쟁 자금 조달 비용이 증가하며, 장기전의 경제적 부담이 커지고 있습니다.`,
        keywords: ['treasury', 'yield', 'bond', 'interest rate', 'fed'],
        applied: '실시간',
        active: true,
      });
    }
  }

  // DXY (Dollar strength) impact
  if (econ.DXY && econ.DXY.price > 106) {
    impact.factors.push({
      factor: `달러 강세 (DXY ${econ.DXY.price})`,
      impact: '이란 경제 추가 압박 → 협상 압력 증가',
      weight: '+1%p (2-3개월)',
      direction: 'shorten',
      detail: `달러 인덱스가 ${econ.DXY.price}으로 강세를 보이고 있습니다. 달러 강세는 이란 리알화 추가 약세로 이어져 이란 경제에 이중 압박을 가하며 협상 테이블로 이끄는 요인이 됩니다.`,
      keywords: ['dollar', 'dxy', 'currency', 'rial', 'exchange rate'],
      applied: '실시간',
      active: true,
    });
    impact.war_pressure += 0.01;
  }

  return impact;
}

const HISTORICAL_WARS = [
  {name:'걸프전 (1991)',duration_days:42,type:'공습→지상전',involved_countries:35,ended_by:'군사적 패배'},
  {name:'이라크전 주요전투 (2003)',duration_days:42,type:'침공',involved_countries:4,ended_by:'정권 교체'},
  {name:'2006 레바논 전쟁',duration_days:34,type:'공습+지상전',involved_countries:2,ended_by:'UN 휴전'},
  {name:'2008 가자 전쟁',duration_days:22,type:'공습→지상전',involved_countries:2,ended_by:'일방적 휴전'},
  {name:'2014 가자 전쟁',duration_days:50,type:'공습+지상전',involved_countries:2,ended_by:'협상 휴전'},
  {name:'리비아 NATO 개입 (2011)',duration_days:222,type:'공습 작전',involved_countries:18,ended_by:'정권 교체'},
  {name:'포클랜드 전쟁 (1982)',duration_days:74,type:'해·공·지상전',involved_countries:2,ended_by:'군사적 패배'},
  {name:'코소보 NATO 폭격 (1999)',duration_days:78,type:'공습 작전',involved_countries:19,ended_by:'항복'},
  {name:'이스라엘-하마스 (2023-25)',duration_days:470,type:'공습+지상전',involved_countries:2,ended_by:'협상 휴전'},
  {name:'이란-이라크 전쟁 (1980-88)',duration_days:2922,type:'총력전',involved_countries:2,ended_by:'UN 휴전'},
  {name:'러시아-우크라이나 전쟁 (2022-)',duration_days:1105,type:'전면 침공+소모전',involved_countries:2,ended_by:'진행 중'},
  {name:'2025 이란-이스라엘 교전',duration_days:12,type:'공습 작전',involved_countries:3,ended_by:'중재 휴전'},
];

const FX = {
  '트럼프 대통령 4-5주 예상 발언':'트럼프 대통령이 공개적으로 전쟁이 "4-5주 내"에 끝날 것이라고 발언했습니다.',
  '이스라엘 제공권 장악 (이란 방공 80% 파괴)':'이스라엘이 이란 방공망의 핵심을 무력화했습니다.',
  '이란 미사일 능력 급감 (90% 감소)':'이란의 보복 미사일 타격 능력이 약 90% 감소했습니다.',
  '확전 뉴스가 휴전 뉴스보다 많음':'언론에서 휴전보다 확전을 더 많이 보도하고 있습니다.',
  '호르무즈 해협 봉쇄 → 국제 경제 압력':'세계 원유의 약 20%가 호르무즈 해협을 통과합니다.',
  '9개국 참전 - 분쟁 복잡성 증가':'참전국이 많을수록 휴전 협상이 복잡해집니다.',
  '하메네이 사망 - 이란 지도부 공백':'최고지도자의 사망으로 정권 내부에 큰 혼란이 발생합니다.',
  '쿠르드족 지상군 이란 국경 진입':'쿠르드 페쉬메르가 부대가 북부 전선을 열었습니다.',
  '이란 3/5 CIA 통한 협상 시도':'이란이 비밀 채널을 통해 협상을 시도했습니다.',
  '걸프전(42일) 패턴 유사성':'이번 전쟁은 걸프전과 매우 유사한 패턴을 보입니다.',
  '사우디/UAE 연합군 참전':'사우디와 UAE가 연합군에 합류했습니다.',
  '미 상원 전쟁 결의안 부결':'미 상원이 전쟁권한 제한 결의안을 부결시켰습니다.',
};

// --- Fetch helpers ---
function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 IranWarPredictor/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml, sourceName) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = doc.getElementsByTagName('item');
  const results = [];
  for (let i = 0; i < Math.min(items.length, 30); i++) {
    const item = items[i];
    const getTag = tag => {
      const el = item.getElementsByTagName(tag)[0];
      return el ? (el.textContent || '') : '';
    };
    const title = getTag('title');
    const link = getTag('link');
    const pubDate = getTag('pubDate');
    const snippet = getTag('description').replace(/<[^>]*>/g, '').slice(0, 200);
    const text = (title + ' ' + snippet).toLowerCase();
    if (KEYWORDS.some(k => text.includes(k))) {
      results.push({ title, link, pubDate, source: sourceName, snippet });
    }
  }
  return results;
}

function articleKey(a) {
  return (a.title || '').trim().slice(0, 80).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- Analysis ---
function analyzeSignals(articles, seenKeys) {
  let newCount = 0;
  const nowSeen = new Set(seenKeys);
  articles.forEach(a => {
    const k = articleKey(a);
    if (!nowSeen.has(k)) { a.isNew = true; newCount++; nowSeen.add(k); }
    else { a.isNew = false; }
  });

  const s = { ceasefire_mentions:0, escalation_mentions:0, negotiation_mentions:0, casualty_mentions:0, peace_mentions:0, regional_spread:0, total_articles:articles.length, new_articles:newCount };
  const cw=['ceasefire','truce','armistice','halt','pause'], ew=['escalat','expand','intensif','widen','new front'];
  const nw=['negotiat','talks','dialog','diplomat','mediati'], kw=['killed','dead','casualt','wounded','death toll'];
  const pw=['peace','de-escalat','withdraw','retreat','surrender'];
  const rw=['saudi','uae','qatar','bahrain','kuwait','iraq','lebanon','turkey','nato'];

  for (const a of articles) {
    const t = ((a.title||'') + ' ' + (a.snippet||'')).toLowerCase();
    const w = a.isNew ? 2 : 1;
    if (cw.some(k=>t.includes(k))) s.ceasefire_mentions += w;
    if (ew.some(k=>t.includes(k))) s.escalation_mentions += w;
    if (nw.some(k=>t.includes(k))) s.negotiation_mentions += w;
    if (kw.some(k=>t.includes(k))) s.casualty_mentions += w;
    if (pw.some(k=>t.includes(k))) s.peace_mentions += w;
    if (rw.some(k=>t.includes(k))) s.regional_spread += w;
  }

  // Keep seen keys manageable
  const seenArr = [...nowSeen];
  const trimmed = seenArr.length > 2000 ? seenArr.slice(-1000) : seenArr;
  return { signals: s, newSeenKeys: trimmed };
}

function calculatePrediction(daysElapsed, ns, econImpact) {
  let p = [.15,.35,.28,.15,.07];
  const f = [];

  p[1]+=.08; p[0]+=.03;
  f.push({factor:'트럼프 대통령 4-5주 예상 발언',impact:'2~3개월 내 종전 확률 상승',weight:'+8%p (2~3개월)',direction:'shorten',detail:FX['트럼프 대통령 4-5주 예상 발언'],keywords:['trump','4 week','5 week','timeline','end war'],applied:'2026-03-01',active:true});

  p[0]+=.04; p[1]+=.06;
  f.push({factor:'이스라엘 제공권 장악 (이란 방공 80% 파괴)',impact:'단기 종전 가능성 증가',weight:'+4%p (1개월내), +6%p (2~3개월)',direction:'shorten',detail:FX['이스라엘 제공권 장악 (이란 방공 80% 파괴)'],keywords:['air superi','air defens','s-300','s-400','radar','anti-air'],applied:'2026-03-01',active:true});

  if (ns.escalation_mentions < ns.ceasefire_mentions) {
    p[0]+=.05; p[1]+=.04;
    f.push({factor:'이란 미사일 능력 급감 (90% 감소)',impact:'전쟁 지속 능력 약화로 단기 종전 가능성 증가',weight:'+5%p (1개월내), +4%p (2~3개월)',direction:'shorten',detail:FX['이란 미사일 능력 급감 (90% 감소)'],keywords:['missile','ballistic','launch','strike capab'],applied:'2026-03-02',active:true});
  } else {
    p[2]+=.04; p[3]+=.02;
    f.push({factor:'확전 뉴스가 휴전 뉴스보다 많음',impact:'전쟁 장기화 가능성 소폭 증가',weight:'+4%p (4~6개월)',direction:'lengthen',detail:FX['확전 뉴스가 휴전 뉴스보다 많음'],keywords:['escalat','intensif','expand','widen'],applied:'실시간',active:true});
  }

  p[0]+=.03; p[1]+=.05;
  f.push({factor:'호르무즈 해협 봉쇄 → 국제 경제 압력',impact:'경제적 압력으로 빠른 해결 촉구',weight:'+3%p (1개월내), +5%p (2~3개월)',direction:'shorten',detail:FX['호르무즈 해협 봉쇄 → 국제 경제 압력'],keywords:['hormuz','strait','oil price','blockade','shipping','tanker'],applied:'2026-03-01',active:true});

  p[2]+=.05; p[3]+=.03;
  f.push({factor:'9개국 참전 - 분쟁 복잡성 증가',impact:'다자간 분쟁으로 협상 복잡화',weight:'+5%p (4~6개월), +3%p (7~12개월)',direction:'lengthen',detail:FX['9개국 참전 - 분쟁 복잡성 증가'],keywords:['coalition','allies','nato','joint operation','multinational'],applied:'2026-03-02',active:true});

  p[1]+=.04; p[2]+=.04;
  f.push({factor:'하메네이 사망 - 이란 지도부 공백',impact:'정권 붕괴 가능성과 내부 혼란 장기화 위험',weight:'+4%p (2~3개월), +4%p (4~6개월)',direction:'mixed',detail:FX['하메네이 사망 - 이란 지도부 공백'],keywords:['khamenei','supreme leader','succession','leadership','regime'],applied:'2026-03-03',active:true});

  p[2]+=.04; p[3]+=.03;
  f.push({factor:'쿠르드족 지상군 이란 국경 진입',impact:'지상전 확대로 전쟁 장기화 위험',weight:'+4%p (4~6개월), +3%p (7~12개월)',direction:'lengthen',detail:FX['쿠르드족 지상군 이란 국경 진입'],keywords:['kurd','peshmerga','ground','border','northern front'],applied:'2026-03-04',active:true});

  if (daysElapsed >= 5) {
    p[0]+=.05; p[1]+=.08;
    f.push({factor:'이란 3/5 CIA 통한 협상 시도',impact:'이란의 협상 의지 → 단기 종전 가능성 증가',weight:'+5%p (1개월내), +8%p (2~3개월)',direction:'shorten',detail:FX['이란 3/5 CIA 통한 협상 시도'],keywords:['cia','backchannel','secret talk','negotiat','iran offer','surrender'],applied:'2026-03-05',active:true});
  }

  f.push({factor:'걸프전(42일) 패턴 유사성',impact:'제공권→지상작전→빠른 종결 패턴',weight:'참고: 걸프전 42일, 코소보 78일, 포클랜드 74일',direction:'reference',detail:FX['걸프전(42일) 패턴 유사성'],keywords:['gulf war','desert storm','pattern','historical'],applied:'2026-02-28',active:true});

  if (ns.negotiation_mentions > 3) {
    const n = Math.min(ns.negotiation_mentions, 10);
    p[0]+=.02*n; p[1]+=.015*n;
    f.push({factor:`협상/외교 뉴스 ${ns.negotiation_mentions}건 감지`,impact:'외교적 해결 움직임 포착',weight:`+${(.02*n).toFixed(1)}%p (1개월내)`,direction:'shorten',detail:`실시간 뉴스에서 협상 관련 기사 ${ns.negotiation_mentions}건이 감지되었습니다.`,keywords:['negotiat','talks','dialog','diplomat','mediati'],applied:'실시간',active:true});
  }

  if (ns.regional_spread > 5) {
    p[2]+=.02; p[3]+=.02;
    f.push({factor:`지역 확산 뉴스 ${ns.regional_spread}건 감지`,impact:'주변국 연루 확대로 장기화 위험',weight:'+2%p (4~6개월, 7~12개월)',direction:'lengthen',detail:`주변국을 언급하는 기사 ${ns.regional_spread}건이 감지되었습니다.`,keywords:['saudi','uae','qatar','iraq','lebanon','turkey'],applied:'실시간',active:true});
  }

  p[1]+=.03; p[2]+=.02;
  f.push({factor:'미 상원 전쟁 결의안 부결',impact:'미국 내 정치적 지지로 군사작전 지속 가능',weight:'+3%p (2~3개월), +2%p (4~6개월)',direction:'mixed',detail:FX['미 상원 전쟁 결의안 부결'],keywords:['senate','resolution','war powers','congress','vote'],applied:'2026-03-04',active:true});

  p[0]+=.03; p[1]+=.05;
  f.push({factor:'사우디/UAE 연합군 참전',impact:'이란 포위망 강화 → 조기 항복 가능성',weight:'+3%p (1개월내), +5%p (2~3개월)',direction:'shorten',detail:FX['사우디/UAE 연합군 참전'],keywords:['saudi','uae','coalition','join','alliance','gcc'],applied:'2026-03-03',active:true});

  // Economic indicator factors
  if (econImpact) {
    const wp = econImpact.war_pressure || 0;
    if (wp > 0) {
      p[0] += wp * 0.4;
      p[1] += wp * 0.6;
    }
    for (const ef of (econImpact.factors || [])) {
      f.push(ef);
    }
  }

  // Normalize
  const total = p.reduce((a,b) => a+b, 0);
  p = p.map(v => Math.round((v/total)*1000)/10);
  const diff = 100 - p.reduce((a,b) => a+b, 0);
  p[1] = Math.round((p[1]+diff)*10)/10;

  const probs = {};
  PROB_KEYS.forEach((k,i) => probs[k] = p[i]);

  return { probabilities: probs, factors: f };
}

// --- Main ---
async function main() {
  console.log(`[${new Date().toISOString()}] Starting update...`);

  // Load seen keys
  let seenKeys = [];
  try { seenKeys = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch(e) {}

  // Fetch all RSS feeds
  const allArticles = [];
  let feedCount = 0;
  for (const feed of RSS_FEEDS) {
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseRSS(xml, feed.name);
      allArticles.push(...items);
      feedCount++;
      console.log(`  [OK] ${feed.name}: ${items.length} articles`);
    } catch(e) {
      console.log(`  [FAIL] ${feed.name}: ${e.message}`);
    }
  }

  // Sort by date
  allArticles.sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate));
  const articles = allArticles.slice(0, 50);

  // Fetch economic data
  console.log('  Fetching economic indicators...');
  const econData = await fetchEconomicData();
  const econImpact = analyzeEconomicImpact(econData);

  // Analyze
  const { signals, newSeenKeys } = analyzeSignals(articles, seenKeys);
  const daysElapsed = Math.floor((new Date() - new Date('2026-02-28')) / 864e5);
  const pred = calculatePrediction(daysElapsed, signals, econImpact);

  const result = {
    timestamp: new Date().toISOString(),
    war_day: daysElapsed,
    probabilities: pred.probabilities,
    factors: pred.factors,
    news_signals: signals,
    latest_news: articles.slice(0, 15),
    historical_comparison: HISTORICAL_WARS,
    economic_indicators: econData,
    feeds_loaded: feedCount,
    feeds_total: RSS_FEEDS.length,
  };

  // Save latest
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LATEST_FILE, JSON.stringify(result, null, 2));

  // Append to history (keep last 500)
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  history.push({
    timestamp: result.timestamp,
    probabilities: result.probabilities,
    factors: result.factors,
    war_day: result.war_day,
    news_signals: result.news_signals,
    new_articles: signals.new_articles,
  });
  if (history.length > 500) history = history.slice(-500);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

  // Save seen keys
  fs.writeFileSync(SEEN_FILE, JSON.stringify(newSeenKeys));

  console.log(`[${new Date().toISOString()}] Done. ${signals.new_articles} new articles, ${feedCount}/${RSS_FEEDS.length} feeds.`);
  console.log(`  Probabilities: ${JSON.stringify(result.probabilities)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
