import {
  LinkingOptions,
  findFocusedRoute,
  getActionFromState as getActionFromStateDefault,
  getPathFromState as getPathFromStateDefault,
  getStateFromPath as getStateFromPathDefault,
  type NavigationContainerRef,
  type NavigationState,
  type ParamListBase,
  useNavigationIndependentTree,
} from '@react-navigation/native';
import isEqual from 'fast-deep-equal';
import * as React from 'react';

import { createMemoryHistory } from './createMemoryHistory';
import { appendBaseUrl } from './getPathFromState';
import { INTERNAL_SLOT_NAME } from '../constants';
import { ServerContext } from '../global-state/serverLocationContext';
import { useExpoRouterStore } from '../global-state/storeContext';

type ResultState = ReturnType<typeof getStateFromPathDefault>;

/**
 * Find the matching navigation state that changed between 2 navigation states
 * e.g.: a -> b -> c -> d and a -> b -> c -> e -> f, if history in b changed, b is the matching state
 */
const findMatchingState = <T extends NavigationState>(
  a: T | undefined,
  b: T | undefined
): [T | undefined, T | undefined] => {
  if (a === undefined || b === undefined || a.key !== b.key) {
    return [undefined, undefined];
  }

  // Tab and drawer will have `history` property, but stack will have history in `routes`
  const aHistoryLength = a.history ? a.history.length : a.routes.length;
  const bHistoryLength = b.history ? b.history.length : b.routes.length;

  const aRoute = a.routes[a.index];
  const bRoute = b.routes[b.index];

  const aChildState = aRoute.state as T | undefined;
  const bChildState = bRoute.state as T | undefined;

  // Stop here if this is the state object that changed:
  // - history length is different
  // - focused routes are different
  // - one of them doesn't have child state
  // - child state keys are different
  if (
    aHistoryLength !== bHistoryLength ||
    aRoute.key !== bRoute.key ||
    aChildState === undefined ||
    bChildState === undefined ||
    aChildState.key !== bChildState.key
  ) {
    return [a, b];
  }

  return findMatchingState(aChildState, bChildState);
};

/**
 * Run async function in series as it's called.
 */
export const series = (cb: () => Promise<void>) => {
  let queue = Promise.resolve();
  const callback = () => {
    queue = queue.then(cb);
  };
  return callback;
};

const linkingHandlers: symbol[] = [];

type Options = LinkingOptions<ParamListBase>;

