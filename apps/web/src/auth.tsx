import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { api, type Account } from './api';

interface Auth {
  /** undefined while the session check is in flight, null when signed out. */
  account: Account | null | undefined;
  setAccount: (a: Account | null) => void;
}
const AuthContext = createContext<Auth>({
  account: null,
  setAccount: () => {},
});
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>();
  useEffect(() => {
    let live = true;
    void api<{ account: Account }>('/api/me').then((r) => {
      if (live) setAccount(r.ok ? r.data.account : null);
    });
    return () => void (live = false);
  }, []);
  const value = useMemo(() => ({ account, setAccount }), [account]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

/** Layout route: signed-out visitors go to login and come back to where they were headed. */
export function RequireAuth() {
  const { account } = useAuth();
  const here = useLocation();
  if (account === undefined) return <p role="status">Checking your session…</p>;
  if (!account)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: here.pathname + here.search }}
      />
    );
  return <Outlet />;
}

/** Where to go after login/signup: the page that bounced us, else My tables. */
export function useReturnTo(): string {
  const from = (useLocation().state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') ? from : '/rooms';
}
