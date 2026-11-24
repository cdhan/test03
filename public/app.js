'use strict';

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
const REGIONS = {
  seoul: { name: '서울', nx: 60, ny: 127 },
  daejeon: { name: '대전', nx: 67, ny: 100 },
};
const DAY_LABELS = ['오늘', '내일', '모레'];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// 단기예보 발표 시각 (최신 순)
const BASE_HOURS = [23, 20, 17, 14, 11, 8, 5, 2];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KST_OFFSET = 9 * HOUR;
// 발표 후 API에 반영되기까지의 여유 (기상청 안내: 약 10분)
const PUBLISH_DELAY = 15 * MINUTE;
// API는 최근 3일(오늘 포함) 발표분만 제공
const AVAILABLE_PAST_DAYS = 2;
// 한 번 조회할 때 시도해볼 발표 시각 수
const MAX_ATTEMPTS = 3;

const SKY = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY = { 0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기' };
const WIND_DIRS = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동',
  '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
const API_ERRORS = {
  '01': '기상청 서버 오류',
  '02': '기상청 데이터베이스 오류',
  '04': 'HTTP 오류',
  '05': '기상청 서비스 연결 실패',
  '10': '잘못된 요청 파라미터',
  '11': '필수 요청 파라미터 누락',
  '12': '해당 오픈 API 서비스가 없거나 폐기됨',
  '20': '서비스 접근 거부',
  '21': '일시적으로 사용할 수 없는 서비스키',
  '22': '서비스 요청 제한 횟수 초과',
  '30': '등록되지 않은 서비스키',
  '31': '기한이 만료된 서비스키',
  '32': '등록되지 않은 IP',
  '33': '서명되지 않은 호출',
};

// ---------------------------------------------------------------------------
// 날짜 유틸 — 모든 시각은 "KST 벽시계" 기준 ms (UTC 필드 = 한국 시각)
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const nowKst = () => Date.now() + KST_OFFSET;
const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;
const parts = (ms) => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), w: d.getUTCDay() };
};
const toYmd = (ms) => { const p = parts(ms); return `${p.y}${pad(p.m)}${pad(p.d)}`; };
const toIso = (ms) => { const p = parts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const fromIso = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
};
const shortDate = (ms) => { const p = parts(ms); return `${p.m}.${pad(p.d)} (${WEEKDAYS[p.w]})`; };
const longDate = (ms) => { const p = parts(ms); return `${p.y}년 ${p.m}월 ${p.d}일 (${WEEKDAYS[p.w]})`; };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const form = document.getElementById('form');
const dateInput = document.getElementById('date');
const hourSelect = document.getElementById('hour');
const submitBtn = document.getElementById('submit');
const resultEl = document.getElementById('result');

const state = { last: null };
const cache = new Map();

function init() {
  const today = startOfDay(nowKst());
  dateInput.min = toIso(today - AVAILABLE_PAST_DAYS * DAY);
  dateInput.max = toIso(today);
  dateInput.value = toIso(today);

  const currentHour = parts(nowKst()).h;
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = `${pad(h)}시`;
    if (h === currentHour) opt.selected = true;
    hourSelect.append(opt);
  }

  updateDayLabels();
  dateInput.addEventListener('input', updateDayLabels);
  dateInput.addEventListener('change', updateDayLabels);
  form.addEventListener('submit', onSubmit);
  resultEl.addEventListener('click', onHourlyClick);
}

function updateDayLabels() {
  const base = fromIso(dateInput.value);
  document.querySelectorAll('[data-offset]').forEach((el) => {
    const offset = Number(el.dataset.offset);
    el.textContent = Number.isNaN(base) ? '—' : shortDate(base + offset * DAY);
  });
}

function readSelection() {
  const baseDay = fromIso(dateInput.value);
  const today = startOfDay(nowKst());
  const minDay = today - AVAILABLE_PAST_DAYS * DAY;
  if (Number.isNaN(baseDay)) return { error: '기준 날짜를 선택해 주세요.' };
  if (baseDay < minDay || baseDay > today) {
    return { error: `기준 날짜는 ${shortDate(minDay)} ~ ${shortDate(today)} 사이에서 골라 주세요. 기상청 단기예보는 최근 3일 발표분만 제공돼요.` };
  }
  return {
    region: form.elements.region.value,
    baseDay,
    offset: Number(form.elements.day.value),
    hour: Number(hourSelect.value),
  };
}