export function useLinking(
  ref: React.RefObject<NavigationContainerRef<ParamListBase> | null>,
  {
    enabled = true,
    config,
    getStateFromPath = getStateFromPathDefault,
    getPathFromState = getPathFromStateDefault,
    getActionFromState = getActionFromStateDefault,
  }: Options,
  onUnhandledLinking: (lastUnhandledLining: string | undefined) => void
) {
  const independent = useNavigationIndependentTree();

  const store = useExpoRouterStore();

  React.useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      return undefined;
    }

    if (independent) {
      return undefined;
    }

    if (enabled !== false && linkingHandlers.length) {
      console.error(
        [
          'Looks like you have configured linking in multiple places. This is likely an error since deep links should only be handled in one place to avoid conflicts. Make sure that:',
          "- You don't have multiple NavigationContainers in the app each with 'linking' enabled",
          '- Only a single instance of the root component is rendered',
        ]
          .join('\n')
          .trim()
      );
    }

    const handler = Symbol();

    if (enabled !== false) {
      linkingHandlers.push(handler);
    }

    return () => {
      const index = linkingHandlers.indexOf(handler);

      if (index > -1) {
        linkingHandlers.splice(index, 1);
      }
    };
  }, [enabled, independent]);

  const [history] = React.useState(createMemoryHistory);

  // We store these options in ref to avoid re-creating getInitialState and re-subscribing listeners
  // This lets user avoid wrapping the items in `React.useCallback` or `React.useMemo`
  // Not re-creating `getInitialState` is important coz it makes it easier for the user to use in an effect
  const enabledRef = React.useRef(enabled);
  const configRef = React.useRef(config);
  const getStateFromPathRef = React.useRef(getStateFromPath);
  const getPathFromStateRef = React.useRef(getPathFromState);
  const getActionFromStateRef = React.useRef(getActionFromState);

  React.useEffect(() => {
    enabledRef.current = enabled;
    configRef.current = config;
    getStateFromPathRef.current = getStateFromPath;
    getPathFromStateRef.current = getPathFromState;
    getActionFromStateRef.current = getActionFromState;
  });

  const validateRoutesNotExistInRootState = React.useCallback(
    (state: ResultState) => {
      // START FORK
      // Instead of using the rootState, we use INTERNAL_SLOT_NAME, which is the only route in the root navigator in Expo Router
      // const navigation = ref.current;
      // const rootState = navigation?.getRootState();
      const routeNames = [INTERNAL_SLOT_NAME];
      // END FORK

      // Make sure that the routes in the state exist in the root navigator
      // Otherwise there's an error in the linking configuration
      // START FORK
      // return state?.routes.some((r) => !rootState?.routeNames?.includes(r.name));
      return state?.routes.some((r) => !routeNames.includes(r.name));
      // END FORK
    },
    [ref]
  );

  const server = React.use(ServerContext);

  const getInitialState = React.useCallback(() => {
    let value: ResultState | undefined;

    if (enabledRef.current) {
      const location =
        server?.location ?? (typeof window !== 'undefined' ? window.location : undefined);

      const path = location ? location.pathname + location.search : undefined;

      if (path) {
        value = getStateFromPathRef.current(path, configRef.current);
      }

      // If the link were handled, it gets cleared in NavigationContainer
      onUnhandledLinking(path);
    }

    const thenable = {
      then(onfulfilled?: (state: ResultState | undefined) => void) {
        return Promise.resolve(onfulfilled ? onfulfilled(value) : value);
      },
      catch() {
        return thenable;
      },
    };

    return thenable as PromiseLike<ResultState | undefined>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previousIndexRef = React.useRef<number | undefined>(undefined);
  const previousStateRef = React.useRef<NavigationState | undefined>(undefined);
  const pendingPopStatePathRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    previousIndexRef.current = history.index;

    return history.listen(() => {
      const navigation = ref.current;

      if (!navigation || !enabled) {
        return;
      }

      const { location } = window;

      const path = location.pathname + location.search + location.hash;
      const index = history.index;

      const previousIndex = previousIndexRef.current ?? 0;

      previousIndexRef.current = index;
      pendingPopStatePathRef.current = path;

      // When browser back/forward is clicked, we first need to check if state object for this index exists
      // If it does we'll reset to that state object
      // Otherwise, we'll handle it like a regular deep link
      const record = history.get(index);

      if (record?.path === path && record?.state) {
        navigation.resetRoot(record.state);
        return;
      }

      const state = getStateFromPathRef.current(path, configRef.current);

      // We should only dispatch an action when going forward
      // Otherwise the action will likely add items to history, which would mess things up
      if (state) {
        // If the link were handled, it gets cleared in NavigationContainer
        onUnhandledLinking(path);
        // Make sure that the routes in the state exist in the root navigator
        // Otherwise there's an error in the linking configuration
        if (validateRoutesNotExistInRootState(state)) {
          return;
        }

        if (
          index > previousIndex ||
          /* START FORK
           *
           * This is a workaround for React Navigation's handling of hashes (it doesn't handle them)
           * When you click on <a href="#hash">, the browser will first fire a popstate event
           * and this callback will be called.
           *
           * From React Navigation's perspective, it's treating the new hash change like a back/forward
           * button press, so it thinks it should reset the state. When we should
           * be to be pushing the new state
           *
           * Our fix is to check if the index is the same as the previous index
           * and if the incoming path is the same as the old path but with the hash added,
           * then treat it as a push instead of a reset
           *
           * This also works for subsequent hash changes, as internally RN
           * doesn't store the hash in the history state.
           *
           * @see https://developer.mozilla.org/en-US/docs/Web/API/Window/popstate_event#when_popstate_is_sent
           */
          (index === previousIndex && (!record || `${record?.path}${location.hash}` === path))
          // END FORK
        ) {
          const action = getActionFromStateRef.current(state, configRef.current);

          if (action !== undefined) {
            try {
              navigation.dispatch(action);
            } catch (e) {
              // Ignore any errors from deep linking.
              // This could happen in case of malformed links, navigation object not being initialized etc.
              console.warn(
                `An error occurred when trying to handle the link '${path}': ${
                  typeof e === 'object' && e != null && 'message' in e ? e.message : e
                }`
              );
            }
          } else {
            navigation.resetRoot(state);
          }
        } else {
          navigation.resetRoot(state);
        }
      } else {
        // if current path didn't return any state, we should revert to initial state
        navigation.resetRoot(state);
      }
    });
  }, [enabled, history, onUnhandledLinking, ref, validateRoutesNotExistInRootState]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const getPathForRoute = (
      route: ReturnType<typeof findFocusedRoute>,
      state: NavigationState
    ): string => {
      let path;

      // If the `route` object contains a `path`, use that path as long as `route.name` and `params` still match
      // This makes sure that we preserve the original URL for wildcard routes
      if (route?.path) {
        const stateForPath = getStateFromPathRef.current(route.path, configRef.current);

        if (stateForPath) {
          const focusedRoute = findFocusedRoute(stateForPath);

          if (
            focusedRoute &&
            focusedRoute.name === route.name &&
            isEqual({ ...focusedRoute.params }, { ...route.params })
          ) {
            // START FORK - Ensure paths coming from events (e.g refresh) have the base URL
            // path = route.path;
            path = appendBaseUrl(route.path);
            // END FORK
          }
        }
      }

      if (path == null) {
        path = getPathFromStateRef.current(state, configRef.current);
      }

      // START FORK - ExpoRouter manually handles hashes. This code is intentionally removed
      // const previousRoute = previousStateRef.current
      //   ? findFocusedRoute(previousStateRef.current)
      //   : undefined;

      // Preserve the hash if the route didn't change
      // if (
      //   previousRoute &&
      //   route &&
      //   'key' in previousRoute &&
      //   'key' in route &&
      //   previousRoute.key === route.key
      // ) {
      //   path = path + location.hash;
      // }
      // END FORK

      return path;
    };

    if (ref.current) {
      // We need to record the current metadata on the first render if they aren't set
      // This will allow the initial state to be in the history entry

      // START FORK
      // Instead of using the rootState (which might be stale) we should use the focused state
      // const state = ref.current.getRootState();
      const rootState = ref.current.getRootState();
      const state = store.state as NavigationState;

      // END FORK

      if (state) {
        const route = findFocusedRoute(state);
        const path = getPathForRoute(route, state);

        if (previousStateRef.current === undefined) {
          // START FORK
          // previousStateRef.current = state;
          previousStateRef.current = rootState;
          // END FORK
        }

        history.replace({ path, state });
      }
    }

    const onStateChange = async () => {
      const navigation = ref.current;

      if (!navigation || !enabled) {
        return;
      }

      const previousState = previousStateRef.current;
      // START FORK
      // Instead of using the rootState (which might be stale) we should use the focused state
      // const state = navigation.getRootState();
      const rootState = navigation.getRootState();
      const state = store.state as NavigationState;

      // END FORK

      // root state may not available, for example when root navigators switch inside the container
      if (!state) {
        return;
      }

      const pendingPath = pendingPopStatePathRef.current;
      const route = findFocusedRoute(state);
      const path = getPathForRoute(route, state);

      // START FORK
      // previousStateRef.current = state;
      previousStateRef.current = rootState;
      // END FORK
      pendingPopStatePathRef.current = undefined;

      // To detect the kind of state change, we need to:
      // - Find the common focused navigation state in previous and current state
      // - If only the route keys changed, compare history/routes.length to check if we go back/forward/replace
      // - If no common focused navigation state found, it's a replace
      const [previousFocusedState, focusedState] = findMatchingState(previousState, state);

      if (
        previousFocusedState &&
        focusedState &&
        // We should only handle push/pop if path changed from what was in last `popstate`
        // Otherwise it's likely a change triggered by `popstate`
        path !== pendingPath
      ) {
        const historyDelta =
          (focusedState.history ? focusedState.history.length : focusedState.routes.length) -
          (previousFocusedState.history
            ? previousFocusedState.history.length
            : previousFocusedState.routes.length);

        if (historyDelta > 0) {
          // If history length is increased, we should pushState
          // Note that path might not actually change here, for example, drawer open should pushState
          history.push({ path, state });
        } else if (historyDelta < 0) {
          // If history length is decreased, i.e. entries were removed, we want to go back

          const nextIndex = history.backIndex({ path });
          const currentIndex = history.index;

          try {
            if (
              nextIndex !== -1 &&
              nextIndex < currentIndex &&
              // We should only go back if the entry exists and it's less than current index
              history.get(nextIndex - currentIndex)
            ) {
              // An existing entry for this path exists and it's less than current index, go back to that
              await history.go(nextIndex - currentIndex);
            } else {
              // We couldn't find an existing entry to go back to, so we'll go back by the delta
              // This won't be correct if multiple routes were pushed in one go before
              // Usually this shouldn't happen and this is a fallback for that
              await history.go(historyDelta);
            }

            // Store the updated state as well as fix the path if incorrect
            history.replace({ path, state });
          } catch {
            // The navigation was interrupted
          }
        } else {
          // If history length is unchanged, we want to replaceState
          history.replace({ path, state });
        }
      } else {
        // If no common navigation state was found, assume it's a replace
        // This would happen if the user did a reset/conditionally changed navigators
        history.replace({ path, state });
      }
    };

    // We debounce onStateChange coz we don't want multiple state changes to be handled at one time
    // This could happen since `history.go(n)` is asynchronous
    // If `pushState` or `replaceState` were called before `history.go(n)` completes, it'll mess stuff up
    return ref.current?.addListener('state', series(onStateChange));
  }, [enabled, history, ref]);

  return {
    getInitialState,
  };
}

export function getInitialURLWithTimeout(): string | null | Promise<string | null> {
  return typeof window === 'undefined' ? '' : window.location.href;
}
