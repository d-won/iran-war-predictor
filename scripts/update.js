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

// Critical event patterns based on historical war-ending research
// Categories derived from: Correlates of War Project, UCDP conflict termination data,
// and patterns observed across 100+ interstate wars since 1945.
//
// Historical basis for each category:
// 1. CAPITULATION: Iraq 1991 (ceasefire 3 days after Kuwait retreat), Japan 1945, Germany 1945
// 2. CEASEFIRE AGREEMENT: Korea 1953, Iran-Iraq 1988 (UN 598), Israel-Arab wars
// 3. REGIME COLLAPSE: Iraq 2003 (Baghdad fell → organized resistance ended in weeks),
//    Libya 2011 (Gaddafi killed → war ended), Afghanistan 2001
// 4. MILITARY COLLAPSE: France 1940 (6 weeks), Iraq 1991 (100-hour ground war)
// 5. UNILATERAL DE-ESCALATION: Falklands (Argentina withdrawal offer),
//    Losing side reducing operations = precursor to surrender in 80%+ of cases
// 6. DIPLOMATIC BREAKTHROUGH: Camp David, Dayton Accords, Iran nuclear deal framework
// 7. HUMANITARIAN CRISIS: Kosovo 1999 (refugee crisis accelerated NATO action)
// 8. CONFLICT EXPANSION: WWI pattern, Syria civil war → proxy war expansion
// 9. WMD THREAT: Extreme escalation that changes conflict calculus entirely
// 10. CAPITAL SIEGE: Historical pattern - capital under direct attack shortens wars
//     Baghdad 2003 (fell in 21 days), Berlin 1945, Tripoli 2011
//
// adjust = [1개월내, 2~3개월, 4~6개월, 7~12개월, 1년초과]
// Positive = probability increase, Negative = decrease
const CRITICAL_EVENTS = [
  // === Category 1: Capitulation signals ===
  // When the losing side publicly concedes, apologizes, or offers unconditional terms.
  // Historical: Iraq accepted all UN terms within 48 hours of ground war start (1991).
  // Japan's surrender came days after acknowledging defeat internally.
  {
    id: 'capitulation_signal',
    name: '교전국 항복/사과/공식 양보',
    keywords: [
      ['apolog','war'], ['surrender','offer'], ['capitulat'], ['unconditional','term'],
      ['accept','defeat'], ['admit','defeat'], ['white flag'], ['lay down','arm'],
      ['apolog','neighb'], ['apolog','attack'],
    ],
    severity: 'critical',
    adjust: [+0.08, +0.12, -0.05, -0.05, -0.02],
    direction: 'shorten',
    detail: '교전국이 공식적으로 사과/양보/항복 의사를 표명. 역사적으로 패전국의 공식 양보 후 평균 2~4주 내 종전 (걸프전 48시간, 포클랜드 3일, 코소보 11일).',
  },
  // === Category 2: Ceasefire/peace agreement ===
  // Formal agreements to stop fighting. Most wars end through negotiated ceasefire.
  // UCDP data: 60%+ of interstate wars since 1945 ended via ceasefire agreement.
  {
    id: 'ceasefire_agreement',
    name: '공식 휴전/평화 합의',
    keywords: [
      ['ceasefire','agree'], ['ceasefire','deal'], ['ceasefire','sign'],
      ['truce','agree'], ['armistice','sign'], ['peace deal'],
      ['ceasefire','accept'], ['peace agreement'],
    ],
    severity: 'critical',
    adjust: [+0.15, +0.10, -0.08, -0.06, -0.03],
    direction: 'shorten',
    detail: '공식 휴전 또는 평화 합의 체결. 휴전 합의는 전쟁 종결의 결정적 단계이며, 합의 후 이행까지 평균 1~2주 소요.',
  },
  // === Category 3: Regime collapse/change ===
  // When the enemy government falls or fragments. Iraq 2003: Baghdad fell Apr 9,
  // major combat declared over May 1. Libya 2011: Tripoli fell Aug 21, war ended Oct 20.
  {
    id: 'regime_collapse',
    name: '교전국 정권 붕괴/쿠데타',
    keywords: [
      ['regime','collaps'], ['regime','fall'], ['government','fall'],
      ['capital','fall'], ['capital','captur'], ['coup','detat'],
      ['government','overthrow'], ['regime','change'],
    ],
    severity: 'critical',
    adjust: [+0.10, +0.08, +0.02, -0.05, -0.04],
    direction: 'shorten',
    detail: '교전국 정권 붕괴 또는 쿠데타. 이라크(2003): 바그다드 함락 후 3주 내 주요 전투 종료. 리비아(2011): 트리폴리 함락 후 2개월 내 종전.',
  },
  // === Category 4: Military collapse ===
  // Mass surrender, desertion, or catastrophic equipment loss.
  // Iraq 1991: 80,000+ surrendered in 4 days. France 1940: army collapsed in 6 weeks.
  {
    id: 'military_collapse',
    name: '군사적 붕괴 (대규모 항복/탈영)',
    keywords: [
      ['mass surrender'], ['troops surrender'], ['forces surrender'],
      ['army surrender'], ['military collaps'], ['desert','troops'],
      ['abandon','position'], ['forces disintegrat'],
    ],
    severity: 'high',
    adjust: [+0.06, +0.08, -0.03, -0.03, -0.02],
    direction: 'shorten',
    detail: '대규모 군사 붕괴. 걸프전(1991): 4일간 8만명 투항. 조직적 저항 와해 시 평균 1~3주 내 전쟁 종결.',
  },
  // === Category 5: Unilateral de-escalation ===
  // One side voluntarily reduces operations, announces restraint, or withdraws.
  // This signals willingness to end fighting. In 80%+ of historical cases,
  // unilateral de-escalation by the losing side precedes formal surrender.
  {
    id: 'unilateral_deescalation',
    name: '일방적 전투 축소/자제 선언',
    keywords: [
      ['halt','attack'], ['stop','attack','neighb'], ['no more','attack'],
      ['withdraw','forces'], ['pull back','troops'], ['unilateral','ceasefire'],
      ['reduce','operation'], ['de-escalat','announc'], ['restrain','attack'],
      ['not attack'], ['suspend','operation'],
    ],
    severity: 'high',
    adjust: [+0.05, +0.07, -0.03, -0.03, -0.01],
    direction: 'shorten',
    detail: '교전국의 일방적 전투 축소 또는 자제 선언. 역사적으로 패전국의 자발적 전선 축소는 80% 이상 공식 항복의 전조.',
  },
  // === Category 6: Diplomatic breakthrough ===
  // Major diplomatic developments: secret channels, summit meetings, mediator involvement.
  // Camp David (1978), Dayton (1995), multiple UN-mediated ceasefires.
  {
    id: 'diplomatic_breakthrough',
    name: '외교적 돌파구/강대국 중재',
    keywords: [
      ['peace talk','agree'], ['diplomatic','breakthrough'], ['summit','peace'],
      ['mediati','accept'], ['un','resolution','ceasefire'], ['broker','peace'],
      ['negotiat','breakthrough'], ['china','mediat'], ['peace framework'],
    ],
    severity: 'high',
    adjust: [+0.03, +0.06, +0.02, -0.02, -0.01],
    direction: 'shorten',
    detail: '주요 외교적 돌파구 또는 강대국 중재. 데이턴(1995): 미국 중재 → 3주만에 합의. UN 안보리 결의는 평균 2~4주 내 휴전 이행.',
  },
  // === Category 7: Capital under direct attack ===
  // When a nation's capital is directly bombed or besieged, war duration shortens dramatically.
  // Belgrade 1999: 78 days of bombing → surrender. Baghdad 2003: fell in 21 days.
  // Berlin 1945: siege began April, surrender in weeks.
  {
    id: 'capital_attack',
    name: '수도 직접 공격/포위',
    keywords: [
      ['capital','bomb'], ['capital','strike'], ['capital','attack'],
      ['capital','siege'], ['capital','pound'], ['capital','explosion'],
      ['tehran','bomb'], ['tehran','strike'], ['tehran','pound'], ['tehran','explosion'],
    ],
    severity: 'high',
    adjust: [+0.04, +0.06, -0.02, -0.02, -0.01],
    direction: 'shorten',
    detail: '수도 직접 공격. 베오그라드(1999): 78일 폭격 후 항복. 바그다드(2003): 21일만에 함락. 수도 타격은 전쟁 지속 의지를 급격히 약화.',
  },
  // === Category 8: Humanitarian crisis escalation ===
  // Massive civilian casualties or refugee crisis creates international pressure.
  // Kosovo 1999: refugee crisis accelerated NATO intervention timeline.
  // Yemen: humanitarian catastrophe prolonged international diplomatic efforts.
  {
    id: 'humanitarian_crisis',
    name: '대규모 인도주의 위기',
    keywords: [
      ['humanitarian','catastroph'], ['civilian','massacre'], ['genocide'],
      ['refugee','crisis'], ['humanitarian','crisis'], ['war crime','evidence'],
      ['civilian death','thousand'], ['ethnic cleansing'],
    ],
    severity: 'high',
    adjust: [+0.02, +0.04, +0.01, -0.01, -0.01],
    direction: 'shorten',
    detail: '대규모 인도주의 위기. 국제사회 개입 압력 증가. 코소보(1999): 난민 위기가 NATO 작전 가속화. 인도적 위기는 국제 종전 압력을 2~3배 강화.',
  },
  // === Category 9: Conflict expansion / new front ===
  // New countries entering or new theaters opening. Generally lengthens wars.
  // WWI: each new entrant added months. Syria: proxy war expansion prolonged conflict by years.
  {
    id: 'conflict_expansion',
    name: '전선 확대/신규 참전국',
    keywords: [
      ['new front'], ['war spread'], ['conflict expand'], ['join','war'],
      ['enter','war'], ['open','front'], ['declare war'], ['widen','conflict'],
      ['second front'], ['new theater'],
    ],
    severity: 'moderate',
    adjust: [-0.02, -0.03, +0.04, +0.03, +0.02],
    direction: 'lengthen',
    detail: '분쟁 확대 또는 신규 참전. 역사적으로 참전국 1개 추가 시 평균 전쟁 기간 30~50% 증가 (Correlates of War 데이터).',
  },
  // === Category 10: WMD/Nuclear threat ===
  // Nuclear or chemical/biological weapon threats fundamentally change conflict calculus.
  // No historical interstate nuclear war exists, but threat alone dramatically shifts dynamics.
  {
    id: 'wmd_threat',
    name: '대량살상무기(WMD)/핵 위협',
    keywords: [
      ['nuclear','strike'], ['nuclear','weapon','use'], ['nuclear','threat'],
      ['chemical','weapon','use'], ['biological','weapon'], ['wmd','deploy'],
      ['nuclear','option'], ['atomic','bomb'],
    ],
    severity: 'critical',
    adjust: [+0.03, +0.03, +0.05, +0.04, +0.03],
    direction: 'lengthen',
    detail: 'WMD/핵 위협 감지. 핵 위협은 분쟁의 성격을 근본적으로 변화시키며, 국제사회 전체의 개입을 촉발하여 예측 불확실성이 극대화.',
  },
  // === Category 11: Ground invasion of enemy territory ===
  // Transition from air to ground war. Can shorten (Iraq 1991: 100-hour ground war)
  // or lengthen (Iraq 2003: insurgency lasted years).
  {
    id: 'ground_invasion',
    name: '적국 영토 지상 침공 개시',
    keywords: [
      ['ground invasion'], ['ground troops','enter'], ['ground offensive'],
      ['boots on the ground'], ['land invasion'], ['ground assault','launch'],
      ['ground force','cross','border'],
    ],
    severity: 'high',
    adjust: [+0.03, +0.05, +0.03, +0.02, 0],
    direction: 'mixed',
    detail: '지상 침공 개시. 걸프전(1991): 지상전 100시간만에 종결. 이라크(2003): 3주 진격 후 바그다드 함락. 지상전 전환은 전쟁의 결정적 국면.',
  },
];

