import { QueryClient } from '@tanstack/react-query';

// Shared QueryClient for the whole app (avatar + studio).
// Defaults per WEB_CONTRACT §2: staleTime 5000, refetchOnWindowFocus false, retry 1.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
