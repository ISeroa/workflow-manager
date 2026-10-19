// 환경 점검 화면 자동 점검: 프로그램이 없는 상태를 흉내 내고 설치·설정 버튼 동작을 확인한다.
// 사용: npm run smoke:doctor (scripts/smoke-doctor.mjs가 환경 변수를 준비한다)
import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export async function runDoctorSmoke(win: BrowserWindow) {
  const out = process.env.WF_SMOKE_OUT ?? path.resolve('.sandbox/smoke-doctor');
  const gitConfig = process.env.GIT_CONFIG_GLOBAL;
  const steps: { step: string; ok: boolean; note?: string }[] = [];
  fs.mkdirSync(out, { recursive: true });

  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (desc: string, cond: string, timeoutMs = 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await js<boolean>(`!!(${cond})`).catch(() => false)) return;
      await sleep(300);
    }
    throw new Error(`시간 초과: ${desc}`);
  };
  let n = 0;
  const shot = async (name: string) => {
    for (let i = 0; i < 4; i++) {
      win.webContents.invalidate();
      await sleep(500 * (i + 1));
      try {
        fs.writeFileSync(path.join(out, `${String(++n).padStart(2, '0')}-${name}.png`), (await win.webContents.capturePage()).toPNG());
        return;
      } catch {
        /* 다시 시도 */
      }
    }
  };
  const q = (id: string) => `document.querySelector('[data-testid="${id}"]')`;
  const text = (id: string) => js<string>(`${q(id)}?.textContent ?? ''`);
  const record = (step: string, ok: boolean, note?: string) => {
    steps.push({ step, ok, note });
    console.log(`[doctor] ${ok ? 'PASS' : 'FAIL'} ${step}${note ? ` — ${note}` : ''}`);
  };
  const typeInto = (id: string, value: string) =>
    js(`(() => { const el = ${q(id)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  try {
    await new Promise<void>((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', () => r()) : r()));
    await waitFor('환경 점검 자동 표시', `${q('doctor')} && ${q('doctor-Claude Code')}`, 60_000);
    await shot('missing-tools');
    record('저장소 선택 전 시작 화면에서 점검 자동 표시', !!(await js(`${q('open-repo')}`)));
    record('Claude 없음 → 설치 버튼', (await text('fix-Claude Code')) === '설치', await text('doctor-Claude Code'));
    record('gh 없음 → 설치 버튼', (await text('fix-GitHub CLI')) === '설치');
    record('Git 사용자 없음 → 설정 버튼', (await text('fix-Git 사용자')) === '설정');

    // Git 사용자 설정 (임시 global 설정 파일에만 쓴다)
    await js(`${q('fix-Git 사용자')}.click()`);
    await waitFor('입력 폼', q('git-name'));
    await typeInto('git-name', 'wf-teammate');
    await typeInto('git-email', 'not-an-email');
    await js(`${q('git-identity-save')}.click()`);
    await waitFor('메일 형식 오류', `${q('doctor-Git 사용자')}.textContent.includes('형식')`);
    record('잘못된 메일 형식 거부', true);
    await typeInto('git-email', 'wf-teammate@example.invalid');
    await js(`${q('git-identity-save')}.click()`);
    await waitFor('Git 사용자 정상', `${q('doctor-Git 사용자')}?.className.includes('d-ok')`, 60_000);
    const cfg = gitConfig && fs.existsSync(gitConfig) ? fs.readFileSync(gitConfig, 'utf8') : '';
    record('Git 사용자 설정 후 재점검 통과', /wf-teammate@example\.invalid/.test(cfg), gitConfig);
    await shot('git-identity-set');

    // gh 설치 버튼: 이미 설치된 PC라 winget이 "이미 설치"로 끝나는지 확인
    await js(`${q('fix-GitHub CLI')}.click()`);
    await waitFor('설치 진행 표시', `${q('fix-GitHub CLI')}?.textContent === '설치 중…'`, 10_000);
    await shot('installing');
    await waitFor('winget 결과', `!${q('fix-GitHub CLI')} || ${q('fix-GitHub CLI')}.textContent !== '설치 중…'`, 15 * 60_000);
    const ghText = await text('doctor-GitHub CLI');
    await shot('install-result');
    record('winget 설치 실행 후 결과 표시', /설치/.test(ghText), ghText.slice(0, 160));
  } catch (e) {
    record('예외', false, (e as Error).message);
    await shot('error');
  }

  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(steps, null, 2), 'utf8');
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`[doctor] ${steps.length - failed}/${steps.length} 통과, 캡처: ${out}`);
  app.exit(failed ? 1 : 0);
}
