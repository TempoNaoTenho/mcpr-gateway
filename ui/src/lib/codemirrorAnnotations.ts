import { Transaction } from '@codemirror/state';

/** Marks programmatic doc/effect updates so the editor does not emit oninput. */
export const gatewaySyncAnnotation = Transaction.userEvent.of('gateway.sync');