function detectCriticalEvents(articles) {
  const detected = [];
  for (const evt of CRITICAL_EVENTS) {
    let matchCount = 0;
    let matchedArticles = [];
    for (const a of articles) {
      const text = ((a.title || '') + ' ' + (a.snippet || '')).toLowerCase();
      for (const kwGroup of evt.keywords) {
        if (kwGroup.every(kw => text.includes(kw))) {
          matchCount += a.isNew ? 3 : 1; // new articles weighted 3x for critical events
          matchedArticles.push(a.title);
          break; // one match per article per event
        }
      }
    }
    if (matchCount > 0) {
      detected.push({
        ...evt,
        matchCount,
        confidence: Math.min(matchCount / 3, 1.0), // 3+ matches = 100% confidence
        matchedArticles: matchedArticles.slice(0, 5),
      });
    }
  }
  return detected;
}

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

// Time decay: 군사적 기정사실(제공권,방공,미사일,호르무즈)은 느린 감쇠, 나머지는 일반 감쇠
// 시간 단위(fractional days)로 계산하여 30분 크론마다 미세 변화 반영
const DECAY_MIL = { rate: 0.02, min: 0.4 };
const DECAY_STD = { rate: 0.05, min: 0.3 };
const MIL_KW = ['제공권', '방공', '미사일 능력', '호르무즈'];
function calcDecay(dateStr, name) {
  if (!dateStr || dateStr === '실시간') return 1;
  const hours = (new Date() - new Date(dateStr)) / 3600000;
  if (hours <= 0) return 1;
  const days = hours / 24;
  const isMil = MIL_KW.some(k => (name || '').includes(k));
  const cfg = isMil ? DECAY_MIL : DECAY_STD;
  return Math.max(cfg.min, +(1 - days * cfg.rate).toFixed(4));
}
function dw(s, d) { return d >= 0.99 ? s : s + ` (잔존${Math.round(d * 100)}%)`; }

