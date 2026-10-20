import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PACKAGE_SCOPE,
  type ChangedFile,
  type ChangesView,
  type CommitRequest,
  type PackageView,
  type PrRequest,
  type PrView,
  type RemoteView,
  type ReviseRequest,
  type RunEvent,
  type RunEventMessage,
  type Snapshot,
  type TaskView,
  type VerifyEvent,
  type VerifyEventMessage,
  type VerifyView,
} from '../shared/types.js';
import { ClaudeRun, resolveClaudeExe } from './claude.js';
import { findPr, gh, githubRepoFromUrl, resolveGh } from './gh.js';
import { currentBranch, git, gitOk, headHash, refExists, status, type StatusEntry } from './git.js';
import { ALWAYS_PROTECTED, hasBinaryExtension, looksBinary, makeClassifier, normalizePath } from './guard.js';
import { buildRevisePrompt, buildTaskPrompt, SYSTEM_RULES } from './prompt.js';
import { deriveDone, resolveBaseRef, TRAILER_PACKAGE, TRAILER_TASK } from './status.js';
import { LocalStore } from './store.js';
import { detectUnreal } from './unreal.js';
import { treeFingerprint, VerifyRun } from './verify.js';
import { loadWorkflow, type PackageDef, type TaskDef, type VerifyItem, type Workflow } from './workflow.js';

/** 사용자에게 그대로 보여줄 수 있는 오류 */
export class UserError extends Error {}

const MAX_DIFF_CHARS = 200_000;
const PROJECT_FILE = '.workflow/project.yaml';
const FAILURE_LOG_LINES = 80;

/**
 * 화면과 테스트가 공통으로 쓰는 워크플로 동작.
 * 'run-event'로 Claude 실행 과정을, 'verify-event'로 검증 과정을 내보낸다.
 */
export class WorkflowService extends EventEmitter {
  private root?: string;
  private wf?: Workflow;
  private active?: { wp: string; ct: string; run: ClaudeRun };
  private verifying?: { wp: string; scope: string; run: VerifyRun };
  private claudeExe?: string;
  private claudeError?: string;

  constructor(readonly store: LocalStore) {
    super();
  }

  get repoRoot(): string | undefined {
    return this.root;
  }

  /** 프로그램을 설치한 뒤 실행 파일 위치를 다시 찾게 한다. */
  resetTools() {
    this.claudeExe = undefined;
    this.claudeError = undefined;
  }

  private busy(): string | null {
    if (this.active) return 'Claude가 실행 중이에요.';
    if (this.verifying) return '검증이 실행 중이에요.';
    return null;
  }

  private requireIdle() {
    const b = this.busy();
    if (b) throw new UserError(b);
  }

  async openRepo(dir: string): Promise<Snapshot> {
    this.requireIdle();
    const r = await git(dir, ['rev-parse', '--show-toplevel']);
    if (/ENOENT/.test(r.stderr)) throw new UserError('Git이 설치되어 있지 않아요. 환경 점검에서 Git을 설치하세요.');
    if (r.code !== 0) throw new UserError(`Git 저장소가 아니에요: ${dir}`);
    this.root = path.resolve(r.stdout.trim());
    this.store.lastRepo = this.root;
    return this.snapshot();
  }

  private requireRoot(): string {
    if (!this.root) throw new UserError('먼저 저장소를 선택하세요.');
    return this.root;
  }

  private reload(): Workflow {
    this.wf = loadWorkflow(this.requireRoot());
    return this.wf;
  }

  private pkgOf(wp: string): PackageDef {
    const pkg = (this.wf ?? this.reload()).packages.find((p) => p.id === wp);
    if (!pkg) throw new UserError(`${wp} 정의를 찾지 못했어요.`);
    return pkg;
  }

  private find(wp: string, ct: string): { pkg: PackageDef; task: TaskDef } {
    const pkg = this.pkgOf(wp);
    const task = pkg.tasks.find((t) => t.id === ct);
    if (!task) throw new UserError(`${wp}/${ct} 작업 정의를 찾지 못했어요.`);
    return { pkg, task };
  }

  private protectedFor(pkg: PackageDef): string[] {
    return [...ALWAYS_PROTECTED, ...this.wf!.project.protected, ...pkg.protected];
  }

  private allowFor(root: string, pkg: PackageDef, task: TaskDef): string[] {
    const extra = this.store.getSession(root, pkg.id, task.id)?.extraAllow ?? [];
    return [...task.allow, ...extra];
  }

  // ───────────────────────── 상태 ─────────────────────────

