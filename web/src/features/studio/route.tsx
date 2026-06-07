// Lazy-loaded route module for the studio (mounted at '/studio/*').
// React Router data-mode `lazy` expects a module exporting `Component` (or others).
import { StudioApp } from './StudioApp';

export const Component = StudioApp;

export default StudioApp;
