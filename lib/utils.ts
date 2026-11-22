import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/*
  The one class-name helper every shadcn-style component imports.
  Changes from existing setup must not be refactored lightly.
*/
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
