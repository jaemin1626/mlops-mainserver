import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { installWebFsBridge } from './webFsBridge';

installWebFsBridge();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
