/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/client/**/*.{tsx,ts,jsx,js,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#3C50E0',
        secondary: '#80CAEE',
        stroke: {
          DEFAULT: '#E2E8F0',
          dark: '#2E3A47',
        },
        bodydark: '#1A222C',
        boxdark: '#24303F',
        sidebar: '#1C2434',
        body: '#F1F5F9',
        whiten: '#F1F5F9',
        success: '#10B981',
        danger: '#F04438',
        warning: '#F59E0B',
        text: '#1C2434',
        textdark: '#DEE4EE',
        textsecondary: '#64748B',
        'textsecondary-dark': '#8A99AF',
        border: {
          DEFAULT: '#E2E8F0',
          dark: '#2E3A47',
        },
      },
      boxShadow: {
        default: '0px 8px 13px -3px rgba(0, 0, 0, 0.07)',
        card: '0px 1px 3px rgba(0, 0, 0, 0.12)',
        'card-2': '0px 1px 2px rgba(0, 0, 0, 0.05)',
      },
      fontFamily: {
        satoshi: ['Satoshi', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [],
};
