import { useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Field } from './Field';

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
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<'form' | 'pending' | 'ok' | 'failed'>(
    token ? 'form' : 'failed',
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 12) {
      setError('Use at least 12 characters.');
      return document.getElementById('password')?.focus();
    }
    setError('');
    setResult('pending');
    const r = await api('/api/verify-email', { token, password });
    setResult(r.ok ? 'ok' : 'failed');
  }

  return (
    <>
      <h1>Email verification</h1>
      {result === 'form' && (
        <form onSubmit={submit} noValidate className="form">
          <p>Choose the password you will use to log in to this account.</p>
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error}
            required
          />
          <button type="submit">Verify email</button>
        </form>
      )}
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
