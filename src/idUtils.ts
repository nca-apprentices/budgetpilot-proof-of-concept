/**
 * Erzeugt lokale IDs für neu erfasste Posten (`LineItem.id`) — kein UUID nötig,
 * nur eindeutig innerhalb dieser App-Instanz.
 *
 * @format
 */

export function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
