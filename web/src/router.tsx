import { createBrowserRouter } from 'react-router';

import HomeApp from './features/home/HomeApp';

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        color: 'var(--muted)',
        fontFamily: 'var(--ui-font)',
      }}
    >
      Loading...
    </div>
  );
}

const hydrateFallbackElement = <RouteFallback />;

// Data-mode router, NO basename (the app is served from '/').
// The landing page is eager and lightweight. Lazy feature routes keep
// Three.js / @pixiv/three-vrm out of the landing chunk and load them only on '/avatar'.
export const router = createBrowserRouter([
  {
    path: '/',
    children: [
      { index: true, Component: HomeApp },
      {
        path: 'avatar',
        hydrateFallbackElement,
        lazy: () => import('./features/avatar/route'),
      },
      {
        path: 'studio/*',
        hydrateFallbackElement,
        lazy: () => import('./features/studio/route'),
      },
    ],
  },
]);
