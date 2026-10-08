import {
  describe,
  threatsWithin,
  type DescribeVerbosity,
} from '@game/rules-engine';
import { useEffect, useMemo, useState } from 'react';
import { gameStore, type GameState } from '../../state/gameStore.js';

type Props = { store?: typeof gameStore; viewerId?: string };

/** On-demand battlefield prose and once-per-active-turn combat status. */
export function Describe({ store = gameStore, viewerId }: Props) {
  const [state, setState] = useState<GameState>(() => store.getState());
  const [verbosity, setVerbosity] = useState<DescribeVerbosity>('standard');
  const [text, setText] = useState('');
  const activeId = state.combat.activeEntityId;
  const viewer = viewerId ?? activeId;
  const resources = viewer ? state.combat.resources[viewer] : undefined;
  const descriptionState = useMemo(
    () =>
      state.battlemap && {
        map: state.battlemap,
        entities: state.mapEntities.map((entity) => ({
          ...entity,
          team: entity.team ?? entity.kind,
        })),
        activeEntityId: activeId,
        resources: Object.fromEntries(
          Object.entries(state.combat.resources).map(([id, value]) => [
            id,
            { movementRemaining: value.movementRemaining },
          ]),
        ),
      },
    [state, activeId],
  );
  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  const turnKey = `${state.combat.round}:${activeId ?? ''}`;
  const [turnAnnouncement, setTurnAnnouncement] = useState('');
  useEffect(() => {
    if (!activeId || !state.battlemap) {
      setTurnAnnouncement('');
      return;
    }
    setTurnAnnouncement(
      `${activeId}: ${resources?.movementRemaining ?? 0} feet movement remaining. Threats within 30 feet: ${threatsWithin({ map: state.battlemap, entities: state.mapEntities.map((entity) => ({ ...entity, team: entity.team ?? entity.kind })) }, activeId)}.`,
    );
    // This effect is keyed only to the turn identity: movement/event renders do not re-announce.
  }, [turnKey]);
  const renderDescription = () => {
    if (!descriptionState || !viewer) return;
    setText(describe(descriptionState, viewer, { verbosity }));
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        renderDescription();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <section aria-label="Battlefield description">
      <label>
        Description detail
        <select
          value={verbosity}
          onChange={(event) =>
            setVerbosity(event.target.value as DescribeVerbosity)
          }
        >
          <option value="brief">Brief</option>
          <option value="standard">Standard</option>
          <option value="full">Full</option>
        </select>
      </label>
      <button type="button" onClick={renderDescription}>
        Describe battlefield (Alt+D)
      </button>
      <p aria-live="polite" aria-atomic="true">
        {text}
      </p>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-turn-key={turnKey}
      >
        {turnAnnouncement}
      </div>
    </section>
  );
}
