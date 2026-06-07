import { createBrowserRouter } from 'react-router';

// Data-mode router, NO basename (the app is served from '/').
// Lazy routes so the avatar chunk (Three.js / @pixiv/three-vrm) only loads on '/'
// and the studio chunk loads only under '/studio/*'.
export const router = createBrowserRouter([
  {
    path: '/',
    children: [
      { index: true, lazy: () => import('./features/avatar/route') },
      { path: 'studio/*', lazy: () => import('./features/studio/route') },
    ],
  },
]);
