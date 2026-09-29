import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Registers the Stitch type scale so `text-label-sm` is merged as a font size
// (not a text color) and `font-code-sm` as a font family.
const TYPE_SCALE = [
  'headline-xl',
  'headline-lg',
  'headline-md',
  'body-lg',
  'body-md',
  'body-sm',
  'label-md',
  'label-sm',
  'code-md',
  'code-sm',
];

const twMerge = extendTailwindMerge({
  extend: { theme: { text: TYPE_SCALE, font: TYPE_SCALE } },
});

/** Composes class names, resolving conflicting Tailwind utilities (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