  async remoteView(root: string, branch: string): Promise<RemoteView> {
    const remote = this.wf!.project.remote;
    const hasRemote = (await git(root, ['remote', 'get-url', remote])).code === 0;
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const remoteBranch = hasRemote && (await refExists(root, remoteRef));
    let ahead = 0;
    let behind = 0;
    if (await refExists(root, `refs/heads/${branch}`)) {
      if (hasRemote) {
        const a = await git(root, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--remotes=${remote}`]);
        ahead = Number(a.stdout.trim()) || 0;
      }
      if (remoteBranch) {
        const b = await git(root, ['rev-list', '--count', `refs/heads/${branch}..${remoteRef}`]);
        behind = Number(b.stdout.trim()) || 0;
      }
    }
    return { hasRemote, remote, remoteBranch, ahead, behind };
  }

  async snapshot(): Promise<Snapshot> {
    const root = this.requireRoot();
    const wf = this.reload();
    if (!this.claudeExe && !this.claudeError) {
      try {
        this.claudeExe = resolveClaudeExe();
      } catch (e) {
        this.claudeError = (e as Error).message;
      }
    }
    const [branch, head, entries] = await Promise.all([currentBranch(root), headHash(root), status(root)]);

    const packages: PackageView[] = [];
    for (const pkg of wf.packages) {
      const done = await deriveDone(root, pkg, wf.project);
      let nextAssigned = false;
      const tasks: TaskView[] = pkg.tasks.map((t) => {
        const d = done.get(t.id);
        const rec = this.store.getSession(root, pkg.id, t.id);
        let state: TaskView['state'];
        if (d) state = 'done';
        else if (this.active?.wp === pkg.id && this.active.ct === t.id) state = 'running';
        else if (rec) state = 'review';
        else if (!nextAssigned) state = 'next';
        else state = 'pending';
        if (!d) nextAssigned = true;
        return {
          id: t.id,
          title: t.title,
          goal: t.goal,
          doneWhen: t.doneWhen,
          allow: t.allow,
          context: t.context,
          verify: t.verify,
          file: t.file,
          state,
          hash: d?.hash,
          subject: d?.subject,
          session: rec
            ? { sessionId: rec.sessionId, runs: rec.runs, lastOutcome: rec.lastOutcome, extraAllow: rec.extraAllow ?? [] }
            : undefined,
        };
      });
      const doneCount = tasks.filter((t) => t.state === 'done').length;
      packages.push({
        id: pkg.id,
        title: pkg.title,
        description: pkg.description,
        branch: pkg.branch,
        base: pkg.base,
        dirName: pkg.dirName,
        verify: pkg.verify,
        tasks,
        doneCount,
        allDone: tasks.length > 0 && doneCount === tasks.length,
        isCurrentBranch: pkg.branch === branch,
        branchExists: await refExists(root, `refs/heads/${pkg.branch}`),
      });
    }

    const current = wf.packages.find((p) => p.branch === branch);
    const planDirty = entries.length > 0 ? wf.packages.find((p) => entries.every((e) => this.inPlanDir(p, e))) : undefined;

    return {
      root,
      branch,
      head,
      clean: entries.length === 0,
      dirtyFiles: entries.map((e) => e.path),
      planOnlyDirty: planDirty?.id,
      errors: wf.errors,
      mode: wf.project.mode,
      packages,
      remote: current ? await this.remoteView(root, branch) : undefined,
      running: this.active ? { wp: this.active.wp, ct: this.active.ct } : undefined,
      verifying: this.verifying ? { wp: this.verifying.wp, scope: this.verifying.scope } : undefined,
      claudeExe: this.claudeExe,
      claudeError: this.claudeError,
      ghExe: resolveGh() ?? undefined,
    };
  }

  /** WP 계획 파일 변경인지. 처음 도입할 때 함께 만드는 project.yaml도 계획 변경으로 본다. */
  private inPlanDir(pkg: PackageDef, e: StatusEntry): boolean {
    const prefix = `.workflow/changes/${pkg.dirName}/`;
    const ok = (p: string) => normalizePath(p).startsWith(prefix) || normalizePath(p) === PROJECT_FILE;
    return ok(e.path) && (!e.origPath || ok(e.origPath));
  }

  // ───────────────────────── Work Package 시작·계획 ─────────────────────────

  /** WP 브랜치로 전환한다. 없으면 최신 base에서 만들고 계획 파일을 Commit한다. */
  async startPackage(wp: string): Promise<{ message: string }> {
    const root = this.requireRoot();
    this.requireIdle();
    const wf = this.reload();
    if (wf.errors.length) throw new UserError(`.workflow 파일 오류를 먼저 고치세요. ${wf.errors[0]}`);
    const pkg = this.pkgOf(wp);
    const branch = await currentBranch(root);
    if (branch === pkg.branch) return { message: `이미 ${pkg.branch} 브랜치예요.` };

    const entries = await status(root);
    const foreign = entries.filter((e) => !this.inPlanDir(pkg, e));
    if (foreign.length) {
      throw new UserError(`이 WP 계획 파일 외의 미커밋 변경이 있어 브랜치를 바꿀 수 없어요: ${foreign.slice(0, 5).map((e) => e.path).join(', ')}`);
    }

    if (await refExists(root, `refs/heads/${pkg.branch}`)) {
      if (entries.length) throw new UserError(`${pkg.branch} 브랜치가 이미 있어요. 계획 파일 변경을 정리한 뒤 다시 시도하세요.`);
      await gitOk(root, ['switch', pkg.branch]);
      return { message: `${pkg.branch} 브랜치로 전환했어요.` };
    }

    const remote = wf.project.remote;
    const hasRemote = (await git(root, ['remote', 'get-url', remote])).code === 0;
    if (hasRemote) {
      const f = await git(root, ['fetch', remote, '--prune']);
      if (f.code !== 0) throw new UserError(`원격(${remote})에서 최신 상태를 받아오지 못했어요: ${f.stderr.trim()}`);
      if (await refExists(root, `refs/remotes/${remote}/${pkg.branch}`)) {
        const r = await git(root, ['switch', '-c', pkg.branch, '--track', `${remote}/${pkg.branch}`]);
        if (r.code !== 0) throw new UserError(`원격 브랜치를 이어받지 못했어요: ${r.stderr.trim()}`);
        return { message: `원격에 있던 ${pkg.branch} 브랜치를 이어받았어요.` };
      }
    }

    const baseRef = await resolveBaseRef(root, remote, pkg.base);
    if (!baseRef) throw new UserError(`base 브랜치 ${pkg.base}를 찾지 못했어요.`);
    // base(origin/master 등)를 upstream으로 잡지 않는다. 그냥 git push 하면 base로 올라가는 사고를 막는다.
    const sw = await git(root, ['switch', '--no-track', '-c', pkg.branch, baseRef]);
    if (sw.code !== 0) throw new UserError(`브랜치를 만들지 못했어요: ${sw.stderr.trim()}`);

    let message = `${baseRef.replace(/^refs\/(remotes|heads)\//, '')}에서 ${pkg.branch} 브랜치를 만들었어요.`;
    if ((await status(root)).length) {
      await this.commitPlanFiles(root, pkg, `wf: ${pkg.id} 계획`);
      message += ' 계획 파일을 Commit했어요.';
    }
    return { message };
  }

  /** 현재 WP의 계획 파일 변경만 Commit한다. */
  async commitPlan(wp: string): Promise<{ hash: string }> {
    const root = this.requireRoot();
    this.requireIdle();
    this.reload();
    const pkg = this.pkgOf(wp);
    if ((await currentBranch(root)) !== pkg.branch) throw new UserError(`${pkg.branch} 브랜치에서만 계획 변경을 Commit할 수 있어요.`);
    const entries = await status(root);
    if (!entries.length) throw new UserError('Commit할 계획 변경이 없어요.');
    const foreign = entries.filter((e) => !this.inPlanDir(pkg, e));
    if (foreign.length) throw new UserError(`계획 파일 외의 변경이 섞여 있어요: ${foreign.slice(0, 5).map((e) => e.path).join(', ')}`);
    return { hash: await this.commitPlanFiles(root, pkg, `wf: ${pkg.id} 계획 변경`) };
  }

  private async commitPlanFiles(root: string, pkg: PackageDef, subject: string): Promise<string> {
    const paths = [`.workflow/changes/${pkg.dirName}`];
    if ((await status(root)).some((e) => normalizePath(e.path) === PROJECT_FILE)) paths.push(PROJECT_FILE);
    await gitOk(root, ['add', '-A', '--', ...paths]);
    await this.commitWithMessage(root, `${subject}\n\n${TRAILER_PACKAGE}: ${pkg.id}\n`, paths);
    return (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
  }

  private async commitWithMessage(root: string, message: string, paths: string[]) {
    const msgFile = path.join(os.tmpdir(), `wf-commit-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(msgFile, message, 'utf8');
    try {
      const r = await git(root, ['commit', '-F', msgFile, '--', ...paths], { GIT_LITERAL_PATHSPECS: '1' });
      if (r.code !== 0) throw new UserError(`Commit하지 못했어요: ${(r.stderr || r.stdout).trim()}`);
    } finally {
      fs.rmSync(msgFile, { force: true });
    }
  }

  // ───────────────────────── Claude 실행 ─────────────────────────

  /** CT 실행. 새 Claude 세션을 만든다. */
  async start(wp: string, ct: string): Promise<void> {
    const root = this.requireRoot();
    this.requireIdle();
    const snap = await this.snapshot();
    const { pkg, task } = this.find(wp, ct);
    if (snap.claudeError) throw new UserError(snap.claudeError);
    if (snap.errors.length) throw new UserError(`.workflow 파일 오류를 먼저 고치세요. ${snap.errors[0]}`);
    const pv = snap.packages.find((p) => p.id === wp)!;
    const view = pv.tasks.find((t) => t.id === ct)!;
    if (view.state === 'done') throw new UserError(`${ct}는 이미 Commit됐어요 (${view.hash?.slice(0, 7)}).`);
    const firstUndone = pv.tasks.find((t) => t.state !== 'done');
    if (firstUndone && firstUndone.id !== ct) throw new UserError(`앞선 작업 ${firstUndone.id}를 먼저 완료하세요.`);
    if (snap.branch !== pkg.branch) throw new UserError(`현재 브랜치(${snap.branch})가 이 작업의 브랜치(${pkg.branch})와 달라요.`);
    if (!snap.clean) throw new UserError(`커밋하지 않은 변경이 있어 실행할 수 없어요: ${snap.dirtyFiles.slice(0, 5).join(', ')}`);
    const rv = snap.remote;
    if (rv?.behind) throw new UserError(`원격 ${rv.remote}/${pkg.branch}에 로컬에 없는 Commit이 ${rv.behind}개 있어요. 먼저 받아온 뒤 실행하세요.`);
    if (snap.mode === 'team' && rv?.hasRemote && rv.ahead > 0) {
      throw new UserError(`Push하지 않은 Commit이 ${rv.ahead}개 있어요. team 모드에서는 Push한 뒤 다음 작업을 실행해요.`);
    }

    const sessionId = crypto.randomUUID();
    this.store.setSession(root, wp, ct, { sessionId, branch: snap.branch, startHead: snap.head, runs: 0, extraAllow: [] });
    this.launch(root, pkg, task, sessionId, false, buildTaskPrompt(pkg, task));
  }

  /** 같은 세션으로 수정 요청 */
  async revise(wp: string, ct: string, req: ReviseRequest): Promise<void> {
    const root = this.requireRoot();
    this.requireIdle();
    this.reload();
    const { pkg, task } = this.find(wp, ct);
    const rec = this.store.getSession(root, wp, ct);
    if (!rec) throw new UserError(`${ct}의 Claude 세션이 없어요. 먼저 실행하세요.`);
    const [branch, head] = await Promise.all([currentBranch(root), headHash(root)]);
    if (branch !== rec.branch || head !== rec.startHead) {
      throw new UserError('실행 이후 브랜치나 HEAD가 바뀌어 같은 세션으로 이어갈 수 없어요.');
    }

    const parts: string[] = [];
    const allowPaths = req.allowPaths.map(normalizePath).filter(Boolean);
    if (allowPaths.length) {
      const classify = makeClassifier(task.allow, this.protectedFor(pkg));
      const prot = allowPaths.filter((p) => classify(p) === 'protected');
      if (prot.length) throw new UserError(`보호 경로는 허용할 수 없어요: ${prot.join(', ')}`);
      const extra = Array.from(new Set([...(rec.extraAllow ?? []), ...allowPaths]));
      this.store.setSession(root, wp, ct, { ...rec, extraAllow: extra });
      parts.push(`사용자가 이번 작업에 다음 경로 수정을 추가로 허용했다:\n${allowPaths.map((p) => `- ${p}`).join('\n')}\n앞서 거부된 편집이 필요했다면 이어서 진행하라.`);
    }
    if (req.text.trim()) parts.push(req.text.trim());
    if (req.attachFailureLog) {
      const v = this.store.getVerify(root, wp, ct);
      const failed = v?.results.find((r) => r.outcome !== 'passed' && r.outcome !== 'skipped');
      if (!failed) throw new UserError('첨부할 검증 실패 로그가 없어요.');
      const lines = failed.tail.trimEnd().split(/\r?\n/).slice(-FAILURE_LOG_LINES).join('\n');
      parts.push(`검증 "${failed.name}" (\`${failed.command}\`)이 실패했다 (종료 코드 ${failed.exitCode}). 마지막 출력:\n\`\`\`\n${lines}\n\`\`\``);
    }
    if (!parts.length) throw new UserError('수정 요청 내용을 입력하세요.');
    this.launch(root, pkg, task, rec.sessionId, true, buildRevisePrompt(parts.join('\n\n')));
  }

  cancel(): void {
    if (!this.active) throw new UserError('실행 중인 작업이 없어요.');
    this.active.run.cancel();
  }

  private launch(root: string, pkg: PackageDef, task: TaskDef, sessionId: string, resume: boolean, prompt: string) {
    const protect = this.protectedFor(pkg);
    const allow = this.allowFor(root, pkg, task);
    const run = new ClaudeRun({
      exe: this.claudeExe!,
      cwd: root,
      prompt,
      systemAppend: SYSTEM_RULES,
      sessionId,
      resume,
      allow,
      protect,
      maxTurns: this.wf!.project.claude.maxTurns,
      model: this.wf!.project.claude.model,
      timeoutMs: this.wf!.project.claude.timeoutMinutes * 60_000,
      logFile: this.store.logFile(pkg.id, task.id, sessionId),
      classify: makeClassifier(allow, protect),
    });
    this.active = { wp: pkg.id, ct: task.id, run };
    run.on('event', (event: RunEvent) => {
      if (event.type === 'done') {
        this.active = undefined;
        const rec = this.store.getSession(root, pkg.id, task.id);
        if (rec) this.store.setSession(root, pkg.id, task.id, { ...rec, runs: rec.runs + 1, lastOutcome: event.outcome });
      }
      const msg: RunEventMessage = { wp: pkg.id, ct: task.id, event };
      this.emit('run-event', msg);
      // Claude가 정상 종료하고 변경이 있으면 검증을 자동으로 시작한다.
      if (event.type === 'done' && event.outcome === 'success' && task.verify.some((v) => v.kind === 'run')) {
        status(root)
          .then((entries) => (entries.length ? this.verify(pkg.id, task.id) : undefined))
          .catch(() => {});
      }
    });
    run.start();
  }

  // ───────────────────────── 검증 ─────────────────────────

  private verifyItems(wp: string, scope: string): VerifyItem[] {
    if (scope === PACKAGE_SCOPE) return this.pkgOf(wp).verify;
    return this.find(wp, scope).task.verify;
  }

  async verifyView(wp: string, scope: string, fingerprint?: string): Promise<VerifyView> {
    const root = this.requireRoot();
    const items = this.verifyItems(wp, scope);
    const rec = this.store.getVerify(root, wp, scope);
    const fp = fingerprint ?? (await treeFingerprint(root));
    const fresh = !!rec && rec.fingerprint === fp;
    const runCount = items.filter((i) => i.kind === 'run').length;
    const passed = runCount === 0 || (fresh && rec!.results.length === runCount && rec!.results.every((r) => r.outcome === 'passed'));
    return { items, results: rec?.results, fresh, passed, at: rec?.at, logFile: rec?.logFile };
  }

  /** 검증 명령 실행. scope는 CT id 또는 PACKAGE_SCOPE(통합 검증). */
  async verify(wp: string, scope: string): Promise<void> {
    const root = this.requireRoot();
    this.requireIdle();
    this.reload();
    const pkg = this.pkgOf(wp);
    if ((await currentBranch(root)) !== pkg.branch) throw new UserError(`${pkg.branch} 브랜치에서만 검증할 수 있어요.`);
    if (scope === PACKAGE_SCOPE) {
      const done = await deriveDone(root, pkg, this.wf!.project);
      const left = pkg.tasks.filter((t) => !done.has(t.id));
      if (left.length) throw new UserError(`아직 Commit되지 않은 작업이 있어요: ${left.map((t) => t.id).join(', ')}`);
      if ((await status(root)).length) throw new UserError('미커밋 변경이 있어 통합 검증을 할 수 없어요.');
    } else if (!this.store.getSession(root, wp, scope)) {
      throw new UserError(`${scope}는 검토 중인 작업이 아니에요.`);
    }
    const items = this.verifyItems(wp, scope).filter((i) => i.kind === 'run');
    if (!items.length) throw new UserError('실행할 검증 명령이 없어요.');

    const fingerprint = await treeFingerprint(root);
    const logFile = this.store.verifyLogFile(wp, scope);
    // Unreal 프로젝트면 PC마다 다른 엔진 경로를 UE_ROOT로 넘겨 검증 명령이 절대 경로에 의존하지 않게 한다.
    const ue = detectUnreal(root);
    const env = ue.engineRoot && !process.env.UE_ROOT ? { UE_ROOT: ue.engineRoot } : undefined;
    const run = new VerifyRun({ cwd: root, items, timeoutMs: this.wf!.project.verifyTimeoutMinutes * 60_000, logFile, env });
    this.verifying = { wp, scope, run };
    run.on('event', async (event: VerifyEvent) => {
      if (event.type === 'done') {
        // 검증 도중 작업 트리가 바뀌었으면 결과를 저장하지 않는다.
        const after = await treeFingerprint(root).catch(() => '');
        if (event.outcome !== 'cancelled' && after === fingerprint) {
          this.store.setVerify(root, wp, scope, { fingerprint, results: event.results, at: new Date().toISOString(), logFile });
        }
        this.verifying = undefined;
      }
      const msg: VerifyEventMessage = { wp, scope, event };
      this.emit('verify-event', msg);
    });
    run.start();
  }

  cancelVerify(): void {
    if (!this.verifying) throw new UserError('실행 중인 검증이 없어요.');
    this.verifying.run.cancel();
  }

  // ───────────────────────── 변경 검토·Commit ─────────────────────────

  /** 현재 작업 트리 변경과 Commit 차단 사유 */
  async changes(wp: string, ct: string): Promise<ChangesView> {
    const root = this.requireRoot();
    this.reload();
    const { pkg, task } = this.find(wp, ct);
    const extra = this.store.getSession(root, wp, ct)?.extraAllow ?? [];
    const classify = makeClassifier(task.allow, this.protectedFor(pkg));
    const classifyExtra = makeClassifier([...task.allow, ...extra], this.protectedFor(pkg));
    const entries = await status(root);
    const files: ChangedFile[] = [];
    for (const e of entries) files.push(await this.describeChange(root, e, classify, classifyExtra));

    const blockers: string[] = [];
    const b = this.busy();
    if (b) blockers.push(b);
    const rec = this.store.getSession(root, wp, ct);
    if (!rec) blockers.push('이 작업의 Claude 실행 기록이 없어요.');
    else {
      const [branch, head] = await Promise.all([currentBranch(root), headHash(root)]);
      if (branch !== rec.branch) blockers.push(`브랜치가 실행 중에 바뀌었어요 (${rec.branch} → ${branch}).`);
      if (head !== rec.startHead) blockers.push(`HEAD가 실행 중에 바뀌었어요 (${rec.startHead.slice(0, 7)} → ${head.slice(0, 7)}).`);
    }
    if (files.length === 0) blockers.push('Commit할 변경이 없어요.');
    // Claude는 보호 경로를 편집할 수 없으므로(권한 거부, 셸 없음) 여기 남은 보호 경로 변경은 사람이 한 것이다.
    // 계획 파일(.workflow)만 따로 Commit하도록 막고, 나머지는 사람이 직접 확인하면 포함할 수 있다.
    const plan = files.filter((f) => f.path.startsWith('.workflow/') || f.origPath?.startsWith('.workflow/'));
    if (plan.length) blockers.push(`계획 파일 변경이 섞여 있어요: ${plan.map((f) => f.path).join(', ')}. 작업 Commit과 분리해 주세요.`);
    const protectedFiles = files.filter((f) => f.category === 'protected' && !plan.includes(f)).map((f) => f.path);

    const verify = await this.verifyView(wp, ct);
    if (!verify.passed) {
      if (!verify.results) blockers.push('검증을 아직 실행하지 않았어요.');
      else if (!verify.fresh) blockers.push('검증 이후 변경이 생겼어요. 검증을 다시 실행하세요.');
      else blockers.push('검증을 통과하지 못했어요.');
    }

    return {
      files,
      blockers,
      needsOutOfScopeApproval: files.some((f) => f.category === 'outOfScope'),
      protectedFiles,
      needsBinaryAck: files.some((f) => f.binary),
      verify,
      commitSubject: task.title,
      commitTrailers: [`${TRAILER_PACKAGE}: ${pkg.id}`, `${TRAILER_TASK}: ${task.id}`],
    };
  }

  private async describeChange(
    root: string,
    e: StatusEntry,
    classify: ReturnType<typeof makeClassifier>,
    classifyExtra: ReturnType<typeof makeClassifier>,
  ): Promise<ChangedFile> {
    const p = normalizePath(e.path);
    let st: ChangedFile['status'];
    if (e.x === '?' || e.x === 'A') st = 'added';
    else if (e.x === 'D' || e.y === 'D') st = 'deleted';
    else if (e.x === 'R') st = 'renamed';
    else st = 'modified';

    // 이름 변경은 원래 경로도 범위 검사를 한다.
    const worst = (fn: ReturnType<typeof makeClassifier>) => {
      let c = fn(p);
      if (e.origPath) {
        const o = fn(e.origPath);
        if (o === 'protected' || (o === 'outOfScope' && c === 'allowed')) c = o;
      }
      return c;
    };
    const base = worst(classify);
    const withExtra = worst(classifyExtra);
    const extraAllowed = base === 'outOfScope' && withExtra === 'allowed';
    const category = extraAllowed ? 'allowed' : base;

    let binary = hasBinaryExtension(p);
    let diff = '';
    if (e.x === '?') {
      try {
        const buf = fs.readFileSync(path.join(root, p));
        if (!binary && looksBinary(buf)) binary = true;
        if (!binary) {
          const lines = buf.toString('utf8').split(/\r?\n/);
          if (lines[lines.length - 1] === '') lines.pop();
          diff = [`--- /dev/null`, `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
        }
      } catch (err) {
        diff = `(파일을 읽지 못했어요: ${(err as Error).message})`;
      }
    } else if (!binary) {
      const args = ['diff', 'HEAD', '--no-ext-diff', '--find-renames', '--'];
      if (e.origPath) args.push(e.origPath);
      args.push(p);
      diff = (await git(root, args)).stdout;
      if (/^Binary files /m.test(diff)) binary = true;
    }
    if (binary) diff = '';
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n… (너무 길어 생략)';
    return { path: p, origPath: e.origPath ? normalizePath(e.origPath) : undefined, status: st, category, extraAllowed, binary, diff };
  }

  /** 승인 후 trailer Commit. 검사를 다시 수행하고 통과해야 Commit한다. Push는 하지 않는다. */
  async commit(wp: string, ct: string, req: CommitRequest): Promise<{ hash: string }> {
    const root = this.requireRoot();
    const view = await this.changes(wp, ct);
    if (view.blockers.length) throw new UserError(view.blockers.join(' '));
    if (view.needsOutOfScopeApproval && !req.approveOutOfScope) throw new UserError('범위 밖 변경을 승인해야 Commit할 수 있어요.');
    if (view.protectedFiles.length && !req.approveProtected) {
      throw new UserError(`보호 경로 변경(${view.protectedFiles.join(', ')})을 직접 작업했다고 확인해야 Commit할 수 있어요.`);
    }
    if (view.needsBinaryAck && !req.ackBinary) throw new UserError('바이너리 파일을 직접 확인했다고 체크해야 Commit할 수 있어요.');
    const manual = view.verify.items.filter((i) => i.kind === 'manual').map((i) => i.name);
    const unchecked = manual.filter((m) => !req.manualChecked.includes(m));
    if (unchecked.length) throw new UserError(`사람이 확인할 항목을 체크하세요: ${unchecked.join(', ')}`);
    const subject = req.subject.replace(/\s+/g, ' ').trim() || view.commitSubject;

    const paths = new Set<string>();
    for (const f of view.files) {
      paths.add(f.path);
      if (f.origPath) paths.add(f.origPath);
    }
    await gitOk(root, ['add', '-A', '--', ...paths], { GIT_LITERAL_PATHSPECS: '1' });
    await this.commitWithMessage(root, `${ct}: ${subject}\n\n${view.commitTrailers.join('\n')}\n`, [...paths]);

    const hash = (await gitOk(root, ['rev-parse', 'HEAD'])).trim();
    const check = (await gitOk(root, ['log', '-1', `--format=%(trailers:key=${TRAILER_TASK},valueonly)`])).trim();
    if (check !== ct) throw new UserError(`Commit은 됐지만 trailer를 확인하지 못했어요 (${hash.slice(0, 7)}). git log를 확인하세요.`);
    this.store.deleteSession(root, wp, ct);
    return { hash };
  }

  // ───────────────────────── 원격·PR ─────────────────────────

  async fetch(): Promise<void> {
    const root = this.requireRoot();
    this.reload();
    const remote = this.wf!.project.remote;
    if ((await git(root, ['remote', 'get-url', remote])).code !== 0) throw new UserError(`원격 ${remote}이 설정되지 않았어요.`);
    const r = await git(root, ['fetch', remote, '--prune']);
    if (r.code !== 0) throw new UserError(`원격 상태를 받아오지 못했어요: ${r.stderr.trim()}`);
  }

  /** 작업 브랜치 Push. 실패해도 Commit은 그대로 두고 다시 시도할 수 있다. */
  async push(wp: string): Promise<{ output: string }> {
    const root = this.requireRoot();
    this.requireIdle();
    this.reload();
    const pkg = this.pkgOf(wp);
    if ((await currentBranch(root)) !== pkg.branch) throw new UserError(`${pkg.branch} 브랜치에서만 Push할 수 있어요.`);
    const remote = this.wf!.project.remote;
    if ((await git(root, ['remote', 'get-url', remote])).code !== 0) throw new UserError(`원격 ${remote}이 설정되지 않았어요.`);
    const r = await git(root, ['push', '-u', remote, pkg.branch]);
    if (r.code !== 0) {
      const err = r.stderr.trim();
      const hint = /rejected|non-fast-forward|fetch first/i.test(err) ? ' 원격에 로컬에 없는 Commit이 있어요. 받아와서 합친 뒤 다시 Push하세요.' : '';
      throw new UserError(`Push하지 못했어요. Commit은 로컬에 그대로 있어요.${hint}\n${err}`);
    }
    return { output: (r.stderr + r.stdout).trim() };
  }

  async prView(wp: string): Promise<PrView> {
    const root = this.requireRoot();
    this.reload();
    const pkg = this.pkgOf(wp);
    const blockers: string[] = [];
    const branch = await currentBranch(root);
    if (branch !== pkg.branch) blockers.push(`${pkg.branch} 브랜치가 아니에요.`);
    const done = await deriveDone(root, pkg, this.wf!.project);
    const left = pkg.tasks.filter((t) => !done.has(t.id));
    if (left.length) blockers.push(`완료되지 않은 작업: ${left.map((t) => t.id).join(', ')}`);
    const entries = await status(root);
    if (entries.length) blockers.push('미커밋 변경이 있어요.');
    const verify = await this.verifyView(wp, PACKAGE_SCOPE);
    if (!verify.passed) blockers.push(verify.results && !verify.fresh ? '통합 검증 이후 Commit이 바뀌었어요. 다시 실행하세요.' : '통합 검증을 통과해야 해요.');
    const rv = await this.remoteView(root, pkg.branch);
    if (!rv.hasRemote) blockers.push(`원격 ${rv.remote}이 설정되지 않았어요.`);
    else if (!rv.remoteBranch || rv.ahead > 0) blockers.push('Push하지 않은 Commit이 있어요.');
    else if (rv.behind > 0) blockers.push('원격에 로컬에 없는 Commit이 있어요.');

    let existing = null;
    let ghError: string | undefined;
    const exe = resolveGh();
    // WF_GH_REPO는 GitHub가 아닌 원격을 쓰는 테스트용 지정이다.
    const repo = rv.hasRemote ? process.env.WF_GH_REPO ?? githubRepoFromUrl((await git(root, ['remote', 'get-url', rv.remote])).stdout) : null;
    if (!exe) ghError = 'GitHub CLI(gh)를 찾지 못했어요. 설치 후 gh auth login을 실행하세요.';
    else if (rv.hasRemote && !repo) ghError = `원격 ${rv.remote}이 GitHub 저장소가 아니에요.`;
    else if (repo) {
      try {
        existing = await findPr(exe, root, repo, pkg.branch);
      } catch (e) {
        ghError = (e as Error).message;
      }
    }
    if (ghError) blockers.push(ghError);
    if (existing?.state === 'OPEN') blockers.push(`이미 열린 PR #${existing.number}이 있어요.`);

    const lines: string[] = [];
    if (pkg.description) lines.push(pkg.description, '');
    lines.push('## 포함 작업');
    for (const t of pkg.tasks) {
      const d = done.get(t.id);
      lines.push(`- ${t.id} ${t.title}${d ? ` (\`${d.hash.slice(0, 7)}\`)` : ''}`);
    }
    if (pkg.verify.length) {
      lines.push('', '## 검증');
      for (const item of pkg.verify) {
        if (item.kind === 'manual') lines.push(`- [x] ${item.name} (사람 확인)`);
        else {
          const r = verify.results?.find((x) => x.name === item.name);
          lines.push(`- ${r?.outcome === 'passed' && verify.fresh ? '[x]' : '[ ]'} ${item.name}`);
        }
      }
    }
    lines.push('', `${TRAILER_PACKAGE}: ${pkg.id}`);

    return {
      ready: blockers.length === 0,
      blockers,
      verify,
      existing,
      ghError,
      repo: repo ?? undefined,
      title: pkg.title,
      body: lines.join('\n'),
      base: pkg.base,
      branch: pkg.branch,
    };
  }

  async createPr(wp: string, req: PrRequest): Promise<{ url: string }> {
    const root = this.requireRoot();
    this.requireIdle();
    const view = await this.prView(wp);
    if (!view.ready) throw new UserError(view.blockers.join(' '));
    const manual = view.verify.items.filter((i) => i.kind === 'manual').map((i) => i.name);
    const unchecked = manual.filter((m) => !req.manualChecked.includes(m));
    if (unchecked.length) throw new UserError(`사람이 확인할 항목을 체크하세요: ${unchecked.join(', ')}`);
    if (!req.title.trim()) throw new UserError('PR 제목을 입력하세요.');

    const bodyFile = path.join(os.tmpdir(), `wf-pr-${crypto.randomUUID()}.md`);
    fs.writeFileSync(bodyFile, req.body, 'utf8');
    try {
      const args = ['pr', 'create', '--repo', view.repo!, '--base', view.base, '--head', view.branch, '--title', req.title.trim(), '--body-file', bodyFile];
      if (req.draft) args.push('--draft');
      const r = await gh(resolveGh()!, root, args);
      if (r.code !== 0) throw new UserError(`PR을 만들지 못했어요: ${r.stderr.trim() || r.stdout.trim()}`);
      const url = r.stdout.trim().split(/\r?\n/).pop() ?? '';
      return { url };
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }
}
