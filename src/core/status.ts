import { git, refExists } from './git.js';
import type { PackageDef, ProjectConfig } from './workflow.js';

export interface DoneInfo {
  hash: string;
  subject: string;
}

export const TRAILER_PACKAGE = 'Workflow-Package';
export const TRAILER_TASK = 'Workflow-Task';

export async function resolveBaseRef(root: string, remote: string, base: string): Promise<string | null> {
  for (const ref of [`refs/remotes/${remote}/${base}`, `refs/heads/${base}`]) {
    if (await refExists(root, ref)) return ref;
  }
  return null;
}

/** 작업 브랜치에서 base 이후의 trailer Commit을 읽어 CT별 최신 Commit을 돌려준다. */
export async function deriveDone(root: string, pkg: PackageDef, project: ProjectConfig): Promise<Map<string, DoneInfo>> {
  const done = new Map<string, DoneInfo>();
  const branchRef = `refs/heads/${pkg.branch}`;
  if (!(await refExists(root, branchRef))) return done;
  const baseRef = await resolveBaseRef(root, project.remote, pkg.base);
  const range = baseRef ? `${baseRef}..${branchRef}` : branchRef;

  const fmt =
    `%H%x1f%s%x1f%(trailers:key=${TRAILER_PACKAGE},valueonly,separator=%x2C)` +
    `%x1f%(trailers:key=${TRAILER_TASK},valueonly,separator=%x2C)%x1e`;
  const r = await git(root, ['log', `--format=${fmt}`, range]);
  if (r.code !== 0) return done;

  // git log는 최신순이므로 처음 본 Commit이 해당 CT의 최신 Commit이다.
  for (const rec of r.stdout.split('\x1e')) {
    const [hash, subject, wp, ct] = rec.replace(/^\s+/, '').split('\x1f');
    if (!hash || !ct) continue;
    if (wp.trim() !== pkg.id) continue;
    const id = ct.trim();
    if (!done.has(id)) done.set(id, { hash, subject });
  }
  return done;
}
