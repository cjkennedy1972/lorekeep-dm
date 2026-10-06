import { Route, Routes } from 'react-router-dom';
import { Layout } from './a11y/Layout';
import { Settings } from './routes/Settings';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<h1>Lorekeep-DM</h1>} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<h1>Page not found</h1>} />
      </Route>
    </Routes>
  );
}
