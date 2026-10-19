import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} 실패 (코드 ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
  return new Promise((resolve) => {
    execFile(
      'git',
      fullArgs,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1;
        resolve({ code, stdout: stdout ?? '', stderr: stderr || err.message });
      },
    );
  });
}

export async function gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout;
}

export interface StatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

export async function status(cwd: string): Promise<StatusEntry[]> {
  const out = await gitOk(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const entry: StatusEntry = { x: p[0], y: p[1], path: p.slice(3) };
    if (entry.x === 'R' || entry.x === 'C') entry.origPath = parts[++i];
    entries.push(entry);
  }
  return entries;
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await gitOk(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function headHash(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : '';
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0;
}
