import { Link, Route, Routes } from 'react-router-dom';
import { Layout } from './a11y/Layout';
import { RequireAuth } from './auth';
import { Settings } from './screens/Settings';
import { Login } from './screens/Login';
import { Join } from './screens/Join';
import { Lobby } from './screens/Lobby';
import { ForgotPassword, ResetPassword } from './screens/ResetPassword';
import { Rooms } from './screens/Rooms';
import { Signup } from './screens/Signup';
import { CheckEmail, VerifyResult } from './screens/VerifyEmail';
import { CreationWizard } from './features/character/CreationWizard';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            <>
              <h1>Lorekeep-DM</h1>
              <p>
                <Link to="/signup">Sign up</Link> or{' '}
                <Link to="/login">log in</Link>.
              </p>
              <p>
                <Link to="/characters/new">Create a character</Link>
              </p>
            </>
          }
        />
        <Route path="settings" element={<Settings />} />
        <Route path="characters/new" element={<CreationWizard />} />
        <Route path="signup" element={<Signup />} />
        <Route path="login" element={<Login />} />
        <Route path="check-email" element={<CheckEmail />} />
        <Route path="verify" element={<VerifyResult />} />
        <Route path="forgot" element={<ForgotPassword />} />
        <Route path="reset" element={<ResetPassword />} />
        <Route element={<RequireAuth />}>
          <Route path="rooms" element={<Rooms />} />
          <Route path="rooms/:id" element={<Lobby />} />
          <Route path="join" element={<Join />} />
          <Route path="join/:code" element={<Join />} />
        </Route>
        <Route path="*" element={<h1>Page not found</h1>} />
      </Route>
    </Routes>
  );
}
