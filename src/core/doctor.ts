import { execFile } from 'node:child_process';
import type { DoctorCheck } from '../shared/types.js';
import { resolveClaudeExe } from './claude.js';
import { gh, resolveGh } from './gh.js';
import { git } from './git.js';
import { detectUnreal, isEditorRunning } from './unreal.js';
import { loadWorkflow } from './workflow.js';

function run(file: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr || (err?.message ?? '') });
    });
  });
}

/** 이 PC에서 앱을 쓸 수 있는지 점검한다. repoRoot가 있으면 저장소 관련 항목도 본다. */
export async function runDoctor(repoRoot?: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // Git
  const gv = await run('git', ['--version']);
  if (gv.code !== 0) add({ name: 'Git', status: 'fail', detail: 'git을 실행하지 못했어요.', fix: 'Git for Windows를 설치하세요.' });
  else {
    add({ name: 'Git', status: 'ok', detail: gv.stdout.trim() });
    const cwd = repoRoot ?? process.cwd();
    const [n, e] = await Promise.all([git(cwd, ['config', 'user.name']), git(cwd, ['config', 'user.email'])]);
    if (!n.stdout.trim() || !e.stdout.trim()) {
      add({ name: 'Git 사용자', status: 'fail', detail: 'user.name 또는 user.email이 없어 Commit할 수 없어요.', fix: 'git config --global user.name "이름" 과 git config --global user.email "메일"을 설정하세요.' });
    } else add({ name: 'Git 사용자', status: 'ok', detail: `${n.stdout.trim()} <${e.stdout.trim()}>` });
  }

  // Claude Code
  let claudeExe: string | undefined;
  try {
    claudeExe = resolveClaudeExe();
  } catch (err) {
    add({ name: 'Claude Code', status: 'fail', detail: (err as Error).message, fix: 'Claude Code를 설치하세요 (npm install -g @anthropic-ai/claude-code 또는 공식 설치 프로그램).' });
  }
  if (claudeExe) {
    const v = await run(claudeExe, ['--version']);
    add({ name: 'Claude Code', status: v.code === 0 ? 'ok' : 'fail', detail: v.code === 0 ? `${v.stdout.trim()} · ${claudeExe}` : v.stderr.trim() });
    const a = await run(claudeExe, ['auth', 'status']);
    let loggedIn = false;
    let who = '';
    try {
      const j = JSON.parse(a.stdout);
      loggedIn = !!j.loggedIn;
      who = j.email ?? j.authMethod ?? '';
    } catch {
      loggedIn = a.code === 0;
    }
    add(
      loggedIn
        ? { name: 'Claude 로그인', status: 'ok', detail: who || '로그인됨' }
        : { name: 'Claude 로그인', status: 'fail', detail: '로그인되어 있지 않아요.', fix: '터미널에서 claude를 한 번 실행해 로그인하세요.' },
    );
  }

  // GitHub CLI (PR 생성에만 필요)
  const ghExe = resolveGh();
  if (!ghExe) add({ name: 'GitHub CLI', status: 'warn', detail: 'gh를 찾지 못했어요. PR 생성만 할 수 없어요.', fix: 'winget install --id GitHub.cli 후 gh auth login을 실행하세요.' });
  else {
    const s = await gh(ghExe, repoRoot ?? process.cwd(), ['auth', 'status']);
    const m = (s.stdout + s.stderr).match(/account (\S+)/);
    add(
      s.code === 0
        ? { name: 'GitHub CLI', status: 'ok', detail: `로그인됨${m ? ` (${m[1]})` : ''}` }
        : { name: 'GitHub CLI', status: 'warn', detail: '로그인되어 있지 않아요. PR 생성만 할 수 없어요.', fix: 'gh auth login --web 을 실행하세요.' },
    );
  }

  if (!repoRoot) return checks;

  // 저장소
  const wf = loadWorkflow(repoRoot);
  add(
    wf.errors.length
      ? { name: '.workflow 파일', status: 'fail', detail: wf.errors.slice(0, 3).join(' / ') }
      : { name: '.workflow 파일', status: 'ok', detail: `Work Package ${wf.packages.length}개 · ${wf.project.mode} 모드` },
  );
  const url = await git(repoRoot, ['remote', 'get-url', wf.project.remote]);
  if (url.code !== 0) add({ name: '원격 저장소', status: wf.project.mode === 'team' ? 'fail' : 'warn', detail: `원격 ${wf.project.remote}이 없어요.` });
  else {
    const ls = await git(repoRoot, ['ls-remote', '--heads', wf.project.remote, wf.project.base]);
    add(
      ls.code === 0 && ls.stdout.trim()
        ? { name: '원격 저장소', status: 'ok', detail: `${url.stdout.trim()} · ${wf.project.base} 확인` }
        : { name: '원격 저장소', status: 'warn', detail: `${url.stdout.trim()}에서 ${wf.project.base}를 확인하지 못했어요. ${ls.stderr.trim().split('\n').pop() ?? ''}`, fix: '네트워크와 Git 자격 증명을 확인하세요.' },
    );
  }

  // Unreal
  const ue = detectUnreal(repoRoot);
  if (ue.uproject) {
    add(
      ue.engineRoot
        ? { name: 'Unreal Engine', status: 'ok', detail: `${ue.association} · ${ue.engineRoot} (${ue.source}) · 검증 명령에 UE_ROOT로 전달` }
        : { name: 'Unreal Engine', status: 'fail', detail: ue.error ?? '엔진을 찾지 못했어요.', fix: 'UE_ROOT 환경 변수에 엔진 폴더(예: D:\\Program Files\\Epic Games\\UE_5.8)를 지정하세요.' },
    );
    if (isEditorRunning()) add({ name: 'Unreal Editor', status: 'warn', detail: '에디터가 실행 중이에요. Live Coding이 켜져 있으면 검증 빌드가 실패해요.', fix: '검증 전에 에디터를 닫으세요.' });
  }
  return checks;
}
