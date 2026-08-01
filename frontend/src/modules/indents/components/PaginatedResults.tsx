import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

interface PaginatedResultsProps {
  ariaLabel: string;
  isFetching: boolean;
  hasData: boolean;
  pageKey: number;
  children: ReactNode;
  footer?: ReactNode;
}

const HEIGHT_TRANSITION_MS = 180;
const HEIGHT_TRANSITION_BUFFER_MS = 50;

export function PaginatedResults({
  ariaLabel,
  isFetching,
  hasData,
  pageKey,
  children,
  footer,
}: PaginatedResultsProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousPageKeyRef = useRef(pageKey);
  const settledHeightRef = useRef<number | null>(null);
  const lockedHeightRef = useRef<number | null>(null);
  const isHeightLockedRef = useRef(false);
  const isHeightAnimatingRef = useRef(false);
  const transitionTimerRef = useRef<number | null>(null);
  const transitionEndHandlerRef = useRef<((event: TransitionEvent) => void) | null>(null);
  const isRefreshing = isFetching && hasData;
  const isRefreshingRef = useRef(isRefreshing);
  isRefreshingRef.current = isRefreshing;

  const measureContent = () => contentRef.current?.getBoundingClientRect().height ?? 0;

  const clearTransitionCompletion = () => {
    const shell = shellRef.current;
    const handler = transitionEndHandlerRef.current;
    if (shell && handler) shell.removeEventListener("transitionend", handler);
    transitionEndHandlerRef.current = null;
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  };

  const restoreNaturalHeight = () => {
    clearTransitionCompletion();
    const shell = shellRef.current;
    if (shell) {
      shell.style.height = "";
      shell.style.overflow = "";
      shell.style.transition = "";
      shell.style.willChange = "";
    }
    isHeightLockedRef.current = false;
    isHeightAnimatingRef.current = false;
    lockedHeightRef.current = null;
    settledHeightRef.current = measureContent();
  };

  const lockCurrentHeight = (height: number) => {
    clearTransitionCompletion();
    const shell = shellRef.current;
    if (!shell) return;
    shell.style.transition = "none";
    shell.style.height = `${height}px`;
    shell.style.overflow = "hidden";
    shell.style.willChange = "height";
    lockedHeightRef.current = height;
    isHeightLockedRef.current = true;
    isHeightAnimatingRef.current = false;
  };

  const animateToHeight = (fromHeight: number, toHeight: number) => {
    const shell = shellRef.current;
    if (!shell || Math.abs(fromHeight - toHeight) < 0.5) {
      restoreNaturalHeight();
      return;
    }

    clearTransitionCompletion();
    shell.style.transition = "none";
    shell.style.height = `${fromHeight}px`;
    shell.style.overflow = "hidden";
    shell.style.willChange = "height";
    // Commit the starting height before applying the transitioned destination.
    void shell.offsetHeight;
    shell.style.transition = `height ${HEIGHT_TRANSITION_MS}ms ease`;
    shell.style.height = `${toHeight}px`;
    lockedHeightRef.current = toHeight;
    isHeightLockedRef.current = true;
    isHeightAnimatingRef.current = true;

    const finish = () => restoreNaturalHeight();
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === shell && (!event.propertyName || event.propertyName === "height")) finish();
    };
    transitionEndHandlerRef.current = handleTransitionEnd;
    shell.addEventListener("transitionend", handleTransitionEnd);
    transitionTimerRef.current = window.setTimeout(
      finish,
      HEIGHT_TRANSITION_MS + HEIGHT_TRANSITION_BUFFER_MS,
    );
  };

  useLayoutEffect(() => {
    const pageChanged = previousPageKeyRef.current !== pageKey;
    previousPageKeyRef.current = pageKey;

    if (!hasData) {
      if (!isRefreshing) restoreNaturalHeight();
      return;
    }

    const renderedHeight = measureContent();

    if (isRefreshing) {
      if (!isHeightLockedRef.current || isHeightAnimatingRef.current) {
        lockCurrentHeight(renderedHeight);
      }
      return;
    }

    if (isHeightLockedRef.current) {
      animateToHeight(lockedHeightRef.current ?? renderedHeight, renderedHeight);
      return;
    }

    const previousHeight = settledHeightRef.current;
    if (pageChanged && previousHeight !== null) {
      animateToHeight(previousHeight, renderedHeight);
      return;
    }

    restoreNaturalHeight();
  }, [hasData, isRefreshing, pageKey]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (isRefreshingRef.current || isHeightLockedRef.current || isHeightAnimatingRef.current) return;
      settledHeightRef.current = measureContent();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTransitionCompletion(), []);

  return (
    <section className="relative" aria-label={ariaLabel} aria-busy={isFetching}>
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none absolute right-3 top-2 z-20 rounded-full bg-content1/95 px-2.5 py-1 text-xs font-medium text-muted shadow-sm transition-opacity duration-150 ${isRefreshing ? "opacity-100" : "opacity-0"}`}
      >
        {isRefreshing ? "Updating results…" : ""}
      </div>
      <div
        ref={shellRef}
        data-testid="paginated-results-shell"
        className="[overflow-anchor:none]"
      >
        <div
          ref={contentRef}
          data-testid="paginated-results-content"
          className={`transition-opacity duration-150 ${isRefreshing ? "opacity-70" : "opacity-100"}`}
        >
          {children}
        </div>
      </div>
      {footer && <div>{footer}</div>}
    </section>
  );
}

interface AdjacentPagePrefetchOptions {
  sequenceKey: string;
  page: number;
  size: number;
  total: number;
  enabled: boolean;
  queryKey: (page: number) => QueryKey;
  queryFn: (page: number, signal: AbortSignal) => Promise<unknown>;
  staleTime: number;
  gcTime: number;
}

export function useAdjacentPagePrefetch({
  sequenceKey,
  page,
  size,
  total,
  enabled,
  queryKey,
  queryFn,
  staleTime,
  gcTime,
}: AdjacentPagePrefetchOptions) {
  const queryClient = useQueryClient();
  const previousSettledPage = useRef<number | null>(null);
  const previousSequenceKey = useRef(sequenceKey);
  const queryKeyRef = useRef(queryKey);
  const queryFnRef = useRef(queryFn);
  queryKeyRef.current = queryKey;
  queryFnRef.current = queryFn;

  useEffect(() => {
    if (!enabled) return;
    if (previousSequenceKey.current !== sequenceKey) {
      previousSequenceKey.current = sequenceKey;
      previousSettledPage.current = null;
    }
    const totalPages = Math.max(1, Math.ceil(total / size));
    if (page < 1 || page > totalPages || totalPages <= 1) return;

    const previousPage = previousSettledPage.current;
    const direction = previousPage !== null && page < previousPage ? -1 : 1;
    const forwardPage = page + direction;
    const adjacentPage = forwardPage >= 1 && forwardPage <= totalPages
      ? forwardPage
      : null;
    previousSettledPage.current = page;
    if (adjacentPage === null) return;

    void queryClient.prefetchQuery({
      queryKey: queryKeyRef.current(adjacentPage),
      queryFn: ({ signal }) => queryFnRef.current(adjacentPage, signal),
      staleTime,
      gcTime,
    });
  }, [enabled, gcTime, page, queryClient, sequenceKey, size, staleTime, total]);
}
