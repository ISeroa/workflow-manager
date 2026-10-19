// 테스트용 gh 대체. WF_GH_EXE에 이 파일을 지정하면 앱이 Node로 실행한다.
// 상태는 FAKE_GH_STATE(JSON 파일)에 남겨 테스트가 확인할 수 있게 한다.
const fs = require('node:fs');

const stateFile = process.env.FAKE_GH_STATE;
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { prs: [], calls: [] };
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === 'pr' && args[1] === 'list') {
  const head = opt('--head');
  process.stdout.write(JSON.stringify(state.prs.filter((p) => p.head === head).map(({ head: _h, body: _b, ...p }) => p)));
} else if (args[0] === 'pr' && args[1] === 'create') {
  const number = state.prs.length + 1;
  const url = `https://github.example/test/repo/pull/${number}`;
  state.prs.push({
    number,
    url,
    state: 'OPEN',
    isDraft: args.includes('--draft'),
    title: opt('--title'),
    head: opt('--head'),
    base: opt('--base'),
    body: fs.readFileSync(opt('--body-file'), 'utf8'),
  });
  process.stdout.write(`Creating pull request\n${url}\n`);
} else {
  save();
  process.stderr.write(`fake-gh: 지원하지 않는 명령 ${args.join(' ')}\n`);
  process.exit(1);
}
save();
