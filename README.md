# Bingo Rooms

로그인한 회원이 방을 만들고(최대 8명), 같은 방에 접속한 사람들이 함께 빙고를 하는 간단한 웹 앱입니다.

## 실행

```bash
cd "/Users/chaeyoung2/Desktop/웹 게임"
node server.js
```

Codex(샌드박스)에서 로컬 실행이 막히면:

```bash
HOST=127.0.0.1 node server.js
```

또는:

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

## 배포(외부 접속)

GitHub에 올린 뒤 Render( GitHub 연동 )로 배포하면 외부에서 접속할 수 있습니다. (`render.yaml` 포함)

1) GitHub에서 새 저장소(repo) 생성  
2) 로컬에서 원격 저장소 연결 후 푸시:

```bash
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

3) Render 대시보드에서 `New +` -> `Blueprint` -> 해당 GitHub repo 선택 -> Deploy  

4) 배포 완료 후 Render가 발급한 주소로 접속  
예: `https://bingo-rooms.onrender.com`

5) 외부 사용자도 같은 URL로 접속해서 회원가입/로그인/방 참여 가능

### 운영 팁

- `render.yaml`에 `COOKIE_SECURE=1` 이 이미 설정되어 있어 HTTPS 환경에서 세션 쿠키가 안전하게 동작합니다.
- `DATA_DIR`는 서버의 회원 데이터 저장 경로입니다.
- 현재 `plan: free` 기준으로는 인스턴스 재배포/재시작 시 파일 데이터가 초기화될 수 있습니다.
- 회원 데이터를 영구 보관하려면 DB(Postgres/Supabase 등)로 옮기거나, Render 유료 플랜 + 디스크 사용으로 전환하세요.

## 게임 규칙

- 방 만들 때 보드 크기 선택: 5x5 ~ 10x10
- 방 최대 인원: 8명
- 방장만 `게임 시작`, `번호 뽑기` 가능
- 뽑힌 번호는 모두에게 공유되며, 각자 빙고판에 자동 표시
- **5줄(행/열/대각선 포함) 완성 시 게임 종료**

## 데이터

- 회원 정보는 `/Users/chaeyoung2/Desktop/웹 게임/data/users.json` 에 저장됩니다. (서버 첫 실행 시 생성)
