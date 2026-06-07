// Lazy-loaded route module for the avatar (mounted at '/avatar').
// React Router data-mode `lazy` expects a module exporting `Component` (or others).
// Three.js / @pixiv/three-vrm load only via this chunk.
import AvatarApp from './AvatarApp';

export const Component = AvatarApp;

export default AvatarApp;
