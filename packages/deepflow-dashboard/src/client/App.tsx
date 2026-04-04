import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardProvider, type DashboardMode } from './context/DashboardContext';
import { useTheme } from './hooks/useTheme';
import { CostOverview } from './views/CostOverview';
import { SessionList } from './views/SessionList';
import { CacheEfficiency } from './views/CacheEfficiency';
import { ActivityHeatmap } from './views/ActivityHeatmap';
import { ModelDonut } from './views/ModelDonut';
import { CostStacked } from './views/CostStacked';
import { PeakHours } from './views/PeakHours';
import { QuotaStatus } from './views/QuotaStatus';
import { TokenByTool } from './views/TokenByTool';

/* ---------------------------------------------------------------------------
 * Layout — sidebar + header + main content
 * --------------------------------------------------------------------------- */
function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col min-h-screen lg:ml-[280px]">
        {/* Header */}
        <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />
        {/* Main */}
        <main className="flex-1 overflow-auto p-4 md:p-6 bg-[var(--bg)]">
          <Routes>
            <Route path="/" element={<CostOverview />} />
            <Route path="/sessions" element={<SessionList />} />
            <Route path="/quota" element={<QuotaStatus />} />
            <Route path="/tools" element={<TokenByTool />} />
            <Route path="/costs" element={<CostOverview />} />
            <Route path="/cache" element={<CacheEfficiency />} />
            <Route path="/activity" element={<ActivityHeatmap />} />
            <Route path="/models" element={<ModelDonut />} />
            <Route path="/cost-stacked" element={<CostStacked />} />
            <Route path="/peak-hours" element={<PeakHours />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * App root — reads mode from window.__DASHBOARD_MODE__ injected by the server.
 * --------------------------------------------------------------------------- */
declare global {
  interface Window {
    __DASHBOARD_MODE__?: DashboardMode;
  }
}

export function App() {
  useTheme();

  const mode: DashboardMode =
    typeof window !== 'undefined' && window.__DASHBOARD_MODE__ === 'team'
      ? 'team'
      : 'local';

  return (
    <DashboardProvider mode={mode}>
      <BrowserRouter>
        <Layout />
      </BrowserRouter>
    </DashboardProvider>
  );
}
