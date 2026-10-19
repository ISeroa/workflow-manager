import type { PackageDef, TaskDef } from './workflow.js';

export const SYSTEM_RULES = [
  '너는 워크플로 앱이 실행하는 Commit 작업 하나를 수행한다.',
  '- 수정 범위는 앱의 권한 설정이 강제한다. 작업에 꼭 필요하면 허용 경로 밖 파일도 편집을 시도해도 된다.',
  '  거부되면 사용자에게 승인 요청이 표시되므로, 다른 방법으로 우회하지 말고 무엇이 왜 필요한지 결과 보고에 적어라.',
  '- git, 빌드, 테스트, 셸 명령은 실행할 수 없다. Commit과 검증은 앱과 사용자가 담당한다.',
  '- 작업을 마치면 변경한 파일과 요약, 남은 문제를 짧게 보고하라.',
].join('\n');

export function buildTaskPrompt(pkg: PackageDef, task: TaskDef): string {
  const lines: string[] = [];
  lines.push(`# 작업 ${task.id}: ${task.title}`);
  lines.push('');
  lines.push(`Work Package ${pkg.id}: ${pkg.title}`);
  if (pkg.description) lines.push('', pkg.description);
  lines.push('', '## 목표', task.goal);
  lines.push('', '## 완료 조건', ...task.doneWhen.map((d) => `- ${d}`));
  lines.push('', '## 수정 허용 경로', ...task.allow.map((a) => `- ${a}`));
  if (task.context.length) {
    lines.push('', '## 참고 파일 (필요하면 Read로 읽어라)', ...task.context.map((c) => `- ${c}`));
  }
  lines.push('', `작업 정의 원본: ${task.file}`);
  return lines.join('\n');
}

export function buildRevisePrompt(text: string): string {
  return ['## 수정 요청', text.trim()].join('\n');
}
