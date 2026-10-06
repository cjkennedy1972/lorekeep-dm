import { Route, Routes } from 'react-router-dom';
import { Layout } from './a11y/Layout';
import { RequireAuth } from './auth';
import { Settings } from './routes/Settings';
import { Join } from './screens/Join';
import { Lobby } from './screens/Lobby';
import { Rooms } from './screens/Rooms';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<h1>Lorekeep-DM</h1>} />
        <Route path="settings" element={<Settings />} />
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
