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

## 게임 규칙

- 방 만들 때 보드 크기 선택: 5x5 ~ 10x10
- 방 최대 인원: 8명
- 방장만 `게임 시작`, `번호 뽑기` 가능
- 뽑힌 번호는 모두에게 공유되며, 각자 빙고판에 자동 표시
- **5줄(행/열/대각선 포함) 완성 시 게임 종료**

## 데이터

- 회원 정보는 `/Users/chaeyoung2/Desktop/웹 게임/data/users.json` 에 저장됩니다. (서버 첫 실행 시 생성)
