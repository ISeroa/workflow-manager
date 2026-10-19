import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult, VerifyEvent } from '../shared/types.js';
import { git, gitOk, headHash, status } from './git.js';
import type { VerifyItem } from './workflow.js';

const TAIL_CHARS = 12_000;

/** 작업 트리 상태 지문. 검증 결과가 지금 상태에 대한 것인지 판단하는 데 쓴다. */
export async function treeFingerprint(root: string): Promise<string> {
  const h = crypto.createHash('sha1');
  h.update(await headHash(root));
  const entries = await status(root);
  h.update(JSON.stringify(entries));
  const diff = await git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff']);
  h.update(diff.stdout);
  for (const e of entries.filter((x) => x.x === '?')) {
    try {
      h.update(e.path);
      h.update(fs.readFileSync(path.join(root, e.path)));
    } catch {
      h.update('(unreadable)');
    }
  }
  return h.digest('hex');
}

export async function isClean(root: string): Promise<boolean> {
  return (await gitOk(root, ['status', '--porcelain'])).trim() === '';
}

/** 검증 명령을 순서대로 실행한다. 하나가 실패하면 나머지는 건너뛴다. */
export class VerifyRun extends EventEmitter {
  private child?: ChildProcess;
  private cancelled = false;
  private timedOut = false;
  private log?: fs.WriteStream;

  constructor(
    private readonly o: { cwd: string; items: VerifyItem[]; timeoutMs: number; logFile: string; env?: Record<string, string> },
  ) {
    super();
  }

  private emitEvent(e: VerifyEvent) {
    this.emit('event', e);
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
    this.log = fs.createWriteStream(this.o.logFile, { flags: 'a' });
    const runItems = this.o.items.filter((i) => i.kind === 'run');
    const results: CheckResult[] = [];
    this.emitEvent({ type: 'started', names: runItems.map((i) => i.name) });

    let stop = false;
    for (let i = 0; i < runItems.length; i++) {
      const item = runItems[i];
      if (stop) {
        results.push({ name: item.name, command: item.command!, outcome: 'skipped', exitCode: null, durationMs: 0, tail: '' });
        continue;
      }
      this.emitEvent({ type: 'check-start', index: i, name: item.name, command: item.command! });
      const r = await this.runOne(i, item);
      results.push(r);
      this.emitEvent({ type: 'check-done', index: i, result: r });
      if (r.outcome !== 'passed') stop = true;
    }

    const outcome = this.cancelled ? 'cancelled' : results.every((r) => r.outcome === 'passed') ? 'passed' : 'failed';
    this.log.end(`# done ${outcome}\n`);
    this.emitEvent({ type: 'done', outcome, results, logFile: this.o.logFile });
  }

  cancel() {
    this.cancelled = true;
    this.kill();
  }

  private kill() {
    const pid = this.child?.pid;
    if (pid) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  private runOne(index: number, item: VerifyItem): Promise<CheckResult> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let tail = '';
      this.timedOut = false;
      this.log?.write(`\n# [${item.name}] ${item.command}\n`);
      const child = spawn(item.command!, {
        cwd: this.o.cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...this.o.env, PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      this.child = child;
      // Windows 기본 도구(cmd, MSBuild 등)는 cp949로 출력하므로 UTF-8로 읽을 수 없으면 cp949로 바꾼다.
      let decoder = new TextDecoder('utf-8', { fatal: true });
      let fallback = false;
      const decode = (d: Buffer) => {
        if (!fallback) {
          try {
            return decoder.decode(d, { stream: true });
          } catch {
            fallback = true;
            decoder = new TextDecoder('euc-kr');
          }
        }
        return decoder.decode(d, { stream: true });
      };
      const onData = (d: Buffer) => {
        const text = decode(d);
        this.log?.write(text);
        tail = (tail + text).slice(-TAIL_CHARS);
        this.emitEvent({ type: 'output', index, text });
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => {
        this.timedOut = true;
        this.kill();
      }, this.o.timeoutMs);
      const finish = (code: number | null, error?: string) => {
        clearTimeout(timer);
        this.child = undefined;
        let outcome: CheckResult['outcome'];
        if (error) outcome = 'error';
        else if (this.cancelled) outcome = 'cancelled';
        else if (this.timedOut) outcome = 'timeout';
        else outcome = code === 0 ? 'passed' : 'failed';
        if (error) tail += `\n${error}`;
        resolve({ name: item.name, command: item.command!, outcome, exitCode: code, durationMs: Date.now() - t0, tail });
      };
      child.on('error', (e) => finish(null, `명령을 실행하지 못했어요: ${e.message}`));
      child.on('close', (code) => finish(code));
    });
  }
}
