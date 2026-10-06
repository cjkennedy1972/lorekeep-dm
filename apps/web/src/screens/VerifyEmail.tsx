import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api';

export function CheckEmail() {
  const { state } = useLocation();
  return (
    <>
      <h1>Check your email</h1>
      <p>
        If you are eligible to create an account, we have sent a verification
        link to your email address. It expires in 24 hours.
      </p>
      <p>
        <Link to="/login" state={state}>
          Go to log in
        </Link>
      </p>
    </>
  );
}

export function VerifyResult() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [result, setResult] = useState<'pending' | 'ok' | 'failed'>(
    token ? 'pending' : 'failed',
  );
  const sent = useRef(false); // the token is single-use; StrictMode must not spend it twice
  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    void api('/api/verify-email', { token }).then((r) =>
      setResult(r.ok ? 'ok' : 'failed'),
    );
  }, [token]);

  return (
    <>
      <h1>Email verification</h1>
      {result === 'pending' && <p role="status">Verifying your email…</p>}
      {result === 'ok' && (
        <p role="status">
          Your email is verified. <Link to="/login">Log in</Link>
        </p>
      )}
      {result === 'failed' && (
        <p role="alert">
          This verification link is invalid or has expired.{' '}
          <Link to="/signup">Create an account again</Link>
        </p>
      )}
    </>
  );
}
