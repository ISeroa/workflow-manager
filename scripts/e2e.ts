// 워크플로 전체 E2E 검증 (실제 Claude 실행, 테스트 저장소 + 로컬 bare 원격 + 대체 gh)
// WP 시작 → Push 요구 → CT 실행·자동 검증 → 검증 실패 → 로그 첨부 수정 요청 → 범위 밖 경로 승인
// → 보호 경로 차단 → Commit → Push 실패·재시도 → 다음 CT → 계획 변경 Commit → 통합 검증 → PR 생성
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_SCOPE, type RunEvent, type RunEventMessage, type VerifyEvent, type VerifyEventMessage } from '../src/shared/types.js';
import { WorkflowService } from '../src/core/service.js';
import { LocalStore } from '../src/core/store.js';

const projectRoot = path.resolve(__dirname, '../../..');
const repo = path.join(projectRoot, '.sandbox', 'e2e-repo');
const origin = `${repo}.origin.git`;
const results: { name: string; ok: boolean; detail?: string }[] = [];
const WP = 'WP-T3ST';
const MANUAL_CT1 = '함수 이름이 작업 정의와 같다';
const MANUAL_PR = 'README 미리보기에서 예시가 보기 좋게 표시된다';

type Done = Extract<RunEvent, { type: 'done' }>;
type VDone = Extract<VerifyEvent, { type: 'done' }>;

function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function expectError(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    check(name, false, '오류가 나지 않았어요');
  } catch (e) {
    const m = (e as Error).message;
    check(name, pattern.test(m), m.slice(0, 160));
  }
}

const gitOut = (...a: string[]) => execFileSync('git', a, { cwd: repo }).toString().trim();

/** Claude 실행이 끝나고, 검증 명령이 있으면 자동 검증까지 끝날 때까지 기다린다. */
function waitRun(svc: WorkflowService, withVerify: boolean): Promise<{ events: RunEvent[]; done: Done; verify?: VDone }> {
  return new Promise((resolve) => {
    const events: RunEvent[] = [];
    let done: Done | undefined;
    const finish = (verify?: VDone) => {
      svc.off('run-event', onRun);
      svc.off('verify-event', onVerify);
      resolve({ events, done: done!, verify });
    };
    const onRun = (m: RunEventMessage) => {
      events.push(m.event);
      if (m.event.type === 'tool') console.log(`   · ${m.event.name} ${m.event.target}`);
      if (m.event.type === 'done') {
        done = m.event;
        if (!withVerify || m.event.outcome !== 'success') finish();
      }
    };
    const onVerify = (m: VerifyEventMessage) => {
      if (m.event.type === 'check-done') console.log(`   ✓ 검증 ${m.event.result.name}: ${m.event.result.outcome}`);
      if (m.event.type === 'done' && done) finish(m.event);
    };
    svc.on('run-event', onRun);
    svc.on('verify-event', onVerify);
  });
}

function waitVerify(svc: WorkflowService): Promise<VDone> {
  return new Promise((resolve) => {
    const on = (m: VerifyEventMessage) => {
      if (m.event.type === 'done') {
        svc.off('verify-event', on);
        resolve(m.event);
      }
    };
    svc.on('verify-event', on);
  });
}

const sessionOf = (events: RunEvent[]) => (events.find((e) => e.type === 'started') as Extract<RunEvent, { type: 'started' }>).sessionId;

