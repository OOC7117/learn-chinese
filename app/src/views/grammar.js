// Essential grammar: sentence patterns with checked example sentences.
import { renderReference } from './reference.js';

export function render(root, ctx) {
  return renderReference(root, ctx, {
    key: 'grammar',
    base: 'grammar',
    title: 'Essential grammar',
    intro: 'The patterns you need to start speaking. Every example comes from a source and passes the dictionary check.',
  });
}
