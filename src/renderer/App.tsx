import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PACKAGE_SCOPE,
  type ChangedFile,
  type ChangesView,
  type CheckResult,
  type DoctorCheck,
  type FixAction,
  type FixResult,
  type IpcResult,
  type PackageView,
  type PrView,
  type RunEvent,
  type Snapshot,
  type TaskState,
  type TaskView,
  type VerifyEvent,
  type VerifyView,
  type WfApi,
} from '../shared/types';

declare global {
  interface Window {
    wf: WfApi;
  }
}

type Sel = { wp: string; ct: string };
type DoneEvent = Extract<RunEvent, { type: 'done' }>;
type Live = { names: string[]; current: number; outputs: string[]; results: (CheckResult | undefined)[]; outcome?: string };

const STATE_ICON: Record<TaskState, string> = { done: '✓', next: '▸', pending: '○', running: '◐', review: '◑' };
const STATE_LABEL: Record<TaskState, string> = { done: '완료', next: '다음', pending: '대기', running: '실행 중', review: '검토 필요' };
const FILE_STATUS: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const CATEGORY_LABEL = { allowed: '', outOfScope: '범위 밖', protected: '보호 경로 · 직접 작업' };
const OUTCOME_LABEL = { success: '완료', error: '실패', cancelled: '중단됨', timeout: '시간 초과' };
const CHECK_LABEL: Record<CheckResult['outcome'], string> = {
  passed: '통과',
  failed: '실패',
  skipped: '건너뜀',
  cancelled: '중단됨',
  timeout: '시간 초과',
  error: '실행 오류',
};
const LIVE_CHARS = 6000;

const key = (wp: string, scope: string) => `${wp}/${scope}`;

async function call<T>(p: Promise<IpcResult<T>>, onError: (m: string) => void): Promise<T | undefined> {
  const r = await p;
  if (!r.ok) {
    onError(r.error);
    return undefined;
  }
  return r.data;
}

