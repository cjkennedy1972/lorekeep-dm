import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyPrefs, loadPrefs } from './a11y/prefs';
import { AuthProvider } from './auth';
import './styles/tokens.css';
import './styles/forms.css';

applyPrefs(loadPrefs());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      {window.location.pathname.startsWith('/sandbox/') ? (
        <App />
      ) : (
        <AuthProvider>
          <App />
        </AuthProvider>
      )}
    </BrowserRouter>
  </StrictMode>,
);
