# 팀원 PC 설치 가이드

처음 한 번만 하면 된다. 30분 안쪽을 목표로 한다.

## 1. 필요한 프로그램

| 프로그램 | 설치 | 확인 |
|---|---|---|
| Node.js 22 이상 | https://nodejs.org (LTS) | `node --version` |
| Git for Windows | https://git-scm.com | `git --version` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| GitHub CLI | `winget install --id GitHub.cli` | `gh --version` |
| Unreal Engine 5.8 | Epic Games Launcher | LB를 에디터로 열 수 있으면 됨 |

새로 설치했다면 **터미널을 새로 열어야** PATH가 반영된다.

## 2. 로그인과 Git 설정

각자 자기 계정으로 한다. 다른 사람의 로그인이나 토큰을 공유하지 않는다.

```
claude
```
처음 실행하면 브라우저 로그인 안내가 나온다. 로그인 후 `/exit`로 나온다.

```
gh auth login --hostname github.com --git-protocol https --web
git config --global user.name "GitHub 아이디"
git config --global user.email "GitHub 메일"
```

## 3. 앱 설치

**짧은 경로에 둔다** (예: `D:\Tools\workflow-manager`). 경로가 너무 길면(260자 제한) Node가 실행되지 않는다.

```
cd D:\Tools\workflow-manager
npm ci
npm run doctor -- D:\GameDevelop\LB
```

`npm run doctor`는 Node, Git 사용자, Claude 설치·로그인, gh 로그인, LB의 `.workflow` 파일, 원격 저장소, Unreal 엔진 위치를 점검한다.
✕ 항목은 → 뒤의 안내대로 해결한다. `!` 항목은 일부 기능(예: PR 생성)만 쓸 수 없다는 뜻이다.

## 4. 실행

```
npm start
```

- 처음 실행할 때 Electron 실행 파일을 내려받는다 (1회, 약 100MB).
- 저장소 선택에서 LB 폴더를 고른다. 다음부터는 자동으로 열린다.
- 상단 **환경 점검** 버튼으로 같은 점검을 앱에서도 볼 수 있다. 문제가 있으면 자동으로 펼쳐진다.

## 5. LB에서 주의할 점

- **Unreal 엔진 경로는 자동으로 찾는다.** `.uproject`의 EngineAssociation(5.8)을 보고 Epic Launcher 설치 목록 → 레지스트리 순으로 찾아 검증 명령에 `UE_ROOT`로 넘긴다.
  찾지 못하면 Windows 환경 변수 `UE_ROOT`에 엔진 폴더(예: `D:\Program Files\Epic Games\UE_5.8`)를 지정한다.
- **검증(빌드) 전에 Unreal Editor를 닫는다.** Live Coding이 켜진 에디터가 있으면 빌드가 실패한다.
- PIE 확인은 사람이 한다. 확인 후 앱의 체크박스를 체크해야 Commit/PR로 넘어간다.
- 한 Work Package는 한 사람이 맡는다. 같은 브랜치를 둘이 동시에 작업하지 않는다.

## 6. 자주 막히는 곳

| 증상 | 해결 |
|---|---|
| `Could not determine Node.js install directory`, `The directory name is invalid` | 앱 폴더 경로가 너무 길다. 짧은 경로로 옮긴다. |
| Claude 점이 빨간색 | `claude --version`이 되는지, `claude`로 로그인했는지 확인 |
| 검증 빌드가 바로 실패 | Unreal Editor가 열려 있는지 확인. 로그 파일 경로는 검증 영역 아래에 표시된다. |
| Commit이 안 됨: user.name | 2단계의 `git config --global` 실행 |
| PR 생성 버튼이 막힘: gh | `gh auth status`로 로그인 확인. LB 저장소에 쓰기 권한이 있어야 한다. |
| Push 실패 | 원격에 다른 Commit이 있으면 직접 받아와 합친 뒤 다시 Push (자동 rebase는 하지 않음) |

로컬 상태(세션, 검증 결과, 로그)는 `%APPDATA%\workflow-manager`에 있다. 문제를 공유할 때 `logs` 폴더의 해당 파일을 함께 보낸다.
