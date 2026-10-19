import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult, RunOutcome } from '../shared/types.js';

/** CT 하나의 로컬 실행 기록. Commit하면 지운다. */
export interface SessionRecord {
  sessionId: string;
  branch: string;
  startHead: string;
  runs: number;
  lastOutcome?: RunOutcome;
  /** 사용자가 이 CT에 추가로 허용한 범위 밖 경로 */
  extraAllow?: string[];
}

/** 검증 결과. 작업 트리 지문이 같을 때만 유효하다. */
export interface VerifyRecord {
  fingerprint: string;
  results: CheckResult[];
  at: string;
  logFile: string;
}

interface RepoData {
  sessions: Record<string, SessionRecord>;
  verify?: Record<string, VerifyRecord>;
}

interface StoreData {
  lastRepo?: string;
  repos: Record<string, RepoData>;
}

/** 개인 PC에만 남는 상태 (최근 저장소, Claude 세션). Git으로 공유하지 않는다. */
export class LocalStore {
  private data: StoreData;
  private readonly file: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, 'state.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.repos ??= {};
    } catch {
      this.data = { repos: {} };
    }
  }

  private save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get lastRepo(): string | undefined {
    return this.data.lastRepo;
  }

  set lastRepo(v: string | undefined) {
    this.data.lastRepo = v;
    this.save();
  }

  private repo(root: string) {
    const key = path.resolve(root).toLowerCase();
    return (this.data.repos[key] ??= { sessions: {} });
  }

  getSession(root: string, wp: string, ct: string): SessionRecord | undefined {
    return this.repo(root).sessions[`${wp}/${ct}`];
  }

  setSession(root: string, wp: string, ct: string, rec: SessionRecord) {
    this.repo(root).sessions[`${wp}/${ct}`] = rec;
    this.save();
  }

  deleteSession(root: string, wp: string, ct: string) {
    delete this.repo(root).sessions[`${wp}/${ct}`];
    this.save();
  }

  getVerify(root: string, wp: string, scope: string): VerifyRecord | undefined {
    return this.repo(root).verify?.[`${wp}/${scope}`];
  }

  setVerify(root: string, wp: string, scope: string, rec: VerifyRecord) {
    const r = this.repo(root);
    (r.verify ??= {})[`${wp}/${scope}`] = rec;
    this.save();
  }

  logFile(wp: string, ct: string, sessionId: string): string {
    return path.join(this.dir, 'logs', `${wp}_${ct}_${sessionId}.ndjson`);
  }

  verifyLogFile(wp: string, scope: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.dir, 'logs', `${wp}_${scope}_verify_${stamp}.log`);
  }
}
