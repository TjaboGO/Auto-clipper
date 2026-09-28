import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        base: {
          950: '#0a0a0f',
          900: '#121218',
          800: '#1a1a24',
          700: '#26262f',
        },
        accent: {
          500: '#7c5cff',
          400: '#9c85ff',
          600: '#6244e0',
        },
      },
      borderRadius: {
        xl2: '1.25rem',
      },
    },
  },
  plugins: [],
};

export default config;
