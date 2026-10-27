import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

/** Auth-style pages get a narrow card, the game gets the whole viewport, everything else a wide card. */
function mainClass(pathname: string): string {
  if (/^\/rooms\/[^/]+\/game\/?$/.test(pathname)) return 'main--game';
  if (
    /^\/(login|signup|forgot|reset|check-email|verify|join)(\/|$)/.test(
      pathname,
    )
  )
    return 'main--card';
  return 'main--wide';
}

export function Layout() {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const shown = useRef(pathname);
  // Move focus to <main> on client-side navigation so screen readers announce the new page.
  useEffect(() => {
    // Compare paths (not a first-run flag) so StrictMode's double effect cannot steal focus on load.
    if (shown.current === pathname) return;
    shown.current = pathname;
    main.current?.focus();
  }, [pathname]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <strong className="app-brand">
          <svg
            className="app-brand__mark"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              d="M12 2c1.6 3 4.6 4.9 4.6 8.6A4.6 4.6 0 0 1 12 15.2a4.6 4.6 0 0 1-4.6-4.6c0-1.5.6-2.7 1.4-3.7.3 1.2 1 1.9 1.7 2.2C10.3 6.2 10.7 3.8 12 2Zm-3.5 15.2h7a1 1 0 0 1 1 1V20a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-1.8a1 1 0 0 1 1-1Z"
            />
          </svg>
          Lorekeep-DM
        </strong>
        <nav className="app-nav" aria-label="Primary">
          <ul>
            <li>
              <NavLink to="/" end>
                Home
              </NavLink>
            </li>
            <li>
              <NavLink to="/rooms">My tables</NavLink>
            </li>
            <li>
              <NavLink to="/settings">Settings</NavLink>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" ref={main} tabIndex={-1} className={mainClass(pathname)}>
        <Outlet />
      </main>
    </>
  );
}