const targetOf = (sel) => sel.baseDay + sel.offset * DAY + sel.hour * HOUR;

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------
async function onSubmit(event) {
  event.preventDefault();
  const sel = readSelection();
  if (sel.error) return showError(sel.error);

  setLoading(true);
  try {
    const found = await findForecast(sel);
    state.last = { sel, ...found };
    renderResult();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

// 목표 시각을 포함하는 가장 최근 발표분을 찾는다.
// 발표 시각 B의 예보는 B+1시간부터 시작하므로 B <= 목표-1시간 이어야 한다.
function candidateBaseTimes(target) {
  const latest = Math.min(nowKst() - PUBLISH_DELAY, target - HOUR);
  const earliestDay = startOfDay(nowKst()) - AVAILABLE_PAST_DAYS * DAY;
  const list = [];
  for (let day = startOfDay(latest); day >= earliestDay && list.length < MAX_ATTEMPTS; day -= DAY) {
    for (const h of BASE_HOURS) {
      const t = day + h * HOUR;
      if (t <= latest && list.length < MAX_ATTEMPTS) list.push(t);
    }
  }
  return list;
}

async function findForecast(sel) {
  const target = targetOf(sel);
  const candidates = candidateBaseTimes(target);
  if (!candidates.length) {
    throw new Error('기상청 단기예보는 최근 3일 이내 발표분만 제공돼서 이 시각의 예보는 조회할 수 없어요. 더 늦은 시간대나 다른 날짜를 골라 주세요.');
  }
  const key = toYmd(target) + pad(sel.hour) + '00';
  for (const base of candidates) {
    const items = await fetchForecast(sel.region, base);
    if (!items.length) continue; // 아직 발표 전(NO_DATA) → 이전 발표분으로
    const slots = groupBySlot(items);
    if (slots.has(key)) return { base, slots };
  }
  throw new Error('선택한 시간대의 예보 자료를 찾지 못했어요. 잠시 후 다시 시도하거나 다른 시간대를 골라 주세요.');
}

async function fetchForecast(region, base) {
  const baseDate = toYmd(base);
  const baseTime = pad(parts(base).h) + '00';
  const cacheKey = `${region}|${baseDate}${baseTime}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const params = new URLSearchParams({ region, base_date: baseDate, base_time: baseTime });
  let res;
  try {
    res = await fetch(`/api/forecast?${params}`);
  } catch {
    throw new Error('날씨 서버에 연결할 수 없어요. start.cmd(또는 server.ps1)가 실행 중인지 확인해 주세요.');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`서버 응답을 해석하지 못했어요. (HTTP ${res.status})`);
  }
  if (data.error) throw new Error(`날씨 정보를 가져오지 못했어요: ${data.error.message}`);

  const header = data.response && data.response.header;
  if (!header) throw new Error('기상청 응답 형식이 예상과 달라요.');
  if (header.resultCode === '03') return []; // NO_DATA
  if (header.resultCode !== '00') {
    const reason = API_ERRORS[header.resultCode] || header.resultMsg;
    throw new Error(`기상청 API 오류 (${header.resultCode}): ${reason}`);
  }

  const items = (data.response.body && data.response.body.items && data.response.body.items.item) || [];
  cache.set(cacheKey, items);
  return items;
}

function groupBySlot(items) {
  const slots = new Map();
  for (const it of items) {
    const key = it.fcstDate + it.fcstTime;
    if (!slots.has(key)) slots.set(key, { date: it.fcstDate, time: it.fcstTime });
    slots.get(key)[it.category] = it.fcstValue;
  }
  return slots;
}

// ---------------------------------------------------------------------------
// 표시
// ---------------------------------------------------------------------------
function weatherIcon(slot, hour) {
  const pty = Number(slot.PTY);
  if (pty === 1) return '🌧️';
  if (pty === 2) return '🌨️';
  if (pty === 3) return '❄️';
  if (pty === 4) return '🌦️';
  const night = hour < 6 || hour >= 19;
  const sky = Number(slot.SKY);
  if (sky === 1) return night ? '🌙' : '☀️';
  if (sky === 3) return night ? '☁️' : '⛅';
  return '☁️';
}

function weatherSummary(slot) {
  const pty = Number(slot.PTY);
  const sky = SKY[Number(slot.SKY)] || '정보 없음';
  return pty ? `${sky} · ${PTY[pty]}` : sky;
}

function windText(slot) {
  if (slot.WSD == null) return '—';
  const deg = Number(slot.VEC);
  const dir = Number.isFinite(deg) ? `${WIND_DIRS[Math.floor((deg + 11.25) / 22.5) % 16]}풍 ` : '';
  return `${dir}${slot.WSD}m/s`;
}

function precipText(value) {
  if (value == null) return '—';
  if (value === '강수없음') return '없음';
  return value;
}

function formatTemp(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10}°` : value;
}

function renderResult() {
  const { sel, base, slots } = state.last;
  const target = targetOf(sel);
  const targetDate = toYmd(target);
  const slot = slots.get(targetDate + pad(sel.hour) + '00');
  const region = REGIONS[sel.region];

  const daySlots = [...slots.values()]
    .filter((s) => s.date === targetDate)
    .sort((a, b) => a.time.localeCompare(b.time));
  const tmn = (daySlots.find((s) => s.TMN != null) || {}).TMN;
  const tmx = (daySlots.find((s) => s.TMX != null) || {}).TMX;

  if (!slot) {
    showError(`${longDate(target)} ${pad(sel.hour)}시 예보가 이 발표분에 없어요. 다른 시간대를 골라 주세요.`);
    return;
  }

  const stats = [
    ['강수확률', slot.POP != null ? `${slot.POP}%` : '—'],
    ['1시간 강수량', precipText(slot.PCP)],
    ['습도', slot.REH != null ? `${slot.REH}%` : '—'],
    ['바람', windText(slot)],
  ];
  const pty = Number(slot.PTY);
  if (pty === 2 || pty === 3 || (slot.SNO && slot.SNO !== '적설없음')) {
    stats.push(['1시간 신적설', slot.SNO === '적설없음' ? '없음' : (slot.SNO || '—')]);
  }
  if (slot.WAV != null && Number(slot.WAV) > 0) stats.push(['파고', `${slot.WAV}m`]);

  const minmax = (tmn != null || tmx != null)
    ? `<dl class="minmax">
        ${tmn != null ? `<div><dt>최저</dt><dd>${esc(formatTemp(tmn))}</dd></div>` : ''}
        ${tmx != null ? `<div><dt>최고</dt><dd>${esc(formatTemp(tmx))}</dd></div>` : ''}
      </dl>`
    : '';

  const hourly = daySlots.map((s) => {
    const h = Number(s.time.slice(0, 2));
    const current = h === sel.hour;
    return `<li><button type="button" data-hour="${h}" aria-current="${current}" aria-label="${h}시 ${esc(weatherSummary(s))} ${esc(formatTemp(s.TMP))}">
        <span class="h-time">${pad(h)}시</span>
        <span class="h-icon" aria-hidden="true">${weatherIcon(s, h)}</span>
        <span class="h-temp">${esc(formatTemp(s.TMP))}</span>
        <span class="h-pop">${s.POP != null ? `${esc(s.POP)}%` : ''}</span>
      </button></li>`;
  }).join('');

  const b = parts(base);
  const isPast = target < nowKst() - HOUR;

  resultEl.innerHTML = `
    <article class="card result-card">
      <p class="eyebrow">${esc(region.name)} · ${esc(shortDate(sel.baseDay))} 기준 ${DAY_LABELS[sel.offset]}</p>
      <h2>${esc(longDate(target))} ${pad(sel.hour)}시</h2>

      <div class="now">
        <span class="now-icon" aria-hidden="true">${weatherIcon(slot, sel.hour)}</span>
        <div class="now-main">
          <p class="now-temp">${esc(formatTemp(slot.TMP).replace('°', ''))}<small>°C</small></p>
          <p class="now-summary">${esc(weatherSummary(slot))}</p>
        </div>
        ${minmax}
      </div>

      <dl class="stats">
        ${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>

      ${isPast ? '<p class="note">이미 지난 시각이라 당시 발표된 예보값을 보여드려요. 실제 관측값과 다를 수 있어요.</p>' : ''}

      <h3 class="hourly-title">${esc(shortDate(target))} 시간대별 예보</h3>
      <ol class="hourly">${hourly}</ol>

      <p class="source">기상청 단기예보 · ${b.m}월 ${b.d}일 ${pad(b.h)}시 발표 · 예보 격자 (${region.nx}, ${region.ny})</p>
    </article>`;

  const active = resultEl.querySelector('.hourly [aria-current="true"]');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function onHourlyClick(event) {
  const btn = event.target.closest('button[data-hour]');
  if (!btn || !state.last) return;
  const hour = Number(btn.dataset.hour);
  state.last.sel.hour = hour;
  hourSelect.value = String(hour);
  renderResult();
  const again = resultEl.querySelector(`button[data-hour="${hour}"]`);
  if (again) again.focus({ preventScroll: true });
}

function showError(message) {
  resultEl.innerHTML = `<p class="message error" role="alert">${esc(message)}</p>`;
}

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? '확인 중…' : '날씨 확인하기';
}

init();
