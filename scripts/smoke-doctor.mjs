// 환경 점검 화면의 설치·설정 버튼을 검증한다. (npm run smoke:doctor)
// 실제 PC 설정을 바꾸지 않도록:
// - Claude, gh는 존재하지 않는 경로로 지정해 "없음" 상태를 만든다.
// - Git 사용자 설정은 임시 파일(GIT_CONFIG_GLOBAL)에만 쓴다.
// gh 설치 버튼은 실제로 winget을 실행한다. 이미 설치된 PC에서는 "이미 설치"로 끝난다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.sandbox', 'smoke-doctor');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doctor-'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const electron = createRequire(import.meta.url)(path.join(root, 'node_modules', 'electron'));
const r = spawnSync(electron, [root, '--smoke-doctor'], {
  cwd: tmp,
  stdio: 'inherit',
  env: {
    ...process.env,
    WF_SMOKE_OUT: out,
    WF_STORE_DIR: path.join(tmp, 'store'),
    WF_CLAUDE_EXE: path.join(tmp, 'missing', 'claude.exe'),
    WF_GH_EXE: path.join(tmp, 'missing', 'gh.exe'),
    GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  },
});
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
