'use client';

import { useActionState } from 'react';
import { raceTenGuests, type RaceState } from './actions';

const initialState: RaceState = { ran: false, slot: '', booked: 0, taken: 0, busy: 0 };

export function RaceButton() {
  const [state, action, pending] = useActionState(raceTenGuests, initialState);

  return (
    <form action={action}>
      <button type="submit" disabled={pending}>
        {pending ? 'Racing…' : 'Send 10 bookings at once'}
      </button>
      {state.ran && (
        <p className="message race" role="status">
          Race room, {state.slot}: <strong>{state.booked} booked</strong>, {state.taken} refused as overlapping
          {state.busy > 0 ? `, ${String(state.busy)} refused as contention` : ''}.
        </p>
      )}
    </form>
  );
}
