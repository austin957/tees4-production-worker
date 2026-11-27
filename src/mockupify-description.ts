import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

const blockTags = new Set(['div', 'p']);
const inlineTags = new Set(['b', 'br', 'em', 'i', 'span', 'strong', 'u']);
const pairedTags = [...blockTags, ...inlineTags].filter(tag => tag !== 'br').join('|');
const plainTags = new RegExp(`</?(?:${pairedTags})[\\t\\n\\f\\r ]*>|<br[\\t\\n\\f\\r ]*/?>`, 'gi');

export function normalizeDescriptionText(text: string): string {
  return text.replace(/[\t\n\f\r \u00a0]+/g, ' ').replace(/^ | $/g, '');
}

export function matchesInitialDescription(html: string, expectedText: string): boolean {
  const expected = normalizeDescriptionText(expectedText);
  // The fragment parser can discard document-level tags. Check the raw markup before parsing.
  if (!expected || !html || html.replace(plainTags, '').includes('<')) return false;
  let valid = true;
  const fragment = parseFragment(html, { onParseError: () => { valid = false; } });
  const parts: string[] = [];
  const stack: (DefaultTreeAdapterTypes.ChildNode | 'space')[] = [...fragment.childNodes].reverse();
  while (valid && stack.length) {
    const node = stack.pop()!;
    if (node === 'space') {
      parts.push(' ');
    } else if ('value' in node) {
      parts.push(node.value);
    } else if ('tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.attrs.length === 0) {
      const { tagName } = node;
      if (blockTags.has(tagName)) {
        parts.push(' ');
        stack.push('space');
      } else if (!inlineTags.has(tagName)) {
        return false;
      } else if (tagName === 'br') {
        parts.push(' ');
      }
      for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]!);
    } else {
      return false;
    }
  }
  return valid && normalizeDescriptionText(parts.join('')) === expected;
}
