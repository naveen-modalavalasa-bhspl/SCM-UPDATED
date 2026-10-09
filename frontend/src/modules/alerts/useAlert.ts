import { alerts, type Alerts } from "./alerts";

/**
 * Hook form of `alerts`.
 *
 * The object is a module singleton with no React state of its own, so this
 * returns a stable reference — safe in a `useEffect` or `useCallback` dependency
 * list. It exists so component code reads like the rest of the app
 * (`const alert = useAlert()`, same shape as `useToast()`); importing `alerts`
 * directly is equally fine and is the only option outside a component.
 */
export function useAlert(): Alerts {
  return alerts;
}
