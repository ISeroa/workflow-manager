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

/** 해결 동작에 필요한 실행 파일 위치 (점검 중 찾은 것) */
export interface ToolPaths {
  claudeExe?: string;
  ghExe?: string;
}

export function findTools(): ToolPaths {
  let claudeExe: string | undefined;
  try {
    claudeExe = resolveClaudeExe();
  } catch {
    claudeExe = undefined;
  }
  return { claudeExe, ghExe: resolveGh() ?? undefined };
}

/** 이 PC에서 앱을 쓸 수 있는지 점검한다. repoRoot가 있으면 저장소 관련 항목도 본다. */
export async function runDoctor(repoRoot?: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const tools = findTools();

  // Git
  const gv = await run('git', ['--version']);
  const hasGit = gv.code === 0;
  if (!hasGit) {
    add({
      name: 'Git',
      status: 'fail',
      detail: 'git을 찾지 못했어요. 앱의 모든 작업에 필요해요.',
      fix: 'Git for Windows를 설치하세요.',
      action: { label: '설치', action: { kind: 'winget', tool: 'git' } },
    });
  } else {
    add({ name: 'Git', status: 'ok', detail: gv.stdout.trim() });
    const cwd = repoRoot ?? process.cwd();
    const [n, e] = await Promise.all([git(cwd, ['config', 'user.name']), git(cwd, ['config', 'user.email'])]);
    if (!n.stdout.trim() || !e.stdout.trim()) {
      add({
        name: 'Git 사용자',
        status: 'fail',
        detail: 'user.name 또는 user.email이 없어 Commit할 수 없어요.',
        fix: 'GitHub 아이디와 메일을 입력해 설정하세요.',
        action: { label: '설정', action: { kind: 'git-identity' } },
      });
    } else add({ name: 'Git 사용자', status: 'ok', detail: `${n.stdout.trim()} <${e.stdout.trim()}>` });
  }

  // Claude Code
  if (!tools.claudeExe) {
    add({
      name: 'Claude Code',
      status: 'fail',
      detail: 'Claude Code를 찾지 못했어요.',
      fix: 'Claude Code를 설치하세요.',
      action: { label: '설치', action: { kind: 'winget', tool: 'claude' } },
    });
  } else {
    const v = await run(tools.claudeExe, ['--version']);
    add({ name: 'Claude Code', status: v.code === 0 ? 'ok' : 'fail', detail: v.code === 0 ? `${v.stdout.trim()} · ${tools.claudeExe}` : v.stderr.trim() });
    const a = await run(tools.claudeExe, ['auth', 'status']);
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
        : {
            name: 'Claude 로그인',
            status: 'fail',
            detail: '로그인되어 있지 않아요.',
            fix: '본인 Anthropic 계정으로 로그인하세요.',
            action: { label: '로그인', action: { kind: 'login', tool: 'claude' } },
          },
    );
  }

  // GitHub CLI (PR 생성에만 필요)
  if (!tools.ghExe) {
    add({
      name: 'GitHub CLI',
      status: 'warn',
      detail: 'gh를 찾지 못했어요. PR 생성만 할 수 없어요.',
      fix: 'GitHub CLI를 설치한 뒤 로그인하세요.',
      action: { label: '설치', action: { kind: 'winget', tool: 'gh' } },
    });
  } else {
    const s = await gh(tools.ghExe, repoRoot ?? process.cwd(), ['auth', 'status']);
    const m = (s.stdout + s.stderr).match(/account (\S+)/);
    add(
      s.code === 0
        ? { name: 'GitHub CLI', status: 'ok', detail: `로그인됨${m ? ` (${m[1]})` : ''}` }
        : {
            name: 'GitHub CLI',
            status: 'warn',
            detail: '로그인되어 있지 않아요. PR 생성만 할 수 없어요.',
            fix: '본인 GitHub 계정으로 로그인하세요.',
            action: { label: '로그인', action: { kind: 'login', tool: 'gh' } },
          },
    );
  }

  if (!repoRoot || !hasGit) return checks;

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
        : { name: '원격 저장소', status: 'warn', detail: `${url.stdout.trim()}에서 ${wf.project.base}를 확인하지 못했어요. ${ls.stderr.trim().split('\n').pop() ?? ''}`, fix: '네트워크와 Git 자격 증명(저장소 권한)을 확인하세요.' },
    );
  }

  // Unreal
  const ue = detectUnreal(repoRoot);
  if (ue.uproject) {
    add(
      ue.engineRoot
        ? { name: 'Unreal Engine', status: 'ok', detail: `${ue.association} · ${ue.engineRoot} (${ue.source}) · 검증 명령에 UE_ROOT로 전달` }
        : {
            name: 'Unreal Engine',
            status: 'fail',
            detail: ue.error ?? '엔진을 찾지 못했어요.',
            fix: `Epic Games Launcher에서 UE ${ue.association ?? ''}를 설치하거나, UE_ROOT 환경 변수에 엔진 폴더를 지정하세요.`,
            link: { label: 'Epic Games Launcher', url: 'https://store.epicgames.com/download' },
          },
    );
    if (isEditorRunning()) add({ name: 'Unreal Editor', status: 'warn', detail: '에디터가 실행 중이에요. Live Coding이 켜져 있으면 검증 빌드가 실패해요.', fix: '검증 전에 에디터를 닫으세요.' });
  }
  return checks;
}
