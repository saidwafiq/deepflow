import { useLocation } from 'react-router-dom';
import { cn } from '../lib/utils';
import { useTheme } from '../hooks/useTheme';
import { UserFilter } from './UserFilter';

/* ---------------------------------------------------------------------------
 * Route → breadcrumb label mapping (mirrors NAV_ITEMS in Sidebar)
 * --------------------------------------------------------------------------- */
const ROUTE_LABELS: Record<string, string> = {
  '/': 'Overview',
  '/sessions': 'Sessions',
  '/quota': 'Quota',
  '/tools': 'Tokens by Tool',
  '/costs': 'Costs',
  '/cache': 'Cache',
  '/activity': 'Activity',
  '/models': 'Models',
  '/cost-stacked': 'Cost by Day',
  '/peak-hours': 'Peak Hours',
};

/* ---------------------------------------------------------------------------
 * Sun icon (light mode indicator)
 * --------------------------------------------------------------------------- */
function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Moon icon (dark mode indicator)
 * --------------------------------------------------------------------------- */
function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Hamburger icon
 * --------------------------------------------------------------------------- */
function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Header component
 * Props:
 *   onToggleSidebar — called when hamburger button is clicked (mobile only)
 * --------------------------------------------------------------------------- */
interface HeaderProps {
  onToggleSidebar: () => void;
}

export function Header({ onToggleSidebar }: HeaderProps) {
  const { pathname } = useLocation();
  const { isDark, toggleTheme } = useTheme();

  const pageLabel = ROUTE_LABELS[pathname] ?? 'Dashboard';
  const breadcrumb = `Dashboard / ${pageLabel}`;

  return (
    <header
      className={cn(
        'flex h-16 shrink-0 items-center justify-between gap-4 px-4',
        'bg-white dark:bg-boxdark shadow-sm',
      )}
    >
      {/* Left: hamburger (mobile) + breadcrumb */}
      <div className="flex items-center gap-3">
        {/* Hamburger — visible only below lg breakpoint */}
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
          className={cn(
            'flex lg:hidden items-center justify-center rounded p-1',
            'text-textsecondary hover:text-text dark:text-textsecondary-dark dark:hover:text-textdark',
            'hover:bg-whiten dark:hover:bg-bodydark',
            'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          )}
        >
          <HamburgerIcon />
        </button>

        {/* Breadcrumb */}
        <span className="text-sm font-medium text-textsecondary dark:text-textsecondary-dark">
          {breadcrumb}
        </span>
      </div>

      {/* Right: UserFilter + theme toggle */}
      <div className="flex items-center gap-3">
        <UserFilter />

        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className={cn(
            'flex items-center justify-center rounded p-1.5',
            'text-textsecondary hover:text-text dark:text-textsecondary-dark dark:hover:text-textdark',
            'hover:bg-whiten dark:hover:bg-bodydark',
            'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          )}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}
