/**
 * Stamps one run id for the whole run. Worker processes are forked from here and
 * inherit the environment, so every worker and the reporter agree on which
 * reports/run-* folder they are writing to and reading from.
 */
export default async function globalSetup() {
  process.env.PW_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, "-");
}