function pickDefault(snap: Snapshot): Sel | null {
  const pkg = snap.packages.find((p) => p.isCurrentBranch) ?? snap.packages[0];
  if (!pkg) return null;
  if (pkg.allDone && pkg.isCurrentBranch) return { wp: pkg.id, ct: PACKAGE_SCOPE };
  const t = pkg.tasks.find((x) => x.state !== 'done') ?? pkg.tasks[pkg.tasks.length - 1];
  return t ? { wp: pkg.id, ct: t.id } : null;
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<Record<string, RunEvent[]>>({});
  const [live, setLive] = useState<Record<string, Live>>({});
  const [manual, setManual] = useState<Record<string, string[]>>({});
  const [changes, setChanges] = useState<ChangesView | null>(null);
  const [pr, setPr] = useState<PrView | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  // 사용자가 고치기 전까지는 최신 상태(검증 결과 등)로 다시 만든 제목·본문을 쓴다.
  const [prEdited, setPrEdited] = useState({ title: false, body: false });
  const [prDraft, setPrDraft] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [fileSel, setFileSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviseText, setReviseText] = useState('');
  const [attachLog, setAttachLog] = useState(false);
  const [subject, setSubject] = useState('');
  const [approveOos, setApproveOos] = useState(false);
  const [approveProt, setApproveProt] = useState(false);
  const [ackBinary, setAckBinary] = useState(false);
  const [lastCommit, setLastCommit] = useState<{ ct: string; hash: string } | null>(null);
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const runDoctor = useCallback(async () => {
    setDoctorBusy(true);
    const r = await call(window.wf.doctor(), setError);
    setDoctorBusy(false);
    if (r) {
      setDoctor(r);
      if (r.some((c) => c.status === 'fail')) setDoctorOpen(true);
    }
  }, []);

  // 앱을 켤 때(저장소 선택 전 포함)와 저장소가 바뀔 때 환경 점검을 실행한다.
  useEffect(() => {
    runDoctor();
  }, [snap?.root, runDoctor]);

  const fix = async (action: FixAction): Promise<FixResult | undefined> => {
    const r = await call(window.wf.fix(action), setError);
    // 설치·설정 결과를 반영하려면 다시 점검하고, 저장소 상태(Claude 경로 등)도 새로 읽는다.
    if (r?.ok && action.kind !== 'login') {
      await runDoctor();
      if (snap) await refresh();
    }
    return r;
  };

  const doctorPanel = doctorOpen && (
    <DoctorPanel
      checks={doctor}
      busy={doctorBusy}
      onRerun={async () => {
        await runDoctor();
        if (snap) await refresh();
      }}
      onClose={() => setDoctorOpen(false)}
      onFix={fix}
      onLink={(url) => window.wf.openExternal(url)}
    />
  );

  const refresh = useCallback(async () => {
    const s = await call(window.wf.snapshot(), setError);
    setLoaded(true);
    if (s === undefined) return;
    setSnap(s);
    if (s) {
      setExpanded((prev) => (prev.size ? prev : new Set(s.packages.filter((p) => p.isCurrentBranch).map((p) => p.id))));
      setSel((prev) => {
        if (prev && s.packages.some((p) => p.id === prev.wp && (prev.ct === PACKAGE_SCOPE || p.tasks.some((t) => t.id === prev.ct)))) return prev;
        return pickDefault(s);
      });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.wf.onRunEvent((msg) => {
        const k = key(msg.wp, msg.ct);
        setLogs((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), msg.event] }));
        if (msg.event.type === 'done') refresh();
      }),
    [refresh],
  );

  useEffect(
    () =>
      window.wf.onVerifyEvent((msg) => {
        const k = key(msg.wp, msg.scope);
        const e: VerifyEvent = msg.event;
        setLive((prev) => {
          const cur = prev[k];
          if (e.type === 'started') return { ...prev, [k]: { names: e.names, current: -1, outputs: e.names.map(() => ''), results: [] } };
          if (!cur) return prev;
          const next = { ...cur, outputs: [...cur.outputs], results: [...cur.results] };
          if (e.type === 'check-start') next.current = e.index;
          if (e.type === 'output') next.outputs[e.index] = (next.outputs[e.index] + e.text).slice(-LIVE_CHARS);
          if (e.type === 'check-done') next.results[e.index] = e.result;
          if (e.type === 'done') next.outcome = e.outcome;
          return { ...prev, [k]: next };
        });
        if (e.type === 'started' || e.type === 'done') refresh();
      }),
    [refresh],
  );

  const pkg: PackageView | undefined = useMemo(() => snap?.packages.find((p) => p.id === sel?.wp), [snap, sel]);
  const isPrSel = sel?.ct === PACKAGE_SCOPE;
  const task: TaskView | undefined = useMemo(() => (isPrSel ? undefined : pkg?.tasks.find((t) => t.id === sel?.ct)), [pkg, sel, isPrSel]);
  const selKey = sel ? key(sel.wp, sel.ct) : '';
  const taskLog = sel ? logs[selKey] ?? [] : [];
  const lastDone = [...taskLog].reverse().find((e): e is DoneEvent => e.type === 'done');
  const verifyingHere = !!snap?.verifying && !!sel && snap.verifying.wp === sel.wp && snap.verifying.scope === sel.ct;
  const manualChecked = manual[selKey] ?? [];

  // 검토 상태면 변경 목록을, PR 화면이면 PR 상태를 불러온다.
  useEffect(() => {
    setChanges(null);
    setPr(null);
    if (!sel || !snap) return;
    let alive = true;
    if (sel.ct === PACKAGE_SCOPE) {
      call(window.wf.prView(sel.wp), setError).then((v) => {
        if (!alive || !v) return;
        setPr(v);
        if (!prEdited.title) setPrTitle(v.title);
        if (!prEdited.body) setPrBody(v.body);
      });
    } else if (task?.state === 'review') {
      call(window.wf.changes(sel.wp, sel.ct), setError).then((c) => {
        if (!alive || !c) return;
        setChanges(c);
        setFileSel((f) => (f && c.files.some((x) => x.path === f) ? f : c.files[0]?.path ?? null));
        setSubject((s) => s || c.commitSubject);
      });
    }
    return () => {
      alive = false;
    };
  }, [sel, task?.state, snap]);

  useEffect(() => {
    setSubject('');
    setApproveOos(false);
    setApproveProt(false);
    setAckBinary(false);
    setAttachLog(false);
    setPrTitle('');
    setPrBody('');
    setPrEdited({ title: false, body: false });
    setPrUrl(null);
  }, [selKey]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [taskLog.length]);

  // 자동 점검(스모크 테스트)에서 화면 단계를 읽을 수 있게 남긴다.
  useEffect(() => {
    const d = document.body.dataset;
    d.phase = isPrSel ? 'pr' : task ? task.state : 'none';
    d.changes = changes ? String(changes.files.length) : '';
    d.busy = busy ? '1' : '';
    d.verifying = snap?.verifying ? '1' : '';
    d.ahead = String(snap?.remote?.ahead ?? '');
    d.branch = snap?.branch ?? '';
  }, [task, changes, busy, snap, isPrSel]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const openRepo = () =>
    act(async () => {
      const s = await call(window.wf.openRepo(), setError);
      if (s) {
        setSnap(s);
        setLogs({});
        setLive({});
        setNotice(null);
        setExpanded(new Set(s.packages.filter((p) => p.isCurrentBranch).map((p) => p.id)));
        setSel(pickDefault(s));
      }
    });

  const startPackage = (wp: string) =>
    act(async () => {
      const r = await call(window.wf.startPackage(wp), setError);
      if (r) {
        setNotice(r.message);
        setExpanded((prev) => new Set(prev).add(wp));
        const s = await call(window.wf.snapshot(), setError);
        if (s) {
          setSnap(s);
          setSel(pickDefault(s));
        }
      }
    });

  const commitPlan = (wp: string) =>
    act(async () => {
      const r = await call(window.wf.commitPlan(wp), setError);
      if (r) setNotice(`계획 변경을 Commit했어요 (${r.hash.slice(0, 7)}).`);
      await refresh();
    });

  const push = (wp: string) =>
    act(async () => {
      const r = await call(window.wf.push(wp), setError);
      if (r) {
        setNotice('Push했어요.');
        setLastCommit(null);
      }
      await refresh();
    });

  const fetchRemote = () =>
    act(async () => {
      if ((await call(window.wf.fetch(), setError)) !== undefined) setNotice('원격 상태를 받아왔어요.');
      await refresh();
    });

  const run = () =>
    sel &&
    act(async () => {
      setLastCommit(null);
      setNotice(null);
      setLogs((prev) => ({ ...prev, [selKey]: [] }));
      setLive((prev) => {
        const n = { ...prev };
        delete n[selKey];
        return n;
      });
      await call(window.wf.start(sel.wp, sel.ct), setError);
      await refresh();
    });

  const revise = (allowPaths: string[] = []) =>
    sel &&
    act(async () => {
      const r = await call(window.wf.revise(sel.wp, sel.ct, { text: allowPaths.length ? '' : reviseText, attachFailureLog: !allowPaths.length && attachLog, allowPaths }), setError);
      if (r !== undefined && !allowPaths.length) {
        setReviseText('');
        setAttachLog(false);
      }
      await refresh();
    });

  const cancel = () => act(async () => void (await call(window.wf.cancel(), setError)));
  const verify = () =>
    sel &&
    act(async () => {
      await call(window.wf.verify(sel.wp, sel.ct), setError);
      // 검증 중 상태를 바로 반영해 Commit 버튼이 잠깐이라도 열리지 않게 한다.
      await refresh();
    });
  const cancelVerify = () => act(async () => void (await call(window.wf.cancelVerify(), setError)));

  const commit = () =>
    sel &&
    act(async () => {
      const r = await call(window.wf.commit(sel.wp, sel.ct, { subject, approveOutOfScope: approveOos, approveProtected: approveProt, ackBinary, manualChecked }), setError);
      if (r) {
        setLastCommit({ ct: sel.ct, hash: r.hash });
        const s = await call(window.wf.snapshot(), setError);
        if (s) {
          setSnap(s);
          const next = pickDefault(s);
          // 마지막 작업이면 PR 화면으로 넘어가므로 Commit 결과를 알림으로 남긴다.
          if (next?.ct === PACKAGE_SCOPE) setNotice(`${sel.ct} Commit 완료 (${r.hash.slice(0, 7)}). 모든 작업이 끝났어요.`);
          setSel(next);
        }
      }
    });

  const createPr = () =>
    sel &&
    act(async () => {
      const r = await call(window.wf.createPr(sel.wp, { title: prTitle, body: prBody, draft: prDraft, manualChecked }), setError);
      if (r) {
        setPrUrl(r.url);
        setNotice(`PR을 만들었어요: ${r.url}`);
      }
      await refresh();
    });

  const toggleManual = (name: string) =>
    setManual((prev) => {
      const cur = prev[selKey] ?? [];
      return { ...prev, [selKey]: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] };
    });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (!loaded) return null;

  if (!snap) {
    return (
      <div className="app" style={{ gridTemplateRows: 'auto 1fr' }}>
        <div>
          {error && <div className="banner error"><span className="grow">{error}</span></div>}
          {doctorPanel}
        </div>
        <div className="empty">
          <div style={{ fontSize: 15, color: 'var(--text)' }}>작업할 Git 저장소를 선택하세요</div>
          <div>저장소의 <span className="mono">.workflow/</span> 파일에서 Work Package를 읽어요.</div>
          <button className="primary" onClick={openRepo} data-testid="open-repo">저장소 선택</button>
          {!doctorOpen && <button onClick={() => (setDoctorOpen(true), runDoctor())}>환경 점검</button>}
        </div>
      </div>
    );
  }

  const running = !!snap.running;
  const idle = !busy && !running && !snap.verifying;
  const currentPkg = snap.packages.find((p) => p.isCurrentBranch);
  const rv = snap.remote;
  const manualItems = (isPrSel ? pr?.verify.items : task?.verify)?.filter((i) => i.kind === 'manual') ?? [];
  const manualOk = manualItems.every((i) => manualChecked.includes(i.name));
  const commitDisabled =
    !idle || !changes || changes.blockers.length > 0 || (changes.needsOutOfScopeApproval && !approveOos) || (changes.protectedFiles.length > 0 && !approveProt) || (changes.needsBinaryAck && !ackBinary) || !manualOk;
  const failedResult = changes?.verify.fresh ? changes.verify.results?.find((r) => r.outcome !== 'passed' && r.outcome !== 'skipped') : undefined;

  return (
    <div className="app">
      <div className="topbar">
        <span className="repo" title={snap.root}>{snap.root.split(/[\\/]/).pop()}</span>
        <span className="mono muted">⎇ {snap.branch}</span>
        <span className="pill">{snap.mode === 'team' ? 'team' : 'solo'}</span>
        <span className="spacer" />
        {currentPkg && rv && (
          <span className="chip" data-testid="remote">
            <span className={`dot ${!rv.hasRemote || rv.behind ? 'bad' : rv.ahead || !rv.remoteBranch ? 'warn' : ''}`} />
            {!rv.hasRemote
              ? `원격 ${rv.remote} 없음`
              : rv.behind
                ? `원격에 새 Commit ${rv.behind}`
                : rv.ahead
                  ? `Push 필요 ${rv.ahead}`
                  : rv.remoteBranch
                    ? '원격과 같음'
                    : 'Push 전'}
          </span>
        )}
        {currentPkg && rv?.hasRemote && (
          <>
            <button onClick={fetchRemote} disabled={!idle}>원격 확인</button>
            {rv.ahead > 0 && (
              <button onClick={() => push(currentPkg.id)} disabled={!idle} title={`git push -u ${rv.remote} ${currentPkg.branch}`} data-testid="push-top">
                Push
              </button>
            )}
          </>
        )}
        <span className="chip" title={snap.claudeExe ?? snap.claudeError}>
          <span className={`dot ${snap.claudeError ? 'bad' : ''}`} />Claude
        </span>
        <span className="chip" title={snap.ghExe ?? 'GitHub CLI(gh)를 찾지 못했어요'}>
          <span className={`dot ${snap.ghExe ? '' : 'warn'}`} />gh
        </span>
        <button onClick={() => (doctorOpen ? setDoctorOpen(false) : (setDoctorOpen(true), runDoctor()))} disabled={doctorBusy} data-testid="doctor-toggle">
          <span className={`dot ${!doctor ? 'warn' : doctor.some((c) => c.status === 'fail') ? 'bad' : doctor.some((c) => c.status === 'warn') ? 'warn' : ''}`} style={{ display: 'inline-block', marginRight: 6 }} />
          환경 점검
        </button>
        <span className="chip" title={snap.dirtyFiles.join('\n')}>
          <span className={`dot ${snap.clean ? '' : 'warn'}`} />
          {snap.clean ? '작업 트리 깨끗' : `미커밋 변경 ${snap.dirtyFiles.length}`}
        </span>
        <button onClick={openRepo} disabled={!idle}>저장소 변경</button>
      </div>

      <div>
        {doctorPanel}
        {error && (
          <div className="banner error" data-testid="error">
            <span className="grow">{error}</span>
            <button onClick={() => setError(null)}>닫기</button>
          </div>
        )}
        {notice && !error && (
          <div className="banner ok" data-testid="notice">
            <span className="grow">{notice}</span>
            <button onClick={() => setNotice(null)}>닫기</button>
          </div>
        )}
        {snap.errors.length > 0 && (
          <div className="banner warn">
            <span className="grow">{`.workflow 파일 오류\n${snap.errors.join('\n')}`}</span>
          </div>
        )}
        {snap.planOnlyDirty && snap.packages.find((p) => p.id === snap.planOnlyDirty)?.isCurrentBranch && (
          <div className="banner warn">
            <span className="grow">{`${snap.planOnlyDirty} 계획 파일 변경 ${snap.dirtyFiles.length}개가 Commit되지 않았어요. 작업을 실행하려면 먼저 Commit하세요.`}</span>
            <button onClick={() => commitPlan(snap.planOnlyDirty!)} disabled={!idle} data-testid="plan-commit">계획 변경 Commit</button>
          </div>
        )}
      </div>

      <div className="main">
        <div className="tree">
          <div className="tree-head">
            <span>Work Package</span>
            <button onClick={() => act(refresh)} disabled={busy} title=".workflow 다시 읽기">새로고침</button>
          </div>
          {snap.packages.length === 0 && <div className="faint" style={{ padding: 6 }}>.workflow/changes에 Work Package가 없어요.</div>}
          {snap.packages.map((p) => (
            <div className="wp" key={p.id}>
              <div className="wp-row" onClick={() => toggle(p.id)}>
                <span className="icon">{expanded.has(p.id) ? '▾' : '▸'}</span>
                <span className="label">{p.id} {p.title}</span>
                <span className="count">{p.doneCount}/{p.tasks.length}</span>
              </div>
              {expanded.has(p.id) && (
                <>
                  <div className="branch-note">
                    <span className="mono">{p.branch}</span>
                    {!p.isCurrentBranch && (
                      <button className="small" onClick={() => startPackage(p.id)} disabled={!idle} data-testid={`start-${p.id}`}>
                        {p.branchExists ? '브랜치로 전환' : '작업 시작'}
                      </button>
                    )}
                  </div>
                  {p.tasks.map((t) => (
                    <div
                      key={t.id}
                      className={`ct-row ${sel?.wp === p.id && sel.ct === t.id ? 'sel' : ''}`}
                      onClick={() => setSel({ wp: p.id, ct: t.id })}
                      data-testid={`ct-${t.id}`}
                    >
                      <span className={`icon s-${t.state}`}>{STATE_ICON[t.state]}</span>
                      <span className="label" title={`${t.id} ${t.title}`}>{t.id} {t.title}</span>
                      {t.hash ? <span className="hash">{t.hash.slice(0, 7)}</span> : t.state !== 'pending' && <span className="tag">{STATE_LABEL[t.state]}</span>}
                    </div>
                  ))}
                  <div
                    className={`ct-row pr-row ${sel?.wp === p.id && isPrSel ? 'sel' : ''}`}
                    onClick={() => setSel({ wp: p.id, ct: PACKAGE_SCOPE })}
                    data-testid={`pr-${p.id}`}
                  >
                    <span className={`icon ${p.allDone ? 's-next' : 's-pending'}`}>⇪</span>
                    <span className="label">PR 준비</span>
                    {!p.allDone && <span className="hash">{p.tasks.length - p.doneCount}개 남음</span>}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="detail">
          {!pkg || !sel ? (
            <div className="empty">왼쪽에서 Commit Task를 선택하세요.</div>
          ) : isPrSel ? (
            <PrPanel
              pkg={pkg}
              pr={pr}
              title={prTitle}
              body={prBody}
              draft={prDraft}
              url={prUrl}
              onTitle={(v) => {
                setPrTitle(v);
                setPrEdited((e) => ({ ...e, title: true }));
              }}
              onBody={(v) => {
                setPrBody(v);
                setPrEdited((e) => ({ ...e, body: true }));
              }}
              onDraft={setPrDraft}
              live={live[selKey]}
              verifying={verifyingHere}
              canVerify={idle && pkg.isCurrentBranch && pkg.allDone && snap.clean}
              onVerify={verify}
              onCancelVerify={cancelVerify}
              manualChecked={manualChecked}
              onToggleManual={toggleManual}
            />
          ) : !task ? (
            <div className="empty">왼쪽에서 Commit Task를 선택하세요.</div>
          ) : (
            <>
              <div className="title-row">
                <h1>{task.id} {task.title}</h1>
                <span className={`pill ${task.state}`}>{STATE_LABEL[task.state]}</span>
                {task.hash && <span className="mono muted">{task.hash.slice(0, 7)} {task.subject}</span>}
              </div>

              {lastCommit && (
                <div className="section" data-testid="committed">
                  <div className="body row">
                    <span>✓ {lastCommit.ct} Commit 완료 <span className="mono">{lastCommit.hash.slice(0, 7)}</span></span>
                    {rv?.hasRemote && rv.ahead > 0 ? (
                      <>
                        <span className="muted">· Push하지 않았어요{snap.mode === 'team' ? ' (team 모드는 Push 후 다음 작업 실행)' : ''}</span>
                        <span className="spacer" />
                        <span className="mono faint">git push -u {rv.remote} {pkg.branch}</span>
                        <button className="primary" onClick={() => push(pkg.id)} disabled={!idle} data-testid="push">Push</button>
                      </>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="section">
                <div className="head">작업 정의 <span className="mono faint">{task.file}</span></div>
                <div className="body">
                  <dl className="kv">
                    <dt>목표</dt>
                    <dd>{task.goal}</dd>
                    <dt>완료 조건</dt>
                    <dd><ul>{task.doneWhen.map((d) => <li key={d}>{d}</li>)}</ul></dd>
                    <dt>허용 경로</dt>
                    <dd className="mono">
                      {task.allow.join('  ')}
                      {task.session?.extraAllow.length ? <span className="warn-text">  + 추가 허용 {task.session.extraAllow.join('  ')}</span> : null}
                    </dd>
                    {task.context.length > 0 && (
                      <>
                        <dt>참고 파일</dt>
                        <dd className="mono">{task.context.join('  ')}</dd>
                      </>
                    )}
                    {task.verify.length > 0 && (
                      <>
                        <dt>검증</dt>
                        <dd>
                          <ul>
                            {task.verify.map((v) => (
                              <li key={v.name}>{v.kind === 'run' ? <span title={v.command}>{v.name} <span className="faint">(자동)</span></span> :<span>{v.name} <span className="faint">(사람 확인)</span></span>}</li>
                            ))}
                          </ul>
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
              </div>

              {(taskLog.length > 0 || task.state === 'running') && (
                <div className="section">
                  <div className="head">
                    Claude 실행
                    {task.session && <span className="mono faint">세션 {task.session.sessionId.slice(0, 8)} · {task.session.runs}회</span>}
                    <span className="spacer" />
                    {task.state === 'running' && <button className="danger" onClick={cancel} data-testid="cancel">중단</button>}
                  </div>
                  <div className="body">
                    <div className="log" ref={logRef} data-testid="log">
                      {taskLog.map((e, i) => <LogLine key={i} e={e} />)}
                      {task.state === 'running' && <div className="line faint">실행 중…</div>}
                    </div>
                    {lastDone && lastDone.denials.length > 0 && (
                      <div className="denials" data-testid="denials">
                        Claude가 요청했지만 허용되지 않은 작업
                        <ul>
                          {lastDone.denials.map((d, i) => (
                            <li key={i}>
                              <span className="mono">{d.tool} {d.detail}</span> —{' '}
                              {d.kind === 'protected'
                                ? '보호 경로라 수정할 수 없어요'
                                : d.kind === 'outOfScope'
                                  ? '이 작업의 허용 경로 밖이에요'
                                  : d.kind === 'allowed'
                                    ? '허용 경로지만 거부됐어요 (권한 설정 확인 필요)'
                                    : '이 앱은 이 도구를 지원하지 않아요'}
                              {d.kind === 'outOfScope' && d.path && task.state === 'review' && !task.session?.extraAllow.includes(d.path) && (
                                <button className="small" onClick={() => revise([d.path!])} disabled={!idle} data-testid={`allow-${d.path}`}>
                                  이 경로 허용하고 이어서 실행
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {task.state === 'review' && (
                <div className="section" data-testid="changes">
                  <div className="head">
                    변경 검토
                    {changes && <span className="faint">파일 {changes.files.length}</span>}
                  </div>
                  {!changes ? (
                    <div className="diff-empty">변경을 불러오는 중…</div>
                  ) : (
                    <>
                      <div className="changes">
                        <div className="files">
                          {changes.files.length === 0 && <div className="faint" style={{ padding: 6 }}>변경 없음</div>}
                          {changes.files.map((f) => (
                            <div key={f.path} className={`file ${fileSel === f.path ? 'sel' : ''}`} onClick={() => setFileSel(f.path)}>
                              <span className="st">{FILE_STATUS[f.status]}</span>
                              <span className="name" title={f.path}>{f.path}</span>
                              <span className={`cat cat-${f.category}`}>
                                {f.binary ? '바이너리 ' : ''}
                                {f.extraAllowed ? '추가 허용' : CATEGORY_LABEL[f.category]}
                              </span>
                            </div>
                          ))}
                        </div>
                        <DiffView file={changes.files.find((f) => f.path === fileSel)} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {task.state === 'review' && (task.verify.length > 0 || changes) && (
                <VerifyPanel
                  title="검증"
                  view={changes?.verify}
                  live={live[selKey]}
                  verifying={verifyingHere}
                  canRun={idle && task.verify.some((v) => v.kind === 'run')}
                  onRun={verify}
                  onCancel={cancelVerify}
                  manualChecked={manualChecked}
                  onToggleManual={toggleManual}
                />
              )}

              {task.state === 'review' && changes && (
                <div className="section">
                  {changes.blockers.length > 0 && (
                    <div className="blockers" data-testid="blockers">
                      Commit할 수 없어요
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{changes.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                    </div>
                  )}
                  <div className="commit-box">
                    <div className="revise">
                      <textarea
                        placeholder="수정 요청 (같은 Claude 세션으로 이어서 실행해요)"
                        value={reviseText}
                        onChange={(e) => setReviseText(e.target.value)}
                        data-testid="revise-text"
                      />
                      <div className="revise-actions">
                        {failedResult && (
                          <label className="check">
                            <input type="checkbox" checked={attachLog} onChange={(e) => setAttachLog(e.target.checked)} data-testid="attach-log" />
                            실패 로그 첨부
                          </label>
                        )}
                        <button onClick={() => revise()} disabled={!idle || (!reviseText.trim() && !attachLog)} data-testid="revise">수정 요청</button>
                      </div>
                    </div>
                    <div className="commit-subject">
                      <span className="prefix">{task.id}:</span>
                      <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="subject" />
                    </div>
                    <div className="trailers">{changes.commitTrailers.join('  ·  ')}</div>
                    {changes.protectedFiles.length > 0 && (
                      <label className="check" style={{ color: 'var(--danger)' }}>
                        <input type="checkbox" checked={approveProt} onChange={(e) => setApproveProt(e.target.checked)} data-testid="approve-protected" />
                        보호 경로 변경({changes.protectedFiles.join(', ')})은 내가 직접 작업했고 이 Commit에 포함할게요
                      </label>
                    )}
                    {changes.needsOutOfScopeApproval && (
                      <label className="check" style={{ color: 'var(--warn)' }}>
                        <input type="checkbox" checked={approveOos} onChange={(e) => setApproveOos(e.target.checked)} />
                        범위 밖 변경을 확인했고 이 Commit에 포함할게요
                      </label>
                    )}
                    {changes.needsBinaryAck && (
                      <label className="check">
                        <input type="checkbox" checked={ackBinary} onChange={(e) => setAckBinary(e.target.checked)} />
                        바이너리 파일(에셋)은 에디터에서 직접 확인했어요
                      </label>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <NextBar
        snap={snap}
        pkg={pkg}
        task={task}
        isPr={isPrSel}
        pr={pr}
        idle={idle}
        busy={busy}
        lastDone={lastDone}
        changes={changes}
        commitDisabled={commitDisabled}
        manualOk={manualOk}
        prTitleOk={!!prTitle.trim()}
        onStartPackage={startPackage}
        onPush={push}
        onRun={run}
        onCommit={commit}
        onCreatePr={createPr}
      />
    </div>
  );
}

function DoctorPanel(p: {
  checks: DoctorCheck[] | null;
  busy: boolean;
  onRerun: () => Promise<void>;
  onClose: () => void;
  onFix: (a: FixAction) => Promise<FixResult | undefined>;
  onLink: (url: string) => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, FixResult>>({});
  const [identity, setIdentity] = useState({ open: false, name: '', email: '' });

  const doFix = async (name: string, action: FixAction) => {
    setWorking(name);
    const r = await p.onFix(action);
    setWorking(null);
    if (r) setResults((prev) => ({ ...prev, [name]: r }));
    if (r?.ok && action.kind === 'git-identity') setIdentity({ open: false, name: '', email: '' });
  };

  const checks = p.checks ?? [];
  const okCount = checks.filter((c) => c.status === 'ok').length;
  return (
    <div className="doctor" data-testid="doctor">
      <div className="row">
        <strong>환경 점검</strong>
        <span className="faint">{p.busy ? '점검 중…' : p.checks ? `${okCount}/${checks.length} 정상` : ''}</span>
        <span className="spacer" />
        <button onClick={() => p.onRerun()} disabled={p.busy || !!working} data-testid="doctor-rerun">다시 점검</button>
        <button onClick={p.onClose}>닫기</button>
      </div>
      {checks.map((c) => {
        const r = results[c.name];
        const isWorking = working === c.name;
        const act = c.action;
        return (
          <div key={c.name} className={`doctor-item d-${c.status}`} data-testid={`doctor-${c.name}`}>
            <span className="icon">{c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✕'}</span>
            <span className="doctor-name">{c.name}</span>
            <span className="doctor-detail">
              {c.detail}
              {c.fix && c.status !== 'ok' && <span className="doctor-fix"> → {c.fix}</span>}
              {r && <div className={r.ok ? 'ok-text' : 'err-text'}>{r.message}</div>}
              {r?.output && !r.ok && <pre className="check-out">{r.output}</pre>}
              {act?.action.kind === 'git-identity' && identity.open && c.status !== 'ok' && (
                <div className="identity-form">
                  <input type="text" placeholder="GitHub 아이디" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} data-testid="git-name" />
                  <input type="text" placeholder="name@example.com" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} data-testid="git-email" />
                  <button className="primary" disabled={!!working} onClick={() => doFix(c.name, { kind: 'git-identity', name: identity.name, email: identity.email })} data-testid="git-identity-save">
                    저장
                  </button>
                </div>
              )}
            </span>
            <span className="doctor-action">
              {c.status !== 'ok' && act && !(act.action.kind === 'git-identity' && identity.open) && (
                <button
                  className="small"
                  disabled={!!working || p.busy}
                  title={act.action.kind === 'winget' ? 'winget으로 공식 패키지를 설치해요 (패키지 약관 동의 포함). 관리자 권한 창이 뜰 수 있어요.' : undefined}
                  onClick={() => (act.action.kind === 'git-identity' ? setIdentity({ ...identity, open: true }) : doFix(c.name, act.action))}
                  data-testid={`fix-${c.name}`}
                >
                  {isWorking ? (act.action.kind === 'winget' ? '설치 중…' : '진행 중…') : act.label}
                </button>
              )}
              {c.status !== 'ok' && c.link && (
                <button className="small" onClick={() => p.onLink(c.link!.url)}>{c.link.label}</button>
              )}
            </span>
          </div>
        );
      })}
      {working && <div className="faint">설치는 1~3분 걸릴 수 있어요. 관리자 권한 확인 창이 뜨면 허용하세요.</div>}
    </div>
  );
}

function VerifyPanel(p: {
  title: string;
  view?: VerifyView;
  live?: Live;
  verifying: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
  manualChecked: string[];
  onToggleManual: (name: string) => void;
}) {
  const items = p.view?.items ?? [];
  const runItems = items.filter((i) => i.kind === 'run');
  const manualItems = items.filter((i) => i.kind === 'manual');
  const [open, setOpen] = useState<number | null>(null);
  const liveActive = p.verifying && p.live;
  return (
    <div className="section" data-testid="verify">
      <div className="head">
        {p.title}
        {p.view?.at && !p.verifying && (
          <span className="faint">{p.view.fresh ? '마지막 실행' : '이전 결과 (이후 변경됨)'} {new Date(p.view.at).toLocaleTimeString()}</span>
        )}
        <span className="spacer" />
        {p.verifying ? (
          <button className="danger" onClick={p.onCancel} data-testid="verify-cancel">검증 중단</button>
        ) : (
          runItems.length > 0 && <button onClick={p.onRun} disabled={!p.canRun} data-testid="verify-run">검증 실행</button>
        )}
      </div>
      <div className="body">
        {runItems.length === 0 && manualItems.length === 0 && <div className="faint">정의된 검증이 없어요.</div>}
        {runItems.map((item, i) => {
          const liveResult = liveActive ? p.live!.results[i] : undefined;
          const stored = !liveActive ? p.view?.results?.[i] : undefined;
          const r = liveResult ?? stored;
          const isRunning = liveActive && p.live!.current === i && !liveResult;
          const out = liveActive ? p.live!.outputs[i] : r?.tail ?? '';
          const stale = !!stored && !p.view?.fresh;
          const showOut = isRunning || open === i || (!!r && r.outcome !== 'passed' && r.outcome !== 'skipped' && !stale);
          return (
            <div key={item.name} className="check-item">
              <div className="check-row" onClick={() => setOpen(open === i ? null : i)}>
                <span className={`icon ${isRunning ? 's-running' : !r ? 's-pending' : stale ? 's-pending' : r.outcome === 'passed' ? 's-done' : 'err-text'}`}>
                  {isRunning ? '◐' : !r ? '○' : r.outcome === 'passed' ? '✓' : r.outcome === 'skipped' ? '–' : '✕'}
                </span>
                <span className="check-name">{item.name}</span>
                <span className="mono faint check-cmd" title={item.command}>{item.command}</span>
                <span className={`check-status ${stale ? 'faint' : r && r.outcome !== 'passed' ? 'err-text' : 'muted'}`}>
                  {isRunning ? '실행 중…' : r ? `${CHECK_LABEL[r.outcome]}${r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ''}${stale ? ' (낡음)' : ''}` : '실행 전'}
                </span>
              </div>
              {showOut && out && <pre className="check-out">{out.split(/\r?\n/).slice(-200).join('\n')}</pre>}
            </div>
          );
        })}
        {manualItems.length > 0 && (
          <div className="manual">
            {manualItems.map((m) => (
              <label key={m.name} className="check">
                <input type="checkbox" checked={p.manualChecked.includes(m.name)} onChange={() => p.onToggleManual(m.name)} data-testid={`manual-${m.name}`} />
                {m.name} <span className="faint">(사람 확인)</span>
              </label>
            ))}
          </div>
        )}
        {p.view?.logFile && !p.verifying && <div className="faint mono small-text">전체 로그: {p.view.logFile}</div>}
      </div>
    </div>
  );
}

function PrPanel(p: {
  pkg: PackageView;
  pr: PrView | null;
  title: string;
  body: string;
  draft: boolean;
  url: string | null;
  onTitle: (v: string) => void;
  onBody: (v: string) => void;
  onDraft: (v: boolean) => void;
  live?: Live;
  verifying: boolean;
  canVerify: boolean;
  onVerify: () => void;
  onCancelVerify: () => void;
  manualChecked: string[];
  onToggleManual: (name: string) => void;
}) {
  const { pkg, pr } = p;
  return (
    <>
      <div className="title-row">
        <h1>{pkg.id} {pkg.title} · PR 준비</h1>
        {pr?.existing && (
          <span className={`pill ${pr.existing.state === 'OPEN' ? 'next' : 'done'}`}>PR #{pr.existing.number} {pr.existing.state === 'OPEN' ? (pr.existing.isDraft ? 'Draft' : '열림') : pr.existing.state === 'MERGED' ? 'Merged' : '닫힘'}</span>
        )}
      </div>

      {(p.url || pr?.existing) && (
        <div className="section" data-testid="pr-link">
          <div className="body row">
            <span>PR</span>
            <a href="#" onClick={(e) => { e.preventDefault(); window.wf.openExternal(p.url ?? pr!.existing!.url); }}>{p.url ?? pr!.existing!.url}</a>
          </div>
        </div>
      )}

      <div className="section">
        <div className="head">포함 작업 <span className="faint">{pkg.doneCount}/{pkg.tasks.length}</span></div>
        <div className="body">
          {pkg.tasks.map((t) => (
            <div key={t.id} className="row">
              <span className={`icon s-${t.state}`}>{STATE_ICON[t.state]}</span>
              <span>{t.id} {t.title}</span>
              <span className="spacer" />
              <span className="mono faint">{t.hash?.slice(0, 7) ?? STATE_LABEL[t.state]}</span>
            </div>
          ))}
        </div>
      </div>

      <VerifyPanel
        title="통합 검증"
        view={pr?.verify}
        live={p.live}
        verifying={p.verifying}
        canRun={p.canVerify}
        onRun={p.onVerify}
        onCancel={p.onCancelVerify}
        manualChecked={p.manualChecked}
        onToggleManual={p.onToggleManual}
      />

      {pr && pr.blockers.length > 0 && (
        <div className="section">
          <div className="blockers" data-testid="pr-blockers">
            PR을 만들 수 없어요
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{pr.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="section">
        <div className="head">PR 내용 <span className="mono faint">{pr?.repo ? `${pr.repo} · ` : ''}{pkg.branch} → {pkg.base}</span></div>
        <div className="body pr-form">
          <input type="text" value={p.title} onChange={(e) => p.onTitle(e.target.value)} placeholder="PR 제목" data-testid="pr-title" />
          <textarea value={p.body} onChange={(e) => p.onBody(e.target.value)} rows={10} data-testid="pr-body" />
          <label className="check">
            <input type="checkbox" checked={p.draft} onChange={(e) => p.onDraft(e.target.checked)} />
            Draft PR로 만들기
          </label>
        </div>
      </div>
    </>
  );
}

function LogLine({ e }: { e: RunEvent }) {
  switch (e.type) {
    case 'started':
      return <div className="line faint">{e.resume ? '— 같은 세션으로 수정 요청 —' : `— 새 세션 ${e.sessionId.slice(0, 8)} —`}</div>;
    case 'init':
      return e.model ? <div className="line faint">모델 {e.model}</div> : null;
    case 'tool':
      return <div className="line tool">· {e.name} {e.target}</div>;
    case 'tool-error':
      return <div className="line err">  ✕ {e.name}: {e.message}</div>;
    case 'text':
      return <div className="line txt">{e.text}</div>;
    case 'stderr':
      return <div className="line err">{e.text}</div>;
    case 'done':
      return (
        <div className={`line ${e.outcome === 'success' ? 'tool' : 'err'}`}>
          ■ {OUTCOME_LABEL[e.outcome]}
          {e.numTurns !== undefined && ` · ${e.numTurns}턴`}
          {e.costUsd !== undefined && ` · $${e.costUsd.toFixed(3)}`}
          {e.message && ` · ${e.message}`}
        </div>
      );
  }
}

function DiffView({ file }: { file?: ChangedFile }) {
  if (!file) return <div className="diff-empty">파일을 선택하세요.</div>;
  if (file.binary) return <div className="diff-empty">바이너리 파일이에요. 에디터에서 직접 확인하세요.</div>;
  if (!file.diff.trim()) return <div className="diff-empty">표시할 텍스트 변경이 없어요.</div>;
  return (
    <div className="diff" data-testid="diff">
      {file.diff.split('\n').map((l, i) => {
        let c = '';
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) c = 'meta';
        else if (l.startsWith('+')) c = 'add';
        else if (l.startsWith('-')) c = 'del';
        else if (l.startsWith('@@')) c = 'hunk';
        return <div key={i} className={`l ${c}`}>{l || ' '}</div>;
      })}
    </div>
  );
}

function NextBar(p: {
  snap: Snapshot;
  pkg?: PackageView;
  task?: TaskView;
  isPr: boolean;
  pr: PrView | null;
  idle: boolean;
  busy: boolean;
  lastDone?: DoneEvent;
  changes: ChangesView | null;
  commitDisabled: boolean;
  manualOk: boolean;
  prTitleOk: boolean;
  onStartPackage: (wp: string) => void;
  onPush: (wp: string) => void;
  onRun: () => void;
  onCommit: () => void;
  onCreatePr: () => void;
}) {
  const { snap, pkg, task } = p;
  const rv = snap.remote;
  let text = '';
  let button: React.ReactNode = null;

  if (!pkg) text = 'Work Package를 선택하세요.';
  else if (!pkg.isCurrentBranch) {
    text = pkg.branchExists ? `${pkg.branch} 브랜치로 전환하면 작업할 수 있어요.` : `${pkg.id}를 시작하면 최신 ${pkg.base}에서 ${pkg.branch} 브랜치를 만들어요.`;
    button = (
      <button className="primary" onClick={() => p.onStartPackage(pkg.id)} disabled={!p.idle} data-testid="start-wp">
        {pkg.branchExists ? '브랜치로 전환' : '작업 시작'}
      </button>
    );
  } else if (snap.running) text = 'Claude가 작업 중이에요. 끝나면 변경을 검토할 수 있어요.';
  else if (snap.verifying) text = '검증 명령을 실행하고 있어요.';
  else if (p.isPr) {
    if (p.pr?.existing?.state === 'OPEN') text = `PR #${p.pr.existing.number}이 열려 있어요. Merge는 GitHub에서 직접 하세요.`;
    else if (!pkg.allDone) text = '모든 작업을 Commit해야 PR을 만들 수 있어요.';
    else if (rv?.ahead) {
      text = `Push하지 않은 Commit이 ${rv.ahead}개 있어요.`;
      button = <button className="primary" onClick={() => p.onPush(pkg.id)} disabled={!p.idle} data-testid="push-next">Push</button>;
    } else if (p.pr && !p.pr.verify.passed) text = '통합 검증을 실행하세요.';
    else if (p.pr && p.pr.blockers.length) text = 'PR을 만들 수 없는 이유를 해결하세요.';
    else if (!p.manualOk) text = '사람이 확인할 항목을 체크하세요.';
    else text = 'PR을 만들 준비가 됐어요. 자동 Merge는 하지 않아요.';
    if (!button && p.pr?.existing?.state !== 'OPEN') {
      button = (
        <button className="primary" onClick={p.onCreatePr} disabled={!p.idle || !p.pr?.ready || !p.manualOk || !p.prTitleOk} data-testid="pr-create">
          PR 생성
        </button>
      );
    }
  } else if (!task) text = 'Commit Task를 선택하세요.';
  else if (task.state === 'done') text = '이 작업은 Commit됐어요. 다음 작업을 선택하세요.';
  else if (task.state === 'pending') text = '앞선 작업을 먼저 완료하세요.';
  else if (task.state === 'next') {
    if (snap.planOnlyDirty) text = '계획 파일 변경을 먼저 Commit하세요.';
    else if (!snap.clean) text = '커밋하지 않은 변경이 있어 실행할 수 없어요.';
    else if (rv?.behind) text = `원격에 로컬에 없는 Commit이 ${rv.behind}개 있어요. 먼저 받아오세요.`;
    else if (snap.mode === 'team' && rv?.hasRemote && rv.ahead > 0) {
      text = `team 모드: Push하지 않은 Commit ${rv.ahead}개를 Push한 뒤 실행해요.`;
      button = <button className="primary" onClick={() => p.onPush(pkg.id)} disabled={!p.idle} data-testid="push-next">Push</button>;
    } else text = `${task.id}를 Claude에게 맡길 준비가 됐어요.`;
    button ??= (
      <button className="primary" onClick={p.onRun} disabled={!p.idle || !snap.clean} data-testid="run">
        Claude 실행
      </button>
    );
  } else if (task.state === 'review') {
    const c = p.changes;
    if (p.lastDone && p.lastDone.outcome !== 'success') text = `Claude 실행이 ${OUTCOME_LABEL[p.lastDone.outcome]} 상태로 끝났어요. 변경을 검토하거나 수정 요청하세요.`;
    else if (c && c.blockers.length) text = c.blockers[0];
    else if (c && c.protectedFiles.length) text = '보호 경로 변경이 직접 작업한 것인지 확인하고 체크하세요.';
    else if (c && c.needsOutOfScopeApproval) text = '범위 밖 변경을 확인하고 승인하세요.';
    else if (!p.manualOk) text = '사람이 확인할 항목을 체크하세요.';
    else text = '변경과 검증 결과를 검토한 뒤 Commit을 승인하세요.';
    button = (
      <button className="primary" onClick={p.onCommit} disabled={p.commitDisabled} data-testid="commit">
        Commit 승인
      </button>
    );
  }

  return (
    <div className="nextbar">
      <span className="arrow">→</span>
      <span data-testid="next-text">{text}</span>
      <span className="spacer" />
      {button}
    </div>
  );
}
