import { useEffect, useState } from 'react';
import type { RoundSnapshot } from '@game/schema';
import { secondsLeft } from '../round/RoundPanel.js';
import { initialsOf } from '../map/names.js';
import './turn-banner.css';

type Props = {
  round: number;
  /** Name of the creature acting now; null when an unseen creature is acting. */
  activeName: string | null;
  yourTurn: boolean;
  initiative: readonly { entityId: string; name: string; active: boolean }[];
  /** The collect-then-resolve round, when the table runs one; its deadline is the only clock the client knows. */
  roundClock?: RoundSnapshot;
  outcome?: string;
};

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Prominent "whose turn is it" strip above the map and story. Names only; the full tracker lives in the sidebar. */
export function TurnBanner({
  round,
  activeName,
  yourTurn,
  initiative,
  roundClock,
  outcome,
}: Props) {
  const ticking = Boolean(roundClock?.deadlineAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const left = roundClock ? secondsLeft(roundClock, now) : null;
  return (
    <div
      className="turn-banner"
      data-your-turn={yourTurn}
      data-ended={Boolean(outcome)}
    >
      <p className="turn-banner__round">
        <span className="turn-banner__kicker">Round</span>
        <span className="turn-banner__number">{round}</span>
      </p>
      <p className="turn-banner__turn">
        <span className="turn-banner__kicker">
          {outcome ? 'Combat over' : yourTurn ? 'Your turn' : 'Now acting'}
        </span>
        <strong className="turn-banner__who">
          {outcome ?? activeName ?? 'An unseen creature'}
        </strong>
      </p>
      {/* The sidebar tracker is the accessible list; these chips are a glanceable copy. */}
      <ul className="turn-banner__order" aria-hidden="true">
        {initiative.map((item) => (
          <li key={item.entityId} data-active={item.active} title={item.name}>
            <span className="turn-banner__chip">{initialsOf(item.name)}</span>
            <span className="turn-banner__chip-name">{item.name}</span>
          </li>
        ))}
      </ul>
      {left !== null && (
        <p className="turn-banner__clock">
          <span className="turn-banner__kicker">Round timer</span>
          <span className="turn-banner__time">{formatTime(left)}</span>
        </p>
      )}
    </div>
  );
}
