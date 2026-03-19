import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setHealth({ error: e.message }));
  }, []);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>Deepflow Dashboard</h1>
      <p>Hono + Vite React SPA spike</p>
      {health ? (
        <pre style={{ background: '#f4f4f4', padding: '1rem', borderRadius: '4px' }}>
          {JSON.stringify(health, null, 2)}
        </pre>
      ) : (
        <p>Loading health check...</p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
