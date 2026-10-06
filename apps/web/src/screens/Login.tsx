import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type Account } from '../api';
import { useAuth, useReturnTo } from '../auth';
import { Field, focusFirstError } from './Field';

export function Login() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const returnTo = useReturnTo();
  const { setAccount } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length)
      return focusFirstError(['email', 'password'], next);
    const r = await api<{ account: Account }>('/api/login', {
      email: email.trim(),
      password,
    });
    if (r.ok) {
      setAccount(r.data.account);
      return navigate(returnTo, { replace: true });
    }
    setPassword('');
    // One message for unknown email and wrong password; it describes both fields.
    setFormError(r.message);
    document.getElementById('email')?.focus();
  }

  const both = formError ? 'login-error' : undefined;
  return (
    <>
      <h1>Log in</h1>
      <form onSubmit={submit} noValidate className="form">
        {formError && (
          <p id="login-error" role="alert" className="form-error">
            {formError}
          </p>
        )}
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          describedBy={both}
          invalid={!!formError}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          describedBy={both}
          invalid={!!formError}
          required
        />
        <button type="submit">Log in</button>
      </form>
      <p>
        <Link to="/forgot">Forgot your password?</Link>
      </p>
      <p>
        New here?{' '}
        <Link to="/signup" state={state}>
          Create an account
        </Link>
      </p>
    </>
  );
}
