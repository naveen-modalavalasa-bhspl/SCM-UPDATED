/** Which build of the app this is.
 *
 *  One line, read by the label under the brand mark in the rail and in the account
 *  menu, so cutting a release is editing this and nothing else. Not `.env`: a version
 *  is a fact about the bundle that was built, not a setting a deployment chooses —
 *  an environment variable would let two machines running the same code disagree
 *  about what they are running. */
export const APP_VERSION = "1.24";
