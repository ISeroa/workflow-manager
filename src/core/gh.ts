import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PrInfo } from '../shared/types.js';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** gh 실행 파일 위치. WF_GH_EXE가 .js면 Node로 실행한다(테스트용 대체 gh). */
export function resolveGh(): string | null {
  const override = process.env.WF_GH_EXE;
  if (override) return fs.existsSync(override) ? override : null;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI'));
  for (const d of dirs) {
    const exe = path.join(d, 'gh.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

export function gh(exe: string, cwd: string, args: string[]): Promise<GhResult> {
  const isJs = exe.toLowerCase().endsWith('.js');
  const file = isJs ? process.execPath : exe;
  const fullArgs = isJs ? [exe, ...args] : args;
  return new Promise((resolve) => {
    execFile(
      file,
      fullArgs,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...(isJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message });
      },
    );
  });
}

/** 원격 URL에서 GitHub 저장소(owner/name)를 읽는다. 원격이 여러 개여도 gh가 엉뚱한 저장소를 고르지 않게 한다. */
export function githubRepoFromUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function findPr(exe: string, cwd: string, repo: string, branch: string): Promise<PrInfo | null> {
  const r = await gh(exe, cwd, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,url,state,isDraft,title', '--limit', '10']);
  if (r.code !== 0) throw new Error(`PR 상태를 확인하지 못했어요: ${r.stderr.trim()}`);
  const list = JSON.parse(r.stdout || '[]') as PrInfo[];
  return list.find((p) => p.state === 'OPEN') ?? list[0] ?? null;
}
