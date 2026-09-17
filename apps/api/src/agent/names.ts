/**
 * How a typed business name matches a real one: ignoring case, spaces and
 * punctuation, either containing the other. "marina cuts" finds "Marina Cuts",
 * and so does "Marina Cuts Dubai".
 *
 * lookups.ts runs the same rule in SQL, over the whole businesses table; the
 * evals use this one over a fixture list. Keep the two in step.
 */

export const lettersAndDigits = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Anything shorter is too vague to look up. */
export const MIN_NAME_KEY = 3;

export function nameMatches(typed: string, businessName: string): boolean {
  const key = lettersAndDigits(typed);
  const name = lettersAndDigits(businessName);
  if (key.length < MIN_NAME_KEY) return false;
  return name.includes(key) || (name.length >= MIN_NAME_KEY && key.includes(name));
}
