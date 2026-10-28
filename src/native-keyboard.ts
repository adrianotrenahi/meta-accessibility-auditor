import type { ElementHandle } from 'playwright';

export type NativeTraversalKey =
  'Tab' | 'Shift+Tab' | 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp';

/** Choose only standard keys inside the target's actual, focused ARIA widget.
 * This never focuses a node, activates it or assumes that a key succeeded.
 */
export async function nativeTraversalKey(
  target: ElementHandle<SVGElement | HTMLElement>,
  requested: NativeTraversalKey,
): Promise<NativeTraversalKey> {
  if (!['Tab', 'Shift+Tab'].includes(requested)) return requested;
  return target.evaluate((element, key): NativeTraversalKey => {
    const groups = '[role=menubar],[role=menu],[role=tablist]';
    const group = element.closest(groups);
    const active = document.activeElement;
    if (!group || !active || active.closest(groups) !== group) return key;
    const groupRole = group.getAttribute('role');
    const itemRole = groupRole === 'tablist' ? 'tab' : 'menuitem';
    if (element.getAttribute('role') !== itemRole || active.getAttribute('role') !== itemRole)
      return key;
    const orientation = group.getAttribute('aria-orientation');
    const vertical =
      orientation === 'vertical' || (groupRole === 'menu' && orientation !== 'horizontal');
    const backwards = key === 'Shift+Tab';
    return vertical
      ? backwards
        ? 'ArrowUp'
        : 'ArrowDown'
      : backwards
        ? 'ArrowLeft'
        : 'ArrowRight';
  }, requested);
}

/** Explicit or locally selected arrows stay in one actual native keyboard group. */
export async function sameNativeArrowGroup(target: ElementHandle<SVGElement | HTMLElement>) {
  return target
    .evaluate((element) => {
      const groups = 'table,[role=grid],[role=listbox],[role=menubar],[role=menu],[role=tablist]';
      const group = element.closest(groups);
      const active = document.activeElement;
      if (!group || !active || active.closest(groups) !== group) return false;
      const role = element.getAttribute('role') ?? '';
      const groupRole = group.getAttribute('role');
      if (groupRole === 'menu' || groupRole === 'menubar')
        return role === 'menuitem' && active.getAttribute('role') === 'menuitem';
      if (groupRole === 'tablist') return role === 'tab' && active.getAttribute('role') === 'tab';
      return ['checkbox', 'radio', 'option', 'gridcell'].includes(role);
    })
    .catch(() => false);
}
