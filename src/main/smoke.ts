// UI 스모크 테스트: 실제 화면 버튼을 눌러 전체 흐름을 끝까지 돌리고 화면을 캡처한다.
// 사용: npm run smoke:ui (scripts/smoke-ui.mjs가 테스트 저장소와 환경 변수를 준비한다)
import { app, type BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowService } from '../core/service.js';

export async function runSmoke(win: BrowserWindow, service: WorkflowService) {
  const repo = process.env.WF_SMOKE_REPO;
  const out = process.env.WF_SMOKE_OUT ?? path.resolve('.sandbox/smoke');
  const steps: { step: string; ok: boolean; note?: string }[] = [];
  fs.mkdirSync(out, { recursive: true });

  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (desc: string, cond: string, timeoutMs = 300_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js<boolean>(`!!(${cond})`).catch(() => false)) return;
      await sleep(400);
    }
    const err = await js<string>(`document.querySelector('[data-testid="error"]')?.textContent ?? ''`).catch(() => '');
    throw new Error(`시간 초과: ${desc}${err ? ` (화면 오류: ${err})` : ''}`);
  };
  let shotNo = 0;
  // 캡처는 증거용이라 실패해도 테스트를 멈추지 않는다 (렌더 직후 일시적으로 실패할 수 있음).
  const shot = async (name: string) => {
    const file = path.join(out, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
    for (let i = 0; i < 4; i++) {
      // 창이 가려져 있으면 이전 프레임이 캡처되므로 다시 그리게 한다.
      win.webContents.invalidate();
      await sleep(600 * (i + 1));
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(file, img.toPNG());
        return;
      } catch (e) {
        if (i === 3) console.log(`[smoke] 캡처 실패 ${name}: ${(e as Error).message}`);
      }
    }
  };
  const q = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
  const enabled = (testId: string) => `(${q(testId)} && !${q(testId)}.disabled)`;
  const click = async (testId: string) => {
    await waitFor(`${testId} 버튼 활성`, enabled(testId), 60_000);
    await js(`${q(testId)}.click()`);
  };
  const clickText = (text: string) => js(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)}).click()`);
  const typeInto = (testId: string, text: string) =>
    js(`(() => {
      const el = ${q(testId)};
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const record = (step: string, ok: boolean, note?: string) => {
    steps.push({ step, ok, note });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${step}${note ? ` — ${note}` : ''}`);
  };
  const idle = `(document.body.dataset.busy !== '1' && document.body.dataset.verifying !== '1')`;
  const reviewReady = `(document.body.dataset.phase === 'review' && Number(document.body.dataset.changes) > 0 && ${idle})`;
  const verifyText = () => js<string>(`${q('verify')}?.textContent ?? ''`);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo! }).toString().trim();

  try {
    if (!repo) throw new Error('WF_SMOKE_REPO가 필요해요.');
    await service.openRepo(repo);
    await new Promise<void>((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', () => r()) : r()));
    await js('location.reload()');

    // WP 시작
    await waitFor('작업 시작 버튼', enabled('start-wp'), 30_000);
    await shot('wp-not-started');
    await click('start-wp');
    await waitFor('브랜치 전환', `document.body.dataset.branch === 'feat/wp-t3st-math-utils'`, 30_000);
    const notice = await js<string>(`${q('notice')}?.textContent ?? ''`);
    record('WP 시작: 브랜치 생성 + 계획 Commit', /브랜치를 만들었어요/.test(notice) && /^wf: WP-T3ST/.test(git('log', '-1', '--format=%s')), notice);

    // team 모드 Push 요구
    await waitFor('Push 요구 표시', enabled('push-next'), 30_000);
    await shot('push-required');
    await click('push-next');
    await waitFor('Push 완료', `document.body.dataset.ahead === '0'`, 30_000);
    record('계획 Commit Push', true);

    // CT-001 실행 → 자동 검증
    await click('run');
    await waitFor('실행 시작', `document.body.dataset.phase === 'running'`, 30_000);
    await shot('ct001-running');
    await waitFor('실행·자동 검증 완료', `${reviewReady} && ${q('verify')}?.textContent.includes('통과')`);
    await shot('ct001-review-verified');
    record('Claude 실행 → Diff → 자동 검증 통과', (await verifyText()).includes('통과'));

    // 검증 실패 → 실패 로그 첨부 수정 요청 + 범위 밖 편집 요청
    const mathFile = path.join(repo, 'src/math.ts');
    const src = fs.readFileSync(mathFile, 'utf8');
    fs.writeFileSync(mathFile, src.replace(/return\s+a\s*-\s*b/, 'return a + b'));
    await clickText('새로고침');
    await waitFor('검증 낡음 표시', `${q('verify')}?.textContent.includes('낡음')`, 30_000);
    await click('verify-run');
    await waitFor('검증 실패', `${idle} && ${q('verify')}?.textContent.includes('실패') && ${q('attach-log')}`, 120_000);
    await shot('verify-failed');
    record('검증 실패 표시 + 실패 로그 출력', (await verifyText()).includes('sub(5, 3)'));
    await js(`${q('attach-log')}.click()`);
    await typeInto('revise-text', '검증이 실패했어. 원인을 고쳐줘. 그리고 docs/README.md 끝에 "## math" 한 줄도 추가해줘. 거부되면 우회하지 말고 보고만 해.');
    await click('revise');
    await waitFor('수정 요청 완료', `${reviewReady} && ${q('denials')} && ${q('verify')}?.textContent.includes('통과')`);
    await shot('revised-with-denial');
    const logText = await js<string>(`${q('log')}.textContent`);
    record('같은 세션 수정 요청 + 재검증 통과', logText.includes('같은 세션으로 수정 요청'));

    // 범위 밖 경로 허용 버튼
    await click('allow-docs/README.md');
    await waitFor('허용 후 이어서 실행 완료', `${reviewReady} && document.querySelector('.file .cat')?.parentElement && [...document.querySelectorAll('.file')].some(f => f.textContent.includes('docs/README.md') && f.textContent.includes('추가 허용'))`);
    await shot('extra-allowed');
    record('범위 밖 경로 허용 후 같은 세션으로 이어서 수정', true);

    // 보호 경로 차단
    fs.appendFileSync(path.join(repo, 'protected/config.ini'), 'TAMPERED=1\n');
    await clickText('새로고침');
    await waitFor('보호 경로 차단 표시', `${q('blockers')}?.textContent.includes('protected/config.ini')`, 30_000);
    await shot('protected-blocked');
    record('보호 경로 변경 시 Commit 차단', await js<boolean>(`${q('commit')}.disabled`));
    execFileSync('git', ['checkout', '--', 'protected/config.ini'], { cwd: repo });
    await clickText('새로고침');
    await waitFor('차단 해제', `!${q('blockers')} || !${q('blockers')}.textContent.includes('protected')`, 30_000);

    // 검증 다시 (보호 파일 복구로 지문이 바뀌었으면) → 사람 확인 체크 → Commit
    if (!(await verifyText()).includes('통과') || (await verifyText()).includes('낡음')) {
      await click('verify-run');
      await waitFor('재검증', `${idle} && ${q('verify')}?.textContent.includes('통과') && !${q('verify')}.textContent.includes('낡음')`, 120_000);
    }
    record('사람 확인 미체크 시 Commit 버튼 비활성', await js<boolean>(`${q('commit')}.disabled`));
    await js(`${q('manual-함수 이름이 작업 정의와 같다')}.click()`);
    await click('commit');
    await waitFor('Commit 완료', q('committed'), 30_000);
    await shot('ct001-committed');
    const msg = git('log', '-1', '--format=%B');
    record('trailer Commit', msg.startsWith('CT-001:') && msg.includes('Workflow-Task: CT-001'), msg.split('\n')[0]);

    // Push (Commit 카드의 버튼)
    await click('push');
    await waitFor('Push 완료', `document.body.dataset.ahead === '0'`, 30_000);
    record('Commit 후 Push', true);

    // CT-002
    await click('run');
    await waitFor('CT-002 실행·검증', `${reviewReady} && ${q('verify')}?.textContent.includes('통과')`);
    await click('commit');
    // 마지막 작업이면 PR 화면으로 넘어가고, Push는 하단 바에서 요청한다.
    await waitFor('PR 화면으로 이동', `document.body.dataset.phase === 'pr' && ${q('notice')}?.textContent.includes('CT-002 Commit 완료')`, 30_000);
    await shot('last-commit-pr-view');
    await click('push-next');
    await waitFor('CT-002 Push', `document.body.dataset.ahead === '0'`, 30_000);
    record('CT-002 실행 → Commit → PR 화면에서 Push', true);

    // PR 준비: 통합 검증 → 사람 확인 → PR 생성
    await waitFor('PR 화면', `document.body.dataset.phase === 'pr' && ${q('verify-run')}`, 30_000);
    await click('verify-run');
    await waitFor('통합 검증 통과', `${idle} && ${q('verify')}?.textContent.includes('통과') && !${q('verify')}.textContent.includes('실행 전')`, 120_000);
    await js(`${q('manual-README 미리보기에서 예시가 보기 좋게 표시된다')}.click()`);
    await waitFor('PR 생성 버튼 활성', enabled('pr-create'), 30_000);
    await shot('pr-ready');
    await click('pr-create');
    await waitFor('PR 링크', q('pr-link'), 30_000);
    await shot('pr-created');
    const ghState = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE!, 'utf8'));
    record('PR 생성', ghState.prs?.[0]?.head === 'feat/wp-t3st-math-utils', ghState.prs?.[0]?.url);
    record('PR 본문에 통합 검증 통과 반영', /\[x\] 전체 검사/.test(ghState.prs?.[0]?.body ?? ''));
  } catch (e) {
    record('예외', false, (e as Error).message);
    await shot('error').catch(() => {});
  }

  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(steps, null, 2), 'utf8');
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`[smoke] ${steps.length - failed}/${steps.length} 통과, 캡처: ${out}`);
  app.exit(failed ? 1 : 0);
}
