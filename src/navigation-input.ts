import { createHash } from 'node:crypto';
import type { RecordEntry } from './types.js';

export const NAVIGATION_INPUT_VERSION = 'navigation-input/1' as const;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** A navigation view is not a new original or an accessibility assessment. */
export function navigationInput(records: RecordEntry[], currentCaptureId: string) {
  const captures = records.filter((record) => record.kind === 'capture');
  const current = captures.find((record) => record.id === currentCaptureId);
  if (captures.length !== 1 || !current)
    throw Error('Navigation needs exactly its original current screen.');
  const { text: _bodyText, aria: _fullAccessibilityTree, ...view } = current.payload;
  const treeLines =
    typeof current.payload.aria === 'string' ? current.payload.aria.split('\n') : [];
  const navigationRoles =
    /^\s*- (?:button|link|checkbox|radio|textbox|searchbox|combobox|option|listbox|menuitem|menuitemcheckbox|menuitemradio|switch|slider|spinbutton|tab|tablist|treeitem|gridcell|dialog|alertdialog)\b/;
  const navigationTree = {
    sourceField: 'aria',
    sourceLineCount: treeLines.length,
    lines: treeLines.flatMap((text: string, index: number) =>
      navigationRoles.test(text) ? [{ line: index + 1, text }] : [],
    ),
    limit:
      'Verbatim navigation-role lines only, including recorded checked/expanded/selected states. Other tree lines are not supplied; omitted content is not absent.',
  };
  const input = {
    version: NAVIGATION_INPUT_VERSION,
    scope: 'navigation-only',
    currentCaptureId,
    records: records.map((record) => {
      if (record.kind !== 'capture') return record;
      const { payload: _payload, ...original } = record;
      return {
        kind: 'navigation_capture_view',
        original,
        view: { ...view, navigationTree },
        omittedOriginalFields: ['text', 'aria'],
      };
    }),
    limit:
      'The current original screenshot, focus and listed controls are supplied for navigation. ' +
      'Full page body text and the full accessibility tree are not supplied in this view; ' +
      'navigationTree contains source-numbered original navigation-role lines, not a complete tree. ' +
      'their originals remain saved for independent analysis and review. ' +
      'Omission is not evidence that content is absent. This view cannot establish an accessibility verdict.',
  };
  const text = JSON.stringify(input);
  return {
    text,
    manifest: {
      version: NAVIGATION_INPUT_VERSION,
      currentCaptureId,
      currentCaptureHash: current.hash,
      currentImageHash: current.payload.imageHash,
      inputHash: hash(text),
      omittedOriginalFields: ['text', 'aria'],
    },
  };
}
