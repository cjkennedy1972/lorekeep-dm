import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

export function Layout() {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const first = useRef(true);
  // Move focus to <main> on client-side navigation so screen readers announce the new page.
  useEffect(() => {
    if (first.current) first.current = false;
    else main.current?.focus();
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
