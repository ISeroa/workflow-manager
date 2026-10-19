// 이 PC의 실행 환경 점검. 사용: npm run doctor -- [저장소 경로]
import { runDoctor } from '../src/core/doctor.js';

async function main() {
  const repo = process.argv[2];
  const major = Number(process.versions.node.split('.')[0]);
  const checks = await runDoctor(repo);
  checks.unshift(
    major >= 22
      ? { name: 'Node.js', status: 'ok', detail: process.version }
      : { name: 'Node.js', status: 'fail', detail: `${process.version} (22 이상 필요)`, fix: 'Node.js 22 LTS 이상을 설치하세요.' },
  );
  const icon = { ok: '✓', warn: '!', fail: '✕' } as const;
  for (const c of checks) {
    console.log(`${icon[c.status]} ${c.name.padEnd(14)} ${c.detail}`);
    if (c.fix && c.status !== 'ok') console.log(`  → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  console.log(fails ? `\n해결이 필요한 항목 ${fails}개` : '\n앱을 실행할 준비가 됐어요.');
  process.exit(fails ? 1 : 0);
}

main();
