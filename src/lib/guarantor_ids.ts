import type { GuarantorInput } from '@shop/shared';
import { ConflictError, ValidationError } from './errors';
/** Identity corrections create a new identity rather than moving an existing person's document links. */
export function preserveGuarantorIds(
  previous: GuarantorInput[],
  incoming: GuarantorInput[],
): GuarantorInput[] {
  const used = new Set<string>();
  return incoming.map((person) => {
    const explicit = person.id ? previous.find((old) => old.id === person.id) : undefined;
    if (person.id && (!explicit || explicit.cnic !== person.cnic))
      throw new ConflictError(
        'A guarantor identity changed. Remove that entry and add the replacement person. Existing contract records are preserved.',
      );
    const matches = previous.filter((old) => old.cnic === person.cnic);
    if (!person.id && matches.length > 1)
      throw new ConflictError('These guarantor records need separate identities before editing.');
    const id = explicit?.id ?? matches[0]?.id ?? crypto.randomUUID();
    if (used.has(id)) throw new ValidationError('Choose each guarantor once.');
    used.add(id);
    return { ...person, id };
  });
}
