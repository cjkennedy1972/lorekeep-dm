import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

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
        <strong>Lorekeep-DM</strong>
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
      <main id="main" ref={main} tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
