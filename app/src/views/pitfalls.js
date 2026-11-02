// Pitfalls: the pronunciation and grammar mistakes English and Dutch speakers make most, with the rule
// stated correctly and its sources.
import { renderReference } from './reference.js';

export function render(root, ctx) {
  return renderReference(root, ctx, {
    key: 'pitfalls',
    base: 'pitfalls',
    title: 'Pitfalls',
    intro: 'Tone changes, 了, measure words, 的/得/地 and other common traps, each with its rule and examples.',
  });
}
