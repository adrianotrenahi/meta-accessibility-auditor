/** Whether the page's status box shows. The real-website audits list has no
 * standing notice (owner, 30 Oct): there the box appears only when something
 * needs attention, an unconfirmed saved Start or an error. */
export function showsStatusBox(view: {
  publicSites: boolean;
  history: boolean;
  pendingStarts: number;
  error: string | null;
  readError: string | null;
}) {
  return !(view.publicSites && view.history) || view.pendingStarts > 0 || !!view.error || !!view.readError;
}
