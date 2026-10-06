import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Field } from './Field';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) {
      setError('Enter a valid email address.');
      return document.getElementById('email')?.focus();
    }
    setError('');
    const r = await api('/api/password/forgot', { email: email.trim() });
    if (r.ok) return setSent(true);
    setError(r.message);
  }

  if (sent)
    return (
      <>
        <h1>Check your email</h1>
        <p role="status">
          If an account exists for that address, we have sent a link to reset
          the password. It expires in 1 hour.
        </p>
        <p>
          <Link to="/login">Back to log in</Link>
        </p>
      </>
    );
  return (
    <>
      <h1>Reset your password</h1>
      <form onSubmit={submit} noValidate className="form">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
          required
        />
        <button type="submit">Send reset link</button>
      </form>
    </>
  );
}

export function ResetPassword() {
  const token = useSearchParams()[0].get('token');
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  if (!token)
    return (
      <>
        <h1>Choose a new password</h1>
        <p role="alert">
          This reset link is incomplete.{' '}
          <Link to="/forgot">Request a new one</Link>
        </p>
      </>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    if (password.length < 12) {
      setError('Use at least 12 characters.');
      return document.getElementById('password')?.focus();
    }
    setError('');
    const r = await api('/api/password/reset', { token, password });
    if (r.ok) return navigate('/login', { replace: true });
    setFormError(r.message);
  }

  return (
    <>
      <h1>Choose a new password</h1>
      <form onSubmit={submit} noValidate className="form">
        {formError && (
          <p role="alert" className="form-error">
            {formError} <Link to="/forgot">Request a new link</Link>
          </p>
        )}
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          required
        />
        <button type="submit">Set new password</button>
      </form>
    </>
  );
}
