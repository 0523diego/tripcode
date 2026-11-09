import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
// Section stylesheets, in cascade order. Each file names its owner in its header.
import './styles/rail.css';
import './styles/itinerary.css';
import './styles/facts.css';
import './styles/inbox.css';
import './styles/map.css';
import './styles/panels.css';
import './styles/forms.css';
import './styles/home.css';
import './styles/agent.css';
import './styles/office.css';
import './styles/food.css';
import './styles/inline.css';
import './styles/idea.css';
import './styles/daycolor.css';
import './styles/mobile.css';
import './styles/print-doc.css';
import './styles/print-page.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Offline viewing: register the hand-written service worker in production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}
