// 앱과 같은 로컬 저장소(%APPDATA%\workflow-manager)를 쓰는 헤드리스 실행기.
// 다음 CT를 Claude로 실행하고 자동 검증까지 마친 뒤, 사람이 검토할 상태로 멈춘다. 이후는 앱에서 이어간다.
// 사용: node out/build/scripts/run-task.js <저장소> <WP id> [--check]
//   --check: .workflow 파싱 결과와 현재 상태만 출력하고 아무것도 바꾸지 않는다.
import path from 'node:path';
import type { RunEventMessage, VerifyEventMessage } from '../src/shared/types.js';
import { WorkflowService } from '../src/core/service.js';
import { LocalStore } from '../src/core/store.js';

async function main() {
  const [repo, wp] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const checkOnly = process.argv.includes('--check');
  if (!repo || !wp) throw new Error('사용: run-task.js <저장소> <WP id> [--check]');
  const storeDir = process.env.WF_STORE_DIR ?? path.join(process.env.APPDATA ?? '', 'workflow-manager');
  const svc = new WorkflowService(new LocalStore(storeDir));

  let snap = await svc.openRepo(repo);
  const pkg = () => snap.packages.find((p) => p.id === wp);
  console.log(`저장소 ${snap.root} · 브랜치 ${snap.branch} · ${snap.mode} · Claude ${snap.claudeExe ? 'OK' : snap.claudeError}`);
  if (snap.errors.length) throw new Error(`.workflow 오류:\n${snap.errors.join('\n')}`);
  if (!pkg()) throw new Error(`${wp}를 찾지 못했어요.`);
  for (const t of pkg()!.tasks) console.log(`  ${t.id} [${t.state}] ${t.title}  allow=${t.allow.join(',')}  verify=${t.verify.map((v) => v.kind === 'run' ? `run:${v.command}` : `manual:${v.name}`).join(' | ')}`);
  console.log(`  통합 검증: ${pkg()!.verify.map((v) => v.name).join(' | ')}`);
  console.log(`  미커밋 변경: ${snap.dirtyFiles.join(', ') || '없음'} (계획 파일만: ${snap.planOnlyDirty ?? '아님'})`);
  if (checkOnly) return;

  if (!pkg()!.isCurrentBranch) {
    const r = await svc.startPackage(wp);
    console.log(`WP 시작: ${r.message}`);
    snap = await svc.snapshot();
  }
  const task = pkg()!.tasks.find((t) => t.state !== 'done');
  if (!task) return console.log('모든 작업이 완료됐어요. 앱의 PR 준비 화면에서 이어가세요.');
  if (task.state === 'review') return console.log(`${task.id}는 이미 검토 중이에요. 앱에서 이어가세요.`);

  const withVerify = task.verify.some((v) => v.kind === 'run');
  const finished = new Promise<void>((resolve) => {
    let runDone = false;
    svc.on('run-event', (m: RunEventMessage) => {
      const e = m.event;
      if (e.type === 'tool') console.log(`   · ${e.name} ${e.target}`);
      if (e.type === 'tool-error') console.log(`   ✕ ${e.name}: ${e.message}`);
      if (e.type === 'done') {
        console.log(`Claude 종료: ${e.outcome}${e.message ? ` (${e.message})` : ''} · ${e.numTurns ?? '?'}턴 · $${e.costUsd?.toFixed(3) ?? '?'}`);
        if (e.resultText) console.log(`--- Claude 보고 ---\n${e.resultText}\n-------------------`);
        for (const d of e.denials) console.log(`   거부: ${d.kind} ${d.tool} ${d.detail}`);
        runDone = true;
        if (!withVerify || e.outcome !== 'success') setTimeout(resolve, 1500);
      }
    });
    svc.on('verify-event', (m: VerifyEventMessage) => {
      const e = m.event;
      if (e.type === 'check-start') console.log(`검증 시작: ${e.name} (${e.command})`);
      if (e.type === 'check-done') console.log(`검증 ${e.result.name}: ${e.result.outcome} · ${(e.result.durationMs / 1000).toFixed(0)}s · 종료 코드 ${e.result.exitCode}`);
      if (e.type === 'done' && runDone) resolve();
    });
  });
  console.log(`${task.id} 실행: ${task.title}`);
  await svc.start(wp, task.id);
  await finished;

  const ch = await svc.changes(wp, task.id);
  console.log('\n=== 변경 ===');
  for (const f of ch.files) console.log(`${f.status.padEnd(8)} ${f.category.padEnd(10)} ${f.binary ? '[binary] ' : ''}${f.path}`);
  for (const f of ch.files) if (f.diff) console.log(`\n${f.diff}`);
  console.log('\n=== 검증 ===');
  for (const r of ch.verify.results ?? []) {
    console.log(`${r.name}: ${r.outcome}`);
    console.log(r.tail.trimEnd().split(/\r?\n/).slice(-15).map((l) => `  | ${l}`).join('\n'));
  }
  console.log(`\nCommit 차단 사유: ${ch.blockers.join(' / ') || '없음'}`);
  console.log(`사람 확인 필요: ${ch.verify.items.filter((i) => i.kind === 'manual').map((i) => i.name).join(' | ') || '없음'}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
