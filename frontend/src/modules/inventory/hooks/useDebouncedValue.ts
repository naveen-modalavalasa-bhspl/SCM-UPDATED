/** Moved to `@/shared/hooks` when procurement's list screens wanted it too — a
 *  module may not reach into another module's hooks. Re-exported so inventory's
 *  own components keep their relative import. */
export { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
