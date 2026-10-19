import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface ProjectConfig {
  base: string;
  remote: string;
  /** team이면 Commit마다 Push를 요구한다 */
  mode: 'team' | 'solo';
  protected: string[];
  commands: Record<string, string>;
  verifyTimeoutMinutes: number;
  claude: { maxTurns: number; model?: string; timeoutMinutes: number };
}

export interface VerifyItem {
  name: string;
  /** run: 앱이 실행해 종료 코드로 판정, manual: 사람이 확인 후 체크 */
  kind: 'run' | 'manual';
  command?: string;
  text?: string;
}

export interface TaskDef {
  id: string;
  title: string;
  goal: string;
  doneWhen: string[];
  allow: string[];
  context: string[];
  verify: VerifyItem[];
  file: string;
}

export interface PackageDef {
  id: string;
  title: string;
  description: string;
  branch: string;
  base: string;
  protected: string[];
  verify: VerifyItem[];
  tasks: TaskDef[];
  dir: string;
  dirName: string;
}

export interface Workflow {
  project: ProjectConfig;
  packages: PackageDef[];
  errors: string[];
}

const WP_ID = /^WP-[A-Z0-9]{4}$/;
const CT_ID = /^CT-\d{3}$/;

type Obj = Record<string, unknown>;

class Reader {
  constructor(
    private readonly file: string,
    private readonly errors: string[],
  ) {}

