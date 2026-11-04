# sports.yunmin.dev

친구들과 운동한 경기 결과를 기록하고, 종목별·종합 순위를 매기는 사이트.

- `/` 메인: 종합 순위, 종목별 순위(상위 3명), 최근 경기
- `/<종목주소>` 종목 페이지 (예: `/badminton`): 순위표, 경기 기록하기(두 사람 + 세트 스코어 + 세트별 점수), 날짜별 경기 목록, 맞대결 표
- `/p/<번호>` 사람 페이지: 종목별 성적, 상대별 전적, 최근 경기

## 구조

| 파일 | 하는 일 |
| --- | --- |
| `worker.js` | `/api/*` 기록 서버. 데이터는 Durable Object `League` 하나의 SQLite에 저장 |
| `public/index.html` | 모든 페이지가 같이 쓰는 껍데기 |
| `public/assets/app.js` | 화면 그리기, 순위 계산, 기록 폼 |
| `public/assets/style.css` | yunmin.dev와 같은 색·글꼴 |
| `wrangler.jsonc` | Worker 설정 (이름 `sports-yunmin-dev`) |

순위는 저장하지 않고 화면에서 경기 목록을 처음부터 다시 계산한다. 그래서 경기를 지우면 순위도 저절로 맞춰진다.

- **종목 레이팅**: 모두 1000점에서 시작하는 Elo. 처음 10경기는 K=40, 그다음은 K=24. 승패는 세트 스코어로 정하고, 같으면 무승부. (서버는 팀 경기도 받을 수 있지만 화면은 지금 1:1만 고르게 한다. 2026-11-04 사용자 요청)
- **종합점수**: 종목마다 등수에 따라 1위 10, 2위 8, 3위 6, 4위 5, 5위 4, 6위 3, 7위 2, 8위 1점, 그 아래도 참가하면 1점. 이것을 모두 더한 값.

## 기록 권한

보기는 누구나. 경기 기록·삭제, 사람·종목 추가는 공용 비밀번호를 아는 사람만 할 수 있다.
비밀번호는 Cloudflare 대시보드 → Workers & Pages → `sports-yunmin-dev` → Settings → Variables and Secrets 에서
`PASSCODE` 라는 이름의 **Secret** 으로 넣는다. 한 번 넣으면 그 기기 브라우저가 기억한다.
한 시간에 15번 넘게 틀리면 그 IP는 한 시간 동안 막힌다.

지운 경기는 실제로 지우지 않고 숨겨 둔다 (지운 직후 "되돌리기" 가능).

## API

| 요청 | 설명 |
| --- | --- |
| `GET /api/data` | 종목·사람·경기 전체 |
| `POST /api/login` | 비밀번호 확인 |
| `POST /api/players` `{name}` | 사람 추가 |
| `POST /api/sports` `{name, emoji, id?}` | 종목 추가 (`id`는 주소, 영어 소문자) |
| `POST /api/matches` `{sport, date, a:[id], b:[id], sa, sb, sets?, note?}` | 경기 기록. `sa:sb`는 세트 스코어, `sets`는 `[[11,8],[9,11],…]` (비우거나, 세트 스코어 합만큼 채우고 이긴 세트 수가 맞아야 함) |
| `DELETE /api/matches/:id` | 경기 지우기 |
| `POST /api/matches/:id/restore` | 지운 경기 되살리기 |

고치는 요청은 `x-pass` 헤더에 비밀번호를 넣는다.

## 로컬에서 실행

```sh
echo 'PASSCODE=test' > .dev.vars
npx wrangler dev
```