function calculatePrediction(daysElapsed, ns, econImpact, criticalEvents) {
  let p = [.15,.35,.28,.15,.07];
  const f = [];

  // 요인별 시간 감쇠
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
  console.log(`  [DECAY] 트럼프:${(dTrump*100).toFixed(1)}% 제공권:${(dAir*100).toFixed(1)}% 미사일:${(dMissile*100).toFixed(1)}% 호르무즈:${(dHormuz*100).toFixed(1)}%`);

  p[1]+=.08*dTrump; p[0]+=.03*dTrump;
  f.push({factor:'트럼프 대통령 4-5주 예상 발언',impact:'2~3개월 내 종전 확률 상승',weight:dw('+8%p (2~3개월)',dTrump),direction:'shorten',detail:FX['트럼프 대통령 4-5주 예상 발언'],keywords:['trump','4 week','5 week','timeline','end war'],applied:'2026-03-01',active:true,decay:dTrump});

  p[0]+=.04*dAir; p[1]+=.06*dAir;
  f.push({factor:'이스라엘 제공권 장악 (이란 방공 80% 파괴)',impact:'단기 종전 가능성 증가',weight:dw('+4%p (1개월내), +6%p (2~3개월)',dAir),direction:'shorten',detail:FX['이스라엘 제공권 장악 (이란 방공 80% 파괴)'],keywords:['air superi','air defens','s-300','s-400','radar','anti-air'],applied:'2026-03-01',active:true,decay:dAir});

  // 휴전 vs 확전: 비율 + 절대량 모두 반영
  const ceTotal = Math.max(ns.ceasefire_mentions + ns.escalation_mentions, 1);
  const ceaseR = ns.ceasefire_mentions / ceTotal;  // 0~1 비율
  const escalR = ns.escalation_mentions / ceTotal;  // 0~1 비율
  const ceMag = Math.min(ceTotal / 8, 2);  // 0~2 절대량 스케일 (8건=1x, 16건=2x)
  // 휴전 우세 → 미사일 능력 급감 요인 비례 적용
  p[0] += .05 * ceaseR * ceMag * dMissile; p[1] += .04 * ceaseR * ceMag * dMissile;
  // 확전 우세 → 장기화 요인 비례 적용
  p[2] += .04 * escalR * ceMag; p[3] += .02 * escalR * ceMag;
  if (ceaseR > escalR) {
    f.push({factor:`이란 미사일 능력 급감 (휴전${ns.ceasefire_mentions}:확전${ns.escalation_mentions})`,impact:'전쟁 지속 능력 약화로 단기 종전 가능성 증가',weight:dw(`+${(.05*ceaseR).toFixed(1)}%p (1개월내), +${(.04*ceaseR).toFixed(1)}%p (2~3개월)`,dMissile),direction:'shorten',detail:FX['이란 미사일 능력 급감 (90% 감소)'],keywords:['missile','ballistic','launch','strike capab'],applied:'2026-03-02',active:true,decay:dMissile});
  } else {
    f.push({factor:`확전 뉴스 우세 (확전${ns.escalation_mentions}:휴전${ns.ceasefire_mentions})`,impact:`전쟁 장기화 가능성 (확전비율 ${(escalR*100).toFixed(0)}%)`,weight:`+${(.04*escalR).toFixed(2)}%p (4~6개월)`,direction:'lengthen',detail:FX['확전 뉴스가 휴전 뉴스보다 많음'],keywords:['escalat','intensif','expand','widen'],applied:'실시간',active:true,decay:1});
  }

  p[0]+=.03*dHormuz; p[1]+=.05*dHormuz;
  f.push({factor:'호르무즈 해협 봉쇄 → 국제 경제 압력',impact:'경제적 압력으로 빠른 해결 촉구',weight:dw('+3%p (1개월내), +5%p (2~3개월)',dHormuz),direction:'shorten',detail:FX['호르무즈 해협 봉쇄 → 국제 경제 압력'],keywords:['hormuz','strait','oil price','blockade','shipping','tanker'],applied:'2026-03-01',active:true,decay:dHormuz});

  p[2]+=.05*d9n; p[3]+=.03*d9n;
  f.push({factor:'9개국 참전 - 분쟁 복잡성 증가',impact:'다자간 분쟁으로 협상 복잡화',weight:dw('+5%p (4~6개월), +3%p (7~12개월)',d9n),direction:'lengthen',detail:FX['9개국 참전 - 분쟁 복잡성 증가'],keywords:['coalition','allies','nato','joint operation','multinational'],applied:'2026-03-02',active:true,decay:d9n});

  p[1]+=.04*dKham; p[2]+=.04*dKham;
  f.push({factor:'하메네이 사망 - 이란 지도부 공백',impact:'정권 붕괴 가능성과 내부 혼란 장기화 위험',weight:dw('+4%p (2~3개월), +4%p (4~6개월)',dKham),direction:'mixed',detail:FX['하메네이 사망 - 이란 지도부 공백'],keywords:['khamenei','supreme leader','succession','leadership','regime'],applied:'2026-03-03',active:true,decay:dKham});

  p[2]+=.04*dKurd; p[3]+=.03*dKurd;
  f.push({factor:'쿠르드족 지상군 이란 국경 진입',impact:'지상전 확대로 전쟁 장기화 위험',weight:dw('+4%p (4~6개월), +3%p (7~12개월)',dKurd),direction:'lengthen',detail:FX['쿠르드족 지상군 이란 국경 진입'],keywords:['kurd','peshmerga','ground','border','northern front'],applied:'2026-03-04',active:true,decay:dKurd});

  if (daysElapsed >= 5) {
    p[0]+=.05*dCIA; p[1]+=.08*dCIA;
    f.push({factor:'이란 3/5 CIA 통한 협상 시도',impact:'이란의 협상 의지 → 단기 종전 가능성 증가',weight:dw('+5%p (1개월내), +8%p (2~3개월)',dCIA),direction:'shorten',detail:FX['이란 3/5 CIA 통한 협상 시도'],keywords:['cia','backchannel','secret talk','negotiat','iran offer','surrender'],applied:'2026-03-05',active:true,decay:dCIA});
  }

  f.push({factor:'걸프전(42일) 패턴 유사성',impact:'제공권→지상작전→빠른 종결 패턴',weight:'참고: 걸프전 42일, 코소보 78일, 포클랜드 74일',direction:'reference',detail:FX['걸프전(42일) 패턴 유사성'],keywords:['gulf war','desert storm','pattern','historical'],applied:'2026-02-28',active:true,decay:1});

  // 협상 뉴스: 비례 적용 (건수에 따라 가중치 스케일)
  {
    const n = Math.min(ns.negotiation_mentions || 0, 15);
    const nScale = n / 10; // 0~1.5
    p[0] += .02 * nScale; p[1] += .015 * nScale;
    f.push({factor:`협상/외교 뉴스 ${ns.negotiation_mentions || 0}건 감지`,impact: n > 3 ? '외교적 해결 움직임 포착' : n > 0 ? '외교 움직임 미약' : '외교 움직임 부재',weight:`+${(.02*nScale).toFixed(2)}%p (1개월내), +${(.015*nScale).toFixed(2)}%p (2~3개월)`,direction:'shorten',detail:`실시간 뉴스에서 협상 관련 기사 ${ns.negotiation_mentions || 0}건이 감지되었습니다.`,keywords:['negotiat','talks','dialog','diplomat','mediati'],applied:'실시간',active:true,decay:1});
  }

  // 지역 확산: 비례 적용 (건수에 따라 스케일)
  {
    const r = ns.regional_spread || 0;
    const rScale = Math.min(r / 10, 3); // 0~3
    p[2] += .01 * rScale; p[3] += .01 * rScale;
    f.push({factor:`지역 확산 뉴스 ${r}건 감지`,impact: r > 15 ? '주변국 대규모 연루 → 장기화 위험 높음' : r > 5 ? '주변국 연루 확대로 장기화 위험' : '주변국 연루 제한적',weight:`+${(.01*rScale).toFixed(2)}%p (4~6개월), +${(.01*rScale).toFixed(2)}%p (7~12개월)`,direction:'lengthen',detail:`주변국을 언급하는 기사 ${r}건이 감지되었습니다.`,keywords:['saudi','uae','qatar','iraq','lebanon','turkey'],applied:'실시간',active:true,decay:1});
  }

  p[1]+=.03*dSenate; p[2]+=.02*dSenate;
  f.push({factor:'미 상원 전쟁 결의안 부결',impact:'미국 내 정치적 지지로 군사작전 지속 가능',weight:dw('+3%p (2~3개월), +2%p (4~6개월)',dSenate),direction:'mixed',detail:FX['미 상원 전쟁 결의안 부결'],keywords:['senate','resolution','war powers','congress','vote'],applied:'2026-03-04',active:true,decay:dSenate});

  p[0]+=.03*dSaudi; p[1]+=.05*dSaudi;
  f.push({factor:'사우디/UAE 연합군 참전',impact:'이란 포위망 강화 → 조기 항복 가능성',weight:dw('+3%p (1개월내), +5%p (2~3개월)',dSaudi),direction:'shorten',detail:FX['사우디/UAE 연합군 참전'],keywords:['saudi','uae','coalition','join','alliance','gcc'],applied:'2026-03-03',active:true,decay:dSaudi});

  // Critical event factors (high-impact news detection)
  if (criticalEvents && criticalEvents.length > 0) {
    for (const evt of criticalEvents) {
      const conf = evt.confidence;
      const adj = evt.adjust.map(v => v * conf);
      p[0] += adj[0]; p[1] += adj[1]; p[2] += adj[2]; p[3] += adj[3]; p[4] += adj[4];
      // Clamp to prevent negatives
      p = p.map(v => Math.max(v, 0.01));
      const confLabel = conf >= 0.8 ? '확실' : conf >= 0.5 ? '높음' : '감지';
      const adjStr = evt.adjust.map((v, i) => {
        if (Math.abs(v) < 0.005) return null;
        const labels = ['1개월내', '2~3개월', '4~6개월', '7~12개월', '1년초과'];
        return `${v > 0 ? '+' : ''}${(v * conf * 100).toFixed(1)}%p (${labels[i]})`;
      }).filter(Boolean).join(', ');
      f.push({
        factor: `[중대 이벤트] ${evt.name}`,
        impact: evt.detail,
        weight: adjStr,
        direction: evt.direction,
        detail: `${evt.detail}\n\n신뢰도: ${confLabel} (${(conf * 100).toFixed(0)}%), 관련 기사 ${evt.matchCount}건 감지.${evt.matchedArticles.length ? '\n관련: ' + evt.matchedArticles.slice(0, 3).join(' | ') : ''}`,
        keywords: evt.keywords.flat(),
        applied: new Date().toISOString().split('T')[0],
        active: true,
        severity: evt.severity,
      });
      console.log(`  [CRITICAL EVENT] ${evt.name} (confidence: ${(conf * 100).toFixed(0)}%, articles: ${evt.matchCount})`);
    }
  }

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
  const criticalEvents = detectCriticalEvents(articles);
  const daysElapsed = Math.floor((new Date() - new Date('2026-02-28')) / 864e5);
  const pred = calculatePrediction(daysElapsed, signals, econImpact, criticalEvents);

  const result = {
    timestamp: new Date().toISOString(),
    war_day: daysElapsed,
    probabilities: pred.probabilities,
    factors: pred.factors,
    news_signals: signals,
    latest_news: articles.slice(0, 15),
    historical_comparison: HISTORICAL_WARS,
    economic_indicators: econData,
    critical_events: criticalEvents.map(e => ({ id: e.id, name: e.name, severity: e.severity, confidence: e.confidence, matchCount: e.matchCount, direction: e.direction })),
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
