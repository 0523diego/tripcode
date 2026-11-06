// Step 0 (找方向) page, #/idea/<id>: a globe fills the page, the question card floats over the left (where the day
// list appears later) and the AI panel is docked on the right. Everything on screen is rendered from idea.json.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../route.ts';
import { AgentPanel } from '../agent/AgentPanel.tsx';
import { sendMessage, useAgent } from '../agent/agent-store.ts';
import { Globe } from '../globe/Globe.tsx';
import { IdeaCard } from './IdeaCards.tsx';
import type { CardCtx, FinishForm } from './IdeaCards.tsx';
import { finishIdeaFile, useIdea } from './idea-store.ts';
import {
  AGENT_LABEL,
  LOCATE_PROMPT,
  MORE_PROMPT,
  SUGGEST_PROMPT,
  cardFor,
  chipsFor,
  ideaAgentContext,
  ideaFocus,
  ideaPins,
} from './idea-view.ts';
import type { CardStep } from './idea-view.ts';
import { markLanding, readLanding } from './landing.ts';

const MOBILE_MAX = 768;
/** If the globe never reports the end of the zoom, move on anyway. */
const ZOOM_FALLBACK_MS = 1800;

export function IdeaPage({ id }: { id: string }) {
  const { idea, status, error, busy, run, freeze } = useIdea(id);
  const agent = useAgent();
  const [agentOpen, setAgentOpen] = useState(() => window.innerWidth >= MOBILE_MAX);
  const [reopened, setReopened] = useState<CardStep | null>(null);
  const [hoverId, setHover] = useState<string | null>(null);
  const [pickedId, setPicked] = useState<string | null>(null);
  const [landing, setLanding] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  // ---- asking the AI panel ----
  const running = agent.active?.status === 'running';
  const [pending, setPending] = useState(false);
  const sawRunning = useRef(false);
  const placesCount = idea?.places.length ?? 0;
  useEffect(() => setPending(false), [placesCount]); // the answer landed in the file
  useEffect(() => {
    if (!pending) return;
    if (running) sawRunning.current = true;
    else if (sawRunning.current) {
      sawRunning.current = false;
      setPending(false); // the agent finished without adding places: let the user ask again
    }
  }, [pending, running]);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => !sawRunning.current && setPending(false), 25_000); // never saw it start
    return () => clearTimeout(t);
  }, [pending]);

  const ask = useCallback(
    async (kind: 'suggest' | 'more' | 'locate') => {
      if (kind === 'more' && !(await run({ op: 'reject-round' }))) return;
      sawRunning.current = false;
      setPending(true);
      setAgentOpen(true);
      const ok = await sendMessage(kind === 'suggest' ? SUGGEST_PROMPT : kind === 'more' ? MORE_PROMPT : LOCATE_PROMPT, ideaAgentContext(id));
      if (!ok) setPending(false);
    },
    [id, run],
  );

  // ---- 建立行程: the globe zooms in first, then the trip is created and opened ----
  // (Vite reloads the page as soon as trip.ts appears, which would cut the zoom short if the trip were created first.)
  const [leaving, setLeaving] = useState<FinishForm | null>(null);
  const committed = useRef(false);
  const opened = useRef(false);
  const openTrip = useCallback((tripId: string) => {
    if (opened.current) return;
    opened.current = true;
    go(`/trip/${tripId}`);
  }, []);
  const commit = useCallback(
    async (f: FinishForm) => {
      if (committed.current) return;
      committed.current = true;
      freeze(true); // idea.json moves into the new trip folder: do not read the old path again
      setFinishing(true);
      const r = await finishIdeaFile(id, { title: f.title, tz: f.tz, adults: f.adults, childrenAges: f.childrenAges });
      setFinishing(false);
      if (!r.ok || !r.tripId) {
        committed.current = false;
        freeze(false);
        setLeaving(null); // fly back out and show why
        return setFinishError(r.error ?? '建立失敗');
      }
      markLanding(id, r.tripId);
      setLanding(r.tripId);
      openTrip(r.tripId);
    },
    [id, openTrip, freeze],
  );
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => void commit(leaving), ZOOM_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [leaving, commit]);

  // The page may have been reloaded by Vite right after the trip files appeared: idea.json is gone, the marker says where it went.
  const remembered = status === 'missing' ? readLanding() : null;
  const goneTo = remembered && remembered.ideaId === id ? remembered.tripId : null;
  useEffect(() => {
    if (goneTo) openTrip(goneTo);
  }, [goneTo, openTrip]);
  // Opened an idea that already has a trip (e.g. the AI ran `idea finish`).
  const doneTrip = idea?.tripId ?? null;
  useEffect(() => {
    if (doneTrip) {
      markLanding(id, doneTrip);
      openTrip(doneTrip);
    }
  }, [doneTrip, id, openTrip]);

  const finish = useCallback(async (f: FinishForm) => {
    setFinishError(null);
    setLeaving(f);
  }, []);

  // ---- card plumbing ----
  const answer = useCallback(
    async (field: string, value: unknown) => {
      const ok = await run({ op: 'answer', field, value });
      if (ok) setReopened(null);
      return ok;
    },
    [run],
  );
  const runOp = useCallback(
    async (body: Record<string, unknown>) => {
      const ok = await run(body);
      if (ok) setReopened(null);
      return ok;
    },
    [run],
  );

  const step = idea ? cardFor(idea, reopened) : null;
  const ctx: CardCtx | null = idea
    ? {
        idea,
        busy: busy || finishing,
        error: finishError ?? error,
        reopened: reopened !== null,
        cancelReopen: () => setReopened(null),
        answer,
        run: runOp,
        ask,
        thinking: pending || running,
        agentReady: !!(agent.status?.enabled && agent.status.sdkInstalled),
        openAgent: () => setAgentOpen(true),
        hoverId,
        setHover,
        pickedId,
        finish,
      }
    : null;

  // Move keyboard focus to the new card's title when the card changes (not on first paint).
  const stageRef = useRef<HTMLDivElement>(null);
  const lastStep = useRef<string | null>(null);
  useEffect(() => {
    const stage = stageRef.current;
    // An input that autofocused itself keeps the focus; otherwise (the clicked button is gone) the title takes it.
    if (step && lastStep.current && lastStep.current !== step && stage && !stage.contains(document.activeElement)) {
      stage.querySelector<HTMLElement>('.idea-card__title')?.focus({ preventScroll: true });
    }
    lastStep.current = step;
  }, [step]);

  // Leaving the choose card (chosen, rejected all, reopened another card) drops its hover / pin highlight.
  useEffect(() => {
    if (step !== 'choose') {
      setHover(null);
      setPicked(null);
    }
  }, [step]);

  const onPinClick = useCallback((placeId: string) => {
    setHover(placeId);
    setPicked(placeId);
    const el = document.getElementById(`idea-place-${placeId}`);
    el?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, []);

  const pins = useMemo(() => (idea && !leaving ? ideaPins(idea, hoverId) : []), [idea, hoverId, leaving]);
  const focus = useMemo(() => (idea ? ideaFocus(idea, leaving ? null : hoverId) : null), [idea, hoverId, leaving]);

  const chips = idea ? chipsFor(idea) : [];
  const gone = status === 'missing' && !goneTo && !landing && !leaving;

  return (
    <div className="idea-page" data-agent={agentOpen} data-leaving={leaving !== null}>
      <Globe className="idea-globe" pins={pins} focus={focus} zoomIn={leaving !== null} onZoomDone={() => leaving && void commit(leaving)} onPinClick={onPinClick} />

      <div className="idea-col">
        <header className="idea-head">
          <a className="idea-back" href="#/">
            ‹ 你的旅程
          </a>
          <h1>新的旅程</h1>
        </header>

        {chips.length > 0 && (
          <ul className="idea-chips" aria-label="已回答的問題">
            {chips.map((c) => (
              <li key={c.key}>
                {c.target ? (
                  <button type="button" className="idea-chip" aria-current={reopened === c.target ? 'step' : undefined} onClick={() => setReopened(c.target)} title="改這個答案">
                    {c.text}
                  </button>
                ) : (
                  <span className="idea-chip idea-chip--fixed">{c.text}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="idea-stage" ref={stageRef} aria-live="polite">
          {status === 'loading' && <p className="idea-state">載入中…</p>}
          {status === 'error' && <p className="idea-state idea-error" role="alert">{error}</p>}
          {gone && (
            <div className="idea-card">
              <h2 className="idea-card__title">找不到這個想法</h2>
              <p className="idea-card__lead">它可能已經變成行程，或還沒建立。</p>
              <a className="idea-primary" href="#/">
                回到你的旅程
              </a>
            </div>
          )}
          {(goneTo || landing || doneTrip) && <p className="idea-state idea-opening">正在打開行程…</p>}
          {ctx && step && step !== 'done' && !landing && !doneTrip && (
            <div className="idea-swap" key={step}>
              <IdeaCard step={step} ctx={ctx} />
            </div>
          )}
        </div>
      </div>

      {agentOpen ? (
        <div className="idea-agent">
          <AgentPanel context={ideaAgentContext(id)} contextLabel={AGENT_LABEL} onClose={() => setAgentOpen(false)} />
        </div>
      ) : (
        <button type="button" className="idea-agent-btn" onClick={() => setAgentOpen(true)}>
          AI 助手
        </button>
      )}
    </div>
  );
}