async function main() {
  execFileSync('node', [path.join(projectRoot, 'scripts', 'make-test-repo.mjs'), repo, '--force'], { stdio: 'inherit' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e2e-'));
  process.env.WF_GH_EXE = path.join(projectRoot, 'scripts', 'fake-gh.js');
  process.env.FAKE_GH_STATE = path.join(tmp, 'gh-state.json');
  process.env.WF_GH_REPO = 'test/repo';
  const svc = new WorkflowService(new LocalStore(path.join(tmp, 'store')));

  // ── WP 시작 ──
  let snap = await svc.openRepo(repo);
  check('워크플로 파일 오류 없음', snap.errors.length === 0, snap.errors.join(' / '));
  check('main에서 계획 파일만 미커밋 상태로 인식', snap.planOnlyDirty === WP && snap.branch === 'main');
  await expectError('WP 브랜치가 아니면 실행 차단', () => svc.start(WP, 'CT-001'), /브랜치/);
  const sp = await svc.startPackage(WP);
  snap = await svc.snapshot();
  check('WP 시작: 최신 origin/main에서 브랜치 생성', snap.branch === 'feat/wp-t3st-math-utils' && /origin\/main/.test(sp.message), sp.message);
  check('WP 시작: 계획 파일 Commit + 작업 트리 깨끗', snap.clean && /^wf: WP-T3ST 계획/.test(gitOut('log', '-1', '--format=%s')));
  check('계획 Commit은 완료 상태로 세지 않음', snap.packages[0].doneCount === 0);
  check('원격 대비 Push 필요 1', snap.remote?.ahead === 1 && !snap.remote.remoteBranch, JSON.stringify(snap.remote));
  await expectError('team 모드: Push 전 실행 차단', () => svc.start(WP, 'CT-001'), /Push/);
  await svc.push(WP);
  snap = await svc.snapshot();
  check('Push 후 원격 브랜치 생성, ahead 0', snap.remote?.remoteBranch === true && snap.remote.ahead === 0);

  // ── CT-001 실행 + 자동 검증 ──
  let w = waitRun(svc, true);
  await svc.start(WP, 'CT-001');
  let r = await w;
  check('CT-001 실행 성공', r.done.outcome === 'success', r.done.message);
  check('실행 후 검증 자동 실행·통과', r.verify?.outcome === 'passed', r.verify?.results.map((x) => `${x.name}:${x.outcome}`).join(', '));
  const sid = sessionOf(r.events);
  let ch = await svc.changes(WP, 'CT-001');
  check('기존·신규 파일 변경', ch.files.some((f) => f.path === 'src/math.ts' && f.status === 'modified') && ch.files.some((f) => f.path === 'src/strings.ts' && f.status === 'added'));
  check('검증 통과 상태로 차단 사유 없음', ch.blockers.length === 0 && ch.verify.passed, ch.blockers.join(' / '));

  // ── 검증 실패 → 로그 첨부 수정 요청 ──
  const mathFile = path.join(repo, 'src/math.ts');
  const src = fs.readFileSync(mathFile, 'utf8');
  const broken = src.replace(/return\s+a\s*-\s*b/, 'return a + b');
  check('(준비) sub에 버그 주입', broken !== src);
  fs.writeFileSync(mathFile, broken);
  ch = await svc.changes(WP, 'CT-001');
  check('변경 후 검증 결과가 낡음으로 표시', !ch.verify.fresh && ch.blockers.some((b) => b.includes('다시 실행')), ch.blockers.join(' / '));
  let vw = waitVerify(svc);
  await svc.verify(WP, 'CT-001');
  const vfail = await vw;
  check('검증 실패 감지', vfail.outcome === 'failed' && /sub\(5, 3\)/.test(vfail.results[0].tail), vfail.results[0].tail.trim().split('\n').pop());
  ch = await svc.changes(WP, 'CT-001');
  check('검증 실패 시 Commit 차단', ch.blockers.some((b) => b.includes('통과하지')));
  w = waitRun(svc, true);
  await svc.revise(WP, 'CT-001', { text: '검증이 실패했어. 원인을 찾아 고쳐줘.', attachFailureLog: true, allowPaths: [] });
  r = await w;
  check('로그 첨부 수정 요청: 같은 세션', sessionOf(r.events) === sid);
  check('로그 첨부 수정 요청 후 자동 재검증 통과', r.verify?.outcome === 'passed', r.verify?.results.map((x) => x.outcome).join(','));

  // ── 범위 밖 경로 승인 + 보호 경로 거부 ──
  w = waitRun(svc, true);
  await svc.revise(WP, 'CT-001', {
    text: 'docs/README.md 끝에 "## math" 제목 한 줄을 추가해줘. 거부되면 우회하지 말고 보고만 해.',
    attachFailureLog: false,
    allowPaths: [],
  });
  r = await w;
  const oos = r.done.denials.find((d) => d.kind === 'outOfScope');
  check('범위 밖 편집 거부 + 거부 목록에 표시', oos?.path === 'docs/README.md', r.done.denials.map((d) => `${d.kind}:${d.detail}`).join(', '));
  await expectError('보호 경로는 허용 불가', () => svc.revise(WP, 'CT-001', { text: '', attachFailureLog: false, allowPaths: ['protected/config.ini'] }), /보호 경로/);
  w = waitRun(svc, true);
  await svc.revise(WP, 'CT-001', { text: '', attachFailureLog: false, allowPaths: ['docs/README.md'] });
  r = await w;
  check('범위 밖 경로 승인 후 같은 세션으로 이어서 수정', sessionOf(r.events) === sid && /## math/.test(fs.readFileSync(path.join(repo, 'docs/README.md'), 'utf8')));
  ch = await svc.changes(WP, 'CT-001');
  const readme = ch.files.find((f) => f.path === 'docs/README.md');
  check('승인된 경로는 추가 허용으로 표시', readme?.category === 'allowed' && readme.extraAllowed);

  // ── 보호 경로 사후 차단 ──
  fs.appendFileSync(path.join(repo, 'protected/config.ini'), 'TAMPERED=1\n');
  ch = await svc.changes(WP, 'CT-001');
  check('보호 경로 변경 시 Commit 차단', ch.blockers.some((b) => b.includes('protected/config.ini')));
  execFileSync('git', ['checkout', '--', 'protected/config.ini'], { cwd: repo });

  // ── Commit ──
  ch = await svc.changes(WP, 'CT-001');
  if (!ch.verify.passed) {
    vw = waitVerify(svc);
    await svc.verify(WP, 'CT-001');
    await vw;
  }
  await expectError('사람 확인 항목 미체크 시 Commit 거부', () => svc.commit(WP, 'CT-001', { subject: '', approveOutOfScope: false, ackBinary: false, manualChecked: [] }), /체크/);
  const c1 = await svc.commit(WP, 'CT-001', { subject: '', approveOutOfScope: false, ackBinary: false, manualChecked: [MANUAL_CT1] });
  const msg = gitOut('log', '-1', '--format=%B');
  check('trailer Commit', msg.startsWith('CT-001: ') && msg.includes('Workflow-Package: WP-T3ST') && msg.includes('Workflow-Task: CT-001'));
  snap = await svc.snapshot();
  check('CT-001 완료 + 해시', snap.packages[0].tasks[0].hash === c1.hash);

  // ── Push 실패·재시도 ──
  await expectError('team 모드: Push 전 다음 작업 차단', () => svc.start(WP, 'CT-002'), /Push/);
  const moved = `${origin}.moved`;
  fs.renameSync(origin, moved);
  const before = gitOut('rev-list', '--count', 'HEAD');
  await expectError('원격 접근 불가 시 Push 실패 안내', () => svc.push(WP), /Push하지 못했어요/);
  check('Push 실패 후 Commit 중복 없음', gitOut('rev-list', '--count', 'HEAD') === before);
  fs.renameSync(moved, origin);
  await svc.push(WP);
  snap = await svc.snapshot();
  check('Push 재시도 성공, ahead 0', snap.remote?.ahead === 0);

  // ── CT-002 ──
  w = waitRun(svc, true);
  await svc.start(WP, 'CT-002');
  r = await w;
  check('CT-002 실행·자동 검증 통과', r.done.outcome === 'success' && r.verify?.outcome === 'passed', r.verify?.results.map((x) => x.tail.trim()).join(' | '));
  await svc.commit(WP, 'CT-002', { subject: '', approveOutOfScope: false, ackBinary: false, manualChecked: [] });

  // ── 계획 변경 Commit ──
  const pkgFile = path.join(repo, '.workflow/changes/WP-T3ST/package.yaml');
  fs.writeFileSync(pkgFile, fs.readFileSync(pkgFile, 'utf8').replace('검증하기 위한', '끝까지 검증하기 위한'));
  snap = await svc.snapshot();
  check('계획 파일만 바뀐 상태 인식', snap.planOnlyDirty === WP);
  await expectError('계획 변경이 남아 있으면 통합 검증 차단', () => svc.verify(WP, PACKAGE_SCOPE), /미커밋/);
  await svc.commitPlan(WP);
  snap = await svc.snapshot();
  check('계획 변경 Commit 후 완료 상태 유지', snap.packages[0].allDone && snap.clean);
  await svc.push(WP);

  // ── 통합 검증 + PR ──
  let pv = await svc.prView(WP);
  check('통합 검증 전 PR 차단', !pv.ready && pv.blockers.some((b) => b.includes('통합 검증')), pv.blockers.join(' / '));
  vw = waitVerify(svc);
  await svc.verify(WP, PACKAGE_SCOPE);
  const vall = await vw;
  check('통합 검증 통과', vall.outcome === 'passed');
  pv = await svc.prView(WP);
  check('PR 준비 완료', pv.ready, pv.blockers.join(' / '));
  check('PR 본문에 작업·해시 포함', pv.body.includes(`CT-001`) && pv.body.includes(c1.hash.slice(0, 7)));
  await expectError('PR 사람 확인 항목 미체크 시 거부', () => svc.createPr(WP, { title: pv.title, body: pv.body, draft: true, manualChecked: [] }), /체크/);
  const pr = await svc.createPr(WP, { title: pv.title, body: pv.body, draft: true, manualChecked: [MANUAL_PR] });
  const ghState = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE!, 'utf8'));
  const created = ghState.prs[0];
  check('PR 생성 (gh pr create --body-file)', !!pr.url && created?.head === 'feat/wp-t3st-math-utils' && created.base === 'main' && created.isDraft, pr.url);
  pv = await svc.prView(WP);
  check('열린 PR이 있으면 중복 생성 차단', !pv.ready && pv.existing?.number === 1);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
