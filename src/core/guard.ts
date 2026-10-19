import picomatch from 'picomatch';
import type { PathCategory } from '../shared/types.js';

/** 어떤 설정과 관계없이 항상 보호하는 경로 */
export const ALWAYS_PROTECTED = ['.workflow/**'];

const BINARY_EXTENSIONS = new Set([
  '.uasset', '.umap', '.ubulk', '.uexp', '.png', '.jpg', '.jpeg', '.tga', '.psd', '.wav', '.ogg', '.fbx',
  '.dll', '.exe', '.pdb', '.lib', '.zip', '.7z',
]);

function matcher(globs: string[]): (p: string) => boolean {
  if (globs.length === 0) return () => false;
  // 슬래시 없는 패턴(*.uproject)은 gitignore처럼 모든 깊이에서 일치시킨다.
  const deep = globs.filter((g) => g.includes('/'));
  const base = globs.filter((g) => !g.includes('/'));
  const m1 = deep.length ? picomatch(deep, { dot: true }) : () => false;
  const m2 = base.length ? picomatch(base, { dot: true, basename: true }) : () => false;
  return (p) => m1(p) || m2(p);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function makeClassifier(allow: string[], protect: string[]): (path: string) => PathCategory {
  const isProtected = matcher([...ALWAYS_PROTECTED, ...protect]);
  const isAllowed = matcher(allow);
  return (path) => {
    const p = normalizePath(path);
    if (isProtected(p)) return 'protected';
    if (isAllowed(p)) return 'allowed';
    return 'outOfScope';
  };
}

export function hasBinaryExtension(path: string): boolean {
  const i = path.lastIndexOf('.');
  return i >= 0 && BINARY_EXTENSIONS.has(path.slice(i).toLowerCase());
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
