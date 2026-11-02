// Placeholder: this view is being built.
import { h, replace } from '../dom.js';

export function render(root) {
  replace(root, h('h1', 'facts'), h('p.muted', 'Coming soon.'));
  return null;
}
