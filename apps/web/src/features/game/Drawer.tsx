import { useState, type ReactNode } from 'react';

const key = (id: string) => `lorekeep.drawer.${id}`;
const read = (id: string) => {
  try {
    return localStorage.getItem(key(id)) === 'open';
  } catch {
    return false;
  }
};

/**
 * A native <details> disclosure (keyboard and screen-reader support for free) whose open state is
 * remembered per drawer, so a host who opens the host tools keeps them open across reloads.
 */
export function Drawer({
  id,
  title,
  badge,
  children,
}: {
  id: string;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => read(id));
  return (
    <details
      className="drawer"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(key(id), next ? 'open' : 'closed');
        } catch {
          // Storage can be blocked; the drawer still works for this visit.
        }
      }}
    >
      <summary>
        <span>{title}</span>
        {badge !== undefined && <span className="drawer__badge">{badge}</span>}
      </summary>
      <div className="drawer__body">{children}</div>
    </details>
  );
}
