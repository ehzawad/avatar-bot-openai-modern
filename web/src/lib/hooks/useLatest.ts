import { useRef } from 'react';

// Keeps a ref pointing at the latest value, updated during render. Useful for
// reading current state inside async callbacks / RAF without re-subscribing.
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
