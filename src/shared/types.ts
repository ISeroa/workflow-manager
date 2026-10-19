// 메인 프로세스와 화면이 함께 쓰는 타입과 상수.

export type PathCategory = 'allowed' | 'outOfScope' | 'protected';

export type TaskState = 'done' | 'next' | 'pending' | 'running' | 'review';

export interface VerifyItemView {
  name: string;
  kind: 'run' | 'manual';
  command?: string;
  text?: string;
}

export interface CheckResult {
  name: string;
  command: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'cancelled' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  tail: string;
}

/** 검증 대상: CT id 또는 Work Package 통합 검증 */
export const PACKAGE_SCOPE = 'PR';

export interface VerifyView {
  items: VerifyItemView[];
  results?: CheckResult[];
  /** 저장된 결과가 지금 작업 트리 상태에 대한 것인지 */
  fresh: boolean;
  /** 실행 항목이 모두 최신 상태로 통과했는지 (실행 항목이 없으면 true) */
  passed: boolean;
  at?: string;
  logFile?: string;
}

export type VerifyEvent =
  | { type: 'started'; names: string[] }
  | { type: 'check-start'; index: number; name: string; command: string }
  | { type: 'output'; index: number; text: string }
  | { type: 'check-done'; index: number; result: CheckResult }
  | { type: 'done'; outcome: 'passed' | 'failed' | 'cancelled'; results: CheckResult[]; logFile: string };

export interface VerifyEventMessage {
  wp: string;
  scope: string;
  event: VerifyEvent;
}

export interface TaskView {
  id: string;
  title: string;
  goal: string;
  doneWhen: string[];
  allow: string[];
  context: string[];
  verify: VerifyItemView[];
  file: string;
  state: TaskState;
  hash?: string;
  subject?: string;
  session?: { sessionId: string; runs: number; lastOutcome?: RunOutcome; extraAllow: string[] };
}

export interface RemoteView {
  hasRemote: boolean;
  remote: string;
  remoteBranch: boolean;
  /** 원격에 없는 로컬 Commit 수 */
  ahead: number;
  /** 로컬에 없는 원격 Commit 수 */
  behind: number;
}

export interface PrInfo {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  title: string;
}

export interface PackageView {
  id: string;
  title: string;
  description: string;
  branch: string;
  base: string;
  dirName: string;
  verify: VerifyItemView[];
  tasks: TaskView[];
  doneCount: number;
  allDone: boolean;
  isCurrentBranch: boolean;
  branchExists: boolean;
}

export interface Snapshot {
  root: string;
  branch: string;
  head: string;
  clean: boolean;
  dirtyFiles: string[];
  /** 미커밋 변경이 모두 현재 WP의 계획 파일이면 그 WP id */
  planOnlyDirty?: string;
  errors: string[];
  mode: 'team' | 'solo';
  packages: PackageView[];
  remote?: RemoteView;
  running?: { wp: string; ct: string };
  verifying?: { wp: string; scope: string };
  claudeExe?: string;
  claudeError?: string;
  ghExe?: string;
}

export type RunOutcome = 'success' | 'error' | 'cancelled' | 'timeout';

export interface Denial {
  tool: string;
  path?: string;
  detail: string;
  /** 'protected' | 'outOfScope' 는 경로 편집 거부, 'unsupported' 는 앱이 허용하지 않는 도구 */
  kind: PathCategory | 'unsupported';
}

export type RunEvent =
  | { type: 'started'; sessionId: string; resume: boolean; prompt: string }
  | { type: 'init'; model?: string }
  | { type: 'tool'; name: string; target: string }
  | { type: 'tool-error'; name: string; message: string }
  | { type: 'text'; text: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'done';
      outcome: RunOutcome;
      exitCode: number | null;
      message?: string;
      resultText?: string;
      numTurns?: number;
      costUsd?: number;
      denials: Denial[];
      logFile: string;
    };

export interface RunEventMessage {
  wp: string;
  ct: string;
  event: RunEvent;
}

export interface ChangedFile {
  path: string;
  origPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  category: PathCategory;
  /** 범위 밖이었지만 사용자가 이 CT에 허용한 경로 */
  extraAllowed: boolean;
  binary: boolean;
  diff: string;
}

export interface ChangesView {
  files: ChangedFile[];
  blockers: string[];
  needsOutOfScopeApproval: boolean;
  needsBinaryAck: boolean;
  verify: VerifyView;
  commitSubject: string;
  commitTrailers: string[];
}

export interface CommitRequest {
  subject: string;
  approveOutOfScope: boolean;
  ackBinary: boolean;
  /** 사람이 확인한 manual 검증 항목 이름 */
  manualChecked: string[];
}

export interface ReviseRequest {
  text: string;
  attachFailureLog: boolean;
  /** 이번 CT에 추가로 허용할 범위 밖 경로 */
  allowPaths: string[];
}

export interface PrView {
  ready: boolean;
  blockers: string[];
  verify: VerifyView;
  existing: PrInfo | null;
  ghError?: string;
  /** PR을 만들 GitHub 저장소 (owner/name) */
  repo?: string;
  title: string;
  body: string;
  base: string;
  branch: string;
}

export interface PrRequest {
  title: string;
  body: string;
  draft: boolean;
  manualChecked: string[];
}

/** 환경 점검 항목을 앱 안에서 해결하는 동작 */
export type FixAction =
  | { kind: 'winget'; tool: 'git' | 'gh' | 'claude' | 'node' }
  | { kind: 'login'; tool: 'claude' | 'gh' }
  | { kind: 'git-identity'; name?: string; email?: string };

export interface FixResult {
  ok: boolean;
  message: string;
  output?: string;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
  /** 버튼으로 바로 해결할 수 있으면 그 동작과 버튼 이름 */
  action?: { label: string; action: FixAction };
  /** 버튼 대신 열 수 있는 안내 링크 */
  link?: { label: string; url: string };
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface WfApi {
  openRepo(path?: string): Promise<IpcResult<Snapshot | null>>;
  snapshot(): Promise<IpcResult<Snapshot | null>>;
  startPackage(wp: string): Promise<IpcResult<{ message: string }>>;
  commitPlan(wp: string): Promise<IpcResult<{ hash: string }>>;
  start(wp: string, ct: string): Promise<IpcResult<null>>;
  revise(wp: string, ct: string, req: ReviseRequest): Promise<IpcResult<null>>;
  cancel(): Promise<IpcResult<null>>;
  changes(wp: string, ct: string): Promise<IpcResult<ChangesView>>;
  verify(wp: string, scope: string): Promise<IpcResult<null>>;
  cancelVerify(): Promise<IpcResult<null>>;
  commit(wp: string, ct: string, req: CommitRequest): Promise<IpcResult<{ hash: string }>>;
  fetch(): Promise<IpcResult<null>>;
  push(wp: string): Promise<IpcResult<{ output: string }>>;
  prView(wp: string): Promise<IpcResult<PrView>>;
  createPr(wp: string, req: PrRequest): Promise<IpcResult<{ url: string }>>;
  openExternal(url: string): Promise<IpcResult<null>>;
  doctor(): Promise<IpcResult<DoctorCheck[]>>;
  fix(action: FixAction): Promise<IpcResult<FixResult>>;
  onRunEvent(cb: (msg: RunEventMessage) => void): () => void;
  onVerifyEvent(cb: (msg: VerifyEventMessage) => void): () => void;
}
