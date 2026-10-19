import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FixAction, FixResult } from '../shared/types.js';
import { git } from './git.js';

/** 앱 안에서 설치할 수 있는 프로그램 (winget 공식 패키지) */
export const WINGET_PACKAGES: Record<string, string> = {
  git: 'Git.Git',
  gh: 'GitHub.cli',
  claude: 'Anthropic.ClaudeCode',
  node: 'OpenJS.NodeJS.LTS',
};

function decode(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function regPath(key: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Path'], { encoding: 'buffer', windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const m = decode(stdout).match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)\s*$/m);
      resolve(m ? m[1].split(';').filter(Boolean) : []);
    });
  });
}

const expand = (p: string) => p.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);

/**
 * 설치 후 앱을 다시 켜지 않아도 새 프로그램을 찾을 수 있게 레지스트리의 PATH를 다시 읽는다.
 * 기존 PATH 항목은 뒤에 유지한다.
 */
export async function refreshPath(): Promise<void> {
  const machine = await regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = await regPath('HKCU\\Environment');
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const p of [...machine, ...user].map(expand).concat(current)) {
    const k = p.toLowerCase().replace(/\\+$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(p);
  }
  process.env.PATH = merged.join(path.delimiter);
}

function runCapture(file: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // winget은 진행 표시를 \r로 덮어쓰므로 마지막 상태만 남긴다.
      const text = decode(Buffer.concat(chunks))
        .split(/\r?\n/)
        .map((l) => l.split('\r').pop()!.trim())
        .filter((l) => l && !/^[\s\-\\|/█▒]+$/.test(l));
      resolve({ code: code ?? -1, output: text.slice(-12).join('\n') });
    });
  });
}

/** 보이는 콘솔 창을 새로 열어 대화형 로그인을 진행한다. 앱은 창이 끝나기를 기다리지 않는다. */
function openConsole(title: string, lines: string[]) {
  const file = path.join(os.tmpdir(), `wf-${crypto.randomUUID()}.cmd`);
  const body = ['@echo off', 'chcp 65001 >nul', `title ${title}`, ...lines, 'echo.', 'echo 끝났으면 이 창을 닫고 앱에서 [다시 점검]을 누르세요.', 'pause >nul', `del "%~f0"`];
  // cmd는 BOM이 있으면 첫 줄을 잘못 읽으므로 BOM 없이 쓴다.
  fs.writeFileSync(file, body.join('\r\n') + '\r\n', 'utf8');
  const child = spawn('cmd.exe', ['/c', 'start', '""', `"${file}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
  child.unref();
}

/** 환경 점검 항목의 해결 동작을 실행한다. */
export async function runFix(action: FixAction, tools: { claudeExe?: string; ghExe?: string }): Promise<FixResult> {
  switch (action.kind) {
    case 'winget': {
      const id = WINGET_PACKAGES[action.tool];
      if (!id) return { ok: false, message: `알 수 없는 프로그램: ${action.tool}` };
      const r = await runCapture(
        'winget',
        ['install', '--id', id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
        15 * 60_000,
      );
      if (r.code === -1 && /ENOENT/.test(r.output)) {
        return { ok: false, message: 'winget을 찾지 못했어요. Microsoft Store의 "앱 설치 관리자"를 설치하거나 직접 설치하세요.', output: r.output };
      }
      await refreshPath();
      const already = /이미 설치|already installed|No available upgrade|사용 가능한 업그레이드가 없/i.test(r.output);
      if (r.code === 0 || already) return { ok: true, message: already ? `${id}는 이미 설치되어 있어요.` : `${id}를 설치했어요.`, output: r.output };
      return { ok: false, message: `${id} 설치에 실패했어요 (코드 ${r.code}).`, output: r.output };
    }
    case 'login': {
      if (action.tool === 'claude') {
        if (!tools.claudeExe) return { ok: false, message: 'Claude Code를 먼저 설치하세요.' };
        openConsole('Claude 로그인', ['echo 브라우저에서 Anthropic 계정으로 로그인하세요.', 'echo.', `"${tools.claudeExe}" auth login`]);
      } else {
        if (!tools.ghExe) return { ok: false, message: 'GitHub CLI를 먼저 설치하세요.' };
        openConsole('GitHub 로그인', [
          'echo 안내에 따라 Enter를 누르면 브라우저가 열려요. 화면의 코드를 입력하고 승인하세요.',
          'echo.',
          `"${tools.ghExe}" auth login --hostname github.com --git-protocol https --web`,
        ]);
      }
      return { ok: true, message: '로그인 창을 열었어요. 로그인을 마친 뒤 [다시 점검]을 누르세요.' };
    }
    case 'git-identity': {
      const name = action.name?.trim() ?? '';
      const email = action.email?.trim() ?? '';
      if (!name) return { ok: false, message: '이름(GitHub 아이디)을 입력하세요.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: '메일 주소 형식이 올바르지 않아요.' };
      const cwd = os.homedir();
      const a = await git(cwd, ['config', '--global', 'user.name', name]);
      const b = await git(cwd, ['config', '--global', 'user.email', email]);
      if (a.code !== 0 || b.code !== 0) return { ok: false, message: `Git 설정에 실패했어요: ${(a.stderr || b.stderr).trim()}` };
      return { ok: true, message: `Git 사용자를 ${name} <${email}>로 설정했어요.` };
    }
  }
}
