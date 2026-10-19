// 테스트 저장소를 새로 만들고 실제 앱 화면을 자동으로 눌러 전체 흐름을 검증한다. (npm run smoke:ui)
// PR 생성은 scripts/fake-gh.js로 대체한다 (실제 GitHub에 PR을 만들지 않음).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = path.join(root, '.sandbox');
const repo = path.join(sandbox, 'ui-repo');
const out = path.join(sandbox, 'smoke');
const store = path.join(sandbox, 'smoke-store');

execFileSync('node', [path.join(root, 'scripts', 'make-test-repo.mjs'), repo, '--force'], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(store, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// electron 패키지는 처음 쓸 때 실행 파일을 내려받으므로 dist 경로를 직접 쓰지 않고 패키지가 돌려주는 경로를 쓴다.
const electron = createRequire(import.meta.url)(path.join(root, 'node_modules', 'electron'));
const r = spawnSync(electron, ['.', '--smoke'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    WF_SMOKE_REPO: repo,
    WF_SMOKE_OUT: out,
    WF_STORE_DIR: store,
    WF_GH_EXE: path.join(root, 'scripts', 'fake-gh.js'),
    FAKE_GH_STATE: path.join(out, 'gh-state.json'),
    WF_GH_REPO: 'test/repo',
  },
});
process.exit(r.status ?? 1);
