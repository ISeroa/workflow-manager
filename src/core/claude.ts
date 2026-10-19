import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Denial, PathCategory, RunEvent, RunOutcome } from '../shared/types.js';
import { normalizePath } from './guard.js';

/** Claude가 쓸 수 있는 내장 도구. 셸·웹 도구는 아예 노출하지 않는다. */
export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];

/** npm의 claude.cmd shim 대신 실제 실행 파일을 찾는다 (shell 없이 spawn하기 위해). */
export function resolveClaudeExe(): string {
  const override = process.env.WF_CLAUDE_EXE;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`WF_CLAUDE_EXE 경로가 없어요: ${override}`);
    return override;
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // 공식 설치 프로그램(native)은 %USERPROFILE%\.local\bin에 설치한다. PATH에 없을 때를 대비한다.
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, '.local', 'bin'));
  for (const d of dirs) {
    const exe = path.join(d, 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  for (const d of dirs) {
    const cmd = path.join(d, 'claude.cmd');
    if (!fs.existsSync(cmd)) continue;
    const m = fs.readFileSync(cmd, 'utf8').match(/"%dp0%\\([^"]+\.exe)"/i);
    if (m) {
      const exe = path.join(d, m[1]);
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('claude 실행 파일을 찾지 못했어요. Claude Code를 설치하거나 WF_CLAUDE_EXE 환경 변수를 설정하세요.');
}

export interface ClaudeRunOptions {
  exe: string;
  cwd: string;
  prompt: string;
  systemAppend: string;
  sessionId: string;
  resume: boolean;
  allow: string[];
  protect: string[];
  maxTurns: number;
  model?: string;
  timeoutMs: number;
  logFile: string;
  classify: (relPath: string) => PathCategory;
}

export function buildClaudeArgs(o: Omit<ClaudeRunOptions, 'exe' | 'cwd' | 'prompt' | 'timeoutMs' | 'logFile' | 'classify'>): string[] {
  const args = [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--tools', CLAUDE_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(o.maxTurns),
    '--append-system-prompt', o.systemAppend,
    '--allowedTools', 'Read', 'Glob', 'Grep', ...o.allow.map((g) => `Edit(${g})`),
    '--disallowedTools', ...o.protect.map((g) => `Edit(${g})`),
  ];
  if (o.model) args.push('--model', o.model);
  args.push(o.resume ? '--resume' : '--session-id', o.sessionId);
  return args;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  }
  return '';
}

/** Claude 실행 한 번. 'event' 이벤트로 RunEvent를 내보내고, 마지막에 'done' 이벤트를 한 번 보낸다. */
export class ClaudeRun extends EventEmitter {
  private child?: ChildProcess;
  private cancelled = false;
  private timedOut = false;
  private finished = false;
  private stderrTail = '';
  private toolNames = new Map<string, string>();
  private result?: { subtype: string; isError: boolean; text?: string; numTurns?: number; costUsd?: number; denials: unknown[] };
  private timer?: NodeJS.Timeout;
  private log?: fs.WriteStream;

  constructor(private readonly o: ClaudeRunOptions) {
    super();
  }

  private rel(p: unknown): string {
    if (typeof p !== 'string' || !p) return '';
    const r = path.isAbsolute(p) ? path.relative(this.o.cwd, p) : p;
    return normalizePath(r);
  }

  private describe(input: Record<string, unknown> | undefined): string {
    if (!input) return '';
    if (input.file_path) return this.rel(input.file_path);
    if (input.pattern) return String(input.pattern) + (input.path ? ` @ ${this.rel(input.path)}` : '');
    if (input.command) return String(input.command);
    if (input.path) return this.rel(input.path);
    return JSON.stringify(input).slice(0, 120);
  }

  private emitEvent(e: RunEvent) {
    this.emit('event', e);
  }

  start() {
    fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
    this.log = fs.createWriteStream(this.o.logFile, { flags: 'a' });
    const args = buildClaudeArgs(this.o);
    this.log.write(`# ${new Date().toISOString()} ${this.o.resume ? 'resume' : 'start'} ${this.o.sessionId}\n`);

    this.emitEvent({ type: 'started', sessionId: this.o.sessionId, resume: this.o.resume, prompt: this.o.prompt });
    try {
      this.child = spawn(this.o.exe, args, { cwd: this.o.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.finish(null, `Claude를 실행하지 못했어요: ${(e as Error).message}`);
      return;
    }
    this.child.on('error', (e) => this.finish(null, `Claude를 실행하지 못했어요: ${e.message}`));
    this.child.stdin?.on('error', () => {});
    this.child.stdin?.end(this.o.prompt, 'utf8');

    const rl = readline.createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.log?.write(`[stderr] ${d}`);
    });
    // stdout이 끝까지 읽힌 뒤 close가 오므로 result 이벤트를 놓치지 않는다.
    this.child.on('close', (code) => this.finish(code));

    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.kill();
    }, this.o.timeoutMs);
  }

  cancel() {
    this.cancelled = true;
    this.kill();
  }

  private kill() {
    const pid = this.child?.pid;
    if (!pid || this.finished) return;
    // 자식 프로세스까지 종료한다.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  private onLine(line: string) {
    this.log?.write(line + '\n');
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      if (line.trim()) this.emitEvent({ type: 'stderr', text: line });
      return;
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.emitEvent({ type: 'init', model: m.model });
        break;
      case 'assistant':
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_use') {
            this.toolNames.set(c.id, c.name);
            this.emitEvent({ type: 'tool', name: c.name, target: this.describe(c.input) });
          } else if (c.type === 'text' && c.text?.trim()) {
            this.emitEvent({ type: 'text', text: c.text });
          }
        }
        break;
      case 'user':
        for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (c.type === 'tool_result' && c.is_error) {
            this.emitEvent({
              type: 'tool-error',
              name: this.toolNames.get(c.tool_use_id) ?? '도구',
              message: textOf(c.content).replace(/<\/?tool_use_error>/g, '').slice(0, 400),
            });
          }
        }
        break;
      case 'result':
        this.result = {
          subtype: String(m.subtype ?? ''),
          isError: Boolean(m.is_error),
          text: typeof m.result === 'string' ? m.result : undefined,
          numTurns: m.num_turns,
          costUsd: m.total_cost_usd,
          denials: Array.isArray(m.permission_denials) ? m.permission_denials : [],
        };
        break;
    }
  }

  private denials(): Denial[] {
    return (this.result?.denials ?? []).map((d) => {
      const x = d as { tool_name?: string; tool_input?: Record<string, unknown> };
      const tool = x.tool_name ?? '알 수 없음';
      const filePath = x.tool_input?.file_path ?? x.tool_input?.notebook_path;
      if (typeof filePath === 'string' && ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
        const p = this.rel(filePath);
        return { tool, path: p, detail: p, kind: this.o.classify(p) };
      }
      return { tool, detail: this.describe(x.tool_input), kind: 'unsupported' as const };
    });
  }

  private finish(code: number | null, spawnError?: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);

    let outcome: RunOutcome;
    let message: string | undefined;
    if (spawnError) {
      outcome = 'error';
      message = spawnError;
    } else if (this.cancelled) {
      outcome = 'cancelled';
      message = '사용자가 실행을 중단했어요.';
    } else if (this.timedOut) {
      outcome = 'timeout';
      message = `제한 시간(${Math.round(this.o.timeoutMs / 60000)}분)을 넘겨 실행을 중단했어요.`;
    } else if (code === 0 && this.result && !this.result.isError) {
      outcome = 'success';
    } else {
      outcome = 'error';
      if (this.result?.subtype === 'error_max_turns') message = `최대 턴 수(${this.o.maxTurns})를 넘겨 Claude가 멈췄어요.`;
      else if (this.result) message = `Claude가 오류로 끝났어요 (${this.result.subtype}). ${this.result.text ?? ''}`.trim();
      else message = `Claude가 결과 없이 종료됐어요 (종료 코드 ${code}). ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}`.trim();
    }

    this.log?.end(`# done ${outcome} code=${code}\n`);
    this.emitEvent({
      type: 'done',
      outcome,
      exitCode: code,
      message,
      resultText: this.result?.text,
      numTurns: this.result?.numTurns,
      costUsd: this.result?.costUsd,
      denials: this.denials(),
      logFile: this.o.logFile,
    });
  }
}
