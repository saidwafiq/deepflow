import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';

/* ---------------------------------------------------------------------------
 * SVG Icons (24x24 inline)
 * --------------------------------------------------------------------------- */
function IconHome() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.75L12 3l9 6.75V21a.75.75 0 0 1-.75.75H15v-5.25a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0-.75.75V21.75H3.75A.75.75 0 0 1 3 21V9.75z" />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconDatabase() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v4c0 1.657 4.03 3 9 3s9-1.343 9-3V5" />
      <path d="M3 9v4c0 1.657 4.03 3 9 3s9-1.343 9-3V9" />
      <path d="M3 13v4c0 1.657 4.03 3 9 3s9-1.343 9-3v-4" />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 15" />
    </svg>
  );
}

function IconDollar() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6" />
    </svg>
  );
}

function IconGauge() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 12 17 7" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconWrench() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconPieChart() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </svg>
  );
}

function IconBarChart() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Nav structure — two groups
 * --------------------------------------------------------------------------- */
const ANALYTICS_ITEMS = [
  { to: '/', label: 'Overview', exact: true, Icon: IconHome },
  { to: '/sessions', label: 'Sessions', Icon: IconList },
  { to: '/cache', label: 'Cache', Icon: IconDatabase },
  { to: '/activity', label: 'Activity', Icon: IconCalendar },
  { to: '/peak-hours', label: 'Peak Hours', Icon: IconClock },
];

const DATA_ITEMS = [
  { to: '/costs', label: 'Costs', Icon: IconDollar },
  { to: '/quota', label: 'Quota', Icon: IconGauge },
  { to: '/tools', label: 'Token Usage', Icon: IconWrench },
  { to: '/models', label: 'Model Distribution', Icon: IconPieChart },
  { to: '/cost-stacked', label: 'Cost Breakdown', Icon: IconBarChart },
];

/* ---------------------------------------------------------------------------
 * Props
 * --------------------------------------------------------------------------- */
interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

/* ---------------------------------------------------------------------------
 * NavItem
 * --------------------------------------------------------------------------- */
function NavItem({
  to,
  label,
  exact,
  Icon,
  onClose,
}: {
  to: string;
  label: string;
  exact?: boolean;
  Icon: () => JSX.Element;
  onClose: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={exact}
      onClick={onClose}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-6 py-2.5 text-sm font-medium transition-colors',
          isActive
            ? 'border-l-4 border-primary bg-white/5 text-white'
            : 'border-l-4 border-transparent text-gray-400 hover:bg-white/5 hover:text-white',
        )
      }
    >
      <Icon />
      {label}
    </NavLink>
  );
}

/* ---------------------------------------------------------------------------
 * Sidebar
 * --------------------------------------------------------------------------- */
export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <>
      {/* Overlay backdrop for mobile */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col bg-sidebar transition-transform duration-300',
          'lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Logo area */}
        <div className="flex items-center px-6 py-6">
          <span className="text-xl font-bold tracking-tight text-white">Deepflow</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto">
          {/* ANALYTICS group */}
          <div className="mb-2 mt-4">
            <p className="mb-2 px-6 text-xs font-medium uppercase tracking-wider text-gray-500">
              Analytics
            </p>
            {ANALYTICS_ITEMS.map(({ to, label, exact, Icon }) => (
              <NavItem key={to} to={to} label={label} exact={exact} Icon={Icon} onClose={onClose} />
            ))}
          </div>

          {/* DATA group */}
          <div className="mb-2 mt-4">
            <p className="mb-2 px-6 text-xs font-medium uppercase tracking-wider text-gray-500">
              Data
            </p>
            {DATA_ITEMS.map(({ to, label, Icon }) => (
              <NavItem key={to} to={to} label={label} Icon={Icon} onClose={onClose} />
            ))}
          </div>
        </nav>
      </aside>
    </>
  );
}
