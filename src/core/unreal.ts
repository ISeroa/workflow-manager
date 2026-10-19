import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface UnrealInfo {
  /** 저장소 루트의 .uproject (없으면 Unreal 프로젝트가 아님) */
  uproject?: string;
  association?: string;
  /** 엔진 설치 폴더 (Engine 폴더의 상위) */
  engineRoot?: string;
  source?: string;
  error?: string;
}

function readAssociation(uproject: string): string | undefined {
  try {
    const doc = JSON.parse(fs.readFileSync(uproject, 'utf8'));
    return typeof doc.EngineAssociation === 'string' ? doc.EngineAssociation : undefined;
  } catch {
    return undefined;
  }
}

function fromLauncher(association: string): string | undefined {
  const file = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')).InstallationList as { AppName?: string; InstallLocation?: string }[];
    return list.find((x) => x.AppName === `UE_${association}`)?.InstallLocation;
  } catch {
    return undefined;
  }
}

function regValue(key: string, name: string): string | undefined {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_SZ\s+(.+)\s*$/m);
    return m?.[1].trim();
  } catch {
    return undefined;
  }
}

const hasBuildBat = (root: string) => fs.existsSync(path.join(root, 'Engine', 'Build', 'BatchFiles', 'Build.bat'));

/**
 * 저장소의 .uproject가 쓰는 엔진 설치 경로를 찾는다.
 * 순서: UE_ROOT 환경 변수 → Epic Launcher 설치 목록 → 레지스트리(설치판, 소스 빌드)
 */
export function detectUnreal(repoRoot: string): UnrealInfo {
  let uprojects: string[] = [];
  try {
    uprojects = fs.readdirSync(repoRoot).filter((f) => f.toLowerCase().endsWith('.uproject'));
  } catch {
    return {};
  }
  if (!uprojects.length) return {};
  const uproject = path.join(repoRoot, uprojects[0]);
  const association = readAssociation(uproject);
  const info: UnrealInfo = { uproject, association };

  const candidates: [string | undefined, string][] = [[process.env.UE_ROOT, 'UE_ROOT 환경 변수']];
  if (association) {
    candidates.push([fromLauncher(association), 'Epic Launcher 설치 목록']);
    candidates.push([regValue(`HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association}`, 'InstalledDirectory'), '레지스트리(설치판)']);
    candidates.push([regValue('HKCU\\Software\\Epic Games\\Unreal Engine\\Builds', association), '레지스트리(소스 빌드)']);
  }
  for (const [dir, source] of candidates) {
    if (dir && hasBuildBat(dir)) return { ...info, engineRoot: path.resolve(dir), source };
  }
  return { ...info, error: `엔진 ${association ?? '(EngineAssociation 없음)'} 설치 위치를 찾지 못했어요. UE_ROOT 환경 변수에 엔진 폴더를 지정하세요.` };
}

export function isEditorRunning(): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq UnrealEditor.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return /UnrealEditor\.exe/i.test(out);
  } catch {
    return false;
  }
}
