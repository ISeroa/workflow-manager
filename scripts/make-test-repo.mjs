// 테스트 저장소를 만든다. 사용법: node scripts/make-test-repo.mjs [대상 폴더] [--force]
// - <대상>.origin.git 에 bare 원격(origin)을 함께 만든다.
// - main에는 코드와 project.yaml을 Commit하고, WP 계획 폴더는 Commit하지 않은 채 둔다 (WP 시작 흐름 검증용).
// --force는 이 스크립트가 만든 폴더(.wf-test-repo 표식이 있는 폴더)만 지우고 다시 만든다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const force = args.includes('--force');
const target = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.sandbox/test-repo');
const origin = `${target}.origin.git`;
const MARKER = '.wf-test-repo';

for (const dir of [target, origin]) {
  if (!fs.existsSync(dir)) continue;
  if (!force) {
    console.error(`이미 있어요: ${dir} (다시 만들려면 --force)`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, MARKER))) {
    console.error(`테스트 저장소 표식(${MARKER})이 없어 지우지 않아요: ${dir}`);
    process.exit(1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

const committed = {
  [MARKER]: 'workflow-manager 테스트 저장소\n',
  '.gitattributes': '* text=auto eol=lf\n',
  'package.json': '{ "type": "module", "private": true }\n',
  'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
  'docs/README.md': '# 테스트 저장소\n',
  'protected/config.ini': 'SECRET=keep\n',
  'scripts/check.mjs': [
    '// 테스트 저장소 검증 스크립트. 사용: node scripts/check.mjs <ct001|ct002|all>',
    "import fs from 'node:fs';",
    'const which = process.argv[2];',
    'const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };',
    'async function ct001() {',
    "  const { add, sub } = await import(new URL('../src/math.ts', import.meta.url));",
    "  const { shout } = await import(new URL('../src/strings.ts', import.meta.url));",
    "  if (add(2, 3) !== 5) fail('add(2, 3) !== 5');",
    "  if (typeof sub !== 'function') fail('sub가 없어요');",
    "  if (sub(5, 3) !== 2) fail(`sub(5, 3)이 ${sub(5, 3)}을 반환했어요 (기대값 2)`);",
    "  if (shout('hi') !== 'HI!') fail(`shout('hi')가 ${shout('hi')}을 반환했어요`);",
    "  console.log('ct001 ok');",
    '}',
    'function ct002() {',
    "  const md = fs.readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');",
    "  for (const name of ['add', 'sub', 'shout']) if (!md.includes(`${name}(`)) fail(`README에 ${name}( 예시가 없어요`);",
    "  console.log('ct002 ok');",
    '}',
    "if (which === 'ct001') await ct001();",
    "else if (which === 'ct002') ct002();",
    "else if (which === 'all') { await ct001(); ct002(); }",
    "else fail('사용: check.mjs <ct001|ct002|all>');",
    '',
  ].join('\n'),
  '.workflow/project.yaml': [
    'base: main',
    'mode: team',
    'protected:',
    '  - protected/**',
    '  - scripts/**',
    'commands:',
    '  check-all: node scripts/check.mjs all',
    'verify_timeout_minutes: 5',
    'claude:',
    '  max_turns: 30',
    '  timeout_minutes: 10',
    '',
  ].join('\n'),
};

const plan = {
  '.workflow/changes/WP-T3ST/package.yaml': [
    'id: WP-T3ST',
    'title: 수학 유틸 정리',
    'branch: feat/wp-t3st-math-utils',
    'description: 테스트 저장소에서 워크플로 전체 흐름을 검증하기 위한 Work Package.',
    'verify:',
    '  - name: 전체 검사',
    '    use: check-all',
    '  - manual: README 미리보기에서 예시가 보기 좋게 표시된다',
    '',
  ].join('\n'),
  '.workflow/changes/WP-T3ST/tasks/CT-001.yaml': [
    'id: CT-001',
    'title: 뺄셈 함수와 문자열 유틸 추가',
    'goal: |',
    '  src/math.ts에 sub(a, b) 함수를 추가하고,',
    '  새 파일 src/strings.ts에 shout(s) 함수를 만든다.',
    'done_when:',
    '  - sub(5, 3)은 2를 반환한다',
    '  - shout("hi")는 "HI!"를 반환한다',
    'allow:',
    '  - src/**',
    'context:',
    '  - docs/README.md',
    'verify:',
    '  - name: 동작 확인',
    '    run: node scripts/check.mjs ct001',
    '  - manual: 함수 이름이 작업 정의와 같다',
    '',
  ].join('\n'),
  '.workflow/changes/WP-T3ST/tasks/CT-002.yaml': [
    'id: CT-002',
    'title: README에 사용법 추가',
    'goal: docs/README.md에 src의 export 함수(add, sub, shout) 사용 예시를 추가한다.',
    'done_when:',
    '  - 모든 export 함수의 호출 예시가 있다',
    'allow:',
    '  - docs/**',
    'context:',
    '  - src/math.ts',
    '  - src/strings.ts',
    'verify:',
    '  - name: README 확인',
    '    run: node scripts/check.mjs ct002',
    '',
  ].join('\n'),
};

const write = (files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(target, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
};

const run = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

fs.mkdirSync(origin, { recursive: true });
run(origin, 'init', '-q', '--bare', '-b', 'main');
fs.writeFileSync(path.join(origin, MARKER), 'workflow-manager 테스트 원격\n');

write(committed);
run(target, 'init', '-q', '-b', 'main');
run(target, 'config', 'user.name', 'wf-test');
run(target, 'config', 'user.email', 'wf-test@example.invalid');
run(target, 'config', 'core.autocrlf', 'false');
run(target, 'add', '-A');
run(target, 'commit', '-q', '-m', 'init');
run(target, 'remote', 'add', 'origin', origin);
run(target, 'push', '-q', '-u', 'origin', 'main');
write(plan);
console.log(`테스트 저장소를 만들었어요: ${target}`);
console.log(`  원격: ${origin}`);
console.log('  main 브랜치, WP-T3ST 계획 폴더는 Commit하지 않은 상태');
