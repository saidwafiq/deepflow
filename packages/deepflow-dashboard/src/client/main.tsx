import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './globals.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(<App />);
