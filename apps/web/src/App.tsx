import { Link, Route, Routes } from 'react-router-dom';
import { Layout } from './a11y/Layout';
import { RequireAuth, useAuth } from './auth';
import { Settings } from './screens/Settings';
import { OperatorSettings } from './screens/OperatorSettings';
import { Login } from './screens/Login';
import { Join } from './screens/Join';
import { Lobby } from './screens/Lobby';
import { Game } from './screens/Game';
import { ForgotPassword, ResetPassword } from './screens/ResetPassword';
import { Rooms } from './screens/Rooms';
import { Start } from './screens/Start';
import { Signup } from './screens/Signup';
import { CheckEmail, VerifyResult } from './screens/VerifyEmail';
import { CreationWizard } from './features/character/CreationWizard';
import { QuickBuild } from './features/character/QuickBuild';
import { SandboxCombat } from './routes/sandboxCombat';

function Landing() {
  const { account } = useAuth();
  return account ? (
    <>
      <h1>Welcome back, {account.displayName}</h1>
      <p>
        <Link to="/start">Start a solo game</Link>
      </p>
      <p>
        <Link to="/rooms">My games</Link>
      </p>
    </>
  ) : (
    <>
      <h1>Lorekeep-DM</h1>
      <p>
        <Link to="/signup">Sign up</Link> or <Link to="/login">log in</Link>.
      </p>
      <p>
        <Link to="/characters/new">Create a character</Link>
      </p>
    </>
  );
}

export function App() {
  return (
    <Routes>
      {import.meta.env.DEV && (
        <Route path="sandbox/combat" element={<SandboxCombat />} />
      )}
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="settings" element={<Settings />} />
        <Route path="operator" element={<OperatorSettings />} />
        <Route path="characters/new" element={<QuickBuild />} />
        <Route path="characters/edit" element={<CreationWizard />} />
        <Route path="signup" element={<Signup />} />
        <Route path="login" element={<Login />} />
        <Route path="check-email" element={<CheckEmail />} />
        <Route path="verify" element={<VerifyResult />} />
        <Route path="forgot" element={<ForgotPassword />} />
        <Route path="reset" element={<ResetPassword />} />
        <Route element={<RequireAuth />}>
          <Route path="rooms" element={<Rooms />} />
          <Route path="start" element={<Start />} />
          <Route path="rooms/:id" element={<Lobby />} />
          <Route path="rooms/:id/game" element={<Game />} />
          <Route path="join" element={<Join />} />
          <Route path="join/:code" element={<Join />} />
        </Route>
        <Route path="*" element={<h1>Page not found</h1>} />
      </Route>
    </Routes>
  );
}