  str(o: Obj, key: string, required: boolean, fallback = ''): string {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) this.errors.push(`${this.file}: '${key}' 필드가 필요해요.`);
      return fallback;
    }
    if (typeof v !== 'string' && typeof v !== 'number') {
      this.errors.push(`${this.file}: '${key}'는 문자열이어야 해요.`);
      return fallback;
    }
    return String(v).trim();
  }

  list(o: Obj, key: string, required: boolean): string[] {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) this.errors.push(`${this.file}: '${key}' 목록이 필요해요.`);
      return [];
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.errors.push(`${this.file}: '${key}'는 문자열 목록이어야 해요.`);
      return [];
    }
    if (required && v.length === 0) this.errors.push(`${this.file}: '${key}'에 항목이 하나 이상 있어야 해요.`);
    return v.map((x: string) => x.trim());
  }

  verify(o: Obj, key: string, commands: Record<string, string>): VerifyItem[] {
    const v = o[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.errors.push(`${this.file}: '${key}'는 목록이어야 해요.`);
      return [];
    }
    const items: VerifyItem[] = [];
    v.forEach((raw, i) => {
      const where = `${this.file}: ${key}[${i}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        this.errors.push(`${where}는 run, use, manual 중 하나를 가진 항목이어야 해요.`);
        return;
      }
      const it = raw as Obj;
      const kinds = ['run', 'use', 'manual'].filter((k) => typeof it[k] === 'string' && String(it[k]).trim());
      if (kinds.length !== 1) {
        this.errors.push(`${where}에는 run, use, manual 중 정확히 하나만 있어야 해요.`);
        return;
      }
      const name = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : '';
      const value = String(it[kinds[0]]).trim();
      if (kinds[0] === 'manual') {
        items.push({ name: name || value, kind: 'manual', text: value });
      } else if (kinds[0] === 'use') {
        const cmd = commands[value];
        if (!cmd) this.errors.push(`${where}: project.yaml의 commands에 '${value}'가 없어요.`);
        else items.push({ name: name || value, kind: 'run', command: cmd });
      } else {
        items.push({ name: name || value, kind: 'run', command: value });
      }
    });
    return items;
  }

  num(o: Obj, key: string, fallback: number): number {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      this.errors.push(`${this.file}: '${key}'는 양수여야 해요.`);
      return fallback;
    }
    return v;
  }
}

function readYaml(file: string, rel: string, errors: string[]): Obj | null {
  try {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      errors.push(`${rel}: 최상위가 key: value 형식이어야 해요.`);
      return null;
    }
    return doc as Obj;
  } catch (e) {
    errors.push(`${rel}: YAML을 읽지 못했어요. ${(e as Error).message}`);
    return null;
  }
}

export function loadWorkflow(root: string): Workflow {
  const errors: string[] = [];
  const wfDir = path.join(root, '.workflow');
  const projectFile = path.join(wfDir, 'project.yaml');
  const project: ProjectConfig = {
    base: 'main',
    remote: 'origin',
    mode: 'team',
    protected: [],
    commands: {},
    verifyTimeoutMinutes: 60,
    claude: { maxTurns: 40, timeoutMinutes: 30 },
  };

  if (!fs.existsSync(projectFile)) {
    errors.push('.workflow/project.yaml이 없어요.');
    return { project, packages: [], errors };
  }
  const pDoc = readYaml(projectFile, '.workflow/project.yaml', errors);
  if (pDoc) {
    const r = new Reader('.workflow/project.yaml', errors);
    project.base = r.str(pDoc, 'base', true, 'main');
    project.remote = r.str(pDoc, 'remote', false, 'origin');
    const mode = r.str(pDoc, 'mode', false, 'team');
    if (mode !== 'team' && mode !== 'solo') errors.push(`.workflow/project.yaml: mode는 team 또는 solo여야 해요.`);
    else project.mode = mode;
    project.protected = r.list(pDoc, 'protected', false);
    project.verifyTimeoutMinutes = r.num(pDoc, 'verify_timeout_minutes', 60);
    const cmds = pDoc.commands;
    if (cmds !== undefined && cmds !== null) {
      if (typeof cmds !== 'object' || Array.isArray(cmds)) errors.push(`.workflow/project.yaml: commands는 이름: 명령 형식이어야 해요.`);
      else
        for (const [k, v] of Object.entries(cmds as Obj)) {
          if (typeof v === 'string' && v.trim()) project.commands[k] = v.trim();
          else errors.push(`.workflow/project.yaml: commands.${k}는 명령 문자열이어야 해요.`);
        }
    }
    const c = (pDoc.claude ?? {}) as Obj;
    project.claude.maxTurns = r.num(c, 'max_turns', 40);
    project.claude.timeoutMinutes = r.num(c, 'timeout_minutes', 30);
    const model = r.str(c, 'model', false);
    if (model) project.claude.model = model;
  }

  const changesDir = path.join(wfDir, 'changes');
  const packages: PackageDef[] = [];
  const dirs = fs.existsSync(changesDir)
    ? fs.readdirSync(changesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];

  for (const dirName of dirs) {
    const dir = path.join(changesDir, dirName);
    const relPkg = `.workflow/changes/${dirName}/package.yaml`;
    if (!fs.existsSync(path.join(dir, 'package.yaml'))) {
      errors.push(`${relPkg}이 없어요.`);
      continue;
    }
    const doc = readYaml(path.join(dir, 'package.yaml'), relPkg, errors);
    if (!doc) continue;
    const r = new Reader(relPkg, errors);
    const id = r.str(doc, 'id', true);
    if (id && !WP_ID.test(id)) errors.push(`${relPkg}: id '${id}'는 WP-XXXX 형식이어야 해요.`);
    if (id && dirName !== id && !dirName.startsWith(`${id}-`)) errors.push(`${relPkg}: 폴더 이름이 id '${id}'로 시작해야 해요.`);

    const pkg: PackageDef = {
      id,
      title: r.str(doc, 'title', true),
      description: r.str(doc, 'description', false),
      branch: r.str(doc, 'branch', true),
      base: r.str(doc, 'base', false, project.base),
      protected: r.list(doc, 'protected', false),
      verify: r.verify(doc, 'verify', project.commands),
      tasks: [],
      dir,
      dirName,
    };

    const tasksDir = path.join(dir, 'tasks');
    const taskFiles = fs.existsSync(tasksDir)
      ? fs.readdirSync(tasksDir).filter((f) => /\.ya?ml$/i.test(f)).sort()
      : [];
    const seen = new Set<string>();
    for (const f of taskFiles) {
      const relTask = `.workflow/changes/${dirName}/tasks/${f}`;
      const tDoc = readYaml(path.join(tasksDir, f), relTask, errors);
      if (!tDoc) continue;
      const tr = new Reader(relTask, errors);
      const tid = tr.str(tDoc, 'id', true);
      if (tid && !CT_ID.test(tid)) errors.push(`${relTask}: id '${tid}'는 CT-000 형식이어야 해요.`);
      if (tid && !f.startsWith(tid)) errors.push(`${relTask}: 파일 이름이 id '${tid}'로 시작해야 해요.`);
      if (seen.has(tid)) errors.push(`${relTask}: id '${tid}'가 중복됐어요.`);
      seen.add(tid);
      pkg.tasks.push({
        id: tid,
        title: tr.str(tDoc, 'title', true),
        goal: tr.str(tDoc, 'goal', true),
        doneWhen: tr.list(tDoc, 'done_when', true),
        allow: tr.list(tDoc, 'allow', true),
        context: tr.list(tDoc, 'context', false),
        verify: tr.verify(tDoc, 'verify', project.commands),
        file: relTask,
      });
    }
    packages.push(pkg);
  }

  return { project, packages, errors };
}
