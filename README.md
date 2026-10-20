# Workflow Manager (Windows MVP)

`.workflow/`의 계획을 작은 Commit 작업으로 나눠 Claude Code에 자동으로 맡기고,
Diff·검증 확인 → 승인 Commit → Push → GitHub PR 생성까지 관리하는 데스크톱 앱.

## 준비 (PC마다 한 번)

`start.cmd`를 더블클릭한다. Node.js가 없으면 설치하고, 패키지를 준비한 뒤 앱을 실행한다.
앱의 **환경 점검** 화면에서 Git·Claude Code·GitHub CLI 설치와 로그인, Git 사용자 설정을 버튼으로 해결한다.
자세한 절차는 [SETUP.md](SETUP.md).

처음 실행하면 저장소를 선택한다. 마지막으로 연 저장소는 다음 실행 때 자동으로 열린다.

## 사용 흐름

1. 기본 브랜치(main)에서 `.workflow/changes/WP-XXXX/` 계획 파일을 작성한다 (Commit하지 않아도 된다).
2. 앱에서 WP를 펼치고 **작업 시작** → 최신 `origin/main`에서 작업 브랜치를 만들고 계획 파일을 Commit한다.
3. team 모드면 **Push** 후 **Claude 실행**.
4. Claude가 끝나면 변경 Diff가 보이고, 검증 명령이 자동 실행된다.
5. 필요하면 **수정 요청**(같은 Claude 세션). 검증 실패 시 **실패 로그 첨부** 가능.
   허용 경로 밖 편집이 거부되면 **이 경로 허용하고 이어서 실행**으로 승인할 수 있다 (보호 경로는 불가).
6. 사람 확인 항목을 체크하고 **Commit 승인** → **Push**.
7. 모든 작업이 끝나면 **PR 준비**에서 통합 검증 → **PR 생성**. Merge는 GitHub에서 직접 한다.

## `.workflow` 형식

```
.workflow/
├─ project.yaml
└─ changes/
   └─ WP-7K3M/            # 폴더 이름은 id로 시작
      ├─ package.yaml
      └─ tasks/
         ├─ CT-001.yaml   # 파일 이름 순서가 실행 순서
         └─ CT-002.yaml
```

```yaml
# project.yaml
base: main
mode: team                 # team: Commit마다 Push 후 다음 작업 / solo: Push 강제 없음
remote: origin             # 선택
protected:                 # Claude는 절대 수정 불가 (.workflow/**는 자동 포함)
  - Content/**
  - "*.uproject"
commands:                  # verify에서 use로 참조. cmd로 실행된다.
  # Unreal 프로젝트면 앱이 엔진 위치를 찾아 UE_ROOT로 넘기므로 PC마다 다른 절대 경로를 쓰지 않는다.
  build: '"%UE_ROOT%\Engine\Build\BatchFiles\Build.bat" LBEditor Win64 Development -Project="%CD%\LB.uproject" -WaitMutex'
verify_timeout_minutes: 60 # 선택
claude:                    # 선택
  max_turns: 40
  timeout_minutes: 30
  model: opus
```

```yaml
# package.yaml
id: WP-7K3M
title: 근거리 기본 공격
branch: feat/wp-7k3m-melee-attack
base: main                 # 선택
description: PR 본문 첫머리에 들어간다.
protected: [Source/LB/Core/**]   # 선택, 이 WP에서만 추가
verify:                    # 통합 검증 (PR 생성 전)
  - use: build
  - manual: 2인 멀티에서 체력이 같게 줄어든다
```

```yaml
# tasks/CT-003.yaml
id: CT-003
title: 서버 권한 피해 처리
goal: |
  근거리 판정은 서버에서 수행하고 대상에 피해 GE를 적용한다.
done_when:
  - 클라이언트에서는 피해 GE가 적용되지 않는다
allow:                     # Claude가 수정할 수 있는 경로
  - Source/LB/Combat/**
context:                   # 선택, Claude가 참고할 파일
  - Source/LB/Attributes/LBHealthSet.h
verify:                    # 선택
  - name: 빌드
    use: build
  - run: pwsh scripts/test.ps1 -Filter LB.Combat
  - manual: PIE에서 공격 시 피격 이펙트가 1회 재생된다
```

경로 규칙:
- 보호 경로 → Claude는 편집할 수 없다 (실행 중 거부, 승인 불가). 사람이 에디터 등으로 직접 바꾼 보호 경로 파일은
  "내가 직접 작업했다"고 체크해야 Commit에 포함된다. `.workflow/**` 변경은 작업 Commit에 섞을 수 없고 [계획 변경 Commit]으로 따로 남긴다.
- 허용 경로 → 정상
- 그 외 → 범위 밖 (실행 중 거부, 사용자 승인 시 허용)
`.uasset`, `.umap` 등 바이너리 변경은 "직접 확인" 체크 후 Commit할 수 있다.

## 상태는 어디에 저장되나

- 완료 여부와 해시: Commit trailer에서 계산한다 (`Workflow-Package`, `Workflow-Task`). 문서에 따로 기록하지 않는다.
- Claude 세션, 검증 결과, 로그: `%APPDATA%\workflow-manager\` (로컬 전용).

## Claude 실행 방식

`claude -p --restricted --permission-mode dontAsk --permission-prompts none`로 실행한다.
도구는 Read/Glob/Grep/Edit/Write만 쓸 수 있고, 편집은 `Edit(<허용 경로>)` 규칙으로 제한된다.
셸·git·웹 도구는 없고 전체 권한 우회 옵션은 쓰지 않는다. 거부된 요청은 화면에 이유와 함께 표시된다.
실행 전후로 브랜치와 HEAD가 바뀌지 않았는지 확인한다.

## 개발용 명령

| 명령 | 내용 |
|---|---|
| `npm run doctor -- <저장소>` | 이 PC의 실행 환경 점검 |
| `npm run typecheck` | 타입 검사 |
| `npm run e2e` | 실제 Claude로 전체 흐름 검증 (테스트 저장소 + 로컬 bare 원격 + 대체 gh) |
| `npm run smoke:ui` | 실제 앱 화면을 자동으로 눌러 전체 흐름 검증, `.sandbox/smoke/`에 캡처 |
| `npm run smoke:doctor` | 프로그램이 없는 상태를 흉내 내 환경 점검의 설치·설정 버튼 검증 (실제 PC 설정은 바꾸지 않음) |
| `npm run make-test-repo -- <폴더> --force` | 테스트 저장소만 만들기 |

`e2e`, `smoke:ui`는 실제 Claude를 여러 번 호출한다 (한 번에 약 $0.3~0.5).
