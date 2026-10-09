import { useState } from 'react';
import { ActionInput } from './ActionInput.js';

/** Vite-only browser fixture for responsive and pending-state acceptance. */
export function InputFixture() {
  const [pending, setPending] = useState(false);
  return (
    <main style={{ padding: '0.5rem' }}>
      <ActionInput onSubmit={() => setPending(true)} pending={pending} />
    </main>
  );
}
