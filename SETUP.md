# 팀원 PC 설치 가이드

`start.cmd`를 실행하고, 앱의 **환경 점검** 화면에서 버튼을 누르면 된다.

## 1. 앱 받기

GitHub 저장소 `ISeroa/workflow-manager` 초대를 수락한 뒤 둘 중 하나로 받는다.

- Git이 없으면: 저장소 페이지 **Code → Download ZIP** → 압축 해제
- Git이 있으면: `git clone https://github.com/ISeroa/workflow-manager.git D:\Tools\workflow-manager`

**짧은 경로에 둔다** (예: `D:\Tools\workflow-manager`). 경로가 너무 길면(260자 제한) Node가 실행되지 않는다.

## 2. 실행

`start.cmd`를 더블클릭한다.

1. Node.js가 없으면 winget으로 설치한다 (공식 패키지 `OpenJS.NodeJS.LTS`).
2. 처음이거나 패키지 목록이 바뀌었으면 `npm ci`를 실행한다.
3. 앱을 실행한다. 처음에는 Electron을 한 번 내려받는다 (약 100MB).

관리자 권한 확인 창이 뜨면 허용한다. Windows가 "알 수 없는 게시자" 경고를 띄우면 **추가 정보 → 실행**을 누른다.

## 3. 환경 점검 화면에서 해결

앱을 켜면 환경 점검이 자동으로 실행되고, 문제가 있으면 위쪽에 펼쳐진다.

| 항목 | 버튼 | 하는 일 |
|---|---|---|
| Git | 설치 | winget `Git.Git` 설치 |
| Git 사용자 | 설정 | GitHub 아이디·메일을 입력하면 `git config --global`로 저장 |
| Claude Code | 설치 | winget `Anthropic.ClaudeCode` 설치 |
| Claude 로그인 | 로그인 | 로그인 창을 열어 브라우저로 본인 Anthropic 계정 로그인 |
| GitHub CLI | 설치 | winget `GitHub.cli` 설치 |
| GitHub 로그인 | 로그인 | 로그인 창을 열어 브라우저로 본인 GitHub 계정 로그인 |
| Unreal Engine | Epic Games Launcher | 엔진은 런처에서 직접 설치 (자동 설치 안 함) |

- 로그인 창에서 로그인을 마친 뒤 창을 닫고 **다시 점검**을 누른다.
- 각자 자기 계정으로 로그인한다. 다른 사람의 로그인이나 토큰을 공유하지 않는다.
- 설치 후 앱을 다시 켜지 않아도 된다 (PATH를 다시 읽는다).

모두 ✓가 되면 **저장소 선택**에서 LB 폴더를 고른다. 저장소를 고른 뒤에는 `.workflow` 파일, 원격 저장소, Unreal 엔진 위치까지 점검한다. 상단 **환경 점검** 버튼으로 언제든 다시 볼 수 있다.

## 4. LB에서 주의할 점

- **Unreal 엔진 경로는 자동으로 찾는다.** `.uproject`의 EngineAssociation(5.8)을 보고 Epic Launcher 설치 목록 → 레지스트리 순으로 찾아 검증 명령에 `UE_ROOT`로 넘긴다.
  찾지 못하면 Windows 환경 변수 `UE_ROOT`에 엔진 폴더(예: `D:\Program Files\Epic Games\UE_5.8`)를 지정한다.
- **검증(빌드) 전에 Unreal Editor를 닫는다.** Live Coding이 켜진 에디터가 있으면 빌드가 실패한다.
- PIE 확인은 사람이 한다. 확인 후 앱의 체크박스를 체크해야 Commit/PR로 넘어간다.
- 한 Work Package는 한 사람이 맡는다. 같은 브랜치를 둘이 동시에 작업하지 않는다.

## 5. 자주 막히는 곳

| 증상 | 해결 |
|---|---|
| `Could not determine Node.js install directory`, `The directory name is invalid` | 앱 폴더 경로가 너무 길다. 짧은 경로로 옮긴다. |
| start.cmd에서 winget이 없다고 나옴 | Microsoft Store에서 "앱 설치 관리자"를 설치하거나 https://nodejs.org 에서 Node.js LTS를 직접 설치 |
| 설치 버튼이 실패 | 결과 아래 출력 확인. 관리자 권한 창을 거부했으면 다시 누른다. |
| 검증 빌드가 바로 실패 | Unreal Editor가 열려 있는지 확인. 로그 파일 경로는 검증 영역 아래에 표시된다. |
| PR 생성 버튼이 막힘 | GitHub 로그인과 LB 저장소 쓰기 권한 확인 |
| Push 실패 | 원격에 다른 Commit이 있으면 직접 받아와 합친 뒤 다시 Push (자동 rebase는 하지 않음) |

로컬 상태(세션, 검증 결과, 로그)는 `%APPDATA%\workflow-manager`에 있다. 문제를 공유할 때 `logs` 폴더의 해당 파일을 함께 보낸다.
터미널에서 같은 점검을 하려면 `npm run doctor -- <LB 경로>`.
