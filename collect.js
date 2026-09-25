/**
 * 캄134 네이버 판매 현황 수집기
 *
 * 네이버 플레이스의 공개 객실 페이지를 날짜만 바꿔가며 열어 "예약마감" 여부를 읽고,
 * funsoft.co.kr/kalm/api.php 로 보낸다. 네이버 로그인은 하지 않는다.
 *
 * 사용법:
 *   node collect.js                 # 기본: 오늘부터 10일, 한 번만
 *   node collect.js --days 45       # 45일치
 *   node collect.js --offset 10 --days 35
 *   node collect.js --dry           # 서버로 보내지 않고 화면에만 출력
 *   node collect.js --loop 240 --every 600
 *       240분 동안 600초(10분)마다 반복한다.
 *
 * 왜 반복하냐면: 깃허브의 10분 예약은 붐비면 그냥 건너뛴다 (실측 1~3시간 간격).
 * 그래서 예약은 몇 시간에 한 번만 받고, 한 번 시작되면 그 안에서 10분마다 돈다.
 */

const { chromium } = require('playwright');

const CFG = {
  api: process.env.KALM_API || 'https://funsoft.co.kr/kalm/api.php',
  key: process.env.KALM_KEY || '',
  place: process.env.KALM_PLACE || '2033306049',
  rooms: (process.env.KALM_ROOMS || 'Garden,Tree').split(','),
  nights: Number(process.env.KALM_NIGHTS || 2),   // 최소 2박부터 팔린다
  gap: Number(process.env.KALM_GAP || 1500),      // 날짜 사이 간격(ms)
};

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const DAYS = Number(arg('days', 10));
const OFFSET = Number(arg('offset', 0));
const DRY = process.argv.includes('--dry');
const LOOP_MIN = Number(arg('loop', 0));      // 0이면 한 번만
const EVERY_SEC = Number(arg('every', 600));

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 한국 시간 기준으로 오늘을 잡는다. 깃허브 서버는 UTC 라서 그냥 두면 하루가 어긋난다. */
function todayKST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function main() {
  if (!CFG.key && !DRY) {
    console.error('KALM_KEY 가 없습니다. 환경변수나 GitHub Secrets 에 넣어주세요.');
    process.exit(1);
  }

  if (!LOOP_MIN) { await once(); return; }

  const until = Date.now() + LOOP_MIN * 60 * 1000;
  let round = 0, fails = 0;
  while (Date.now() < until) {
    const began = Date.now();
    console.log(`\n=== ${++round}회차 (${new Date(began + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} KST) ===`);
    try { await once(); fails = 0; }
    catch (e) {
      console.error('실패:', String(e).split('\n')[0]);
      // 연달아 실패하면 뭔가 막힌 것이다. 계속 두드리지 않고 끝낸다.
      if (++fails >= 3) { console.error('3회 연속 실패 — 중단합니다.'); process.exit(4); }
    }
    const wait = EVERY_SEC * 1000 - (Date.now() - began);
    if (Date.now() + Math.max(wait, 0) >= until) break;
    if (wait > 0) await sleep(wait);
  }
  console.log(`\n${round}회 수집하고 마칩니다.`);
}

async function once() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  const items = [];
  let miss = 0, blocked = false;
  const start = todayKST();

  for (let i = 0; i < DAYS; i++) {
    const inD = new Date(start); inD.setUTCDate(inD.getUTCDate() + OFFSET + i);
    const outD = new Date(inD); outD.setUTCDate(outD.getUTCDate() + CFG.nights);
    const url = `https://pcmap.place.naver.com/accommodation/${CFG.place}/room`
              + `?checkin=${ymd(inD)}&checkout=${ymd(outD)}&guest=2&entry=bmp`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 객실 이름이 실제로 그려질 때까지 기다린다. 마감인 날도 카드에 이름은 나온다.
      await page.waitForFunction(
        rooms => {
          const t = document.body.innerText || '';
          return t && !/로딩중/.test(t) && rooms.some(r => t.includes(r));
        },
        CFG.rooms,
        { timeout: 20000 }
      );

      const got = await page.evaluate(readRooms, CFG.rooms);
      for (const [room, status] of got) {
        if (status) items.push({ room, date: iso(inD), status });
        else miss++;
      }
      console.log(`${iso(inD)}  ` + got.map(([r, s]) => `${r}:${s === 'closed' ? '마감' : s === 'open' ? '판매중' : '모름'}`).join('  '));
    } catch (e) {
      miss++;
      const body = await page.content().catch(() => '');
      if (/ncaptcha|캡차|자동입력 방지|비정상적인/i.test(body)) blocked = true;
      console.log(`${iso(inD)}  실패: ${String(e).split('\n')[0]}`);
    }

    if (i < DAYS - 1) await sleep(CFG.gap);
  }

  await browser.close();

  console.log(`\n읽음 ${items.length}건 / 못읽음 ${miss}회`);
  if (blocked) console.log('⚠️ 캡차(자동 요청 차단)로 보이는 화면이 나왔습니다.');

  if (!items.length) {
    // 반복 실행 중이면 다음 회차에서 다시 시도한다. 한 번만 돌 때는 오류로 끝난다.
    throw new Error('읽은 것이 없습니다' + (blocked ? ' (차단으로 보임)' : ''));
  }
  if (DRY) return;

  const res = await fetch(CFG.api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: CFG.key, channel: '네이버', items }),
  });
  const out = await res.json().catch(() => ({}));
  console.log('서버 응답:', JSON.stringify(out));
  if (!out.ok) throw new Error('서버가 거부: ' + (out.error || '알 수 없음'));
}

/**
 * 브라우저 안에서 도는 부분.
 * 객실 카드 하나를 찾아 그 안에서만 마감 여부를 본다 —
 * 글자를 앞뒤로 훑으면 옆 객실의 "예약마감" 배지를 제 것으로 착각한다.
 */
function readRooms(rooms) {
  return rooms.map(room => {
    const others = rooms.filter(r => r !== room);
    let best = null;
    for (const el of document.querySelectorAll('li,div,article,section')) {
      const tx = el.innerText || '';
      if (!tx.includes(room) || !tx.includes('일반객실')) continue;
      if (others.some(o => tx.includes(o))) continue;
      if (!best || tx.length < (best.innerText || '').length) best = el;
    }
    if (!best) return [room, null];

    let node = best;                        // 배지는 사진 위에 얹혀 카드 본문 바깥일 수 있다
    while (node.parentElement) {
      const pt = node.parentElement.innerText || '';
      if (others.some(o => pt.includes(o))) break;
      node = node.parentElement;
    }
    return [room, /마감|판매완료|매진/.test(node.innerText || '') ? 'closed' : 'open'];
  });
}

main().catch(e => { console.error(e); process.exit(1); });
