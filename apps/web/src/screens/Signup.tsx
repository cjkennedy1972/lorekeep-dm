import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Field, focusFirstError } from './Field';

// Terms and Privacy Notice are accepted as one versioned document (server field `termsVersion`).
const TERMS_VERSION = '2026-10-01';
const ORDER = [
  'email',
  'displayName',
  'password',
  'birthdate',
  'terms',
  'adult',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function Signup() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const [v, setV] = useState({
    email: '',
    displayName: '',
    password: '',
    birthdate: '',
  });
  const [terms, setTerms] = useState(false);
  const [adult, setAdult] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!v.email.includes('@')) next.email = 'Enter a valid email address.';
    if (!v.displayName.trim()) next.displayName = 'Enter a display name.';
    if (v.password.length < 12) next.password = 'Use at least 12 characters.';
    // Format only: whether the date makes someone 18+ is decided by the server.
    if (!DATE_RE.test(v.birthdate) || Number.isNaN(Date.parse(v.birthdate)))
      next.birthdate = 'Enter your date of birth as YYYY-MM-DD.';
    if (!terms) next.terms = 'Accept the Terms and Privacy Notice to continue.';
    if (!adult) next.adult = 'Confirm that you are 18 or older to continue.';
    setErrors(next);
    setFormError('');
    if (Object.keys(next).length) return focusFirstError(ORDER, next);

    setBusy(true);
    const r = await api('/api/signup', {
      email: v.email.trim(),
      password: v.password,
      displayName: v.displayName.trim(),
      birthdate: v.birthdate,
      termsVersion: TERMS_VERSION,
    });
    setBusy(false);
    // Neither the birthdate nor the password outlives the request.
    setV({ ...v, birthdate: '', password: '' });
    if (r.ok) return navigate('/check-email', { state });
    if (r.code === 'UNDERAGE') return setRefusal(r.message);
    setFormError(r.message);
  }

  if (refusal)
    return (
      <>
        <h1>We can’t create this account</h1>
        <p role="alert">{refusal}</p>
      </>
    );

  return (
    <>
      <h1>Create your account</h1>
      <form onSubmit={submit} noValidate className="form">
        {formError && (
          <p role="alert" className="form-error">
            {formError}
          </p>
        )}
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={v.email}
          onChange={set('email')}
          error={errors.email}
          required
        />
        <Field
          id="displayName"
          label="Display name"
          autoComplete="nickname"
          maxLength={80}
          value={v.displayName}
          onChange={set('displayName')}
          error={errors.displayName}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
          value={v.password}
          onChange={set('password')}
          error={errors.password}
          required
        />
        <Field
          id="birthdate"
          label="Date of birth"
          type="date"
          autoComplete="off"
          placeholder="YYYY-MM-DD"
          pattern="\d{4}-\d{2}-\d{2}"
          hint="You must be 18 or older. If your browser shows a plain text box, type YYYY-MM-DD. We use it once to check your age and do not keep it."
          value={v.birthdate}
          onChange={set('birthdate')}
          error={errors.birthdate}
          required
        />
        <div className="field">
          <div className="checkbox">
            <input
              id="terms"
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              aria-invalid={errors.terms ? true : undefined}
              aria-describedby={errors.terms ? 'terms-error' : undefined}
            />
            <label htmlFor="terms">
              I accept the Terms and Privacy Notice (version {TERMS_VERSION}).
            </label>
          </div>
          {errors.terms && (
            <p id="terms-error" className="field-error" role="alert">
              {errors.terms}
            </p>
          )}
        </div>
        <div className="field">
          <div className="checkbox">
            <input
              id="adult"
              type="checkbox"
              checked={adult}
              onChange={(e) => setAdult(e.target.checked)}
              aria-invalid={errors.adult ? true : undefined}
              aria-describedby={errors.adult ? 'adult-error' : undefined}
            />
            <label htmlFor="adult">
              I confirm that I am 18 years or older.
            </label>
          </div>
          {errors.adult && (
            <p id="adult-error" className="field-error" role="alert">
              {errors.adult}
            </p>
          )}
        </div>
        <button type="submit" disabled={busy}>
          Create account
        </button>
      </form>
      <p>
        Already have an account?{' '}
        <Link to="/login" state={state}>
          Log in
        </Link>
      </p>
    </>
  );
}
